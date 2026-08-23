const express = require("express");
const crypto = require("crypto");
const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen } = require("../lib/core");
const { createBankStatementLine } = require("../lib/bankMovements");
const { resolvePeriodForDate } = require("../lib/recurring");
const { getRate } = require("../lib/cnbExchangeRate");
const router = express.Router();

// Vestavěný slovník klíčových slov — výchozí návrh kategorie, dokud si
// systém nevytvoří vlastní naučená pravidla z reálného zaúčtování (viz níže).
const KEYWORD_HINTS = [
  { pattern: /popla|vedení účtu/i, account_number: "568" },
  { pattern: /úrok/i, account_number: "662" },
  { pattern: /nájem|pronáj/i, account_number: "518" },
  { pattern: /honorář|dj\b|zvukař/i, account_number: "518" },
  { pattern: /\bosa\b/i, account_number: "531" },
];
function normalizeParty(name) { return (name || "").trim().toLowerCase().slice(0, 60); }

// GET /api/bank?unit=1 — bankovní/pokladní řádky s příznakem spárování
router.get("/", async (req, res) => {
  try {
    res.json(await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? ORDER BY statement_date DESC",
      [req.query.unit]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/bank/:id — oprava řádku výpisu (např. špatně naparsovaná/naimportovaná
// částka). Povoleno jen dokud je řádek nespárovaný — po spárování by úprava částky
// rozjela už vzniklé zaúčtování (kurzový rozdíl, marže banky) mimo realitu.
router.patch("/:id", async (req, res) => {
  const unitId = req.user.accountingUnitId;
  const { amount, statement_date, counterparty_name, variable_symbol } = req.body;
  try {
    const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, unitId]);
    if (!line) return res.status(404).json({ error: "Řádek výpisu nenalezen" });
    if (line.matched_document_id) return res.status(400).json({ error: "Řádek je už spárovaný s dokladem — úprava částky by neodpovídala zaúčtování. Zrušte párování, nebo opravte ručním zaúčtováním." });

    await store.run(
      `UPDATE bank_statement_line SET
        amount = COALESCE(?, amount),
        statement_date = COALESCE(?, statement_date),
        counterparty_name = COALESCE(?, counterparty_name),
        variable_symbol = COALESCE(?, variable_symbol)
       WHERE id = ? AND accounting_unit_id = ?`,
      [amount === undefined ? null : amount, statement_date || null, counterparty_name === undefined ? null : counterparty_name,
       variable_symbol === undefined ? null : variable_symbol, req.params.id, unitId]
    );
    store.persist();
    res.json(await store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/bank/:id — smazání chybně zadaného/naimportovaného řádku (duplicita,
// testovací data). Povoleno jen dokud je řádek nespárovaný a nezaúčtovaný — jakmile
// vznikne posting, jde o skutečný účetní zápis a ten je append-only (storno, ne smazání).
router.delete("/:id", async (req, res) => {
  const unitId = req.user.accountingUnitId;
  try {
    const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, unitId]);
    if (!line) return res.status(404).json({ error: "Řádek výpisu nenalezen" });
    if (line.matched_document_id || line.posting_id) return res.status(400).json({ error: "Řádek je už spárovaný/zaúčtovaný — nelze smazat, jen stornovat příslušný zápis." });

    await store.run("DELETE FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, unitId]);
    store.persist();
    await writeAuditLog({ unitId, userId: req.user.id, action: "DELETE", table: "bank_statement_line", entityId: req.params.id, before: line });
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/bank/import — ruční zadání / import řádků výpisu (kap. 5.4 brief — CSV v1. fázi mimo rozsah,
// zde zadání strukturovaných řádků, které frontend může naplnit i z nahraného CSV)
//
// FIX (2026-07-20, opakovaný/celý-historie CSV import): CSV export z banky
// nemá vlastní unikátní ID (na rozdíl od e-mailového/Stripe importu, tam
// idempotenci řeší external_ref v createBankStatementLine) — když se stejný
// nebo překrývající se výpis nahraje podruhé (např. "celá historie" po
// předchozím dílčím importu), řádky bez external_ref by se vložily znovu
// jako duplicity. Řádek se tedy PŘESKOČÍ, pokud už existuje jiný se stejným
// (accounting_unit_id, bank_account, statement_date, amount) — to je jediná
// spolehlivá shoda, kterou z prostého CSV (datum+částka) máme.
router.post("/import", async (req, res) => {
  const { accounting_unit_id, bank_account, lines } = req.body;
  if (!Array.isArray(lines)) return res.status(400).json({ error: "Očekává se pole 'lines'." });
  try {
    const result = await store.transaction(async () => {
      const inserted = [];
      let skipped = 0;
      for (const l of lines) {
        // Starší importy external_ref neukládaly. Nový CSV už ID transakce
        // má, ale při prvním opakovaném importu musíme porovnat i historický
        // fingerprint, jinak se celá stará historie vloží podruhé.
        const existing = l.external_ref
          ? await store.get(
              `SELECT id FROM bank_statement_line WHERE accounting_unit_id = ? AND
                 (external_ref = ? OR (external_ref IS NULL AND bank_account = ? AND statement_date = ? AND amount = ?))`,
              [accounting_unit_id, l.external_ref, bank_account, l.statement_date, l.amount]
            )
          : await store.get(
              `SELECT id FROM bank_statement_line WHERE accounting_unit_id = ? AND bank_account = ? AND statement_date = ? AND amount = ?`,
              [accounting_unit_id, bank_account, l.statement_date, l.amount]
            );
        if (existing) { skipped += 1; continue; }
        inserted.push(await createBankStatementLine({
          unitId: accounting_unit_id,
          bankAccount: bank_account,
          date: l.statement_date,
          amount: l.amount,
          counterpartyName: l.counterparty_name,
          variableSymbol: l.variable_symbol,
          externalRef: l.external_ref,
        }));
      }
      return { inserted, skipped };
    });
    res.status(201).json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Maximální reálný rozptyl mezi kurzem ČNB (referenční) a komerčním kurzem
// banky při skutečné konverzi měny — běžně 1-5 %. 10% je bezpečná horní mez,
// která pokryje i horší kurzy, ale pořád spolehlivě odchytí skutečnou částečnou
// úhradu nebo spárování s nesprávným dokladem (ty bývají o desítky procent mimo).
const FX_BANK_MARGIN_TOLERANCE = 0.10;

// Zapíše vyrovnávací zápis (kurzový rozdíl NEBO bankovní kurzová marže) proti
// stejnému účtu pohledávky/závazku (311/321) napojenému na doklad. Sdílená
// znaménková logika pro obě odchylky — jen jiné cílové účty a popisek.
async function postFxAdjustment({ unitId, doc, line, diff, gainAccountNumber, lossAccountNumber, label, createdBy }) {
  if (Math.abs(diff) < 0.01) return null;
  const prefix = doc.doc_type === "faktura_vydana" ? "311" : "321";
  const linkedLine = await store.get(
    `SELECT pl.account_id FROM posting_line pl
     JOIN posting p ON p.id = pl.posting_id
     JOIN chart_of_accounts coa ON coa.id = pl.account_id
     WHERE p.document_id = ? AND p.accounting_unit_id = ? AND coa.account_number LIKE ?
     LIMIT 1`,
    [doc.id, unitId, prefix + "%"]
  );
  if (!linkedLine) return null;

  // Vydaná (pohledávka 311) — zisk když diff>0 (dostali jsme/dostaneme víc, než
  // jsme čekali) -> MD 311/D zisk. Přijatá (závazek 321) je zrcadlová — zisk
  // když diff<0 (zaplatili jsme míň, než jsme dlužili) -> MD 321/D zisk.
  const gain = doc.doc_type === "faktura_vydana" ? diff > 0 : diff < 0;
  const account = await store.get(
    "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
    [unitId, gain ? gainAccountNumber : lossAccountNumber]
  );
  if (!account) return null;

  const amt = Math.abs(diff);
  const postLines = gain
    ? [{ account_id: linkedLine.account_id, side: "MD", amount: amt }, { account_id: account.id, side: "D", amount: amt }]
    : [{ account_id: account.id, side: "MD", amount: amt }, { account_id: linkedLine.account_id, side: "D", amount: amt }];

  const postingNumber = await nextPostingNumber(unitId);
  await store.run(
    `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
     VALUES (?,?,?,?,?,?,?)`,
    [unitId, doc.period_id, postingNumber, doc.id, line.statement_date, `${label} k úhradě ${doc.doc_number}`, createdBy || null]
  );
  const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
  for (const l of postLines) {
    await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, l.account_id, l.side, l.amount]);
  }
  const posting = await store.get("SELECT * FROM posting WHERE id = ?", [postingId]);
  await writeAuditLog({
    unitId, userId: createdBy, action: "POST", table: "posting", entityId: postingId,
    after: { kind: label, document_id: doc.id, diff, gain },
  });
  return posting;
}

// POST /api/bank/:id/match — spárování řádku výpisu s dokladem (faktura/pokladní doklad).
// FIX (critic 2026-07-09): scope na accounting_unit_id (IDOR).
// FIX (úkol 4, kurzové rozdíly): u cizoměnového dokladu se částka pohybu (VŽDY
// v CZK) porovnává s CZK ekvivalentem dokladu K DATU ÚHRADY (kurz ČNB toho dne),
// ne s raw total_amount v cizí měně. Pokud se kurz vystavení a úhrady liší,
// vygeneruje se navíc vyrovnávací zápis kurzového rozdílu (563/663 proti 311/321).
// FIX (2026-07-13): banka reálně směňuje za VLASTNÍ komerční kurz, ne za kurz
// ČNB — přesná shoda na 0.01 Kč je tedy pro cizoměnové doklady nereálná (viz
// příklad RB vs. ČNB, rozdíl ~3,4 %). Tolerance FX_BANK_MARGIN_TOLERANCE a
// rozdíl (skutečná částka banky vs. ČNB kurz k datu úhrady) se zaúčtuje zvlášť
// jako "kurzová marže banky" (568/668), odděleně od kurzového rozdílu
// vystavení→úhrada (563/663) — kurzový rozdíl je posun kurzu ČNB v čase, marže
// banky je cena za směnu u konkrétní banky, není to kurzový rozdíl ve smyslu zákona.
// FIX (2026-07-14, rozložené platby): jeden doklad (smlouva/faktura) může být
// uhrazen VÍCE bankovními pohyby (např. smlouva na 5900 Kč zaplacená jako
// 5000+900 Kč). Místo požadavku na přesnou shodu s CELOU částkou dokladu se
// teď sčítá součet VŠECH už spárovaných řádků + tento řádek a porovnává se
// s očekávanou částkou — odmítne se jen PŘEPLATEK nad toleranci, podplatek
// (další platba doplní zbytek) je vždy v pořádku. Kurzové vyrovnání (FX
// rozdíl/marže) se počítá jen na řádku, který doklad DOPLATÍ do celé částky,
// ne na každé dílčí platbě zvlášť.
router.post("/:id/match", async (req, res) => {
  const { document_id, created_by } = req.body;
  const unitId = req.user.accountingUnitId;
  try {
    const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, unitId]);
    if (!line) return res.status(404).json({ error: "Řádek výpisu nenalezen" });
    const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [document_id, unitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    if (line.posting_id) return res.status(400).json({ error: "Bankovní pohyb je již zaúčtovaný." });

    // Banka je aktivní účet: příjem = MD 221, výdej = D 221.
    // Vydaná faktura se smí párovat jen s příjmem (221/311), přijatá
    // jen s výdejem (321/221). Dříve match pouze uložil vazbu na doklad
    // a nevytvořil žádný zápis úhrady, takže hlavní kniha banku ignorovala.
    if (doc.doc_type === "faktura_vydana" && Number(line.amount) <= 0) {
      return res.status(400).json({ error: "Vydanou fakturu lze spárovat pouze s příchozí platbou." });
    }
    if (doc.doc_type === "faktura_prijata" && Number(line.amount) >= 0) {
      return res.status(400).json({ error: "Přijatou fakturu lze spárovat pouze s odchozí platbou." });
    }

    const isForeign = !!(doc.currency && doc.currency !== "CZK");
    let czkPay = doc.total_amount;
    let czkIssue = doc.total_amount;
    let expected = doc.total_amount;

    if (isForeign) {
      const ratePay = await getRate(doc.currency, line.statement_date).catch(() => null);
      if (!ratePay) {
        return res.status(400).json({ error: `Kurz ${doc.currency} k datu ${line.statement_date} se nepodařilo zjistit z ČNB — párování cizoměnového dokladu nelze provést.` });
      }
      czkPay = Math.round(doc.total_amount * (ratePay.rate / (ratePay.unit || 1)) * 100) / 100;
      if (doc.fx_rate) czkIssue = Math.round(doc.total_amount * (doc.fx_rate / (doc.fx_rate_unit || 1)) * 100) / 100;
      expected = czkPay;
    }

    const already = await store.get(
      `SELECT COALESCE(SUM(ABS(amount)),0) AS sum FROM bank_statement_line
       WHERE matched_document_id = ? AND accounting_unit_id = ? AND id <> ?`,
      [document_id, unitId, req.params.id]
    );
    const alreadyMatched = Math.round(Number(already.sum) * 100) / 100;
    const newTotal = Math.round((alreadyMatched + Math.abs(line.amount)) * 100) / 100;

    // Tolerance přeplatku: u cizoměnových dokladů širší (marže banky), u CZK
    // jen zaokrouhlení na haléře. Podplatek nikdy neodmítáme — to je přesně
    // rozložená platba, další řádek doplní zbytek.
    const overshootTolerance = isForeign ? expected * FX_BANK_MARGIN_TOLERANCE : 0.02;
    if (newTotal - expected > overshootTolerance) {
      const zbyva = Math.max(0, Math.round((expected - alreadyMatched) * 100) / 100);
      return res.status(400).json({
        error: `Částka pohybu (${Math.abs(line.amount)} Kč) by spolu s už spárovanými platbami (${alreadyMatched} Kč) přesáhla částku dokladu (${expected} Kč i s tolerancí) — zbývá uhradit ${zbyva} Kč. Zkontrolujte částku nebo vyberte jiný doklad.`,
      });
    }
    const fullyPaid = expected - newTotal <= overshootTolerance;

    // FIX (A3): párování cizoměnového dokladu generuje účetní zápisy (kurzový
    // rozdíl, marže banky), takže musí respektovat zámek období i měsíce —
    // dřív tady kontrola chyběla úplně.
    await assertPeriodOpen(doc.period_id);
    await assertMonthOpen(unitId, line.statement_date);

    const result = await store.transaction(async () => {
      const bankAccount = await store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
        [unitId, line.bank_account]
      );
      if (!bankAccount) throw new Error(`Účet ${line.bank_account} nenalezen v účtovém rozvrhu.`);
      const settlementNumber = doc.doc_type === "faktura_vydana" ? "311" : "321";
      const settlementAccount = await store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
        [unitId, settlementNumber]
      );
      if (!settlementAccount) throw new Error(`Účet ${settlementNumber} nenalezen v účtovém rozvrhu.`);

      const paymentPeriod = await resolvePeriodForDate(unitId, line.statement_date);
      if (!paymentPeriod) throw new Error(`Pro datum ${line.statement_date} neexistuje účetní období.`);
      await assertPeriodOpen(paymentPeriod.id);
      const paidAmount = Math.abs(Number(line.amount));
      const postingNumber = await nextPostingNumber(unitId);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [unitId, paymentPeriod.id, postingNumber, doc.id, line.statement_date,
         `Úhrada ${doc.doc_number} — ${line.counterparty_name || line.bank_account}`, created_by || req.user.id]
      );
      const settlementPostingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      const settlementLines = Number(line.amount) > 0
        ? [[bankAccount.id, "MD"], [settlementAccount.id, "D"]]
        : [[settlementAccount.id, "MD"], [bankAccount.id, "D"]];
      for (const [accountId, side] of settlementLines) {
        await store.run(
          "INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)",
          [settlementPostingId, accountId, side, paidAmount]
        );
      }
      await store.run(
        "UPDATE bank_statement_line SET matched_document_id = ?, posting_id = ? WHERE id = ? AND accounting_unit_id = ?",
        [document_id, settlementPostingId, req.params.id, unitId]
      );
      await writeAuditLog({
        unitId, userId: created_by || req.user.id, action: "POST", table: "bank_statement_line", entityId: line.id,
        after: { matched_document_id: document_id, posting_id: settlementPostingId },
      });

      let fxPosting = null;
      let marginPosting = null;
      // Kurzové vyrovnání jen na řádku, který doklad doplácí do celé částky —
      // na dílčích platbách před tím ještě neznáme finální rozdíl.
      if (isForeign && doc.fx_rate && fullyPaid) {
        fxPosting = await postFxAdjustment({
          unitId, doc, line, diff: Math.round((czkPay - czkIssue) * 100) / 100,
          gainAccountNumber: "663", lossAccountNumber: "563", label: "Kurzový rozdíl", createdBy: created_by,
        });
        marginPosting = await postFxAdjustment({
          unitId, doc, line, diff: Math.round((newTotal - czkPay) * 100) / 100,
          gainAccountNumber: "668", lossAccountNumber: "568", label: "Kurzová marže banky", createdBy: created_by,
        });
      }
      return {
        line: await store.get("SELECT * FROM bank_statement_line WHERE id = ?", [req.params.id]),
        settlement_posting_id: settlementPostingId,
        fx_posting: fxPosting,
        margin_posting: marginPosting,
        already_matched: alreadyMatched,
        new_total: newTotal,
        expected,
        fully_paid: fullyPaid,
      };
    });
    store.persist();
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/bank/suggest-matches?unit=1 — automatický návrh párování podle VS a částky
router.get("/suggest-matches", async (req, res) => {
  try {
    const unmatched = await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND matched_document_id IS NULL",
      [req.query.unit]
    );
    const suggestions = [];
    for (const line of unmatched) {
      const candidate = await store.get(
        `SELECT * FROM document
         WHERE accounting_unit_id = ? AND status <> 'stornovany'
           AND (variable_symbol = ? OR ABS(total_amount - ABS(?)) < 0.01)
         LIMIT 1`,
        [req.query.unit, line.variable_symbol, line.amount]
      );
      if (candidate) suggestions.push({ bank_line: line, suggested_document: candidate });
    }
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/bank/suggest-categories?unit=1 — pro pohyby bez dokladu (poplatky,
// úroky...) navrhne účet: nejdřív podle naučeného pravidla (bank_category_rule),
// jinak podle vestavěného slovníku klíčových slov. Navrhuje jen účty, které
// v účtovém rozvrhu této jednotky skutečně existují.
router.get("/suggest-categories", async (req, res) => {
  try {
    const unit = req.query.unit;
    const unmatched = await store.all(
      "SELECT * FROM bank_statement_line WHERE accounting_unit_id = ? AND matched_document_id IS NULL AND posting_id IS NULL",
      [unit]
    );
    const accounts = await store.all("SELECT id, account_number FROM chart_of_accounts WHERE accounting_unit_id = ?", [unit]);
    const byNumber = Object.fromEntries(accounts.map((a) => [a.account_number, a]));
    const rules = await store.all("SELECT * FROM bank_category_rule WHERE accounting_unit_id = ?", [unit]);
    const byParty = Object.fromEntries(rules.map((r) => [r.match_text, r]));

    const suggestions = [];
    for (const line of unmatched) {
      const party = normalizeParty(line.counterparty_name);
      let account = null, source = null;
      const rule = party && byParty[party];
      if (rule) { account = accounts.find((a) => a.id === rule.account_id); source = "naučené pravidlo"; }
      if (!account) {
        const hint = KEYWORD_HINTS.find((h) => h.pattern.test(line.counterparty_name || ""));
        if (hint && byNumber[hint.account_number]) { account = byNumber[hint.account_number]; source = "klíčové slovo"; }
      }
      if (account) suggestions.push({ bank_line_id: line.id, account_id: account.id, account_number: account.account_number, source });
    }
    res.json(suggestions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/:id/quick-post — přímé zaúčtování pohybu bez dokladu (bankovní
// poplatek, úrok, honorář placený rovnou z účtu...). Vytvoří dvouřádkový zápis
// proti bankovnímu/pokladnímu účtu a naučí se protistranu -> účet pro příště.
router.post("/:id/quick-post", async (req, res) => {
  const { account_id, created_by, description } = req.body;
  try {
    const posting = await store.transaction(async () => {
      const line = await store.get("SELECT * FROM bank_statement_line WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
      if (!line) throw new Error("Řádek výpisu nenalezen.");
      if (line.matched_document_id || line.posting_id) throw new Error("Pohyb je již zaúčtovaný.");
      // FIX (A3): quick-post vytváří účetní zápis, takže platí zámek období
      // i měsíce podle DATA POHYBU. Dřív se kontrolovalo jen "existuje nějaké
      // otevřené období", což uzamčený měsíc vůbec neřešilo.

      const bankAccount = await store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = ?",
        [line.accounting_unit_id, line.bank_account]
      );
      if (!bankAccount) throw new Error(`Účet ${line.bank_account} nenalezen v účtovém rozvrhu.`);
      // FIX (A3): dřív se bralo "jakékoli otevřené období" (nejnovější podle
      // start_date), ale účtovalo se DATEM POHYBU — zápis tak mohl spadnout do
      // období, do kterého jeho datum vůbec nepatří (pohyb z 3/2026 do období
      // 2027). Období se teď hledá podle data pohybu a musí být otevřené;
      // navíc platí zámek měsíce.
      const period = await resolvePeriodForDate(line.accounting_unit_id, line.statement_date);
      if (!period) throw new Error(`Pro datum ${line.statement_date} neexistuje účetní období — nejprve ho otevřete.`);
      await assertPeriodOpen(period.id);
      await assertMonthOpen(line.accounting_unit_id, line.statement_date);

      const amt = Math.abs(line.amount);
      const bankSide = line.amount >= 0 ? "MD" : "D";
      const categorySide = line.amount >= 0 ? "D" : "MD";

      const postingNumber = await nextPostingNumber(line.accounting_unit_id);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [line.accounting_unit_id, period.id, postingNumber, null, line.statement_date,
         description || `Bankovní pohyb — ${line.counterparty_name || line.bank_account}`, created_by]
      );
      const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, bankAccount.id, bankSide, amt]);
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, account_id, categorySide, amt]);
      await store.run("UPDATE bank_statement_line SET posting_id = ? WHERE id = ?", [postingId, line.id]);

      const party = normalizeParty(line.counterparty_name);
      if (party) {
        // Časové razítko se předává jako parametr (ne SQL funkcí) — tahle
        // routa běží beze změny nad SQLite i Postgres a datetime('now')/now()
        // se v obou dialektech píše jinak.
        await store.run(
          `INSERT INTO bank_category_rule (accounting_unit_id, match_text, account_id, hits, updated_at)
           VALUES (?,?,?,1,?)
           ON CONFLICT (accounting_unit_id, match_text) DO UPDATE SET account_id = excluded.account_id, hits = bank_category_rule.hits + 1, updated_at = excluded.updated_at`,
          [line.accounting_unit_id, party, account_id, new Date().toISOString()]
        );
      }
      await writeAuditLog({ unitId: line.accounting_unit_id, userId: created_by, action: "POST", table: "bank_statement_line", entityId: line.id, after: { posting_id: postingId, account_id } });
      return store.get("SELECT * FROM posting WHERE id = ?", [postingId]);
    });
    store.persist();
    res.status(201).json(posting);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/bank/inbound-mailbox?unit=1 — vrátí existující párovací token/adresu
// pro danou firmu (bank_inbound_mailbox), pokud už byl vygenerován.
router.get("/inbound-mailbox", async (req, res) => {
  try {
    const unitId = req.query.unit || req.user.accountingUnitId;
    const mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    if (!mailbox) return res.json(null);
    res.json({ ...mailbox, address: buildInboundAddress(mailbox.token) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bank/inbound-mailbox — vygeneruje párovací token pro firmu (Postmark
// MailboxHash routing, ekvivalent Fakturoidí adresy bank.X.Y@...). Idempotentní —
// pokud token pro firmu už existuje, vrátí ten stávající (nepřegeneruje).
router.post("/inbound-mailbox", async (req, res) => {
  const { bank_account } = req.body;
  const unitId = req.user.accountingUnitId;
  if (!bank_account) return res.status(400).json({ error: "Chybí bank_account." });
  try {
    let mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    if (!mailbox) {
      const token = crypto.randomBytes(8).toString("hex");
      await store.run(
        "INSERT INTO bank_inbound_mailbox (accounting_unit_id, token, bank_account) VALUES (?,?,?)",
        [unitId, token, bank_account]
      );
      store.persist();
      mailbox = await store.get("SELECT * FROM bank_inbound_mailbox WHERE accounting_unit_id = ?", [unitId]);
    }
    res.status(201).json({ ...mailbox, address: buildInboundAddress(mailbox.token) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Sestaví párovací e-mailovou adresu. Dvě varianty:
// 1) POSTMARK_INBOUND_DOMAIN (vlastní subdoména s MX na Postmark, "Inbound
//    Domain Forwarding") -> "token@in.vasedomena.cz", BEZ "+" — některé
//    bankovní formuláře pro upozornění na pohyby (ověřeno u RB, 2026-07-20)
//    striktně odmítají "+" v e-mailu jako "neplatný formát", i když je to
//    platný tvar adresy. Preferovaná varianta, pokud je nastavená.
// 2) POSTMARK_INBOUND_ADDRESS (výchozí Postmark adresa typu
//    "abc123@inbound.postmarkapp.com") -> vloží se +token před "@" (Postmark
//    MailboxHash routing) — funguje, ale obsahuje "+", viz výše.
// Bez obou proměnných vrací null — frontend zobrazí informaci, že adresa
// čeká na doplnění nastavení serveru.
function buildInboundAddress(token) {
  const domain = process.env.POSTMARK_INBOUND_DOMAIN;
  if (domain) return `${token}@${domain}`;
  const base = process.env.POSTMARK_INBOUND_ADDRESS;
  if (!base) return null;
  const at = base.indexOf("@");
  if (at === -1) return `${base}+${token}`;
  return `${base.slice(0, at)}+${token}${base.slice(at)}`;
}

// GET /api/bank/cashflow?unit=1 — zůstatky po jednotlivých účtech (banka/pokladna)
// a přehled příjmů/výdajů za posledních 30 a 90 dní.
router.get("/cashflow", async (req, res) => {
  try {
    const unit = req.query.unit;
    const lines = await store.all("SELECT bank_account, amount, statement_date FROM bank_statement_line WHERE accounting_unit_id = ?", [unit]);
    const balances = {};
    for (const l of lines) balances[l.bank_account] = (balances[l.bank_account] || 0) + Number(l.amount);

    const cutoff = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const sumSince = (days, positive) => lines
      .filter((l) => l.statement_date >= cutoff(days) && (positive ? l.amount > 0 : l.amount < 0))
      .reduce((s, l) => s + Math.abs(Number(l.amount)), 0);

    // Měsíční přehled za posledních 12 měsíců pro graf na dashboardu — počítáno
    // v JS ze stejných řádků (žádná dialektově specifická SQL date funkce).
    const monthKey = (d) => d.slice(0, 7); // "YYYY-MM"
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
    const monthly = months.map((month) => {
      const inMonth = lines.filter((l) => monthKey(l.statement_date) === month);
      const income = inMonth.filter((l) => l.amount > 0).reduce((s, l) => s + Number(l.amount), 0);
      const expense = inMonth.filter((l) => l.amount < 0).reduce((s, l) => s + Math.abs(Number(l.amount)), 0);
      return { month, income, expense, net: income - expense };
    });

    res.json({
      by_account: Object.entries(balances).map(([bank_account, balance]) => ({ bank_account, balance })),
      last30: { income: sumSince(30, true), expense: sumSince(30, false) },
      last90: { income: sumSince(90, true), expense: sumSince(90, false) },
      monthly,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
