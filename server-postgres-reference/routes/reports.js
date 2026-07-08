const express = require("express");
const { pool } = require("../db");
const router = express.Router();

// GET /api/reports/hlavni-kniha?unit=1&asOf=2026-12-31
router.get("/hlavni-kniha", async (req, res) => {
  const { unit, asOf } = req.query;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM fn_hlavni_kniha($1, COALESCE($2, CURRENT_DATE))", [unit, asOf || null]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/rozvaha?unit=1&asOf=2026-12-31
router.get("/rozvaha", async (req, res) => {
  const { unit, asOf } = req.query;
  try {
    const data = await pool.query(
      "SELECT * FROM fn_rozvaha($1, COALESCE($2, CURRENT_DATE))", [unit, asOf || null]
    );
    const kontrola = await pool.query(
      "SELECT * FROM fn_rozvaha_kontrola($1, COALESCE($2, CURRENT_DATE))", [unit, asOf || null]
    );
    res.json({ polozky: data.rows, kontrola: kontrola.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/vysledovka?unit=1&period=1
router.get("/vysledovka", async (req, res) => {
  const { unit, period } = req.query;
  try {
    const data = await pool.query("SELECT * FROM fn_vysledovka($1, $2)", [unit, period]);
    const vysledek = await pool.query("SELECT fn_vysledek_hospodareni($1, $2) AS vysledek", [unit, period]);
    res.json({ polozky: data.rows, vysledek_hospodareni: vysledek.rows[0].vysledek });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/obrat-dph?unit=1  — proaktivní hlídání limitu 2 mil. Kč
router.get("/obrat-dph", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM v_obrat_12m WHERE accounting_unit_id = $1", [req.query.unit]);
    res.json(rows[0] || { accounting_unit_id: Number(req.query.unit), obrat_12m: 0, blizi_se_limitu_dph: false, zbyva_do_limitu: 2000000 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/pohledavky-zavazky?unit=1
router.get("/pohledavky-zavazky", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.* FROM v_kniha_pohledavky_zavazky v
       JOIN document d ON d.id = v.document_id WHERE d.accounting_unit_id = $1`,
      [req.query.unit]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
