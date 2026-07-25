#!/usr/bin/env node
// =====================================================================
// restore-backup.js — obnova databáze ze zálohy vytvořené lib/backup.js
// (endpoint GET /api/cron/backup).
//
// POUŽITÍ:
//   DATABASE_URL=postgres://...  node server/scripts/restore-backup.js <soubor.json> [--dry-run] [--force]
//
//   --dry-run  jen vypíše, co by se stalo (nic nezapisuje) — VÝCHOZÍ chování
//              je taky bezpečné: bez --force skript odmítne psát do neprázdné DB.
//   --force    povolí obnovu i do databáze, která už obsahuje data (SMAŽE je).
//
// ⚠ PROČ TENHLE SKRIPT DOČASNĚ VYPÍNÁ TRIGGERY
// Databáze záměrně brání přepisu účetních záznamů (§ 33a ZoÚ) a zápisu do
// uzavřených období (§ 29-30). Při obnově ze zálohy je ale potřeba vložit
// data přesně tak, jak byla — včetně zápisů v už uzavřených obdobích. Kdyby
// triggery běžely, obnova by na nich legitimně spadla.
//
// Nejde tedy o obcházení append-only pravidla, ale o jeho správné pořadí:
// pravidlo chrání BĚŽÍCÍ systém před změnou historie, ne obnovu havarované
// databáze ze vlastní zálohy. Vypnutí je omezené na jednu transakci, celý
// skript je out-of-band administrátorská operace a fakt obnovy se zapíše do
// audit logu. Aplikace sama tuhle cestu nikdy nepoužívá.
//
// Podporuje jen PostgreSQL (produkční cíl). Desktopová SQLite verze se
// obnovuje jednodušeji — zkopírováním souboru ucetnictvi.sqlite.
// =====================================================================
const fs = require("fs");
const path = require("path");

const APPEND_ONLY_TRIGGERS = [
  ["document", "trg_document_no_delete"],
  ["document", "trg_document_edit_guard"],
  ["document", "trg_document_period_lock"],
  ["document", "trg_document_month_lock"],
  ["posting", "trg_posting_no_update"],
  ["posting", "trg_posting_no_delete"],
  ["posting", "trg_posting_period_lock"],
  ["posting", "trg_posting_month_lock"],
  ["posting_line", "trg_posting_line_no_update"],
  ["posting_line", "trg_posting_line_no_delete"],
  ["audit_log", "trg_audit_log_no_update"],
  ["audit_log", "trg_audit_log_no_delete"],
];

// Pořadí vkládání respektuje cizí klíče. Tabulky neuvedené zde se vloží
// nakonec (abecedně) — nová tabulka tak obnovu nerozbije.
const INSERT_ORDER = [
  "accounting_unit", "app_user", "company_director", "company_invite",
  "chart_of_accounts", "accounting_period", "period_month_lock",
  "contact", "project", "price_list_item",
  "document", "document_line", "document_attachment",
  "posting", "posting_line", "posting_template", "posting_template_line",
  "vat_ledger_entry", "fixed_asset", "depreciation_entry",
  "bank_statement_line", "bank_inbound_mailbox", "invoice_payment", "bank_category_rule",
  "inventory_check", "inventory_check_line",
  "financial_statement_note", "financial_statement_note_version",
  "document_number_sequence", "posting_number_sequence", "audit_log", "exchange_rate",
  "offer", "offer_line", "recurring_invoice", "recurring_invoice_line",
];

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  if (!file) {
    console.error("Použití: node server/scripts/restore-backup.js <soubor.json> [--dry-run] [--force]");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("Chybí DATABASE_URL — skript obnovuje jen PostgreSQL (desktop SQLite se obnovuje kopií souboru).");
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(path.resolve(file), "utf-8"));
  if (snapshot.format !== "globaal-elevate-ucetnictvi-backup") {
    console.error(`Nerozpoznaný formát zálohy: ${snapshot.format}`);
    process.exit(1);
  }

  console.log(`Záloha z ${snapshot.created_at}, ${snapshot.table_count} tabulek.`);
  const tables = Object.keys(snapshot.data);
  const ordered = [
    ...INSERT_ORDER.filter((t) => tables.includes(t)),
    ...tables.filter((t) => !INSERT_ORDER.includes(t)).sort(),
  ];

  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const existing = await client.query("SELECT COUNT(*)::int AS n FROM accounting_unit");
    if (existing.rows[0].n > 0 && !force) {
      console.error(`\nCílová databáze už obsahuje ${existing.rows[0].n} účetních jednotek.`);
      console.error("Obnova by je smazala. Pokud to je záměr, spusťte znovu s --force.");
      process.exit(2);
    }

    if (dryRun) {
      console.log("\n--dry-run — nic se nezapisuje. Obnovilo by se:");
      for (const t of ordered) console.log(`  ${t}: ${snapshot.data[t].length} řádků`);
      return;
    }

    await client.query("BEGIN");
    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`).catch(() => {});
    }

    // Mazat v obráceném pořadí vkládání (kvůli cizím klíčům).
    for (const table of [...ordered].reverse()) {
      await client.query(`DELETE FROM ${table}`);
    }

    let inserted = 0;
    for (const table of ordered) {
      for (const row of snapshot.data[table]) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
        await client.query(
          `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders})`,
          cols.map((c) => row[c])
        );
        inserted += 1;
      }
      console.log(`  ${table}: ${snapshot.data[table].length} řádků`);
    }

    // Sekvence SERIAL sloupců je potřeba posunout za nejvyšší obnovené ID,
    // jinak by první nový záznam narazil na duplicitní primární klíč.
    for (const table of ordered) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))
         WHERE pg_get_serial_sequence('${table}', 'id') IS NOT NULL`
      ).catch(() => {});
    }

    for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
      await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`).catch(() => {});
    }

    // Fakt obnovy patří do audit logu — trigger je v tu chvíli už zapnutý,
    // takže tenhle zápis projde standardní cestou a nelze ho pak změnit.
    await client.query(
      `INSERT INTO audit_log (action, entity_table, entity_id, after_data)
       VALUES ('RESTORE', 'database', NULL, $1)`,
      [JSON.stringify({ from_backup: snapshot.created_at, tables: ordered.length, rows: inserted })]
    );

    await client.query("COMMIT");
    console.log(`\nHotovo — obnoveno ${inserted} řádků v ${ordered.length} tabulkách.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("\nObnova selhala, změny vráceny zpět:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
