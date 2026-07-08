const express = require("express");
const reports = require("../lib/reports");
const router = express.Router();

// GET /api/reports/hlavni-kniha?unit=1&asOf=2026-12-31
router.get("/hlavni-kniha", (req, res) => {
  try {
    res.json(reports.hlavniKniha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/rozvaha?unit=1&asOf=2026-12-31
router.get("/rozvaha", (req, res) => {
  try {
    const { polozky, kontrola } = reports.rozvaha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
    res.json({ polozky, kontrola });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/vysledovka?unit=1&period=1
router.get("/vysledovka", (req, res) => {
  try {
    res.json(reports.vysledovka(req.query.unit, req.query.period));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/obrat-dph?unit=1
router.get("/obrat-dph", (req, res) => {
  try {
    res.json(reports.obratDph(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/pohledavky-zavazky?unit=1
router.get("/pohledavky-zavazky", (req, res) => {
  try {
    res.json(reports.knihaPohledavkyZavazky(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
