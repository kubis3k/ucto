// =====================================================================
// fxRevaluation.js — přecenění otevřených cizoměnových pohledávek/závazků
// k rozvahovému dni (§ 24 odst. 6-7 ZoÚ). Explicitní akce (routes/reports.js
// POST /precenit-kurzove), NE automatika při close/zaverka.pdf — viz
// flow-state.md plán úkolu 4 (ROZHODNUTÍ) pro zdůvodnění.
// =====================================================================
const store = require("../db");
const { nextPostingNumber, writeAuditLog } = require("./core");
const { knihaPohledavkyZavazky } = require("./reports");
const { getRate } = require("./cnbExchangeRate");

const DESCRIPTION_PREFIX = (rozvahovyDen) => `Přecenění k ${rozvahovyDen}`;

// Idempotence: nezaúčtovat 2x ke stejnému dni pro stejný doklad — pozná se
// podle description prefixu "Přecenění k {rozvahovyDen}" na postingu
// navázaném na daný document_id.
async function alreadyRevalued(docId, rozvahovyDen) {
  const existing = await store.get(
    `SELECT id FROM posting WHERE document_id = ? AND description LIKE ?`,
    [docId, DESCRIPTION_PREFIX(rozvahovyDen) + "%"]
  );
  return !!existing;
}

async function preceniOtevrenePohledavkyZavazky(unitId, rozvahovyDen, createdBy) {
  const kniha = await knihaPohledavkyZavazky(unitId);
  const foreign = kniha.filter((r) => r.currency && r.currency !== "CZK");

  const results = [];
  for (const r of foreign) {
    if (await alreadyRevalued(r.document_id, rozvahovyDen)) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: "Již přeceněno k tomuto dni." });
      continue;
    }
    if (!r.fx_rate) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: "Doklad nemá kurz vystavení (fx_rate), nelze přecenit." });
      continue;
    }

    const rateRozvahovyDen = await getRate(r.currency, rozvahovyDen).catch(() => null);
    if (!rateRozvahovyDen) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: "Kurz ČNB k rozvahovému dni se nepodařilo zjistit." });
      continue;
    }

    // FIX (2026-07-14, rozložené platby): přecenit jen nesplacenou částku
    // (r.outstanding_amount), ne celou původní r.total_amount — u dokladu
    // rozloženého na víc plateb by jinak přecenění nadhodnotilo rozdíl o už
    // uhrazenou část.
    const diff = Math.round(
      r.outstanding_amount * (rateRozvahovyDen.rate / (rateRozvahovyDen.unit || 1) - r.fx_rate / (r.fx_rate_unit || 1)) * 100
    ) / 100;
    if (Math.abs(diff) < 0.01) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: "Kurzový rozdíl je nulový." });
      continue;
    }

    const prefix = r.doc_type === "faktura_vydana" ? "311" : "321";
    const linkedLine = await store.get(
      `SELECT pl.account_id FROM posting_line pl
       JOIN posting p ON p.id = pl.posting_id
       JOIN chart_of_accounts coa ON coa.id = pl.account_id
       WHERE p.document_id = ? AND p.accounting_unit_id = ? AND coa.account_number LIKE ?
       LIMIT 1`,
      [r.document_id, unitId, prefix + "%"]
    );
    if (!linkedLine) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: "Doklad ještě není zaúčtovaný (chybí posting_line 311/321)." });
      continue;
    }

    // Stejná znaménková logika jako bank.js POST /:id/match (krok 5 plánu):
    // vydaná — zisk když diff>0 (kurz vzrostl, pohledávka v CZK stoupla) -> MD 311/D 663;
    // přijatá — zrcadlově, zisk když diff<0 -> MD 321/D 663.
    const gain = r.doc_type === "faktura_vydana" ? diff > 0 : diff < 0;
    const fxAccountNumber = gain ? "663" : "563";
    const fxAccount = await store.get(
      "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
      [unitId, fxAccountNumber]
    );
    if (!fxAccount) {
      results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: true, reason: `Účet ${fxAccountNumber} nenalezen v účtovém rozvrhu.` });
      continue;
    }

    const amt = Math.abs(diff);
    const postLines = gain
      ? [{ account_id: linkedLine.account_id, side: "MD", amount: amt }, { account_id: fxAccount.id, side: "D", amount: amt }]
      : [{ account_id: fxAccount.id, side: "MD", amount: amt }, { account_id: linkedLine.account_id, side: "D", amount: amt }];

    const docRow = await store.get("SELECT period_id FROM document WHERE id = ?", [r.document_id]);
    const postingNumber = await nextPostingNumber(unitId);
    await store.run(
      `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [unitId, docRow.period_id, postingNumber, r.document_id, rozvahovyDen, `${DESCRIPTION_PREFIX(rozvahovyDen)} — ${r.doc_number}`, createdBy || null]
    );
    const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
    for (const l of postLines) {
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, l.account_id, l.side, l.amount]);
    }
    await writeAuditLog({
      unitId, userId: createdBy, action: "POST", table: "posting", entityId: postingId,
      after: { kind: "precenení_kurzove", document_id: r.document_id, diff, gain, rozvahovyDen },
    });
    results.push({ document_id: r.document_id, doc_number: r.doc_number, skipped: false, diff, posting_id: postingId });
  }

  return results;
}

module.exports = { preceniOtevrenePohledavkyZavazky };
