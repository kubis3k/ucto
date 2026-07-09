// =====================================================================
// invoiceScan.js — vytažení textu z nahrané faktury a heuristické
// rozpoznání polí dokladu (číslo, datum, VS, IČO/DIČ, částka).
//
// PDF: plný text přes pdf-parse (funguje pro naprostou většinu faktur —
// jsou generované, ne skenované, takže mají textovou vrstvu).
// Obrázky (PNG/JPG): OCR není v této verzi zapojeno (náročné na
// instalaci/výkon) — vrací se prázdná extrakce, doklad lze přiložit a
// pole doplnit ručně.
// =====================================================================
// pdf-parse@1.x (klasické API, ne novější PDFParse třída z 2.x) — 2.x interně
// zapojuje pdfjs-dist cestu, která vyžaduje browser globals (DOMMatrix apod.)
// nedostupné v serverless Node runtime (Vercel), viz ověřeno end-to-end.
const pdfParse = require("pdf-parse");

async function extractText(buffer, mimeType) {
  if (mimeType === "application/pdf") {
    const result = await pdfParse(buffer);
    return result.text || "";
  }
  return ""; // obrázky — bez OCR v této verzi
}

// Normalizace čísel ve formátu "15 000,00 Kč" / "15.000,00" -> 15000
function parseAmount(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/\s/g, "").replace(/\.(?=\d{3},)/g, "").replace(",", ".");
  const n = Number(cleaned.replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n;
}

function parseCzechDate(raw) {
  const m = raw && raw.match(/(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function extractFields(text) {
  const fields = {};

  const docNum = text.match(/(?:faktura\s*(?:číslo|č\.?)|invoice\s*(?:no\.?|number))\s*:?\s*([A-Za-z0-9\/-]{4,20})/i);
  if (docNum) fields.doc_number_hint = docNum[1];

  const issueDate = text.match(/datum\s+vystaven[ií]\s*:?\s*(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/i);
  if (issueDate) fields.issue_date = parseCzechDate(issueDate[1]);

  const dueDate = text.match(/splatnost\s*:?\s*(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/i);
  if (dueDate) fields.due_date = parseCzechDate(dueDate[1]);

  const duzp = text.match(/(?:duzp|datum\s+uskutečnění[^:]*)\s*:?\s*(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/i);
  if (duzp) fields.taxable_supply_date = parseCzechDate(duzp[1]);

  const vs = text.match(/variabiln[íi]\s+symbol\s*:?\s*(\d{3,15})/i);
  if (vs) fields.variable_symbol = vs[1];

  const total = text.match(/celkem\s+k\s+úhrad[ěe]\s*:?\s*([\d\s.,]+)\s*Kč/i)
    || text.match(/celkem\s*:?\s*([\d\s.,]+)\s*Kč/i);
  if (total) fields.total_amount = parseAmount(total[1]);

  // IČO dodavatele — první výskyt (dodavatel bývá první blok na faktuře)
  const icoMatches = [...text.matchAll(/I[ČC]:?\s*(\d{8})/gi)];
  if (icoMatches.length) fields.supplier_ico = icoMatches[0][1];
  if (icoMatches.length > 1) fields.buyer_ico = icoMatches[1][1];

  const dicMatches = [...text.matchAll(/DI[ČC]:?\s*(CZ\d{8,10})/gi)];
  if (dicMatches.length) fields.supplier_dic = dicMatches[0][1];

  const iban = text.match(/\b([A-Z]{2}\d{2}[\dA-Z]{10,30})\b/);
  if (iban) fields.supplier_iban = iban[1];

  const account = text.match(/číslo\s+účtu\s*:?\s*(\d{6,10}\/\d{4})/i);
  if (account) fields.supplier_bank_account = account[1];

  // Jméno dodavatele se z dvojsloupcového rozvržení faktury regexem nedá
  // vytáhnout spolehlivě — frontend proto místo toho dohledá přesný název
  // (a ověří IČO) přímo v ARES podle fields.supplier_ico.

  return fields;
}

module.exports = { extractText, extractFields };
