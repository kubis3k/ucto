// Katalog režimů plnění pro účely DPH — FÁZE B (přeshraniční DPH).
//
// ČEMU TENTO SOUBOR SLOUŽÍ: pojmenovat situace, které u dokladu mohou nastat,
// a nabídnout je v UI. NIC VÍC.
//
// ČEMU NESLOUŽÍ: rozhodnout, co z které situace právně vyplývá. Sazba, řádek
// přiznání, existence nároku na odpočet, povinnost uvést plnění v souhrnném
// hlášení a účty, na které se daň zaúčtuje — to všechno je obsah tabulky
// `vat_regime_config`, kterou vyplní a potvrdí účetní (viz DPH_ROZHODNUTI.md).
// Dokud řádek konfigurace neexistuje nebo není potvrzený, lib/vatSelfAssessment.js
// odmítne cokoli zaúčtovat. Záměrně: špatně odhadnutý §-mapping v kódu je horší
// než chybějící funkce, protože se tváří jako správný výsledek.
//
// `self_assessment_candidate` NENÍ daňové rozhodnutí — je to jen informace, že
// u tohoto režimu má smysl NABÍDNOUT mechanismus samovyměření (v názvu režimu
// to už je obsaženo). Zda a v jaké výši se skutečně vyměří, plyne z konfigurace.

const REGIMES = [
  {
    key: "tuzemsko_standard",
    label: "Tuzemské plnění (standardní)",
    description: "Dosavadní chování — DPH účtuje a odvádí dodavatel. Výchozí hodnota u všech existujících dokladů.",
    cross_border: false,
    self_assessment_candidate: false,
  },
  {
    key: "reverse_charge_tuzemsko",
    label: "Tuzemský reverse charge",
    description: "Přenesení daňové povinnosti mezi tuzemskými plátci (typicky stavební a montážní práce).",
    cross_border: false,
    self_assessment_candidate: true,
  },
  {
    key: "reverse_charge_sluzba_eu",
    label: "Přijatá služba z EU",
    description: "Služba od osoby registrované k dani v jiném členském státě (Meta, Google Ireland, Stripe apod.).",
    cross_border: true,
    self_assessment_candidate: true,
  },
  {
    key: "reverse_charge_sluzba_3zeme",
    label: "Přijatá služba ze třetí země",
    description: "Služba od osoby ze státu mimo EU (Anthropic, Vercel apod.).",
    cross_border: true,
    self_assessment_candidate: true,
  },
  {
    key: "intrakomunitarni_porizeni_zbozi",
    label: "Pořízení zboží z EU",
    description: "Nákup zboží od osoby registrované k dani v jiném členském státě.",
    cross_border: true,
    self_assessment_candidate: true,
  },
  {
    key: "dodani_zbozi_eu",
    label: "Dodání zboží do EU",
    description: "Vlastní dodání zboží osobě registrované k dani v jiném členském státě.",
    cross_border: true,
    self_assessment_candidate: false,
  },
  {
    key: "sluzba_eu_poskytnuta",
    label: "Poskytnutá služba do EU",
    description: "Vlastní služba osobě registrované k dani v jiném členském státě.",
    cross_border: true,
    self_assessment_candidate: false,
  },
  {
    key: "dovoz",
    label: "Dovoz zboží",
    description: "Zboží ze třetí země propuštěné do volného obchodu.",
    cross_border: true,
    self_assessment_candidate: true,
  },
  {
    key: "vyvoz",
    label: "Vývoz zboží",
    description: "Zboží dodané do třetí země.",
    cross_border: true,
    self_assessment_candidate: false,
  },
  {
    key: "osvobozeno",
    label: "Osvobozené plnění",
    description: "Plnění osvobozené od daně — s nárokem nebo bez nároku na odpočet podle konkrétního titulu.",
    cross_border: false,
    self_assessment_candidate: false,
  },
  {
    key: "mimo_predmet",
    label: "Mimo předmět daně",
    description: "Transakce, která není předmětem DPH.",
    cross_border: false,
    self_assessment_candidate: false,
  },
];

const BY_KEY = new Map(REGIMES.map((r) => [r.key, r]));
const DEFAULT_REGIME = "tuzemsko_standard";

function isKnown(key) {
  return BY_KEY.has(key);
}

function get(key) {
  return BY_KEY.get(key) || null;
}

// Validace hodnoty přicházející z klienta. Migrované SQLite databáze nemají na
// `document.vat_regime` CHECK constraint (ALTER TABLE ho v SQLite doplnit nelze,
// viz db-sqlite.js migrate()), takže tohle je jediná záruka v takové instalaci.
function assertKnown(key) {
  if (!isKnown(key)) {
    throw new Error(`Neznámý režim plnění DPH: ${key}. Povolené hodnoty: ${REGIMES.map((r) => r.key).join(", ")}.`);
  }
  return key;
}

// Normalizace vstupu — prázdná/chybějící hodnota = dosavadní chování.
function normalize(key) {
  if (key === undefined || key === null || key === "") return DEFAULT_REGIME;
  return assertKnown(String(key));
}

module.exports = { REGIMES, DEFAULT_REGIME, isKnown, get, assertKnown, normalize };
