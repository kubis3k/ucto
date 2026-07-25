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
//
// FÁZE B (přeshraniční DPH): přidána podpora Souhrnného hlášení (DPHSHV) a
// možnost naplnit přeshraniční řádky DPHDP3. Které atributy XML se u kterého
// režimu plnění plní, ALE NENÍ v tomto souboru rozhodnuto — mapování si zadává
// účetní do `vat_regime_config.vat_return_row` (formát viz parseVatReturnRow
// níže). Bez potvrzeného mapování se řádek nevyplní a výstup nese upozornění.
// Seznam SEZNAM_ATRIBUTU níže je jen whitelist proti překlepům, opsaný z XSD.
// https://adisspr.mfcr.cz/adis/jepo/schema/dphshv_epo2.xsd
const RATE_BUCKET = { 21: "23", 12: "5" }; // XSD historicky pojmenovává sazby "23"/"5"

// Atributy převzaté 1:1 z dphdp3_epo2.xsd (elementy Veta1–Veta3). Slouží pouze
// k ověření, že to, co účetní zapsala do konfigurace, ve schématu existuje —
// nepřiřazuje žádný atribut žádnému režimu plnění.
const DP3_ATTRIBUTES = {
  Veta1: ["dan23", "dan5", "dan_dzb23", "dan_dzb5", "dan_pdop_nrg", "dan_psl23_e", "dan_psl23_z",
    "dan_psl5_e", "dan_psl5_z", "dan_pzb23", "dan_pzb5", "dan_rpren23", "dan_rpren5",
    "dov_zb23", "dov_zb5", "obrat23", "obrat5", "p_dop_nrg", "p_sl23_e", "p_sl23_z",
    "p_sl5_e", "p_sl5_z", "p_zb23", "p_zb5", "rez_pren23", "rez_pren5",
    "opr_dane_zd", "opr_dane_dan"],
  Veta2: ["dod_dop_nrg", "dod_zb", "pln_ost", "pln_rez_pren", "pln_sluzby", "pln_vyvoz", "pln_zaslani"],
  Veta3: ["dov_osv", "opr_dluz", "opr_verit", "tri_dozb", "tri_pozb"],
  Veta4: ["dov_cu", "nar_maj", "nar_zdp23", "nar_zdp5", "od_maj", "od_zdp23", "od_zdp5",
    "odkr_maj", "odkr_zdp23", "odkr_zdp5", "odp_cu", "odp_cu_nar", "odp_rez_nar",
    "odp_rezim", "odp_sum_kr", "odp_sum_nar", "odp_tuz23", "odp_tuz23_nar",
    "odp_tuz5", "odp_tuz5_nar"],
};

// `vat_return_row` má formát "Veta1:p_sl23_e,dan_psl23_e" — element, atribut pro
// základ a (volitelně) atribut pro daň. Řádky Veta2/Veta3 nesou jen hodnotu
// plnění, takže druhý atribut chybí. Vrací null, pokud není co použít; vyhodí
// chybu jen u zjevného překlepu, aby se špatné mapování nedostalo do podání.
function parseVatReturnRow(raw) {
  if (!raw) return null;
  const [element, attrPart] = String(raw).split(":");
  const el = (element || "").trim();
  if (!DP3_ATTRIBUTES[el]) {
    throw new Error(`Mapování na přiznání odkazuje na neznámý element „${el}“. Použijte Veta1, Veta2 nebo Veta3.`);
  }
  const attrs = String(attrPart || "").split(",").map((a) => a.trim()).filter(Boolean);
  if (!attrs.length) throw new Error(`Mapování „${raw}“ neobsahuje žádný atribut.`);
  for (const a of attrs) {
    if (!DP3_ATTRIBUTES[el].includes(a)) {
      throw new Error(`Atribut „${a}“ v elementu ${el} podle schématu dphdp3_epo2.xsd neexistuje — zkontrolujte mapování v nastavení režimů DPH.`);
    }
  }
  return { element: el, baseAttr: attrs[0], taxAttr: attrs[1] || null };
}

