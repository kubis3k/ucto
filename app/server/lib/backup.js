// =====================================================================
// backup.js — aplikační záloha celé databáze do objektového úložiště.
//
// PROČ: jediný zdroj pravdy webové verze je Neon Postgres. Bez vlastní
// zálohy je firma závislá výhradně na poskytovateli a ruční export do CSV
// nepokrývá celý datový model (§ 8 ZoÚ — trvalost účetních záznamů).
//
// PROČ NE pg_dump: Vercel serverless runtime neobsahuje klientské binárky
// Postgresu, takže `pg_dump` tam prostě není. Záloha je proto aplikační —
// projde tabulky přes store.listTables() a serializuje řádky do JSON.
//
// TOHLE JE DRUHÁ VRSTVA, NE JEDINÁ. První vrstvou má být PITR / branching
// na straně Neonu (nastavuje se mimo kód, viz DOKUMENTACE.md 10.7).
// Aplikační záloha chrání i proti chybě v aplikaci nebo omylem smazaným
// datům, na které by PITR musel obnovovat celou databázi.
//
// Tabulky se NEZADRÁTOVÁVAJÍ — čtou se z katalogu, aby nová tabulka
// v záloze tiše nechyběla (to je u zálohy horší než hlasitá chyba).
// =====================================================================
const store = require("../db");
const blobClient = require("./blobClient");

const BACKUP_PREFIX = "backups/";
const DEFAULT_RETENTION_DAYS = 90;

function retentionDays() {
  const raw = Number(process.env.BACKUP_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

// Vytvoří serializovatelný snapshot celé databáze.
async function collectSnapshot() {
  const tables = await store.listTables();
  const data = {};
  const counts = {};
  for (const table of tables) {
    const rows = await store.all(`SELECT * FROM ${table}`);
    data[table] = rows;
    counts[table] = rows.length;
  }
  return {
    format: "globaal-elevate-ucetnictvi-backup",
    format_version: 1,
    created_at: new Date().toISOString(),
    table_count: tables.length,
    row_counts: counts,
    data,
  };
}

// Vytvoří zálohu a uloží ji. Vrací metadata (klíč, velikost, počty řádků),
// nikdy ne celý obsah — ten by v HTTP odpovědi cronu neměl co dělat.
async function createBackup() {
  const snapshot = await collectSnapshot();
  const body = Buffer.from(JSON.stringify(snapshot), "utf-8");
  const stamp = snapshot.created_at.replace(/[:.]/g, "-");
  const key = `${BACKUP_PREFIX}ucetnictvi-${stamp}.json`;

  if (!blobClient.isConfigured()) {
    // Bez úložiště zálohu VĚDOMĚ neděláme naslepo — vracíme jasný stav,
    // ať se v produkci nedá přehlédnout, že zálohy nejely.
    throw Object.assign(
      new Error("Záloha není nakonfigurovaná — chybí BLOB_READ_WRITE_TOKEN (objektové úložiště)."),
      { status: 503 }
    );
  }

  const { put } = blobClient.get();
  const result = await put(key, body, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    token: blobClient.token(),
  });

  return {
    key,
    url: result.url,
    size_bytes: body.length,
    created_at: snapshot.created_at,
    table_count: snapshot.table_count,
    row_counts: snapshot.row_counts,
  };
}

// Smaže zálohy starší než retenční lhůta. Datum se bere z `uploadedAt`
// úložiště, ne z názvu — název jde přejmenovat, metadata ne.
async function pruneOldBackups() {
  if (!blobClient.isConfigured()) return { deleted: [], kept: 0 };
  const { list, del } = blobClient.get();
  const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;

  const listed = await list({ prefix: BACKUP_PREFIX, token: blobClient.token() });
  const blobs = listed.blobs || [];
  const deleted = [];
  for (const b of blobs) {
    const uploadedAt = new Date(b.uploadedAt || b.uploaded_at || 0).getTime();
    if (Number.isFinite(uploadedAt) && uploadedAt > 0 && uploadedAt < cutoff) {
      await del(b.url, { token: blobClient.token() });
      deleted.push(b.pathname || b.url);
    }
  }
  return { deleted, kept: blobs.length - deleted.length, retention_days: retentionDays() };
}

module.exports = { createBackup, pruneOldBackups, collectSnapshot, retentionDays, BACKUP_PREFIX };
