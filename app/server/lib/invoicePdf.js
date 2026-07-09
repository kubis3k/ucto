// =====================================================================
// invoicePdf.js — vizuál vydané faktury (PDF) přes pdfkit (čistě JS, bez
// nativních závislostí / headless Chromia — funguje stejně v Electronu
// i na Vercel serverless, kde není k dispozici nic navíc než Node).
// Layout inspirovaný běžnými českými fakturačními systémy (Fakturoid,
// iDoklad): hlavička s logem, dva sloupce dodavatel/odběratel, tabulka
// položek, QR platba (SPD) a razítko/podpis v patičce.
// =====================================================================
const path = require("path");
const PDFDocument = require("pdfkit");
const qrplatba = require("./qrplatba");

const INK = "#1a2230", DIM = "#5a6472", FAINT = "#8a92a0", LINE = "#e2e6ec", BRAND = "#3f6ff0";
const FONTS_DIR = path.join(__dirname, "..", "assets", "fonts");
// pdfkit vestavěné fonty (Helvetica apod.) používají WinAnsi kódování bez
// české diakritiky (č/ě/ř/ů/š/ž se vykreslí jako přeslapy) — proto musí
// jít vlastní TTF s plným Unicode rozsahem (IBM Plex Serif, OFL licence).
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
function dataUrlToBuffer(dataUrl) {
  const match = /^data:[^;]+;base64,(.+)$/.exec(String(dataUrl || ""));
  return match ? Buffer.from(match[1], "base64") : null;
}

