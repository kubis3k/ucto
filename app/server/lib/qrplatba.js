// =====================================================================
// qrplatba.js — generování QR platby ve formátu SPD 1.0 (Short Payment
// Descriptor, standard České bankovní asociace). Stejný QR kód, jaký
// tisknou na faktury Fakturoid, iDoklad i Pohoda — zákazník ho naskenuje
// v mobilním bankovnictví a platba se předvyplní.
// Spec: https://qr-platba.cz/pro-vyvojare/specifikace-formatu/
// =====================================================================
const QRCode = require("qrcode");

// Odstraní diakritiku a znak * (ten má v SPD speciální význam)
function sanitize(text) {
  return String(text || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\*/g, "")
    .toUpperCase();
}

// Sestaví SPAYD řetězec
function buildSpayd({ iban, amount, currency = "CZK", vs, message }) {
  const parts = [`SPD*1.0*ACC:${iban.replace(/\s/g, "")}`];
  if (amount != null) parts.push(`AM:${Number(amount).toFixed(2)}`);
  parts.push(`CC:${currency}`);
  if (vs) parts.push(`X-VS:${String(vs).replace(/\D/g, "")}`);
  if (message) parts.push(`MSG:${sanitize(message).slice(0, 60)}`);
  return parts.join("*");
}

// Vrátí { spayd, svg } — SVG lze přímo vložit do stránky (žádné externí volání)
async function generate(opts) {
  const spayd = buildSpayd(opts);
  const svg = await QRCode.toString(spayd, { type: "svg", margin: 1, width: 220 });
  return { spayd, svg };
}

module.exports = { buildSpayd, generate };
