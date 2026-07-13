// Generování XML pro elektronické podání finanční správě (soubor "Pisemnost"
// dle EPO2 rozhraní) — Přiznání k DPH (DPHDP3) a Kontrolní hlášení (DPHKH1).
//
// Zdroj struktury: oficiální XSD publikovaná finanční správou —
// https://adisspr.mfcr.cz/adis/jepo/schema/dphdp3_epo2.xsd
// https://adisspr.mfcr.cz/adis/jepo/schema/dphkh1_epo2.xsd
//
// ROZSAH (vědomě omezeno, viz BRIEF.md): pokrývá jen běžná tuzemská plnění se
// standardní (21 %) a první sníženou (12 %) sazbou — pole pro přenesenou
// daňovou povinnost, intrakomunitární plnění, dovoz a opravy zůstávají
// nevyplněná/nulová, protože je dnešní datový model (vat_ledger_entry)
// nerozlišuje. Výstup je nutné před podáním zkontrolovat s účetní/daňovým
// poradcem — jde o podklad pro nahrání do MOJE daně/EPO, ne o ověřené podání.
const RATE_BUCKET = { 21: "23", 12: "5" }; // XSD historicky pojmenovává sazby "23"/"5"

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// "2026-07-31" -> "31.7.2026" (dateInMultiFormat dle XSD)
function fmtDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

function dicWithoutPrefix(dic) {
  return String(dic || "").replace(/^CZ/i, "").trim();
}

function buildVetaP(unit) {
  const attrs = {
    dic: dicWithoutPrefix(unit.dic),
    c_ufo: unit.ufo_code || "",
    c_pracufo: "",
    typ_ds: "P", // systém dnes modeluje jen firmy (s.r.o.) — právnická osoba
    zkrobchjm: unit.name,
    ulice: unit.fs_street || "",
    c_pop: unit.fs_house_number || "",
    c_orient: unit.fs_orientation_number || "",
    naz_obce: unit.fs_city || "",
    psc: unit.fs_zip || "",
    stat: "CESKA REPUBLIKA",
    email: unit.email || "",
    c_telef: unit.phone || "",
  };
  return Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
}

function num(n) { return (Number(n) || 0).toFixed(2); }

// agg = { out23: {base,tax}, out5: {base,tax}, in23: {base,tax}, in5: {base,tax}, unmapped: [{rate, direction, base, tax}] }
function generateDphDp3Xml({ unit, rok, mesic, ctvrt, zdobdOd, zdobdDo, agg, dPoddp }) {
  const vetaD = [
    `dokument="DP3"`, `k_uladis="DPH"`, `rok="${rok}"`,
    mesic ? `mesic="${String(mesic).padStart(2, "0")}"` : "",
    ctvrt ? `ctvrt="${ctvrt}"` : "",
    `zdobd_od="${fmtDate(zdobdOd)}"`, `zdobd_do="${fmtDate(zdobdDo)}"`,
    `dapdph_forma="B"`, `typ_ds="P"`, `typ_platce="P"`, `trans="A"`,
    `d_poddp="${fmtDate(dPoddp)}"`,
  ].filter(Boolean).join(" ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Pisemnost>
  <DPHDP3 verzePis="1">
    <VetaD ${vetaD}/>
    <VetaP ${buildVetaP(unit)}/>
    <Veta1 obrat23="${num(agg.out23.base)}" dan23="${num(agg.out23.tax)}" obrat5="${num(agg.out5.base)}" dan5="${num(agg.out5.tax)}"/>
    <Veta2/>
    <Veta3/>
    <Veta4 odp_tuz23="${num(agg.in23.base)}" odp_tuz5="${num(agg.in5.base)}"/>
  </DPHDP3>
</Pisemnost>
`;
}

// entries = řádky vat_ledger_entry JOIN document nad limitem KH (requires_individual_kh = 1)
function generateKontrolniHlaseniXml({ unit, rok, mesic, ctvrt, zdobdOd, zdobdDo, entries, dPoddp }) {
  const vetaD = [
    `dokument="KH1"`, `k_uladis="DPH"`, `rok="${rok}"`,
    mesic ? `mesic="${String(mesic).padStart(2, "0")}"` : "",
    ctvrt ? `ctvrt="${ctvrt}"` : "",
    `zdobd_od="${fmtDate(zdobdOd)}"`, `zdobd_do="${fmtDate(zdobdDo)}"`,
    `khdph_forma="B"`, `d_poddp="${fmtDate(dPoddp)}"`,
  ].filter(Boolean).join(" ");

  let rowNo = 0;
  const rateAttrs = (rate, base, tax) => {
    const bucket = RATE_BUCKET[Math.round(Number(rate))];
    if (bucket === "23") return `zakl_dane1="${num(base)}" dan1="${num(tax)}"`;
    if (bucket === "5") return `zakl_dane2="${num(base)}" dan2="${num(tax)}"`;
    return `zakl_dane1="0.00" dan1="0.00"`; // nemapovaná sazba — MVP rozsah, viz komentář nahoře
  };

  const a1Rows = entries
    .filter((e) => e.direction === "uskutecnene")
    .map((e) => {
      rowNo += 1;
      return `    <VetaA1 c_radku="${rowNo}" dic_odb="${esc(dicWithoutPrefix(e.counterparty_dic))}" c_evid_dd="${esc(e.doc_number)}" duzp="${fmtDate(e.duzp)}" ${rateAttrs(e.vat_rate, e.vat_base, e.vat_amount)} kod_pred_pl="0"/>`;
    });

  let rowNoB = 0;
  const b1Rows = entries
    .filter((e) => e.direction === "prijate")
    .map((e) => {
      rowNoB += 1;
      return `    <VetaB1 c_radku="${rowNoB}" dic_dod="${esc(dicWithoutPrefix(e.counterparty_dic))}" c_evid_dd="${esc(e.doc_number)}" duzp="${fmtDate(e.duzp)}" ${rateAttrs(e.vat_rate, e.vat_base, e.vat_amount)} kod_pred_pl="0"/>`;
    });

  return `<?xml version="1.0" encoding="UTF-8"?>
<Pisemnost>
  <DPHKH1 verzePis="1">
    <VetaD ${vetaD}/>
    <VetaP ${buildVetaP(unit)}/>
${a1Rows.join("\n")}
${b1Rows.join("\n")}
  </DPHKH1>
</Pisemnost>
`;
}

module.exports = { generateDphDp3Xml, generateKontrolniHlaseniXml, fmtDate, dicWithoutPrefix };
