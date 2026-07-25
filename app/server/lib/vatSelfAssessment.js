// Samovyměření DPH (self-assessment) u režimů s přenesenou daňovou povinností —
// FÁZE B (přeshraniční DPH).
//
// PRAVIDLO TOHOTO MODULU: mechanismus je tady, daňová rozhodnutí nikoli.
//
// Modul umí vygenerovat účetní zápis daně na výstupu a (je-li přiznán) nárok na
// odpočet na vstupu. NEVÍ ale:
//   - na které účty to patří            -> vat_regime_config.output_vat_account_id / input_vat_account_id
//   - zda nárok na odpočet vůbec je     -> vat_regime_config.deduction_allowed
//   - jakou sazbou se daň vyměří        -> document.vat_rate, vyplňuje uživatel/účetní
//   - na kterém řádku přiznání to skončí-> vat_regime_config.vat_return_row
// Cokoli z toho nevyplněné = zápis se NEVYGENERUJE a vrátí se konkrétní chyba.
// To je záměr, ne nedodělek: viz DPH_ROZHODNUTI.md. Odhadnutý §-mapping v kódu
// je horší než chybějící funkce, protože vypadá jako správný výsledek.
//
// Účet na vstupu má dvojí význam podle `deduction_allowed`:
//   deduction_allowed = 1 -> input_vat_account_id je účet nároku na odpočet (343/xxx)
//   deduction_allowed = 0 -> input_vat_account_id je NÁKLADOVÝ účet, na kterém
//                            neodpočitatelná daň zůstane jako náklad
// Které to je, rozhoduje účetní v konfiguraci; kód jen zaúčtuje, kam mu řekne.

const store = require("../db");
const regimes = require("./vatRegimes");
const { nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen } = require("./core");

// Načte konfiguraci režimu pro firmu. Nic nevytváří — chybějící řádek je
// legitimní stav "účetní se k tomu ještě nedostala".
async function getConfig(unitId, regime) {
  return store.get(
    "SELECT * FROM vat_regime_config WHERE accounting_unit_id = ? AND vat_regime = ?",
    [unitId, regimes.assertKnown(regime)]
  );
}

async function listConfig(unitId) {
  const rows = await store.all(
    "SELECT * FROM vat_regime_config WHERE accounting_unit_id = ?",
    [unitId]
  );
  const byRegime = new Map(rows.map((r) => [r.vat_regime, r]));
  // Vždy vrátíme všechny režimy, i nekonfigurované — UI má ukázat, co chybí.
  return regimes.REGIMES.map((r) => ({
    ...r,
    config: byRegime.get(r.key) || null,
    ready: Boolean(byRegime.get(r.key) && byRegime.get(r.key).confirmed_at),
  }));
}

// Vrátí seznam důvodů, proč se samovyměření nespustí. Prázdný = lze účtovat.
function configBlockers(config, regime) {
  if (!config) return [`Režim „${regime}“ nemá vyplněnou konfiguraci (tabulka vat_regime_config).`];
  const missing = [];
  if (!config.confirmed_at) missing.push("konfigurace není potvrzená účetní (confirmed_at je prázdné)");
  if (!config.output_vat_account_id) missing.push("není zvolen účet daně na výstupu");
  // NULL znamená "nerozhodnuto", ne "ne" — rozdíl je podstatný, proto === null.
  if (config.deduction_allowed === null || config.deduction_allowed === undefined) {
    missing.push("není rozhodnuto, zda je nárok na odpočet (deduction_allowed je NULL)");
  } else if (!config.input_vat_account_id) {
    missing.push(Number(config.deduction_allowed) === 1
      ? "není zvolen účet nároku na odpočet"
      : "není zvolen nákladový účet pro neodpočitatelnou daň");
  }
  return missing;
}

async function assertConfigured(unitId, regime) {
  const config = await getConfig(unitId, regime);
  const blockers = configBlockers(config, regime);
  if (blockers.length) {
    const err = new Error(
      `Samovyměření DPH nelze provést — chybí daňové rozhodnutí: ${blockers.join("; ")}. ` +
      "Nastavení režimů DPH vyplňuje a potvrzuje účetní (viz DPH_ROZHODNUTI.md)."
    );
    err.status = 409;
    err.blockers = blockers;
    throw err;
  }
  return config;
}

