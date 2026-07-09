// =====================================================================
// cnbExchangeRate.js — kurz devizového trhu ČNB (§ 24 odst. 6-7 ZoÚ),
// cache-first přes globální tabulku exchange_rate (viz schema.sql — vědomě
// BEZ accounting_unit_id, veřejná referenční data).
//
// Formát ČNB (ověřeno živě orchestrátorem 2026-07-10, viz flow-state.md
// "PLÁN — Úkol 4" PRŮZKUM): endpoint
//   https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=DD.MM.YYYY
// Tělo: 1. řádek "DD.MM.YYYY #poradi", 2. řádek hlavička
// "země|měna|množství|kód|kurz", pak pipe-delimited řádky, kurz s DESETINNOU
// ČÁRKOU (např. "EMU|euro|1|EUR|24,255"). CZK za 1 jednotku = kurz/množství.
// O víkendu/svátku ČNB SAMA vrátí kurz posledního předchozího pracovního dne
// — ŽÁDNÝ vlastní walk-back tady není potřeba, cache klíčujeme podle
// DOTAZOVANÉHO data (ne podle data v hlavičce odpovědi), ať příští dotaz na
// stejný víkendový den trefí cache rovnou.
// =====================================================================
const store = require("../db");

const CNB_URL = "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt";

function isoToCnbDate(dateISO) {
  const [y, m, d] = dateISO.split("-");
  return `${d}.${m}.${y}`;
}

// Zapíše všechny měny z jedné ČNB odpovědi do cache pod DOTAZOVANÝM datem
// (dateISO), ne pod datem z hlavičky odpovědi (viz komentář výše).
// POZOR: NEVOLÁ store.persist() — getRate() se často volá ZEVNITŘ existující
// store.transaction() (documents.js POST /, bank.js /match, fxRevaluation.js),
// a db-sqlite.js persist() (db.export()) uprostřed otevřené transakce ji sql.js
// nenávratně ukončí (ověřeno — způsobovalo "cannot commit/rollback - no
// transaction is active"). Cache řádek zůstane jen v paměti, dokud ho neuloží
// nejbližší obklopující store.transaction() při vlastním commitu/persist().
async function cacheCnbResponse(dateISO, text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // lines[0] = "DD.MM.YYYY #poradi", lines[1] = hlavička "země|měna|množství|kód|kurz"
  const rows = lines.slice(2);
  const parsed = [];
  for (const line of rows) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const unit = Number(parts[2]);
    const code = parts[3].trim();
    const rate = Number(parts[4].replace(",", "."));
    if (!code || !Number.isFinite(unit) || !Number.isFinite(rate)) continue;
    parsed.push({ code, unit, rate });
  }
  for (const p of parsed) {
    await store.run(
      `INSERT INTO exchange_rate (rate_date, currency, rate, unit, source)
       VALUES (?,?,?,?,'CNB')
       ON CONFLICT (rate_date, currency) DO NOTHING`,
      [dateISO, p.code, p.rate, p.unit]
    );
  }
  return parsed;
}

// getRate('EUR', '2026-01-15') -> { rate, unit } — CZK za `unit` jednotek měny.
async function getRate(currency, dateISO) {
  if (!currency || currency === "CZK") return { rate: 1, unit: 1 };

  const cached = await store.get(
    "SELECT rate, unit FROM exchange_rate WHERE rate_date = ? AND currency = ?",
    [dateISO, currency]
  );
  if (cached) return { rate: cached.rate, unit: cached.unit };

  const res = await fetch(`${CNB_URL}?date=${isoToCnbDate(dateISO)}`);
  if (!res.ok) throw new Error(`ČNB kurzovní lístek nedostupný (HTTP ${res.status}).`);
  const text = await res.text();
  const parsed = await cacheCnbResponse(dateISO, text);

  const found = parsed.find((p) => p.code === currency);
  if (!found) throw new Error(`Měna ${currency} nebyla v odpovědi ČNB nalezena.`);
  return { rate: found.rate, unit: found.unit };
}

module.exports = { getRate };
