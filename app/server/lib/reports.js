// =====================================================================
// reports.js — portace ../../../db/004_views_vykazy.sql (Hlavní kniha,
// Rozvaha, Výsledovka, sledování obratu pro DPH limit) do JS/SQLite.
// =====================================================================
const store = require("../db");
const {
  ROZVAHA_ROWS, ACCOUNT_TO_ROZVAHA_ROW,
  VYSLEDOVKA_ROWS, ACCOUNT_TO_VYSLEDOVKA_ROW,
  resolveRow,
} = require("./statementMapping");

async function accountNaturalBalance(accountId, asOfDate) {
  const acc = await store.get(`SELECT account_type FROM chart_of_accounts WHERE id = ?`, [accountId]);
  const sums = await store.get(
    `SELECT
       COALESCE(SUM(CASE WHEN pl.side='MD' THEN pl.amount ELSE 0 END),0) AS md,
       COALESCE(SUM(CASE WHEN pl.side='D'  THEN pl.amount ELSE 0 END),0) AS d
     FROM posting_line pl JOIN posting p ON p.id = pl.posting_id
     WHERE pl.account_id = ? AND p.posting_date <= ?`,
    [accountId, asOfDate]
  );
  if (acc.account_type === "rozvahovy_aktivni" || acc.account_type === "vysledkovy_naklad") {
    return sums.md - sums.d;
  }
  return sums.d - sums.md;
}

// HLAVNÍ KNIHA — pohyby a průběžný zůstatek po účtech
async function hlavniKniha(unitId, asOfDate) {
  const rows = await store.all(
    `SELECT coa.id AS account_id, coa.account_number, coa.name AS account_name, coa.account_type,
            p.posting_date, p.posting_number, p.description, pl.side, pl.amount
     FROM posting_line pl
     JOIN posting p ON p.id = pl.posting_id
     JOIN chart_of_accounts coa ON coa.id = pl.account_id
     WHERE coa.accounting_unit_id = ? AND p.posting_date <= ?
     ORDER BY coa.account_number, p.posting_date, p.posting_number`,
    [unitId, asOfDate]
  );
  const running = {};
  return rows.map((r) => {
    const natural = r.account_type === "rozvahovy_aktivni" || r.account_type === "vysledkovy_naklad";
    const delta = natural ? (r.side === "MD" ? r.amount : -r.amount) : (r.side === "D" ? r.amount : -r.amount);
    running[r.account_id] = (running[r.account_id] || 0) + delta;
    return {
      account_number: r.account_number,
      account_name: r.account_name,
      posting_date: r.posting_date,
      posting_number: r.posting_number,
      description: r.description,
      md_amount: r.side === "MD" ? r.amount : null,
      d_amount: r.side === "D" ? r.amount : null,
      running_balance: running[r.account_id],
    };
  });
}