// Celá hodnota `vat_return_row` může nést mapování zvlášť pro daň na výstupu
// a zvlášť pro nárok na odpočet, protože u samovyměření jde o dva různé řádky
// přiznání:
//   "uskutecnene=Veta1:p_sl23_e,dan_psl23_e|prijate=Veta4:odp_tuz23"
// Bez prefixu se mapování použije pro uskutečněná plnění.
function parseVatReturnMapping(raw) {
  const out = {};
  if (!raw) return out;
  for (const part of String(raw).split("|").map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^(uskutecnene|prijate)\s*=\s*(.+)$/);
    const direction = m ? m[1] : "uskutecnene";
    out[direction] = parseVatReturnRow(m ? m[2] : part);
  }
  return out;
}

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

// crossBorder = [{ regime, label, mapping: "Veta1:p_sl23_e,dan_psl23_e"|null, base, tax }]
// Vrací atributy k doplnění do jednotlivých Vet + seznam režimů, které mapování
// nemají (ty se do XML NEDOSTANOU a musí se doplnit ručně).
function buildCrossBorderAttrs(crossBorder) {
  const perElement = { Veta1: {}, Veta2: {}, Veta3: {}, Veta4: {} };
  const unmapped = [];
  for (const item of crossBorder || []) {
    const direction = item.direction || "uskutecnene";
    let parsed = null;
    try {
      parsed = parseVatReturnMapping(item.mapping)[direction] || null;
    } catch (err) {
      unmapped.push({ ...item, reason: err.message });
      continue;
    }
    if (!parsed) {
      unmapped.push({ ...item, reason: `režim nemá potvrzené mapování na řádek přiznání pro ${direction === "prijate" ? "nárok na odpočet" : "daň na výstupu"}` });
      continue;
    }
    const target = perElement[parsed.element];
    target[parsed.baseAttr] = (target[parsed.baseAttr] || 0) + Number(item.base || 0);
    if (parsed.taxAttr) {
      target[parsed.taxAttr] = (target[parsed.taxAttr] || 0) + Number(item.tax || 0);
    } else if (Number(item.tax || 0) !== 0) {
      // Element bez atributu pro daň dostal nenulovou daň — to je nesoulad
      // mapování a dat, ne něco, co bychom měli mlčky zahodit.
      unmapped.push({ ...item, reason: `mapování ${item.mapping} nemá atribut pro daň, ale režim daň nese` });
    }
  }
  return { perElement, unmapped };
}

// Tuzemský odpočet (dosavadní chování) a případný přeshraniční odpočet míří do
// stejného elementu Veta4, takže se stejnojmenné atributy sečtou.
function mergeVeta4(agg, crossBorderVeta4) {
  const merged = { odp_tuz23: Number(agg.in23.base) || 0, odp_tuz5: Number(agg.in5.base) || 0 };
  for (const [k, v] of Object.entries(crossBorderVeta4)) {
    merged[k] = (merged[k] || 0) + Number(v || 0);
  }
  return merged;
}

function attrsOf(map) {
  const keys = Object.keys(map);
  if (!keys.length) return "";
  return " " + keys.sort().map((k) => `${k}="${num(map[k])}"`).join(" ");
}

