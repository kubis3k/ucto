const express = require("express");
const crypto = require("crypto");
const store = require("../db");
const { nextPostingNumber, writeAuditLog } = require("../lib/core");
const { createBankStatementLine, amountsMatch } = require("../lib/bankMovements");
const router = express.Router();

// Vestavěný slovník klíčových slov — výchozí návrh kategorie, dokud si
// systém nevytvoří vlastní naučená pravidla z reálného zaúčtování (viz níže).
const KEYWORD_HINTS = [
  { pattern: /popla|vedení účtu/i, account_number: "568" },
  { pattern: /úrok/i, account_number: "662" },
  { pattern: /nájem|pronáj/i, account_number: "518" },
  { pattern: /honorář|dj\b|zvukař/i, account_number: "518" },
  { pattern: /\bosa\b/i, account_number: "531" },
];
function normalizeParty(name) { return (name || "").trim().toLowerCase().slice(0, 60); }

// GET /api/bank?unit=1 — bankovní/pokladní řádky s příznakem spárování
router.get("/", async (req, res) => {
  try {
    res.json(await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? ORDER BY statement_date DESC",
      [req.query.unit]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/import — ruční zadání / import řádků výpisu (kap. 5.4 brief — CSV v1. fázi mimo rozsah,
// zde zadání strukturovaných řádků, které frontend může naplnit i z nahraného CSV)
router.post("/import", async (req, res) => {
  const { accounting_unit_id, bank_account, lines } = req.body;
  if (!Array.isArray(lines)) return res.status(400).json({ error: "Očekává se pole 'lines'." });
  try {
    const inserted = await store.transaction(async () => {
      const rows = [];
      for (const l of lines) {
        rows.push(await createBankStatementLine({
          unitId: accounting_unit_id,
          bankAccount: bank_account,
          date: l.statement_date,
          amount: l.amount,
          counterpartyName: l.counterparty_name,
          variableSymbol: l.variable_symbol,
          externalRef: l.external_ref,
        }));
      }
      return rows;
    });
    res.status(201).json(inserted);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/bank/:id/match — spárování řádku výpisu s dokladem (faktura/pokladní doklad).
// FIX (critic 2026-07-09): scope na accounting_unit_id (IDOR) + odmítnutí
// neshody částky (viz lib/bankMovements.amountsMatch — částečná úhrada by
// spárovala celou fakturu a ta by zmizela z pohledávky/závazky reportu).
router.post("/:id/match", async (req, res) => {
  const { document_id } = req.body;
  const unitId = req.user.accountingUnitId;
  try {
    const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, unitId]);
    if (!line) return res.status(404).json({ error: "Řádek výpisu nenalezen" });
    const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [document_id, unitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    if (!amountsMatch(line.amount, doc.total_amount)) {
      return res.status(400).json({
        error: `Částka pohybu (${Math.abs(line.amount)}) neodpovídá částce dokladu (${doc.total_amount}) — nelze spárovat celou fakturu s částečnou úhradou. Pro částečné úhrady použijte zaúčtování bez dokladu (quick-post).`,
      });
    }
    await store.run("UPDATE bank_statement_line SET matched_document_id = ? WHERE id = ? AND accounting_unit_id = ?", [document_id, req.params.id, unitId]);
    store.persist();
    res.json(await store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/bank/suggest-matches?unit=1 — automatický návrh párování podle VS a částky
router.get("/suggest-matches", async (req, res) => {
  try {
    const unmatched = await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND matched_document_id IS NULL",
      [req.query.unit]
    );
    const suggestions = [];
    for (const line of unmatched) {
      const candidate = await store.get(
        `SELECT * FROM document
         WHERE accounting_unit_id = ? AND status <> 'stornovany'
           AND (variable_symbol = ? OR ABS(total_amount - ABS(?)) < 0.01)
         LIMIT 1`,
        [req.query.unit, line.variable_symbol, line.amount]
      );
      if (candidate) suggestions.push({ bank_line: line, suggested_document: candidate });
    }
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bank/suggest-categories?unit=1 — pro pohyby bez dokladu (poplatky,
// úroky...) navrhne účet: nejdřív podle naučeného pravidla (bank_category_rule),
// jinak podle vestavěného slovníku klíčových slov. Navrhuje jen účty, které
// v účtovém rozvrhu této jednotky skutečně existují.
router.get("/suggest-categories", async (req, res) => {
  try {
    const unit = req.query.unit;
    const unmatched = await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND matched_document_id IS NULL AND posting_id IS NULL",
      [unit]
    );
    const accounts = await store.all("SELECT id, account_number FROM chart_of_accounts WHERE accounting_unit_id = ?", [unit]);
    const byNumber = Object.fromEntries(accounts.map((a) => [a.account_number, a]));
    const rules = await store.all("SELECT * FROM bank_category_rule WHERE accounting_unit_id = ?", [unit]);
    const byParty = Object.fromEntries(rules.map((r) => [r.match_text, r]));

    const suggestions = [];
    for (const line of unmatched) {
      const party = normalizeParty(line.counterparty_name);
      let account = null, source = null;
      const rule = party && byParty[party];
      if (rule) { account = accounts.find((a) => a.id === rule.account_id); source = "naučené pravidlo"; }
      if (!account) {
        const hint = KEYWORD_HINTS.find((h) => h.pattern.test(line.counterparty_name || ""));
        if (hint && byNumber[hint.account_number]) { account = byNumber[hint.account_number]; source = "klíčové slovo"; }
      }
      if (account) suggestions.push({ bank_line_id: line.id, account_id: account.id, account_number: account.account_number, source });
    }
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/:id/quick-post — přímé zaúčtování pohybu bez dokladu (bankovní
// poplatek, úrok, honorář placený rovnou z účtu...). Vytvoří dvouřádkový zápis
// proti bankovnímu/pokladnímu účtu a naučí se protistranu -> účet pro příště.
router.post("/:id/quick-post", async (req, res) => {
  const { account_id, created_by, description } = req.body;
  try {
    const posting = await store.transaction(async () => {
      const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]);
      if (!line) throw new Error("Řádek výpisu nenalezen.");
      if (line.matched_document_id || line.posting_id) throw new Error("Pohyb je již zaúčtovaný.");

      const bankAccount = await store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
        [line.accounting_unit_id, line.bank_account]
      );
      if (!bankAccount) throw new Error(`Účet ${line.bank_account} nenalezen v účtovém rozvrhu.`);
      const period = await store.get(
        "SELECT id FROM accounting_period WHERE accounting_unit_id = ? AND status = 'otevrene' ORDER BY start_date DESC LIMIT 1",
        [line.accounting_unit_id]
      );
      if (!period) throw new Error("Není otevřené účetní období.");

      const amt = Math.abs(line.amount);
      const bankSide = line.amount >= 0 ? "MD" : "D";
      const categorySide = line.amount >= 0 ? "D" : "MD";

      const postingNumber = await nextPostingNumber(line.accounting_unit_id);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [line.accounting_unit_id, period.id, postingNumber, null, line.statement_date,
         description || `Bankovní pohyb — ${line.counterparty_name || line.bank_account}`, created_by]
      );
      const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, bankAccount.id, bankSide, amt]);
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, account_id, categorySide, amt]);
      await store.run("UPDATE bank_statement_line SET posting_id = ? WHERE id = ?", [postingId, line.id]);

      const party = normalizeParty(line.counterparty_name);
      if (party) {
        // Časové razítko se předává jako parametr (ne SQL funkcí) — tahle
        // routa běží beze změny nad SQLite i Postgres a datetime('now')/now()
        // se v obou dialektech píše jinak.
        await store.run(
          `INSERT INTO bank_category_rule (accounting_unit_id, match_text, account_id, hits, updated_at)
           VALUES (?,?,?,1,?)
           ON CONFLICT (accounting_unit_id, match_text) DO UPDATE SET account_id = excluded.account_id, hits = bank_category_rule.hits + 1, updated_at = excluded.updated_at`,
          [line.accounting_unit_id, party, account_id, new Date().toISOString()]
        );
      }
      await writeAuditLog({ unitId: line.accounting_unit_id, userId: created_by, action: "POST", table: "bank_statement_line", entityId: line.id, after: { posting_id: postingId, account_id } });
      return store.get("SELECT * FROM posting WHERE id = ?", [postingId]);
    });
    store.persist();
    res.status(201).json(posting);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/bank/inbound-mailbox?unit=1 — vrátí existující párovací token/adresu
// pro danou firmu (bank_inbound_mailbox), pokud už byl vygenerován.
router.get("/inbound-mailbox", async (req, res) => {
  try {
    const unitId = req.query.unit || req.user.accountingUnitId;
    const mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    if (!mailbox) return res.json(null);
    res.json({ ...mailbox, address: buildInboundAddress(mailbox.token) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/inbound-mailbox — vygeneruje párovací token pro firmu (Postmark
// MailboxHash routing, ekvivalent Fakturoidí adresy bank.X.Y@...). Idempotentní —
// pokud token pro firmu už existuje, vrátí ten stávající (nepřegeneruje).
router.post("/inbound-mailbox", async (req, res) => {
  const { bank_account } = req.body;
  const unitId = req.user.accountingUnitId;
  if (!bank_account) return res.status(400).json({ error: "Chybí bank_account." });
  try {
    let mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    if (!mailbox) {
      const token = crypto.randomBytes(8).toString("hex");
      await store.run(
        "INSERT INTO bank_inbound_mailbox (accounting_unit_id, token, bank_account) VALUES (?,?,?)",
        [unitId, token, bank_account]
      );
      store.persist();
      mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    }
    res.status(201).json({ ...mailbox, address: buildInboundAddress(mailbox.token) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Sestaví párovací e-mailovou adresu z POSTMARK_INBOUND_ADDRESS (např.
// "abc123@inbound.postmarkapp.com") vložením +token před "@" (Postmark
// MailboxHash routing). Bez env proměnné vrací null — frontend zobrazí
// informaci, že adresa čeká na doplnění nastavení serveru.
function buildInboundAddress(token) {
  const base = process.env.POSTMARK_INBOUND_ADDRESS;
  if (!base) return null;
  const at = base.indexOf("@");
  if (at === -1) return `${base}+${token}`;
  return `${base.slice(0, at)}+${token}${base.slice(at)}`;
}

// GET /api/bank/cashflow?unit=1 — zůstatky po jednotlivých účtech (banka/pokladna)
// a přehled příjmů/výdajů za posledních 30 a 90 dní.
router.get("/cashflow", async (req, res) => {
  try {
    const unit = req.query.unit;
    const lines = await store.all("SELECT bank_account, amount, statement_date FROM bank_statement_line WHERE accounting_unit_id = ?", [unit]);
    const balances = {};
    for (const l of lines) balances[l.bank_account] = (balances[l.bank_account] || 0) + Number(l.amount);

    const cutoff = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const sumSince = (days, positive) => lines
      .filter((l) => l.statement_date >= cutoff(days) && (positive ? l.amount > 0 : l.amount < 0))
      .reduce((s, l) => s + Math.abs(Number(l.amount)), 0);

    res.json({
      by_account: Object.entries(balances).map(([bank_account, balance]) => ({ bank_account, balance })),
      last30: { income: sumSince(30, true), expense: sumSince(30, false) },
      last90: { income: sumSince(90, true), expense: sumSince(90, false) },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
