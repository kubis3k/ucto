// =====================================================================
// statementPdf.js — kompletní účetní závěrka (rozvaha + výsledovka +
// příloha dle § 18 ZoÚ) do jednoho PDF, ke stažení pro sbírku listin.
// Vzor invoicePdf.js (pdfkit, IBM Plex Serif kvůli diakritice — bez
// vlastního TTF by pdfkit vestavěné fonty (WinAnsi) rozbily č/ř/ů/š/ž).
// =====================================================================
const path = require("path");
const PDFDocument = require("pdfkit");

const INK = "#1a2230", DIM = "#5a6472", FAINT = "#8a92a0", LINE = "#e2e6ec", BRAND = "#3f6ff0";
const FONTS_DIR = path.join(__dirname, "..", "assets", "fonts");
const FONT_REGULAR = path.join(FONTS_DIR, "IBMPlexSerif-Regular.ttf");
const FONT_BOLD = path.join(FONTS_DIR, "IBMPlexSerif-Bold.ttf");

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
}
function fmtMoney(n) {
  return Number(n || 0).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Kč";
}

function pageHeader(pdf, title, unit) {
  pdf.font("Bold").fontSize(16).fillColor(INK).text(title, 50, 50);
  pdf.font("Body").fontSize(9).fillColor(DIM).text(unit.name || "—", 50, 72);
  pdf.moveTo(50, 92).lineTo(545, 92).strokeColor(LINE).stroke();
}

function tableRows(pdf, startY, rows, cols) {
  let y = startY;
  rows.forEach((row) => {
    if (y > 760) { pdf.addPage(); y = 50; }
    let x = 50;
    cols.forEach((c) => {
      pdf.font(c.bold ? "Bold" : "Body").fontSize(9).fillColor(INK)
        .text(String(row[c.key] ?? ""), x, y, { width: c.width, align: c.align || "left" });
      x += c.width;
    });
    y += 16;
  });
  return y;
}

