// =====================================================================
// cron.js — endpoint pro Vercel Cron (web nasazení). MUSÍ být mountovaný
// PŘED requireAuth middlewarem (index.js) — cron nemá uživatelskou session,
// autentizuje se vlastním sdíleným tokenem CRON_SECRET. Desktop verze
// (Electron) tento endpoint nevolá — má vlastní startup hook v main.js.
// =====================================================================
const express = require("express");
const store = require("../db");
const { generateDueRecurringInvoices } = require("../lib/recurring");
const backup = require("../lib/backup");
const router = express.Router();

// Sdílená autentizace cronu — bez nastaveného CRON_SECRET vždy odmítni
// (žádný tichý bypass, stejný vzor jako u ostatních webhooků).
function cronAuthorized(req) {
  const auth = req.headers.authorization || "";
  return !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
}

router.get("/recurring", async (req, res) => {
  if (!cronAuthorized(req)) {
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

// GET /api/cron/backup — denní aplikační záloha celé databáze do objektového
// úložiště + smazání záloh po retenční lhůtě. Druhá vrstva vedle PITR na
// straně poskytovatele databáze (viz lib/backup.js a DOKUMENTACE.md 10.7).
router.get("/backup", async (req, res) => {
  if (!cronAuthorized(req)) {
    return res.status(401).json({ error: "Neautorizováno." });
  }
  try {
    const created = await backup.createBackup();
    // Prořezání nesmí shodit už vytvořenou zálohu — chybu jen ohlásíme.
    let pruned = null;
    let pruneError = null;
    try {
      pruned = await backup.pruneOldBackups();
    } catch (err) {
      pruneError = err.message;
    }
    res.json({ ok: true, backup: created, pruned, prune_error: pruneError });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
