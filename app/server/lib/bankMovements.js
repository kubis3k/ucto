// =====================================================================
// bankMovements.js — jediné místo, které vkládá řádky bankovního výpisu
// (bank_statement_line). Používá ho routes/bank.js (POST /import, ruční
// zadání), routes/inbound-email.js (e-mailový parsing od banky) a
// routes/stripe.js (webhook checkout.session.completed) — ŽÁDNÁ z těchto
// cest nesmí duplikovat INSERT logiku (viz flow-state.md INVARIANTY).
// =====================================================================
const store = require("../db");

// Vloží nový řádek bankovního výpisu. Idempotence přes (accounting_unit_id,
// external_ref) — pokud řádek se stejným external_ref už existuje (e-mail
// doručený 2x od Postmarku, webhook Stripe zopakovaný), vrátí existující
// řádek beze vkládání duplicity. externalRef je volitelný (ruční zadání ho
// nepoužívá, tam se duplicita neřeší).
async function createBankStatementLine({ unitId, bankAccount, date, amount, counterpartyName, variableSymbol, externalRef }) {
  if (externalRef) {
    const existing = await store.get(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND external_ref = ?",
      [unitId, externalRef]
    );
    if (existing) return existing;
  }
  await store.run(
    `INSERT INTO bank_statement_line (accounting_unit_id, bank_account, statement_date, amount, counterparty_name, variable_symbol, external_ref)
     VALUES (?,?,?,?,?,?,?)`,
    [unitId, bankAccount, date, amount, counterpartyName || null, variableSymbol || null, externalRef || null]
  );
  return store.get("SELECT * FROM bank_statement_line WHERE id = last_insert_rowid()");
}

// FIX P1 (critic 2026-07-09, agent-memory/critic/document_storno_ghost_posting.md):
// match je povolený JEN když se částka pohybu rovná částce dokladu (tolerance
// 0.01) — jinak by částečná úhrada spárovala celou fakturu a ta by zmizela
// z knihy pohledávek/závazků (reports.js), ačkoliv dluží zbytek. Částečné
// úhrady se řeší přes existující quick-post (bank.js POST /:id/quick-post),
// to se touto opravou NEMĚNÍ.
function amountsMatch(lineAmount, documentTotal) {
  if (documentTotal === null || documentTotal === undefined) return false;
  return Math.abs(Math.abs(Number(lineAmount)) - Number(documentTotal)) < 0.01;
}

// Stejná vyhledávací logika jako GET /api/bank/suggest-matches (VS nebo
// částka), ale skutečně ZAPÍŠE matched_document_id — a jen když amountsMatch
// souhlasí. Vrací aktualizovaný řádek, nebo null (nic k spárování / neshoda
// částky). Volitelné pro ruční zápis, POVINNÉ pro e-mail/Stripe automatizaci
// (nikdo tam neklikne na "Navrhnout párování").
async function autoMatchLine(lineId, unitId) {
  const line = await store.get(
    "SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?",
    [lineId, unitId]
  );
  if (!line || line.matched_document_id) return null;

  const candidate = await store.get(
    `SELECT * FROM document
     WHERE accounting_unit_id = ? AND status <> 'stornovany'
       AND (variable_symbol = ? OR ABS(total_amount - ABS(?)) < 0.01)
     LIMIT 1`,
    [unitId, line.variable_symbol, line.amount]
  );
  if (!candidate || !amountsMatch(line.amount, candidate.total_amount)) return null;

  await store.run(
    "UPDATE bank_statement_line SET matched_document_id = ? WHERE id = ? AND accounting_unit_id = ?",
    [candidate.id, lineId, unitId]
  );
  return store.get("SELECT * FROM bank_statement_line WHERE id = ?", [lineId]);
}

module.exports = { createBankStatementLine, autoMatchLine, amountsMatch };
