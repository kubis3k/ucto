// =====================================================================
// core.js — byznys logika, která byla v PostgreSQL verzi v PL/pgSQL
// funkcích/triggerech (viz ../../../db/002_functions_triggers.sql).
// sql.js triggery umí jen jednoduché RAISE(ABORT) hlídky (viz schema.sql),
// složitější logika (číslování, storno, audit log) žije zde v JS a je
// volána z route handlerů uvnitř store.transaction(...).
// =====================================================================
const store = require("../db");

const DOC_PREFIX = {
  faktura_vydana: "FV",
  faktura_prijata: "FP",
  pokladni_prijem: "PP",
  pokladni_vydej: "PV",
  bankovni_pohyb: "BV",
  interni_doklad: "ID",
  nabidka: "NAB",
};

// Nepřerušená číselná řada dokladů (§ 11 ZoÚ): {TYP}-{ROK}-{POŘADÍ}
async function generateDocumentNumber(unitId, docType, year) {
  const existing = await store.get(
    `SELECT last_number FROM document_number_sequence WHERE accounting_unit_id = ? AND doc_type = ? AND fiscal_year = ?`,
    [unitId, docType, year]
  );
  const next = (existing?.last_number || 0) + 1;
  if (existing) {
    await store.run(
      `UPDATE document_number_sequence SET last_number = ? WHERE accounting_unit_id = ? AND doc_type = ? AND fiscal_year = ?`,
      [next, unitId, docType, year]
    );
  } else {
    await store.run(
      `INSERT INTO document_number_sequence (accounting_unit_id, doc_type, fiscal_year, last_number) VALUES (?,?,?,?)`,
      [unitId, docType, year, next]
    );
  }
  return `${DOC_PREFIX[docType]}-${year}-${String(next).padStart(4, "0")}`;
}

// Nepřerušená číselná řada účetních zápisů
async function nextPostingNumber(unitId) {
  const existing = await store.get(`SELECT last_number FROM posting_number_sequence WHERE accounting_unit_id = ?`, [unitId]);
  const next = (existing?.last_number || 0) + 1;
  if (existing) {
    await store.run(`UPDATE posting_number_sequence SET last_number = ? WHERE accounting_unit_id = ?`, [next, unitId]);
  } else {
    await store.run(`INSERT INTO posting_number_sequence (accounting_unit_id, last_number) VALUES (?,?)`, [unitId, next]);
  }
  return next;
}

async function writeAuditLog({ unitId, userId, action, table, entityId, before, after }) {
  await store.run(
    `INSERT INTO audit_log (accounting_unit_id, user_id, action, entity_table, entity_id, before_data, after_data)
     VALUES (?,?,?,?,?,?,?)`,
    [unitId || null, userId || null, action, table, entityId || null,
     before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

async function assertPeriodOpen(periodId) {
  const period = await store.get(`SELECT status FROM accounting_period WHERE id = ?`, [periodId]);
  if (!period) throw new Error("Účetní období neexistuje.");
  if (period.status === "uzavrene") throw new Error("Účetní období je uzavřené po inventarizaci — zápis není možný.");
}

// Stejná kontrola jako trg_document_month_lock/trg_posting_month_lock v
// schema.sql/schema-pg.sql (ty jsou nezbytný, neobejitelný backstop na úrovni
// DB) — tady jen kvůli hezčí, srozumitelné chybové hlášce dřív, než dotaz
// vůbec doletí k INSERTu a spadne na syrové SQLite/Postgres výjimce.
async function assertMonthOpen(unitId, dateStr) {
  if (!dateStr) return;
  const [y, m] = dateStr.split("-");
  const locked = await store.get(
    "SELECT id FROM period_month_lock WHERE accounting_unit_id = ? AND fiscal_year = ? AND month = ? AND unlocked_at IS NULL",
    [unitId, Number(y), Number(m)]
  );
  if (locked) throw new Error(`Měsíc ${Number(m)}/${y} je uzamčen měsíční uzávěrkou — zápis s tímto datem není možný.`);
}

// Jediný povolený způsob "zrušení" zaúčtovaného zápisu — nový, protichůdný
// zápis (MD <-> D prohozeno), který odkazuje na původní přes storno_of_posting_id.
//
// FIX (2026-07-21, revize dokumentace): `unitId` je POVINNÝ a dohledání zápisu
// je jím scopované. Dřív se hledalo jen `WHERE id = ?`, což u postings.js
// POST /:id/storno znamenalo IDOR — přihlášený uživatel jedné firmy mohl
// vytvořit stornovací zápis v účetnictví jiné firmy uhádnutím číselného ID
// (globální middleware v index.js přepisuje jen query/body, ne path parametr).
// Parametr je záměrně povinný a chybí-li, funkce hlasitě spadne — tichý
// unscoped dotaz by byl horší než výjimka.
async function stornoPosting(postingId, reason, userId, unitId) {
  if (!unitId) throw new Error("stornoPosting: chybí unitId (scope na účetní jednotku je povinný).");
  const original = await store.get(
    `SELECT * FROM posting WHERE id = ? AND accounting_unit_id = ?`,
    [postingId, unitId]
  );
  if (!original) throw new Error("Účetní zápis nenalezen.");

  const postingNumber = await nextPostingNumber(original.accounting_unit_id);
  await store.run(
    `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, storno_of_posting_id, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [original.accounting_unit_id, original.period_id, postingNumber, null,
     new Date().toISOString().slice(0, 10), "STORNO: " + reason, postingId, userId]
  );
  const newPostingId = (await store.get("SELECT last_insert_rowid() AS id")).id;

  const lines = await store.all(`SELECT * FROM posting_line WHERE posting_id = ?`, [postingId]);
  for (const l of lines) {
    await store.run(
      `INSERT INTO posting_line (posting_id, account_id, side, amount, project_id) VALUES (?,?,?,?,?)`,
      [newPostingId, l.account_id, l.side === "MD" ? "D" : "MD", l.amount, l.project_id]
    );
  }
  await writeAuditLog({ unitId: original.accounting_unit_id, userId, action: "STORNO", table: "posting", entityId: postingId, after: { storno_posting_id: newPostingId, reason } });
  return newPostingId;
}

module.exports = { generateDocumentNumber, nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen, stornoPosting };