// ROZVAHA (zjednodušený rozsah — mikro účetní jednotka, agregováno podle
// vyhlášky č. 500/2002 Sb., příloha č. 1 — viz lib/statementMapping.js
// pro mapu účet->řádek a právní upozornění o nutném ověření účetní firmou).
async function rozvaha(unitId, asOfDate) {
  const accounts = await store.all(
    `SELECT id, account_class, account_number, name, account_type
     FROM chart_of_accounts
     WHERE accounting_unit_id = ? AND account_type IN ('rozvahovy_aktivni','rozvahovy_pasivni')
       AND parent_account_id IS NULL
     ORDER BY account_type DESC, account_number`,
    [unitId]
  );

  // Zůstatky za jednotlivé účty (surová data — NEZÁVISLÉ na mapování řádků,
  // aby kontrola AKTIVA=PASIVA fungovala i kdyby v mapě byla chyba/mezera).
  const detail = [];
  for (const a of accounts) {
    detail.push({
      strana: a.account_type === "rozvahovy_aktivni" ? "AKTIVA" : "PASIVA",
      account_number: a.account_number,
      account_name: a.name,
      zustatek: await accountNaturalBalance(a.id, asOfDate),
    });
  }
  let aktiva_celkem = detail.filter((p) => p.strana === "AKTIVA").reduce((s, p) => s + p.zustatek, 0);
  let pasiva_celkem = detail.filter((p) => p.strana === "PASIVA").reduce((s, p) => s + p.zustatek, 0);

  // Agregace do oficiálních řádků výkazu.
  const soucty = {};
  for (const d of detail) {
    const rowCode = resolveRow(d.account_number, ACCOUNT_TO_ROZVAHA_ROW) || (d.strana === "AKTIVA" ? "AKTIVA.X" : "PASIVA.X");
    soucty[rowCode] = (soucty[rowCode] || 0) + d.zustatek;
  }

  // A.V. "Výsledek hospodaření běžného účetního období" — dokud neproběhne
  // roční uzávěrka (§ 29-30 ZoÚ, závěrkové účty 701/702/710), zisk/ztráta
  // BĚŽNÉHO období nejsou promítnuty žádným zápisem do vlastního kapitálu
  // (posting/postings.js "close" jen mění status období, nezaúčtovává).
  // Interní/průběžná rozvaha proto řádek A.V. dopočítá živě z výsledovky
  // za období pokrývající asOfDate — to je stejný postup, jaký by "ručně"
  // udělal účetní u nezávěrkové rozvahy v průběhu roku. Uzavřené minulé
  // roky, které NEBYLY promítnuty do 428/429 zápisem, jsou mimo rozsah
  // tohoto úkolu (samostatný problém — automatizace roční uzávěrky).
  const currentPeriod = await store.get(
    `SELECT id, start_date, end_date FROM accounting_period
     WHERE accounting_unit_id = ? AND start_date <= ? AND end_date >= ? ORDER BY fiscal_year DESC LIMIT 1`,
    [unitId, asOfDate, asOfDate]
  );
  if (currentPeriod) {
    const { vysledek_hospodareni } = await vysledovka(unitId, currentPeriod.id, asOfDate);
    soucty["A.V."] = (soucty["A.V."] || 0) + vysledek_hospodareni;
    pasiva_celkem += vysledek_hospodareni;
  }

  const polozky = ROZVAHA_ROWS
    .map((r) => ({ strana: r.strana, code: r.code, label: r.label, castka: soucty[r.code] || 0 }))
    .filter((p) => p.castka !== 0 || !p.code.endsWith(".X")); // "Nezařazeno" se zobrazí, jen když v ní něco je

  return {
    polozky,
    detail, // účet-po-účtu podklad pro audit/kontrolu mapování — NENÍ v CSV exportu
    kontrola: { aktiva_celkem, pasiva_celkem, rozdil: aktiva_celkem - pasiva_celkem },
  };
}

