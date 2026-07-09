const express = require("express");
const store = require("../db");
const reports = require("../lib/reports");
const router = express.Router();

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(";"), ...rows.map((r) => headers.map((h) => escape(r[h])).join(";"))].join("\n");
}

function sendCsv(res, filename, rows) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + toCsv(rows)); // BOM pro správné zobrazení diakritiky v Excelu
}

// GET /api/export/doklady?unit=1 — export pro daňového poradce/auditora (kap. 5.10 brief)
router.get("/doklady", async (req, res) => {
  const rows = await store.all("SELECT * FROM document WHERE accounting_unit_id = ? ORDER BY issue_date", [req.query.unit]);
  sendCsv(res, "doklady.csv", rows);
});

router.get("/hlavni-kniha", async (req, res) => {
  const rows = await reports.hlavniKniha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
  sendCsv(res, "hlavni-kniha.csv", rows);
});

router.get("/ucetni-denik", async (req, res) => {
  const rows = await store.all(
    `SELECT p.posting_number, p.posting_date, p.description, coa.account_number, coa.name AS account_name, pl.side, pl.amount
     FROM posting p JOIN posting_line pl ON pl.posting_id = p.id JOIN chart_of_accounts coa ON coa.id = pl.account_id
     WHERE p.accounting_unit_id = ? ORDER BY p.posting_number, pl.id`,
    [req.query.unit]
  );
  sendCsv(res, "ucetni-denik.csv", rows);
});

router.get("/rozvaha", async (req, res) => {
  const { polozky } = await reports.rozvaha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
  sendCsv(res, "rozvaha.csv", polozky);
});

router.get("/vysledovka", async (req, res) => {
  const { polozky } = await reports.vysledovka(req.query.unit, req.query.period);
  sendCsv(res, "vysledovka.csv", polozky);
});

router.get("/audit-log", async (req, res) => {
  const rows = await store.all("SELECT * FROM audit_log WHERE accounting_unit_id = ? ORDER BY occurred_at", [req.query.unit]);
  sendCsv(res, "audit-log.csv", rows);
});

module.exports = router;
