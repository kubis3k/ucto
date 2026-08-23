const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertMonthOpen } = require("./core");
const { resolvePeriodForDate } = require("./recurring");

const SHAREHOLDER = /(?:štěpán\s+lísa|jakub\s+lučan|lučan\s+jakub|jan\s+leština|leština\s+jan)/i;

async function account(unitId, number) {
  const row = await store.get("SELECT id FROM chart_of_accounts WHERE accounting_unit_id=? AND account_number=?", [unitId, number]);
  if (!row) throw new Error(`Účet ${number} není v účtovém rozvrhu.`);
  return row.id;
}

async function createPosting({ unitId, userId, date, description, documentId = null, lines }) {
  try {
    const period = await resolvePeriodForDate(unitId, date);
    if (!period) throw new Error(`Pro datum ${date} neexistuje účetní období.`);
    await assertMonthOpen(unitId, date);
    const number = await nextPostingNumber(unitId);
    const inserted = await store.get(
    `INSERT INTO posting (accounting_unit_id,period_id,posting_number,document_id,posting_date,description,created_by)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [unitId, period.id, number, documentId, date, description, userId]
    );
    const id = inserted.id;
    // Produkční append-only trigger uzamkne zápis po prvním INSERTu.
    // Všechny řádky proto musí vzniknout jedním atomickým příkazem.
    await store.run(
      `INSERT INTO posting_line (posting_id,account_id,side,amount) VALUES ${lines.map(() => "(?,?,?,?)").join(",")}`,
      lines.flatMap((line) => [id, line.account_id, line.side, line.amount])
    );
    await writeAuditLog({ unitId, userId, action: "POST", table: "posting", entityId: id, after: { migration: "bank-history-v2", description } });
    return id;
  } catch (err) {
    throw new Error(`[${description}] ${err.message}`);
  }
}

async function rebuildBankHistory({ unitId, userId, capitalAmount, capitalDate }) {
  const summary = { merged_duplicates: 0, corrected_loans: 0, posted_loans: 0, posted_payments: 0, capital_posted: false };

  // CSV s bankovním ID je autoritativní historie. Starší řádky bez ID
  // nemažeme (audit), ale vyřadíme je z aktivní historie a případné vazby
  // na doklad/zápis přeneseme na nejbližší skutečnou bankovní transakci.
  const canonical = await store.all(
    "SELECT * FROM bank_statement_line WHERE accounting_unit_id=? AND external_ref IS NOT NULL ORDER BY statement_date,id", [unitId]
  );
  const legacy = canonical.length ? await store.get(
    "SELECT * FROM bank_statement_line WHERE accounting_unit_id=? AND external_ref IS NULL AND superseded_by_bank_line_id IS NULL ORDER BY id LIMIT 1", [unitId]
  ) : null;
  if (legacy) {
    const used = new Set((await store.all(
      "SELECT superseded_by_bank_line_id AS id FROM bank_statement_line WHERE accounting_unit_id=? AND superseded_by_bank_line_id IS NOT NULL", [unitId]
    )).map((r) => Number(r.id)));
    const day = (s) => Date.parse(String(s).slice(0, 10) + "T00:00:00Z") / 86400000;
    const candidates = canonical.filter((c) => !used.has(Number(c.id)) && Math.sign(Number(c.amount)) === Math.sign(Number(legacy.amount)))
      .map((c) => ({ c, days: Math.abs(day(c.statement_date) - day(legacy.statement_date)), diff: Math.abs(Number(c.amount) - Number(legacy.amount)) }))
      .filter((x) => x.days <= 5 && (x.diff <= 6 || x.diff / Math.max(1, Math.abs(Number(x.c.amount))) <= 0.02))
      .sort((a, b) => (a.days * 100 + a.diff) - (b.days * 100 + b.diff));
    const replacement = candidates[0]?.c;
    if (replacement) {
      await store.run(
        `UPDATE bank_statement_line SET
           matched_document_id=COALESCE(matched_document_id,?), posting_id=COALESCE(posting_id,?)
         WHERE id=?`, [legacy.matched_document_id, legacy.posting_id, replacement.id]
      );
    }
    // Pokud starý ruční/importní řádek nemá protějšek ve výpisu od banky,
    // je rovněž vyřazen: výpis pokrývá celé fungování společnosti.
    await store.run("UPDATE bank_statement_line SET superseded_by_bank_line_id=? WHERE id=?", [replacement?.id || legacy.id, legacy.id]);
    summary.merged_duplicates = 1;
    return { ...summary, completed: false };
  }

  const a221 = await account(unitId, "221"), a354 = await account(unitId, "354"), a365 = await account(unitId, "365");

  // Odstranit účetní účinek duplicitních automatických zápůjček, pokud
  // stejný bankovní příjem už reprezentuje starší správný nebo opravený zápis.
  const duplicateLoans = await store.all(
    `SELECT p.*,b.id AS bank_line_id,b.amount AS bank_amount FROM bank_statement_line b
     JOIN posting p ON p.id=b.posting_id
     WHERE b.accounting_unit_id=? AND b.superseded_by_bank_line_id IS NULL
       AND p.description LIKE 'Zápůjčka od společníka — %'
       AND NOT EXISTS (SELECT 1 FROM posting x WHERE x.accounting_unit_id=p.accounting_unit_id
         AND x.description=('OPRAVA DUPLICITNÍ zápůjčky k zápisu č. ' || p.posting_number))
     ORDER BY p.id`, [unitId]
  );
  for (const duplicateLoan of duplicateLoans) {
    let replacement = await store.get(
      `SELECT p.id FROM posting p JOIN posting_line pl ON pl.posting_id=p.id
       JOIN chart_of_accounts ca ON ca.id=pl.account_id AND ca.account_number LIKE '221%'
       WHERE p.accounting_unit_id=? AND p.id<>? AND p.posting_date=? AND pl.side='MD'
         AND ABS(pl.amount-?)<0.005 AND p.description NOT LIKE 'Zápůjčka od společníka — %'
       ORDER BY p.id LIMIT 1`, [unitId, duplicateLoan.id, duplicateLoan.posting_date, duplicateLoan.bank_amount]
    );
    if (!replacement) replacement = await store.get(
      `SELECT p.id FROM posting p JOIN posting_line pl ON pl.posting_id=p.id
       JOIN chart_of_accounts ca ON ca.id=pl.account_id AND ca.account_number LIKE '221%'
       WHERE p.accounting_unit_id=? AND p.description LIKE 'OPRAVA SPRÁVNÉ zápůjčky k zápisu č. %'
         AND pl.side='MD' AND ABS(pl.amount-?)<0.005 ORDER BY p.id LIMIT 1`, [unitId, duplicateLoan.bank_amount]
    );
    if (replacement) {
      const oldLines = await store.all("SELECT account_id,side,amount FROM posting_line WHERE posting_id=?", [duplicateLoan.id]);
      await createPosting({ unitId, userId, date: new Date().toISOString().slice(0, 10),
        description: `OPRAVA DUPLICITNÍ zápůjčky k zápisu č. ${duplicateLoan.posting_number}`,
        lines: oldLines.map((l) => ({ ...l, side: l.side === "MD" ? "D" : "MD" })) });
      await store.run("UPDATE bank_statement_line SET posting_id=? WHERE id=?", [replacement.id, duplicateLoan.bank_line_id]);
      summary.corrected_loans++;
      return { ...summary, completed: false };
    }
  }

  // Obecná oprava starých bankovních zápisů: aktivní účet 221 roste na MD
  // a klesá na D. Opravujeme pouze prokazatelný rozpor se znaménkem výpisu.
  const inverted = await store.get(
    `SELECT p.*,b.amount AS statement_amount FROM bank_statement_line b
     JOIN posting p ON p.id=b.posting_id
     JOIN posting_line pl ON pl.posting_id=p.id
     JOIN chart_of_accounts ca ON ca.id=pl.account_id AND ca.account_number LIKE '221%'
     WHERE b.accounting_unit_id=? AND b.superseded_by_bank_line_id IS NULL
       AND ((b.amount>0 AND pl.side='D') OR (b.amount<0 AND pl.side='MD'))
       AND NOT EXISTS (SELECT 1 FROM posting x WHERE x.accounting_unit_id=p.accounting_unit_id
         AND (x.description=('OPRAVA MD/D banky — zrušení zápisu č. ' || p.posting_number)
              OR x.description=('OPRAVA ZRUŠENÍ chybné zápůjčky k zápisu č. ' || p.posting_number)))
     ORDER BY p.id LIMIT 1`, [unitId]
  );
  if (inverted) {
    const oldLines = await store.all("SELECT account_id,side,amount FROM posting_line WHERE posting_id=?", [inverted.id]);
    const flipped = oldLines.map((l) => ({ ...l, side: l.side === "MD" ? "D" : "MD" }));
    const correctionDate = new Date().toISOString().slice(0, 10);
    await createPosting({ unitId, userId, date: correctionDate,
      description: `OPRAVA MD/D banky — zrušení zápisu č. ${inverted.posting_number}`, lines: flipped });
    await createPosting({ unitId, userId, date: correctionDate,
      description: `OPRAVA MD/D banky — správný zápis č. ${inverted.posting_number}`, lines: flipped });
    summary.corrected_loans++;
    return { ...summary, completed: false };
  }

  // Opravit všechny historické zápisy, které současně použily 221 a
  // 354 pro příjem zápůjčky. Idempotence: již stornované přeskočit.
  const wrongLoans = await store.all(
    `SELECT DISTINCT p.*,b.amount AS bank_amount FROM posting p
     JOIN posting_line b ON b.posting_id=p.id AND b.side='D'
     JOIN chart_of_accounts ba ON ba.id=b.account_id AND ba.account_number LIKE '221%'
     JOIN posting_line s ON s.posting_id=p.id AND s.side='MD'
     JOIN chart_of_accounts sa ON sa.id=s.account_id AND sa.account_number LIKE '354%'
     WHERE p.accounting_unit_id=? AND p.storno_of_posting_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM posting x WHERE x.storno_of_posting_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM posting x WHERE x.accounting_unit_id=p.accounting_unit_id
         AND x.description = ('OPRAVA ZRUŠENÍ chybné zápůjčky k zápisu č. ' || p.posting_number))`,
    [unitId]
  );
  for (const p of wrongLoans) {
    const correctionDate = new Date().toISOString().slice(0, 10);
    await createPosting({ unitId, userId, date: correctionDate,
      description: `OPRAVA ZRUŠENÍ chybné zápůjčky k zápisu č. ${p.posting_number}`,
      lines: [{ account_id: a221, side: "MD", amount: p.bank_amount }, { account_id: a354, side: "D", amount: p.bank_amount }] });
    await createPosting({ unitId, userId, date: correctionDate,
      description: `OPRAVA SPRÁVNÉ zápůjčky k zápisu č. ${p.posting_number}`,
      lines: [{ account_id: a221, side: "MD", amount: p.bank_amount }, { account_id: a365, side: "D", amount: p.bank_amount }] });
    summary.corrected_loans++;
    return { ...summary, completed: false };
  }

  // Nové, dosud nezaúčtované příjmy od potvrzených společníků.
  const bankLines = await store.all("SELECT * FROM bank_statement_line WHERE accounting_unit_id=? AND superseded_by_bank_line_id IS NULL ORDER BY statement_date,id", [unitId]);
  for (const line of bankLines) {
    if (Number(line.amount) > 0 && !line.posting_id && !line.matched_document_id && SHAREHOLDER.test(line.counterparty_name || "")) {
      const id = await createPosting({ unitId, userId, date: line.statement_date,
        description: `Zápůjčka od společníka — ${line.counterparty_name}`,
        lines: [{ account_id: a221, side: "MD", amount: Number(line.amount) }, { account_id: a365, side: "D", amount: Number(line.amount) }] });
      await store.run("UPDATE bank_statement_line SET posting_id=? WHERE id=?", [id, line.id]);
      summary.posted_loans++;
      return { ...summary, completed: false };
    }
  }

  // Zachované vazby na faktury převést na skutečné zápisy úhrad.
  const matched = await store.all(
    `SELECT b.*,d.doc_type,d.doc_number,d.id AS document_id FROM bank_statement_line b
     JOIN document d ON d.id=b.matched_document_id
     WHERE b.accounting_unit_id=? AND b.superseded_by_bank_line_id IS NULL AND d.doc_type IN ('faktura_vydana','faktura_prijata')`,
    [unitId]
  );
  const a311 = await account(unitId, "311"), a321 = await account(unitId, "321");
  for (const line of matched) {
    if ((line.doc_type === "faktura_vydana" && Number(line.amount) <= 0) || (line.doc_type === "faktura_prijata" && Number(line.amount) >= 0)) continue;
    const amt = Math.abs(Number(line.amount));
    const settlementExists = await store.get(
      `SELECT p.id FROM posting p JOIN posting_line pl ON pl.posting_id=p.id AND pl.account_id=?
       WHERE p.accounting_unit_id=? AND p.document_id=? AND p.posting_date=? AND ABS(pl.amount-?)<0.005
         AND p.description LIKE 'Úhrada %' LIMIT 1`,
      [a221, unitId, line.document_id, line.statement_date, amt]
    );
    if (settlementExists) continue;
    const lines = Number(line.amount) > 0
      ? [{ account_id: a221, side: "MD", amount: amt }, { account_id: a311, side: "D", amount: amt }]
      : [{ account_id: a321, side: "MD", amount: amt }, { account_id: a221, side: "D", amount: amt }];
    const id = await createPosting({ unitId, userId, date: line.statement_date, documentId: line.document_id,
      description: `Úhrada ${line.doc_number}`, lines });
    summary.posted_payments++;
    return { ...summary, completed: false };
  }

  // Každý pohyb musí být v hlavní knize 221 právě jednou. Nezařazené
  // transakce dočasně vedeme proti 315/325; po dodání dokladu se
  // reklasifikuje pouze protistrana a banka zůstane nedotčená.
  const pending = await store.get(
    `SELECT * FROM bank_statement_line WHERE accounting_unit_id=?
       AND superseded_by_bank_line_id IS NULL AND posting_id IS NULL AND matched_document_id IS NULL
     ORDER BY statement_date,id LIMIT 1`, [unitId]
  );
  if (pending) {
    const a315 = await account(unitId, "315"), a325 = await account(unitId, "325");
    const amount = Math.abs(Number(pending.amount));
    const lines = Number(pending.amount) > 0
      ? [{ account_id: a221, side: "MD", amount }, { account_id: a325, side: "D", amount }]
      : [{ account_id: a315, side: "MD", amount }, { account_id: a221, side: "D", amount }];
    const id = await createPosting({ unitId, userId, date: pending.statement_date,
      description: `Bankovní pohyb čeká na doklad — ${pending.counterparty_name || pending.external_ref || pending.id}`, lines });
    await store.run("UPDATE bank_statement_line SET posting_id=? WHERE id=?", [id, pending.id]);
    summary.posted_payments++;
    return { ...summary, completed: false };
  }

  const a353 = await account(unitId, "353"), a411 = await account(unitId, "411");
  const capitalExists = await store.get(
    `SELECT p.id FROM posting p JOIN posting_line l ON l.posting_id=p.id
     WHERE p.accounting_unit_id=? AND l.account_id=? AND l.side='D' AND ABS(l.amount-?)<0.005 LIMIT 1`,
    [unitId, a411, capitalAmount]
  );
  if (!capitalExists) {
    await createPosting({ unitId, userId, date: capitalDate, description: "Úpis nesplaceného základního kapitálu",
      lines: [{ account_id: a353, side: "MD", amount: capitalAmount }, { account_id: a411, side: "D", amount: capitalAmount }] });
    summary.capital_posted = true;
    return { ...summary, completed: false };
  }
  return { ...summary, completed: true };
}

module.exports = { rebuildBankHistory };
