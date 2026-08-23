const express = require("express");
const store = require("../db");
const reports = require("../lib/reports");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
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

async function sendXlsx(res, filename, title, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "BilanxFlow";
  const ws = wb.addWorksheet(title.slice(0, 31));
  const headers = rows.length ? Object.keys(rows[0]) : ["data"];
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.min(45, Math.max(14, h.length + 3)) }));
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF17324D" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(await wb.xlsx.writeBuffer());
}

function sendPdf(res, filename, title, rows) {
  const doc = new PDFDocument({ size: "A4", margin: 36, layout: "landscape" });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    res.send(Buffer.concat(chunks));
  });
  doc.fontSize(16).text(title).moveDown(0.7).fontSize(7);
  if (!rows.length) doc.text("Bez dat.");
  else {
    const headers = Object.keys(rows[0]);
    doc.font("Helvetica-Bold").text(headers.join(" | "));
    doc.font("Helvetica").moveDown(0.3);
    for (const row of rows) {
      if (doc.y > 540) doc.addPage();
      doc.text(headers.map((h) => row[h] == null ? "" : String(row[h])).join(" | "), { ellipsis: true, width: 760 });
    }
  }
  doc.end();
}

async function sendFormat(req, res, baseName, title, rows) {
  const format = String(req.query.format || "csv").toLowerCase();
  if (format === "xlsx") return sendXlsx(res, baseName, title, rows);
  if (format === "pdf") return sendPdf(res, baseName, title, rows);
  if (format !== "csv") return res.status(400).json({ error: "Formát musí být csv, xlsx nebo pdf." });
  return sendCsv(res, `${baseName}.csv`, rows);
}

// GET /api/export/doklady?unit=1 — export pro daňového poradce/auditora (kap. 5.10 brief)
router.get("/doklady", async (req, res) => {
  const rows = await store.all("SELECT * FROM document WHERE accounting_unit_id = ? ORDER BY issue_date", [req.query.unit]);
  sendCsv(res, "doklady.csv", rows);
});

router.get("/hlavni-kniha", async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const integrity = await reports.ledgerIntegrity(req.query.unit, asOf);
  if (!integrity.balanced) return res.status(409).json({ error: "Hlavní knihu nelze exportovat: aktivní účetní zápisy nejsou podvojně vyrovnané.", integrity });
  const rows = await reports.hlavniKniha(req.query.unit, asOf);
  await sendFormat(req, res, "hlavni-kniha", "Hlavní kniha", rows);
});

router.get("/ucetni-denik", async (req, res) => {
  const integrity = await reports.ledgerIntegrity(req.query.unit, new Date().toISOString().slice(0, 10));
  if (!integrity.balanced) return res.status(409).json({ error: "Účetní deník nelze exportovat: aktivní účetní zápisy nejsou podvojně vyrovnané.", integrity });
  const rows = await store.all(
    `SELECT p.posting_number, p.posting_date, p.description, coa.account_number, coa.name AS account_name, pl.side, pl.amount
     FROM posting p JOIN posting_line pl ON pl.posting_id = p.id JOIN chart_of_accounts coa ON coa.id = pl.account_id
     WHERE p.accounting_unit_id = ?
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
     ORDER BY p.posting_number, pl.id`,
    [req.query.unit]
  );
  await sendFormat(req, res, "ucetni-denik", "Účetní deník", rows);
});

router.get("/rozvaha", async (req, res) => {
  const { polozky } = await reports.rozvaha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
  await sendFormat(req, res, "rozvaha", "Rozvaha", polozky);
});

router.get("/vysledovka", async (req, res) => {
  const { polozky } = await reports.vysledovka(req.query.unit, req.query.period);
  await sendFormat(req, res, "vysledovka", "Výsledovka", polozky);
});

router.get("/audit-log", async (req, res) => {
  const rows = await store.all("SELECT * FROM audit_log WHERE accounting_unit_id = ? ORDER BY occurred_at", [req.query.unit]);
  sendCsv(res, "audit-log.csv", rows);
});

module.exports = router;