// VÝSLEDOVKA za účetní období — zjednodušený rozsah, druhové členění podle
// vyhlášky č. 500/2002 Sb., příloha č. 2 (viz lib/statementMapping.js).
// `asOfDate` (nepovinné) omezí konec rozsahu na kratší datum než konec
// období — používá rozvaha() pro živý dopočet průběžného výsledku
// hospodaření k libovolnému dni v rámci otevřeného období.
async function vysledovka(unitId, periodId, asOfDate) {
  const period = await store.get(`SELECT start_date, end_date FROM accounting_period WHERE id = ?`, [periodId]);
  if (!period) throw new Error("Účetní období neexistuje.");
  const rangeEnd = asOfDate && asOfDate < period.end_date ? asOfDate : period.end_date;

  const rows = await store.all(
    `SELECT coa.account_type, coa.account_number, coa.name,
            SUM(CASE
                  WHEN coa.account_type='vysledkovy_naklad' AND pl.side='MD' THEN pl.amount
                  WHEN coa.account_type='vysledkovy_vynos'  AND pl.side='D'  THEN pl.amount
                  ELSE 0 END) AS castka
     FROM posting_line pl
     JOIN posting p ON p.id = pl.posting_id
     JOIN chart_of_accounts coa ON coa.id = pl.account_id
     WHERE coa.accounting_unit_id = ? AND coa.account_type IN ('vysledkovy_naklad','vysledkovy_vynos')
       AND p.posting_date BETWEEN ? AND ? AND coa.parent_account_id IS NULL
     GROUP BY coa.account_type, coa.account_number, coa.name
     ORDER BY coa.account_type, coa.account_number`,
    [unitId, period.start_date, rangeEnd]
  );
  const detail = rows.map((r) => ({
    druh: r.account_type === "vysledkovy_naklad" ? "NÁKLAD" : "VÝNOS",
    account_number: r.account_number,
    account_name: r.name,
    castka: r.castka,
  }));

  const soucty = {};
  let nezarazeno = 0;
  for (const d of detail) {
    const rowCode = resolveRow(d.account_number, ACCOUNT_TO_VYSLEDOVKA_ROW);
    if (!rowCode) { nezarazeno += d.druh === "NÁKLAD" ? d.castka : -d.castka; continue; }
    soucty[rowCode] = (soucty[rowCode] || 0) + d.castka;
  }

  // Dopočítat řádky v pořadí (formula-řádky potřebují už spočtené předchozí).
  const values = {};
  const polozky = [];
  for (const r of VYSLEDOVKA_ROWS) {
    const castka = r.druh === "SUM" ? r.formula(values) : (soucty[r.code] || 0);
    values[r.code] = castka;
    polozky.push({ code: r.code, label: r.label, druh: r.druh, castka });
  }
  if (Math.abs(nezarazeno) > 0.01) {
    polozky.push({ code: "X.", label: "Nezařazeno (doplnit mapu)", druh: "NÁKLAD", castka: nezarazeno });
  }

  return {
    polozky,
    detail,
    vysledek_hospodareni: values["***"] - nezarazeno,
  };
}

// Sledování obratu pro DPH limit (2 mil. Kč / 12 po sobě jdoucích měsíců)
async function obratDph(unitId) {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

  const row = await store.get(
    `SELECT COALESCE(SUM(total_amount),0) AS obrat
     FROM document
     WHERE accounting_unit_id = ? AND doc_type = 'faktura_vydana' AND status <> 'stornovany' AND issue_date >= ?`,
    [unitId, cutoff]
  );
  const obrat = row.obrat;
  return {
    accounting_unit_id: Number(unitId),
    obrat_12m: obrat,
    blizi_se_limitu_dph: obrat >= 2000000,
    zbyva_do_limitu: 2000000 - obrat,
  };
}

