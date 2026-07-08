const express = require("express");
const { pool } = require("../db");
const router = express.Router();

// GET /api/accounts?unit=1
router.get("/accounts", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM chart_of_accounts WHERE accounting_unit_id = $1 ORDER BY account_number",
      [req.query.unit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/periods?unit=1
router.get("/periods", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM accounting_period WHERE accounting_unit_id = $1 ORDER BY fiscal_year",
      [req.query.unit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/periods/:id/close — roční uzávěrka. Po zavolání systém
// odmítne jakýkoli další zápis s datem v tomto období (§ 29-30 ZoÚ).
router.post("/periods/:id/close", async (req, res) => {
  const { closed_by } = req.body;
  try {
    await pool.query("SELECT close_accounting_period($1, $2)", [req.params.id, closed_by]);
    const { rows } = await pool.query("SELECT * FROM accounting_period WHERE id = $1", [req.params.id]);
    res.json(rows[0]);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