// Základ daně v CZK. Přepočet cizí valuty používá kurz zamrznutý na dokladu
// (stejná logika jako zaúčtování dokladu v routes/documents.js) — ne aktuální.
function baseInCzk(doc) {
  const raw = doc.vat_base_amount !== null && doc.vat_base_amount !== undefined
    ? Number(doc.vat_base_amount)
    // U přenesené daňové povinnosti dodavatel fakturuje bez daně, takže celá
    // částka dokladu je základem. To je aritmetika, ne §-mapping.
    : Number(doc.total_amount);
  if (!doc.currency || doc.currency === "CZK") return round2(raw);
  if (!doc.fx_rate) {
    const err = new Error(`Doklad je v ${doc.currency}, ale nemá kurz — bez kurzu nelze základ daně přepočíst na CZK.`);
    err.status = 400;
    throw err;
  }
  return round2(raw * (Number(doc.fx_rate) / (Number(doc.fx_rate_unit) || 1)));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Vygeneruje zápis samovyměření k dokladu. Volá se VŽDY uvnitř transakce
// (store.transaction) — sama ji nezakládá, aby šla složit s dalšími kroky.
//
// Zápis vzniká takto (částky v CZK):
//   MD input_vat_account   / D output_vat_account     ... při nároku na odpočet
//   MD input_vat_account (nákladový) / D output_vat_account ... bez nároku
// V obou případech MD = D, takže podvojnost drží; liší se jen povaha MD účtu.
async function generateSelfAssessmentPosting({ documentId, unitId, userId }) {
  const doc = await store.get(
    "SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?",
    [documentId, unitId]
  );
  if (!doc) {
    const err = new Error("Doklad nenalezen.");
    err.status = 404;
    throw err;
  }

  const regime = regimes.normalize(doc.vat_regime);
  const meta = regimes.get(regime);
  if (!meta.self_assessment_candidate) {
    const err = new Error(`Režim „${meta.label}“ samovyměření nepoužívá — daň na výstupu si nevyměřuje odběratel.`);
    err.status = 400;
    throw err;
  }
  if (doc.vat_rate === null || doc.vat_rate === undefined || Number(doc.vat_rate) <= 0) {
    // Sazbu záměrně nehádáme. Která sazba na dané plnění dopadá, je daňové
    // rozhodnutí; kód umí jen počítat s tou, kterou dostane.
    const err = new Error("Doklad nemá vyplněnou sazbu DPH — sazbu pro samovyměření musí zadat účetní, systém ji neodhaduje.");
    err.status = 400;
    throw err;
  }

  const config = await assertConfigured(unitId, regime);
  const base = baseInCzk(doc);
  const tax = round2(base * (Number(doc.vat_rate) / 100));
  if (tax <= 0) {
    const err = new Error("Vypočtená daň k samovyměření je nulová — zkontrolujte základ a sazbu.");
    err.status = 400;
    throw err;
  }

  const postingDate = doc.taxable_supply_date || doc.issue_date;
  await assertPeriodOpen(doc.period_id);
  await assertMonthOpen(unitId, postingDate);

  // Existující zápis samovyměření nepřepisujeme (append-only, § 33a ZoÚ) —
  // oprava se dělá stornem. Duplicitu ale hlásíme, ať uživatel netvoří dvojí daň.
  const existing = await store.get(
    `SELECT p.id FROM posting p
     WHERE p.document_id = ? AND p.accounting_unit_id = ? AND p.description LIKE 'Samovyměření DPH%'
       AND NOT EXISTS (SELECT 1 FROM posting s WHERE s.storno_of_posting_id = p.id)`,
    [documentId, unitId]
  );
  if (existing) {
    const err = new Error(`K dokladu už existuje nestornovaný zápis samovyměření (č. zápisu id ${existing.id}). Opravu proveďte stornem, ne novým zápisem.`);
    err.status = 409;
    throw err;
  }

  const postingNumber = await nextPostingNumber(unitId);
  const description = `Samovyměření DPH (${meta.label}) k dokladu ${doc.doc_number}`;
  await store.run(
    `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [unitId, doc.period_id, postingNumber, documentId, postingDate, description, userId]
  );
  const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;

  await store.run(
    "INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)",
    [postingId, config.input_vat_account_id, "MD", tax]
  );
  await store.run(
    "INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)",
    [postingId, config.output_vat_account_id, "D", tax]
  );

  // Evidence pro DPH (§ 100 ZDPH). Daň na výstupu vzniká vždy; řádek na vstupu
  // jen při přiznaném nároku — jinak by se v přiznání objevil odpočet, o kterém
  // účetní rozhodla, že nepatří.
  const duzp = postingDate;
  const deduction = Number(config.deduction_allowed) === 1;
  await insertLedgerEntry({ doc, direction: "uskutecnene", base, tax, regime, duzp });
  if (deduction) {
    await insertLedgerEntry({ doc, direction: "prijate", base, tax, regime, duzp });
  }

  await writeAuditLog({
    unitId,
    userId,
    action: "INSERT",
    table: "posting",
    entityId: postingId,
    after: { posting_number: postingNumber, vat_regime: regime, base, tax, deduction_allowed: deduction ? 1 : 0 },
  });

  return {
    posting_id: postingId,
    posting_number: postingNumber,
    vat_regime: regime,
    vat_base: base,
    vat_amount: tax,
    deduction_claimed: deduction,
    vat_return_row: config.vat_return_row || null,
  };
}

const KH_THRESHOLD = 10000; // § 100 ZDPH, stejný limit jako routes/vat.js

async function insertLedgerEntry({ doc, direction, base, tax, regime, duzp }) {
  const { country, vatId } = splitVatId(doc.counterparty_dic);
  await store.run(
    `INSERT INTO vat_ledger_entry
       (document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic, duzp,
        requires_individual_kh, vat_regime, counterparty_vat_id, counterparty_country)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [doc.id, direction, base, Number(doc.vat_rate), tax, doc.counterparty_dic || null, duzp,
     base + tax >= KH_THRESHOLD ? 1 : 0, regime, vatId, country]
  );
}

// Souhrnné hlášení pracuje s kódem státu a číslem VAT ODDĚLENĚ (prvky `k_stat`
// a `c_vat` ve schématu dphshv_epo2.xsd), zatímco tuzemské DIČ je v systému
// jedno pole. Rozdělení je čistě textové — dvě písmena předčíslí + zbytek.
function splitVatId(dic) {
  if (!dic) return { country: null, vatId: null };
  const clean = String(dic).replace(/\s+/g, "").toUpperCase();
  const m = clean.match(/^([A-Z]{2})(.+)$/);
  if (!m) return { country: null, vatId: clean };
  return { country: m[1], vatId: m[2] };
}

module.exports = {
  getConfig,
  listConfig,
  configBlockers,
  assertConfigured,
  generateSelfAssessmentPosting,
  splitVatId,
  baseInCzk,
};
