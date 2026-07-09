const express = require("express");
const reports = require("../lib/reports");
const router = express.Router();

// GET /api/reports/hlavni-kniha?unit=1&asOf=2026-12-31
router.get("/hlavni-kniha", async (req, res) => {
  try {
    res.json(await reports.hlavniKniha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/rozvaha?unit=1&asOf=2026-12-31
router.get("/rozvaha", async (req, res) => {
  try {
    const { polozky, kontrola } = await reports.rozvaha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
    res.json({ polozky, kontrola });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/vysledovka?unit=1&period=1
router.get("/vysledovka", async (req, res) => {
  try {
    res.json(await reports.vysledovka(req.query.unit, req.query.period));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/obrat-dph?unit=1
router.get("/obrat-dph", async (req, res) => {
  try {
    res.json(await reports.obratDph(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/pohledavky-zavazky?unit=1
router.get("/pohledavky-zavazky", async (req, res) => {
  try {
    res.json(await reports.knihaPohledavkyZavazky(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
