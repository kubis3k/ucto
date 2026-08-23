// =====================================================================
// bankMovements.js — jediné místo, které vkládá řádky bankovního výpisu
// (bank_statement_line). Používá ho routes/bank.js (POST /import, ruční
// zadání), routes/inbound-email.js (e-mailový parsing od banky) a
// routes/stripe.js (webhook checkout.session.completed) — ŽÁDNÁ z těchto
// cest nesmí duplikovat INSERT logiku (viz flow-state.md INVARIANTY).
// =====================================================================
const store = require("../db");
const SHAREHOLDER = /(?:štěpán\s+lísa|stepan\s+lisa|jakub\s+lučan|jakub\s+lucan|lučan\s+jakub|lucan\s+jakub|jan\s+leština|jan\s+lestina|leština\s+jan|lestina\s+jan)/i;

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
    if (existing) {
      // Bankovní ID je autoritativní identita, ne důvod ponechat hodnoty
      // chybně naparsované starší verzí. Vazby na doklad/posting zachováme.
      await store.run(
        `UPDATE bank_statement_line SET bank_account=?,statement_date=?,amount=?,
          counterparty_name=?,variable_symbol=?,superseded_by_bank_line_id=NULL WHERE id=?`,
        [bankAccount, date, amount, counterpartyName || null, variableSymbol || null, existing.id]
      );
      if (Number(amount) > 0 && SHAREHOLDER.test(counterpartyName || "")) {
        await store.run("UPDATE bank_statement_line SET matched_document_id=NULL WHERE id=?", [existing.id]);
      }
      // Opakovaný import může doplnit obchodníka/zprávu, kterou starší
      // parser zahodil. Takový řádek musí jít znovu do klasifikace.
      await store.run("DELETE FROM bank_clean_pending WHERE bank_line_id = ?", [existing.id]);
      return store.get("SELECT * FROM bank_statement_line WHERE id = ?", [existing.id]);
    }
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
  // Vklad/zápůjčka společníka má přednost před shodou částky či VS s
  // fakturou. Jde o MD 221 / D 365, nikoli úhradu dodavatelského závazku.
  if (Number(line.amount) > 0 && SHAREHOLDER.test(line.counterparty_name || "")) return null;

  const candidates = await store.all(
    `SELECT * FROM document
     WHERE accounting_unit_id = ? AND status <> 'stornovany'
       AND ((COALESCE(CAST(? AS TEXT),'') <> '' AND variable_symbol = CAST(? AS TEXT))
         OR ABS(total_amount - ABS(CAST(? AS DOUBLE PRECISION))) < 0.01)
       AND ((doc_type='faktura_vydana' AND CAST(? AS DOUBLE PRECISION) > 0)
         OR (doc_type='faktura_prijata' AND CAST(? AS DOUBLE PRECISION) < 0))
     ORDER BY CASE WHEN variable_symbol = CAST(? AS TEXT)
       AND COALESCE(CAST(? AS TEXT),'') <> '' THEN 0 ELSE 1 END, id`,
    [unitId, line.variable_symbol, line.variable_symbol, line.amount,
      line.amount, line.amount, line.variable_symbol, line.variable_symbol]
  );
  const exactVs = candidates.filter((d) => line.variable_symbol && d.variable_symbol === line.variable_symbol);
  const viable = exactVs.length ? exactVs : candidates.filter((d) => amountsMatch(line.amount, d.total_amount));
  // Částka sama je bezpečná jen při jediné shodě; při více kandidátech
  // musí rozhodnout uživatel. Variabilní symbol má přednost.
  const candidate = viable.length === 1 ? viable[0] : null;
  if (!candidate || !amountsMatch(line.amount, candidate.total_amount)) return null;

  await store.run(
    "UPDATE bank_statement_line SET matched_document_id = ? WHERE id = ? AND accounting_unit_id = ?",
    [candidate.id, lineId, unitId]
  );
  return store.get("SELECT * FROM bank_statement_line WHERE id = ?", [lineId]);
}

module.exports = { createBankStatementLine, autoMatchLine, amountsMatch };