// unit = accounting_unit, period = accounting_period, rozvaha/vysledovka =
// výstup lib/reports.js, note = financial_statement_note row|null,
// auto = prilohaAutoData() výstup.
async function buildStatementPdf({ unit, period, rozvaha, vysledovka, note, auto }) {
  const chunks = [];
  const pdf = new PDFDocument({ size: "A4", margin: 50 });
  pdf.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  pdf.registerFont("Body", FONT_REGULAR);
  pdf.registerFont("Bold", FONT_BOLD);
  pdf.font("Body");

  // --- Strana 1: titulka ---
  pdf.font("Bold").fontSize(24).fillColor(INK).text(`Účetní závěrka ${period.fiscal_year}`, 50, 220, { width: 495, align: "center" });
  pdf.font("Body").fontSize(13).fillColor(DIM).text(unit.name || "—", 50, 260, { width: 495, align: "center" });
  pdf.fontSize(10).fillColor(FAINT).text(`IČO: ${unit.ico || "—"}${unit.dic ? "   DIČ: " + unit.dic : ""}`, 50, 282, { width: 495, align: "center" });
  pdf.fontSize(10).fillColor(FAINT).text(`Účetní období: ${fmtDate(period.start_date)} – ${fmtDate(period.end_date)}`, 50, 300, { width: 495, align: "center" });
  pdf.fontSize(9).fillColor(FAINT).text("Rozvaha, výsledovka a příloha k účetní závěrce (§ 18 zákona č. 563/1991 Sb., o účetnictví).", 50, 700, { width: 495, align: "center" });

  // --- Strana 2: Rozvaha ---
  pdf.addPage();
  pageHeader(pdf, "Rozvaha (zjednodušený rozsah dle vyhl. č. 500/2002 Sb.)", unit);
  let y = 108;
  pdf.font("Bold").fontSize(9).fillColor(FAINT);
  pdf.text("STRANA", 50, y, { width: 60 });
  pdf.text("ŘÁDEK", 110, y, { width: 60 });
  pdf.text("POLOŽKA", 170, y, { width: 275 });
  pdf.text("ČÁSTKA", 445, y, { width: 100, align: "right" });
  y += 16;
  pdf.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
  y += 6;
  y = tableRows(pdf, y, rozvaha.polozky.map((p) => ({
    strana: p.strana, code: p.code, label: p.label, castka: fmtMoney(p.castka),
  })), [
    { key: "strana", width: 60 },
    { key: "code", width: 60 },
    { key: "label", width: 275 },
    { key: "castka", width: 100, align: "right" },
  ]);
  y += 8;
  pdf.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
  y += 10;
  pdf.font("Bold").fontSize(10).fillColor(rozvaha.kontrola && Math.abs(rozvaha.kontrola.rozdil) < 0.01 ? "#1a7a3c" : "#b3261e")
    .text(`AKTIVA CELKEM: ${fmtMoney(rozvaha.kontrola.aktiva_celkem)}   |   PASIVA CELKEM: ${fmtMoney(rozvaha.kontrola.pasiva_celkem)}`, 50, y, { width: 495 });
  y = pdf.y + 6;
  pdf.font("Body").fontSize(8).fillColor(FAINT).text("Mapování účtů na řádky výkazu je návrh dle vyhlášky — před oficiálním podáním nechte potvrdit účetní firmou.", 50, y, { width: 495 });

  // --- Strana 3: Výsledovka ---
  pdf.addPage();
  pageHeader(pdf, "Výsledovka (zjednodušený rozsah dle vyhl. č. 500/2002 Sb.)", unit);
  y = 108;
  pdf.font("Bold").fontSize(9).fillColor(FAINT);
  pdf.text("ŘÁDEK", 50, y, { width: 60 });
  pdf.text("POLOŽKA", 110, y, { width: 335 });
  pdf.text("ČÁSTKA", 445, y, { width: 100, align: "right" });
  y += 16;
  pdf.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
  y += 6;
  if (vysledovka) {
    y = tableRows(pdf, y, vysledovka.polozky.map((p) => ({
      code: p.code, label: p.label, castka: fmtMoney(p.castka), bold: p.druh === "SUM",
    })), [
      { key: "code", width: 60 },
      { key: "label", width: 335 },
      { key: "castka", width: 100, align: "right" },
    ]);
    y += 8;
    pdf.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
    y += 10;
    pdf.font("Bold").fontSize(10).fillColor(vysledovka.vysledek_hospodareni >= 0 ? "#1a7a3c" : "#b3261e")
      .text(`Výsledek hospodaření: ${fmtMoney(vysledovka.vysledek_hospodareni)}`, 50, y, { width: 495 });
  } else {
    pdf.font("Body").fontSize(10).fillColor(DIM).text("Za dané období není k dispozici výsledovka.", 50, y);
  }

  // --- Strana 4+: Příloha ---
  pdf.addPage();
  pageHeader(pdf, "Příloha k účetní závěrce (§ 18 zákona o účetnictví)", unit);
  y = 108;

  function section(title) {
    if (y > 720) { pdf.addPage(); y = 50; }
    pdf.font("Bold").fontSize(11).fillColor(INK).text(title, 50, y, { width: 495 });
    y = pdf.y + 6;
  }
  function paragraph(text) {
    if (y > 740) { pdf.addPage(); y = 50; }
    pdf.font("Body").fontSize(9.5).fillColor(DIM).text(text && text.trim() ? text : "— neuvedeno —", 50, y, { width: 495 });
    y = pdf.y + 14;
  }

  section("1. Použité účetní metody");
  paragraph(note?.pouzite_ucetni_metody);

  section("2. Informace o dlouhodobém majetku");
  paragraph(note?.informace_majetek_komentar);
  if (auto?.majetek?.seznam?.length) {
    y += 2;
    pdf.font("Bold").fontSize(8.5).fillColor(FAINT);
    pdf.text("MAJETEK", 50, y, { width: 220 });
    pdf.text("POŘIZ. CENA", 270, y, { width: 90, align: "right" });
    pdf.text("OPRÁVKY", 360, y, { width: 90, align: "right" });
    pdf.text("ZŮSTATEK", 455, y, { width: 90, align: "right" });
    y += 14;
    pdf.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
    y += 4;
    y = tableRows(pdf, y, auto.majetek.seznam.map((m) => ({
      name: m.name, cost: fmtMoney(m.acquisition_cost),
      dep: fmtMoney(m.accumulated_depreciation), nbv: fmtMoney(m.net_book_value),
    })), [
      { key: "name", width: 220 },
      { key: "cost", width: 90, align: "right" },
      { key: "dep", width: 90, align: "right" },
      { key: "nbv", width: 90, align: "right" },
    ]);
    y += 4;
    pdf.font("Bold").fontSize(9).fillColor(INK).text(
      `Celkem: pořiz. cena ${fmtMoney(auto.majetek.souhrn.poc_cena_celkem)}, oprávky ${fmtMoney(auto.majetek.souhrn.opravky_celkem)}, zůstatek ${fmtMoney(auto.majetek.souhrn.zustatek_celkem)}`,
      50, y, { width: 495 }
    );
    y = pdf.y + 14;
  } else {
    paragraph("Účetní jednotka neeviduje žádný dlouhodobý majetek.");
  }

  section("3. Pohledávky a závazky po splatnosti");
  paragraph(note?.pohledavky_zavazky_komentar);
  if (auto?.poSplatnosti && (auto.poSplatnosti.pohledavky.length || auto.poSplatnosti.zavazky.length)) {
    pdf.font("Bold").fontSize(9).fillColor(INK).text(
      `Pohledávky po splatnosti celkem: ${fmtMoney(auto.poSplatnosti.souhrn.pohledavky_celkem)}   Závazky po splatnosti celkem: ${fmtMoney(auto.poSplatnosti.souhrn.zavazky_celkem)}`,
      50, y, { width: 495 }
    );
    y = pdf.y + 10;
  } else {
    paragraph("Účetní jednotka neeviduje žádné pohledávky ani závazky po splatnosti.");
  }

  section("4. Významné události po rozvahovém dni");
  paragraph(note?.udalosti_po_rozvahovem_dni);

  section("5. Průměrný počet zaměstnanců");
  paragraph(note?.prumerny_pocet_zamestnancu != null ? String(note.prumerny_pocet_zamestnancu) : "");

  section("6. Doplňující informace");
  paragraph(note?.doplnujici_informace);

  pdf.end();
  return done;
}

module.exports = { buildStatementPdf };