// agg = { out23: {base,tax}, out5: {base,tax}, in23: {base,tax}, in5: {base,tax}, unmapped: [{rate, direction, base, tax}] }
// crossBorder (volitelné) = viz buildCrossBorderAttrs
function generateDphDp3Xml({ unit, rok, mesic, ctvrt, zdobdOd, zdobdDo, agg, dPoddp, crossBorder }) {
  const cb = buildCrossBorderAttrs(crossBorder);
  const warn = cb.unmapped.length
    ? `  <!-- UPOZORNĚNÍ: následující přeshraniční plnění NEJSOU v tomto XML zahrnuta,
       protože k nim není potvrzené mapování na řádek přiznání. Doplňte je ručně
       v aplikaci EPO/MOJE daně, nebo mapování potvrďte v nastavení režimů DPH:
${cb.unmapped.map((u) => `       - ${u.label || u.regime}: základ ${num(u.base)}, daň ${num(u.tax)} (${u.reason})`).join("\n")} -->\n`
    : "";
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
${warn}  <DPHDP3 verzePis="1">
    <VetaD ${vetaD}/>
    <VetaP ${buildVetaP(unit)}/>
    <Veta1 obrat23="${num(agg.out23.base)}" dan23="${num(agg.out23.tax)}" obrat5="${num(agg.out5.base)}" dan5="${num(agg.out5.tax)}"${attrsOf(cb.perElement.Veta1)}/>
    <Veta2${attrsOf(cb.perElement.Veta2)}/>
    <Veta3${attrsOf(cb.perElement.Veta3)}/>
    <Veta4${attrsOf(mergeVeta4(agg, cb.perElement.Veta4))}/>
  </DPHDP3>
</Pisemnost>
`;
}

// Souhrnné hlášení (§ 102 ZDPH), dokument DPHSHV.
//
// Struktura ověřena proti oficiálnímu dphshv_epo2.xsd: VetaD (hlavička období),
// VetaP (podávající), VetaR (jednotlivé řádky: k_stat + c_vat + k_pln_eu +
// pln_pocet + pln_hodnota), VetaS (třístranný obchod, jen u k_pln_eu = 2).
//
// Kód plnění `k_pln_eu` NEODVOZUJEME z režimu sami — dodává ho konfigurace
// (`vat_regime_config.summary_report_code`) potvrzená účetní. Číselník ze XSD:
//   0 = dodání zboží do jiného členského státu
//   1 = přemístění obchodního majetku
//   2 = dodání zboží prostřední osobou v třístranném obchodu
//   3 = poskytnutí služby s místem plnění v jiném členském státě
// Všechny čtyři kódy popisují plnění POSKYTNUTÁ do EU. Zda a kdy do hlášení
// patří i něco jiného, je otevřená otázka pro účetní (viz DPH_ROZHODNUTI.md).
//
// rows = [{ country, vat_id, code, count, value }]
function generateSouhrnneHlaseniXml({ unit, rok, mesic, ctvrt, rows, dPoddp, warnings }) {
  const vetaD = [
    `dokument="SHV"`, `k_uladis="DPH"`, `rok="${rok}"`,
    mesic ? `mesic="${String(mesic).padStart(2, "0")}"` : "",
    ctvrt ? `ctvrt="${ctvrt}"` : "",
    `shvies_forma="R"`, // R = řádné hlášení (N = následné, to systém negeneruje)
    `d_poddp="${fmtDate(dPoddp)}"`,
  ].filter(Boolean).join(" ");

  const warn = (warnings || []).length
    ? `  <!-- UPOZORNĚNÍ:\n${warnings.map((w) => `       - ${w}`).join("\n")} -->\n`
    : "";

  const vetaR = rows.map((r, i) =>
    `    <VetaR c_radku="${i + 1}" k_stat="${esc(r.country)}" c_vat="${esc(r.vat_id)}" k_pln_eu="${esc(r.code)}" pln_pocet="${Number(r.count) || 1}" pln_hodnota="${Math.round(Number(r.value) || 0)}"/>`
  );

  return `<?xml version="1.0" encoding="UTF-8"?>
<Pisemnost>
${warn}  <DPHSHV verzePis="1">
    <VetaD ${vetaD}/>
    <VetaP ${buildVetaP(unit)}/>
${vetaR.join("\n")}
  </DPHSHV>
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

module.exports = {
  generateDphDp3Xml,
  generateKontrolniHlaseniXml,
  generateSouhrnneHlaseniXml,
  parseVatReturnRow,
  parseVatReturnMapping,
  buildCrossBorderAttrs,
  DP3_ATTRIBUTES,
  fmtDate,
  dicWithoutPrefix,
};
