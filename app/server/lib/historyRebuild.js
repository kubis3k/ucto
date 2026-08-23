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

  // Nový řádek s external_ref sloučit do staršího kanonického řádku,
  // který už může nést vazbu na doklad/zápis. Starší importy mohly mít
  // external_ref také, proto je rozhodující nižší id a shodný bankovní otisk.
  const duplicate = await store.get(
    `SELECT n.id FROM bank_statement_line n WHERE n.accounting_unit_id=? AND n.external_ref IS NOT NULL
       AND n.matched_document_id IS NULL AND n.posting_id IS NULL AND EXISTS (
          SELECT 1 FROM bank_statement_line o WHERE o.accounting_unit_id=n.accounting_unit_id
          AND o.id<n.id AND o.bank_account=n.bank_account
          AND o.statement_date=n.statement_date AND o.amount=n.amount
          AND COALESCE(o.variable_symbol,'')=COALESCE(n.variable_symbol,''))
     ORDER BY n.id LIMIT 1`, [unitId]
  );
  if (duplicate) {
    await store.run("DELETE FROM bank_statement_line WHERE id=?", [duplicate.id]);
    summary.merged_duplicates = 1;
    return { ...summary, completed: false };
  }

  const a221 = await account(unitId, "221"), a354 = await account(unitId, "354"), a365 = await account(unitId, "365");

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
  const bankLines = await store.all("SELECT * FROM bank_statement_line WHERE accounting_unit_id=? ORDER BY statement_date,id", [unitId]);
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
     WHERE b.accounting_unit_id=? AND d.doc_type IN ('faktura_vydana','faktura_prijata')`,
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
