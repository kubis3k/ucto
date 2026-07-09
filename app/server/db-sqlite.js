// =====================================================================
// db.js — obálka nad sql.js (SQLite zkompilované do WebAssembly).
//
// Proč sql.js a ne better-sqlite3: sql.js nepotřebuje nativní kompilaci
// (node-gyp / Visual Studio Build Tools), takže se dá bezpečně zabalit
// do .exe přes electron-builder na jakémkoliv Windows počítači bez
// dalších nástrojů. Cenou je, že běží čistě v paměti — proto po každé
// zapisovací operaci soubor databáze ukládáme na disk (persist()).
//
// Rozhraní (get/all/run/transaction) je async, i když sql.js interně
// pracuje synchronně — to proto, aby stejný route/lib kód šel beze změny
// spustit i nad db-pg.js (Postgres, webová verze), kde async není na výběr.
// =====================================================================
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

let SQL = null;
let db = null;
let dbFilePath = null;
let userDataDirPath = null;

async function init(userDataDir) {
  // V zabalené .exe aplikaci je sql-wasm.wasm zkopírován do resources/ (viz
  // "extraResources" v package.json) — čtení z .asar archivu wasm modulem
  // by bylo nespolehlivé. Ve vývoji se použije přímo node_modules.
  const packagedWasmDir = typeof process !== "undefined" && process.resourcesPath ? process.resourcesPath : null;
  const devWasmDir = path.join(__dirname, "..", "node_modules", "sql.js", "dist");

  SQL = await initSqlJs({
    locateFile: (file) => {
      if (packagedWasmDir) {
        const packagedPath = path.join(packagedWasmDir, file);
        if (fs.existsSync(packagedPath)) return packagedPath;
      }
      return path.join(devWasmDir, file);
    },
  });

  userDataDirPath = userDataDir;
  dbFilePath = path.join(userDataDir, "ucetnictvi.sqlite");
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");

  if (fs.existsSync(dbFilePath)) {
    const fileBuffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(fileBuffer);
    db.run(schemaSql); // idempotentní (IF NOT EXISTS) — doplní nové tabulky/triggery po update appky
  } else {
    db = new SQL.Database();
    db.run(schemaSql);
  }

  await migrate();
  persist();
  return db;
}

// Přidání sloupců, které nešly vytvořit přes IF NOT EXISTS (SQLite nemá
// "ADD COLUMN IF NOT EXISTS"). Bezpečné pro upgrade existujících databází.
async function ensureColumn(table, column, definition) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrate() {
  // IBAN účetní jednotky — potřebný pro QR platbu na vydaných fakturách.
  await ensureColumn("accounting_unit", "iban", "TEXT");
  await ensureColumn("accounting_unit", "bank_account", "TEXT");
  // IBAN kontaktu — pro QR platbu na přijatých fakturách / úhradách dodavatelům.
  await ensureColumn("contact", "iban", "TEXT");
  // Přihlašování — heslo a BankID ověření jednatele.
  await ensureColumn("app_user", "password_hash", "TEXT");
  await ensureColumn("app_user", "bankid_verified", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("app_user", "bankid_sub", "TEXT");
  // Přímé zaúčtování bankovního/pokladního pohybu bez dokladu (poplatky, úroky).
  await ensureColumn("bank_statement_line", "posting_id", "INTEGER");
  // Fakturační branding a hlavička vydaných faktur (logo/razítko/podpis jako
  // data URL — malé obrázky, žádné externí úložiště potřeba) + sídlo/kontakt.
  await ensureColumn("accounting_unit", "address", "TEXT");
  await ensureColumn("accounting_unit", "email", "TEXT");
  await ensureColumn("accounting_unit", "phone", "TEXT");
  await ensureColumn("accounting_unit", "logo_data_url", "TEXT");
  await ensureColumn("accounting_unit", "stamp_data_url", "TEXT");
  await ensureColumn("accounting_unit", "signature_data_url", "TEXT");
  // E-mail kontaktu — výchozí adresát při odeslání vydané faktury.
  await ensureColumn("contact", "email", "TEXT");
  // Bankovní e-mail parsing + Stripe platby — idempotence pohybů (viz
  // lib/bankMovements.js). Index musí vzniknout AŽ po ensureColumn, jinak
  // by na starších DB (bez sloupce) CREATE INDEX v schema.sql shodilo init.
  await ensureColumn("bank_statement_line", "external_ref", "TEXT");
  db.run(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_statement_line_external_ref
     ON bank_statement_line(accounting_unit_id, external_ref) WHERE external_ref IS NOT NULL`
  );
}

function persist() {
  if (!db || !dbFilePath) return;
  const data = db.export();
  fs.writeFileSync(dbFilePath, Buffer.from(data));
}

// Vrátí pole objektů (jako řádky) pro SELECT dotazy
async function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Vrátí první řádek nebo undefined
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

// INSERT / UPDATE / DELETE — vrací { lastInsertRowid, changes }
async function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  const lastRow = await get("SELECT last_insert_rowid() AS id");
  const changes = db.getRowsModified();
  return { lastInsertRowid: lastRow?.id, changes };
}

// Transakční obálka — sql.js podporuje reálné BEGIN/COMMIT/ROLLBACK v rámci
// jednou načtené databáze. Při chybě uvnitř fn() se vše vrátí zpět.
async function transaction(fn) {
  db.run("BEGIN");
  try {
    const result = await fn();
    db.run("COMMIT");
    persist();
    return result;
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

function getDb() {
  return db;
}

function getUserDataDir() {
  return userDataDirPath;
}

module.exports = { init, persist, all, get, run, transaction, getDb, getUserDataDir };
