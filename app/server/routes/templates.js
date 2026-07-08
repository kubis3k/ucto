const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/templates?unit=1 — seznam předkontací s řádky
router.get("/", (req, res) => {
  try {
    const templates = store.all(
      "SELECT * FROM posting_template WHERE accounting_unit_id = ? AND active = 1 ORDER BY name",
      [req.query.unit]
    );
    const withLines = templates.map((t) => ({
      ...t,
      lines: store.all(
        `SELECT tl.*, coa.account_number, coa.name AS account_name
         FROM posting_template_line tl JOIN chart_of_accounts coa ON coa.id = tl.account_id
         WHERE template_id = ?`,
        [t.id]
      ),
    }));
    res.json(withLines);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/templates — vytvoření předkontace
router.post("/", (req, res) => {
  const { accounting_unit_id, name, doc_type, description, lines } = req.body;
  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: "Předkontace musí mít alespoň dva řádky (MD a D)." });
  }
  try {
    const result = store.transaction(() => {
      store.run(
        `INSERT INTO posting_template (accounting_unit_id, name, doc_type, description) VALUES (?,?,?,?)`,
        [accounting_unit_id, name, doc_type || null, description || null]
      );
      const id = store.get("SELECT last_insert_rowid() AS id").id;
      for (const l of lines) {
        store.run(
          `INSERT INTO posting_template_line (template_id, account_id, side, amount_source) VALUES (?,?,?,?)`,
          [id, l.account_id, l.side, l.amount_source || "celkem"]
        );
      }
      return id;
    });
    res.status(201).json({ id: result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/templates/:id — deaktivace předkontace (číselník, ne účetní záznam)
router.delete("/:id", (req, res) => {
  try {
    store.run("UPDATE posting_template SET active = 0 WHERE id = ?", [req.params.id]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