// doc = řádek document (doc_type faktura_vydana), lines = document_line[],
// unit = accounting_unit (vystavovatel), contact = contact|null (odběratel).
async function buildInvoicePdf({ doc, lines, unit, contact }) {
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

  // --- Hlavička: logo + název ---
  const logo = dataUrlToBuffer(unit.logo_data_url);
  if (logo) {
    try { pdf.image(logo, 50, 46, { fit: [130, 56] }); } catch (e) { /* poškozený obrázek — ignorovat, nepřerušit fakturu */ }
  }
  pdf.font("Bold").fontSize(22).fillColor(INK).text("FAKTURA", 300, 48, { width: 245, align: "right" });
  pdf.font("Body").fontSize(11).fillColor(DIM).text(`č. ${doc.doc_number}`, 300, 76, { width: 245, align: "right" });

  pdf.moveTo(50, 120).lineTo(545, 120).strokeColor(LINE).stroke();

  // --- Dodavatel / odběratel ---
  const colY = 138;
  pdf.fontSize(8.5).fillColor(FAINT).text("DODAVATEL", 50, colY, { characterSpacing: 0.6 });
  pdf.fontSize(11.5).fillColor(INK).text(unit.name || "—", 50, colY + 14);
  pdf.fontSize(9).fillColor(DIM);
  let y = colY + 32;
  if (unit.address) { pdf.text(unit.address, 50, y, { width: 220 }); y = pdf.y + 2; }
  pdf.text(`IČO: ${unit.ico || "—"}${unit.dic ? "   DIČ: " + unit.dic : ""}`, 50, y); y = pdf.y + 2;
  if (unit.email) { pdf.text(unit.email, 50, y); y = pdf.y + 2; }
  if (unit.phone) { pdf.text(unit.phone, 50, y); }

  pdf.fontSize(8.5).fillColor(FAINT).text("ODBĚRATEL", 320, colY, { characterSpacing: 0.6 });
  pdf.fontSize(11.5).fillColor(INK).text(contact?.name || "—", 320, colY + 14, { width: 225 });
  pdf.fontSize(9).fillColor(DIM);
  let y2 = colY + 32;
  if (contact?.address) { pdf.text(contact.address, 320, y2, { width: 225 }); y2 = pdf.y + 2; }
  if (contact?.ico) { pdf.text(`IČO: ${contact.ico}${contact.dic ? "   DIČ: " + contact.dic : ""}`, 320, y2); y2 = pdf.y + 2; }

  // --- Metadata (datumy, VS) ---
  const metaY = 232;
  const metaCols = [
    ["VYSTAVENO", fmtDate(doc.issue_date), 50],
    ["DUZP", fmtDate(doc.taxable_supply_date), 195],
    ["SPLATNOST", fmtDate(doc.due_date), 340],
    ["VAR. SYMBOL", doc.variable_symbol || doc.doc_number.replace(/\D/g, ""), 470],
  ];
  metaCols.forEach(([label, val, x]) => {
    pdf.fontSize(8).fillColor(FAINT).text(label, x, metaY, { characterSpacing: 0.5 });
    pdf.fontSize(11).fillColor(INK).text(val, x, metaY + 12);
  });

  pdf.moveTo(50, 280).lineTo(545, 280).strokeColor(LINE).stroke();

  // --- Tabulka položek ---
  let rowY = 292;
  pdf.fontSize(8.5).fillColor(FAINT);
  pdf.text("POPIS", 50, rowY, { characterSpacing: 0.4 });
  pdf.text("MNOŽ.", 330, rowY, { width: 50, align: "right" });
  pdf.text("CENA/MJ", 385, rowY, { width: 70, align: "right" });
  pdf.text("CELKEM", 465, rowY, { width: 80, align: "right" });
  rowY += 16;
  pdf.moveTo(50, rowY).lineTo(545, rowY).strokeColor(LINE).stroke();
  rowY += 8;

  const items = lines && lines.length ? lines : [{ description: doc.description, quantity: 1, unit_price: doc.total_amount, line_amount: doc.total_amount }];
  items.forEach((l) => {
    if (rowY > 700) { pdf.addPage(); rowY = 50; }
    pdf.fontSize(10).fillColor(INK).text(l.description || "—", 50, rowY, { width: 270 });
    pdf.text(String(l.quantity ?? 1), 330, rowY, { width: 50, align: "right" });
    pdf.text(fmtMoney(l.unit_price), 385, rowY, { width: 70, align: "right" });
    pdf.text(fmtMoney(l.line_amount), 465, rowY, { width: 80, align: "right" });
    rowY = pdf.y + 10;
  });

  pdf.moveTo(50, rowY).lineTo(545, rowY).strokeColor(LINE).stroke();
  rowY += 14;

  if (doc.is_vat_document) {
    pdf.fontSize(9).fillColor(DIM).text(`Základ daně: ${fmtMoney(doc.vat_base_amount)}   DPH ${doc.vat_rate}%: ${fmtMoney(doc.vat_amount)}`, 50, rowY, { width: 495, align: "right" });
    rowY = pdf.y + 8;
  } else {
    pdf.fontSize(9).fillColor(DIM).text("Nejsme plátci DPH.", 50, rowY, { width: 495, align: "right" });
    rowY = pdf.y + 8;
  }
  pdf.font("Bold").fontSize(16).fillColor(BRAND).text(`Celkem k úhradě: ${fmtMoney(doc.total_amount)}`, 50, rowY, { width: 495, align: "right" });
  pdf.font("Body");
  rowY = pdf.y + 24;

  // --- QR platba ---
  if (unit.iban) {
    try {
      const { png } = await qrplatba.generatePng({
        iban: unit.iban, amount: doc.total_amount,
        vs: doc.variable_symbol || doc.doc_number.replace(/\D/g, ""), message: doc.description,
      });
      const qrY = rowY;
      pdf.image(png, 50, qrY, { fit: [90, 90] });
      pdf.fontSize(8.5).fillColor(FAINT).text("QR PLATBA", 150, qrY + 4, { characterSpacing: 0.5 });
      pdf.fontSize(9).fillColor(DIM).text(`Naskenujte v mobilním bankovnictví.\nBankovní spojení: ${unit.bank_account || unit.iban}`, 150, qrY + 18, { width: 250 });
      rowY = qrY + 100;
    } catch (e) { /* chybný IBAN apod. — faktura se vytiskne i bez QR */ }
  }

  // --- Razítko / podpis ---
  const stamp = dataUrlToBuffer(unit.stamp_data_url);
  const signature = dataUrlToBuffer(unit.signature_data_url);
  if (stamp || signature) {
    const sigY = Math.max(rowY, 620);
    if (stamp) { try { pdf.image(stamp, 350, sigY, { fit: [90, 90] }); } catch (e) {} }
    if (signature) { try { pdf.image(signature, 450, sigY + 25, { fit: [95, 45] }); } catch (e) {} }
  }

  pdf.end();
  return done;
}

