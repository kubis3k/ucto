const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/bank?unit=1 — bankovní/pokladní řádky s příznakem spárování
router.get("/", (req, res) => {
  try {
    res.json(store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? ORDER BY statement_date DESC",
      [req.query.unit]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/import — ruční zadání / import řádků výpisu (kap. 5.4 brief — CSV v1. fázi mimo rozsah,
// zde zadání strukturovaných řádků, které frontend může naplnit i z nahraného CSV)
router.post("/import", (req, res) => {
  const { accounting_unit_id, bank_account, lines } = req.body;
  if (!Array.isArray(lines)) return res.status(400).json({ error: "Očekává se pole 'lines'." });
  try {
    const inserted = store.transaction(() =>
      lines.map((l) => {
        store.run(
          `INSERT INTO bank_statement_line (accounting_unit_id, bank_account, statement_date, amount, counterparty_name, variable_symbol)
           VALUES (?,?,?,?,?,?)`,
          [accounting_unit_id, bank_account, l.statement_date, l.amount, l.counterparty_name || null, l.variable_symbol || null]
        );
        return store.get("SELECT * FROM bank_statement_line WHERE id = last_insert_rowid()");
      })
    );
    res.status(201).json(inserted);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/bank/:id/match — spárování řádku výpisu s dokladem (faktura/pokladní doklad)
router.post("/:id/match", (req, res) => {
  const { document_id } = req.body;
  try {
    const line = store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]);
    if (!line) return res.status(404).json({ error: "Řádek výpisu nenalezen" });
    store.run("UPDATE bank_statement_line SET matched_document_id = ? WHERE id = ?", [document_id, req.params.id]);
    store.persist();
    res.json(store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/bank/suggest-matches?unit=1 — automatický návrh párování podle VS a částky
router.get("/suggest-matches", (req, res) => {
  try {
    const unmatched = store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND matched_document_id IS NULL",
      [req.query.unit]
    );
    const suggestions = unmatched.map((line) => {
      const candidate = store.get(
        `SELECT * FROM document
         WHERE accounting_unit_id = ? AND status <> 'stornovany'
           AND (variable_symbol = ? OR ABS(total_amount - ABS(?)) < 0.01)
         LIMIT 1`,
        [req.query.unit, line.variable_symbol, line.amount]
      );
      return { bank_line: line, suggested_document: candidate || null };
    }).filter((s) => s.suggested_document);
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
