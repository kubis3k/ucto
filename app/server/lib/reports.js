// =====================================================================
// reports.js — portace ../../../db/004_views_vykazy.sql (Hlavní kniha,
// Rozvaha, Výsledovka, sledování obratu pro DPH limit) do JS/SQLite.
// =====================================================================
const store = require("../db");

function accountNaturalBalance(accountId, asOfDate) {
  const acc = store.get(`SELECT account_type FROM chart_of_accounts WHERE id = ?`, [accountId]);
  const sums = store.get(
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
function hlavniKniha(unitId, asOfDate) {
  const rows = store.all(
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

// ROZVAHA (zjednodušený rozsah — mikro účetní jednotka)
function rozvaha(unitId, asOfDate) {
  const accounts = store.all(
    `SELECT id, account_class, account_number, name, account_type
     FROM chart_of_accounts
     WHERE accounting_unit_id = ? AND account_type IN ('rozvahovy_aktivni','rozvahovy_pasivni')
       AND parent_account_id IS NULL
     ORDER BY account_type DESC, account_number`,
    [unitId]
  );
  const polozky = accounts.map((a) => ({
    strana: a.account_type === "rozvahovy_aktivni" ? "AKTIVA" : "PASIVA",
    account_class: a.account_class,
    account_number: a.account_number,
    account_name: a.name,
    zustatek: accountNaturalBalance(a.id, asOfDate),
  }));
  const aktiva = polozky.filter((p) => p.strana === "AKTIVA").reduce((s, p) => s + p.zustatek, 0);
  const pasiva = polozky.filter((p) => p.strana === "PASIVA").reduce((s, p) => s + p.zustatek, 0);
  return { polozky, kontrola: { aktiva_celkem: aktiva, pasiva_celkem: pasiva, rozdil: aktiva - pasiva } };
}

// VÝSLEDOVKA za účetní období — zjednodušený rozsah
function vysledovka(unitId, periodId) {
  const period = store.get(`SELECT start_date, end_date FROM accounting_period WHERE id = ?`, [periodId]);
  if (!period) throw new Error("Účetní období neexistuje.");

  const rows = store.all(
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
    [unitId, period.start_date, period.end_date]
  );
  const polozky = rows.map((r) => ({
    druh: r.account_type === "vysledkovy_naklad" ? "NÁKLAD" : "VÝNOS",
    account_number: r.account_number,
    account_name: r.name,
    castka: r.castka,
  }));
  const vynosy = polozky.filter((p) => p.druh === "VÝNOS").reduce((s, p) => s + p.castka, 0);
  const naklady = polozky.filter((p) => p.druh === "NÁKLAD").reduce((s, p) => s + p.castka, 0);
  return { polozky, vysledek_hospodareni: vynosy - naklady };
}

// Sledování obratu pro DPH limit (2 mil. Kč / 12 po sobě jdoucích měsíců)
function obratDph(unitId) {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

  const row = store.get(
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

// Kniha pohledávek a závazků — nesplacené faktury
function knihaPohledavkyZavazky(unitId) {
  return store.all(
    `SELECT d.id AS document_id, d.doc_type, d.doc_number, c.name AS protistrana,
            d.issue_date, d.due_date, d.total_amount, d.status,
            CAST(julianday('now') - julianday(d.due_date) AS INTEGER) AS dni_po_splatnosti
     FROM document d
     LEFT JOIN contact c ON c.id = d.contact_id
     WHERE d.accounting_unit_id = ? AND d.doc_type IN ('faktura_vydana','faktura_prijata')
       AND d.status <> 'stornovany'
       AND d.id NOT IN (SELECT matched_document_id FROM bank_statement_line WHERE matched_document_id IS NOT NULL)
     ORDER BY d.due_date`,
    [unitId]
  );
}

module.exports = { hlavniKniha, rozvaha, vysledovka, obratDph, knihaPohledavkyZavazky, accountNaturalBalance };