// offer = řádek `offer`, lines = offer_line[], unit = accounting_unit
// (vystavovatel), contact = contact|null. Sdílí layout s buildInvoicePdf,
// ale bez QR platby (nabídka není platební doklad) a s "Platnost do".
async function buildOfferPdf({ offer, lines, unit, contact }) {
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

  const logo = dataUrlToBuffer(unit.logo_data_url);
  if (logo) {
    try { pdf.image(logo, 50, 46, { fit: [130, 56] }); } catch (e) { /* poškozený obrázek — ignorovat */ }
  }
  pdf.font("Bold").fontSize(22).fillColor(INK).text("CENOVÁ NABÍDKA", 260, 48, { width: 285, align: "right" });
  pdf.font("Body").fontSize(11).fillColor(DIM).text(`č. ${offer.offer_number}`, 260, 76, { width: 285, align: "right" });

  pdf.moveTo(50, 120).lineTo(545, 120).strokeColor(LINE).stroke();

  const colY = 138;
  pdf.fontSize(8.5).fillColor(FAINT).text("DODAVATEL", 50, colY, { characterSpacing: 0.6 });
  pdf.fontSize(11.5).fillColor(INK).text(unit.name || "—", 50, colY + 14);
  pdf.fontSize(9).fillColor(DIM);
  let y = colY + 32;
  if (unit.address) { pdf.text(unit.address, 50, y, { width: 220 }); y = pdf.y + 2; }
  pdf.text(`IČO: ${unit.ico || "—"}${unit.dic ? "   DIČ: " + unit.dic : ""}`, 50, y); y = pdf.y + 2;
  if (unit.email) { pdf.text(unit.email, 50, y); y = pdf.y + 2; }
  if (unit.phone) { pdf.text(unit.phone, 50, y); }

  pdf.fontSize(8.5).fillColor(FAINT).text("ODBĚRATEL", 320, colY, { characterSpacing: 0.6 });
  pdf.fontSize(11.5).fillColor(INK).text(contact?.name || "—", 320, colY + 14, { width: 225 });
  pdf.fontSize(9).fillColor(DIM);
  let y2 = colY + 32;
  if (contact?.address) { pdf.text(contact.address, 320, y2, { width: 225 }); y2 = pdf.y + 2; }
  if (contact?.ico) { pdf.text(`IČO: ${contact.ico}${contact.dic ? "   DIČ: " + contact.dic : ""}`, 320, y2); y2 = pdf.y + 2; }

  const metaY = 232;
  const metaCols = [
    ["VYSTAVENO", fmtDate(offer.issue_date), 50],
    ["PLATNOST DO", fmtDate(offer.valid_until), 260],
    ["STATUS", offer.status, 470],
  ];
  metaCols.forEach(([label, val, x]) => {
    pdf.fontSize(8).fillColor(FAINT).text(label, x, metaY, { characterSpacing: 0.5 });
    pdf.fontSize(11).fillColor(INK).text(val, x, metaY + 12);
  });

  pdf.moveTo(50, 280).lineTo(545, 280).strokeColor(LINE).stroke();

  let rowY = 292;
  pdf.fontSize(8.5).fillColor(FAINT);
  pdf.text("POPIS", 50, rowY, { characterSpacing: 0.4 });
  pdf.text("MNOŽ.", 330, rowY, { width: 50, align: "right" });
  pdf.text("CENA/MJ", 385, rowY, { width: 70, align: "right" });
  pdf.text("CELKEM", 465, rowY, { width: 80, align: "right" });
  rowY += 16;
  pdf.moveTo(50, rowY).lineTo(545, rowY).strokeColor(LINE).stroke();
  rowY += 8;

  const items = lines && lines.length ? lines : [{ description: offer.description, quantity: 1, unit_price: offer.total_amount, line_amount: offer.total_amount }];
  items.forEach((l) => {
    if (rowY > 700) { pdf.addPage(); rowY = 50; }
    pdf.fontSize(10).fillColor(INK).text(l.description || "—", 50, rowY, { width: 270 });
    pdf.text(String(l.quantity ?? 1), 330, rowY, { width: 50, align: "right" });
    pdf.text(fmtMoney(l.unit_price), 385, rowY, { width: 70, align: "right" });
    pdf.text(fmtMoney(l.line_amount), 465, rowY, { width: 80, align: "right" });
    rowY = pdf.y + 10;
  });

  pdf.moveTo(50, rowY).lineTo(545, rowY).strokeColor(LINE).stroke();
  rowY += 14;

  if (offer.is_vat_document) {
    pdf.fontSize(9).fillColor(DIM).text(`Základ daně: ${fmtMoney(offer.vat_base_amount)}   DPH ${offer.vat_rate}%: ${fmtMoney(offer.vat_amount)}`, 50, rowY, { width: 495, align: "right" });
    rowY = pdf.y + 8;
  } else {
    pdf.fontSize(9).fillColor(DIM).text("Nejsme plátci DPH.", 50, rowY, { width: 495, align: "right" });
    rowY = pdf.y + 8;
  }
  pdf.font("Bold").fontSize(16).fillColor(BRAND).text(`Celkem: ${fmtMoney(offer.total_amount)}`, 50, rowY, { width: 495, align: "right" });
  pdf.font("Body");
  rowY = pdf.y + 24;

  const stamp = dataUrlToBuffer(unit.stamp_data_url);
  const signature = dataUrlToBuffer(unit.signature_data_url);
  if (stamp || signature) {
    const sigY = Math.max(rowY, 620);
    if (stamp) { try { pdf.image(stamp, 350, sigY, { fit: [90, 90] }); } catch (e) {} }
    if (signature) { try { pdf.image(signature, 450, sigY + 25, { fit: [95, 45] }); } catch (e) {} }
  }

  pdf.end();
  return done;
}

module.exports = { buildInvoicePdf, buildOfferPdf };