// Kniha pohledávek a závazků — nesplacené faktury. Dny po splatnosti se
// počítají v JS, ne v SQL (julianday() je jen SQLite, Postgres ho nemá —
// takhle to funguje shodně na obou dialektech beze změny SQL).
//
// FIX (2026-07-14, rozložené platby): doklad se dřív z reportu vyřadil, jakmile
// měl JAKÝKOLI spárovaný bankovní řádek — ale bank.js /:id/match teď umožňuje
// spárovat víc řádků na jeden doklad (smlouva rozdělená na víc plateb), takže
// jeden spárovaný řádek už neznamená "uhrazeno". Místo toho se sčítá součet
// VŠECH spárovaných řádků na doklad a porovnává s očekávanou částkou (CZK
// ekvivalent při cizí měně, přepočteno kurzem k vystavení jako přiblížení —
// stejná logika jako czkIssue v bank.js).
async function knihaPohledavkyZavazky(unitId) {
  const rows = await store.all(
    `SELECT d.id AS document_id, d.doc_type, d.doc_number, c.name AS protistrana,
            d.issue_date, d.due_date, d.total_amount, d.status, d.currency, d.fx_rate, d.fx_rate_unit,
            COALESCE((SELECT SUM(ABS(amount)) FROM bank_statement_line WHERE matched_document_id = d.id), 0) AS uhrazeno
     FROM document d
     LEFT JOIN contact c ON c.id = d.contact_id
     WHERE d.accounting_unit_id = ? AND d.doc_type IN ('faktura_vydana','faktura_prijata')
       AND d.status <> 'stornovany'
     ORDER BY d.due_date`,
    [unitId]
  );
  const today = new Date(new Date().toDateString());
  return rows
    .map((r) => {
      const isForeign = !!(r.currency && r.currency !== "CZK");
      const expected = isForeign && r.fx_rate
        ? Math.round(r.total_amount * (r.fx_rate / (r.fx_rate_unit || 1)) * 100) / 100
        : r.total_amount;
      const zbyva = Math.round((expected - r.uhrazeno) * 100) / 100;
      // Nesplacená částka v PŮVODNÍ měně dokladu (ne v CZK) — potřebné pro
      // přecenění k rozvahovému dni (fxRevaluation.js), které smí přecenit jen
      // to, co ještě skutečně dlužíme, ne celou původní částku dokladu, pokud
      // je doklad rozložený na víc plateb a část už je uhrazená.
      const outstandingAmount = isForeign && expected > 0 ? Math.round((r.total_amount * zbyva / expected) * 100) / 100 : r.total_amount;
      return { ...r, expected_czk: expected, zbyva, outstanding_amount: outstandingAmount };
    })
    .filter((r) => r.zbyva > 0.02)
    .map((r) => ({
      ...r,
      dni_po_splatnosti: r.due_date ? Math.floor((today - new Date(r.due_date)) / 86400000) : null,
    }));
}

// Automaticky dopočítaná data pro přílohu k účetní závěrce (§ 18 ZoÚ) —
// majetek (stejný výpočet jako routes/assets.js:7-16) a pohledávky/závazky
// po splatnosti (knihaPohledavkyZavazky() filtr dni_po_splatnosti > 0,
// rozdělené podle doc_type). Vše se počítá živě, NEUKLÁDÁ se (viz plán
// úkolu 3 v flow-state.md — auto data by jinak držela nekonzistentní kopii).
async function prilohaAutoData(unitId, periodId, asOfDate) {
  const assets = await store.all(
    "SELECT * FROM fixed_asset WHERE accounting_unit_id = ? ORDER BY acquisition_date",
    [unitId]
  );
  const majetekSeznam = [];
  let pocCenaCelkem = 0, opravkyCelkem = 0, zustatekCelkem = 0;
  for (const a of assets) {
    const dep = await store.get(
      "SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entry WHERE fixed_asset_id = ?",
      [a.id]
    );
    const netBookValue = a.acquisition_cost - dep.total;
    majetekSeznam.push({
      name: a.name,
      acquisition_cost: a.acquisition_cost,
      acquisition_date: a.acquisition_date,
      accumulated_depreciation: dep.total,
      net_book_value: netBookValue,
    });
    pocCenaCelkem += a.acquisition_cost;
    opravkyCelkem += dep.total;
    zustatekCelkem += netBookValue;
  }

  const kniha = await knihaPohledavkyZavazky(unitId);
  const poSplatnosti = kniha.filter((r) => (r.dni_po_splatnosti || 0) > 0);
  const pohledavky = poSplatnosti.filter((r) => r.doc_type === "faktura_vydana");
  const zavazky = poSplatnosti.filter((r) => r.doc_type === "faktura_prijata");

  return {
    majetek: {
      seznam: majetekSeznam,
      souhrn: {
        poc_cena_celkem: pocCenaCelkem,
        opravky_celkem: opravkyCelkem,
        zustatek_celkem: zustatekCelkem,
      },
    },
    poSplatnosti: {
      pohledavky,
      zavazky,
      souhrn: {
        pohledavky_celkem: pohledavky.reduce((s, r) => s + r.total_amount, 0),
        zavazky_celkem: zavazky.reduce((s, r) => s + r.total_amount, 0),
      },
    },
  };
}

module.exports = { hlavniKniha, rozvaha, vysledovka, obratDph, knihaPohledavkyZavazky, accountNaturalBalance, prilohaAutoData };
