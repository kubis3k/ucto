// =====================================================================
// cron.js — endpoint pro Vercel Cron (web nasazení). MUSÍ být mountovaný
// PŘED requireAuth middlewarem (index.js) — cron nemá uživatelskou session,
// autentizuje se vlastním sdíleným tokenem CRON_SECRET. Desktop verze
// (Electron) tento endpoint nevolá — má vlastní startup hook v main.js.
// =====================================================================
const express = require("express");
const store = require("../db");
const { generateDueRecurringInvoices } = require("../lib/recurring");
const router = express.Router();

router.get("/recurring", async (req, res) => {
  const auth = req.headers.authorization || "";
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Neautorizováno." });
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const result = await generateDueRecurringInvoices(today);
    store.persist();
    res.json({ created: result.created.length, skipped: result.skipped.length, details: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
