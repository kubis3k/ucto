const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertMonthOpen } = require("./core");
const { resolvePeriodForDate } = require("./recurring");

const SHAREHOLDER = /(?:štěpán\s+lísa|stepan\s+lisa|jakub\s+lučan|jakub\s+lucan|lučan\s+jakub|lucan\s+jakub|jan\s+leština|jan\s+lestina|leština\s+jan|lestina\s+jan)/i;

async function account(unitId, number) {
  const row = await store.get("SELECT id FROM chart_of_accounts WHERE accounting_unit_id=? AND account_number=?", [unitId, number]);
  if (!row) throw new Error(`Účet ${number} není v účtovém rozvrhu.`);
  return row.id;
}

async function createPosting(unitId, userId, line, description, pairs, documentId = null) {
  const period = await resolvePeriodForDate(unitId, line.statement_date);
  if (!period) throw new Error(`Pro datum ${line.statement_date} neexistuje účetní období.`);
  await assertMonthOpen(unitId, line.statement_date);
  const number = await nextPostingNumber(unitId);
  const inserted = await store.get(
    `INSERT INTO posting (accounting_unit_id,period_id,posting_number,document_id,posting_date,description,created_by)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
    [unitId, period.id, number, documentId, line.statement_date, description, userId]
  );
  await store.run(
    `INSERT INTO posting_line (posting_id,account_id,side,amount) VALUES ${pairs.map(() => "(?,?,?,?)").join(",")}`,
    pairs.flatMap((p) => [inserted.id, p.account_id, p.side, p.amount])
  );
  await writeAuditLog({ unitId, userId, action: "POST", table: "posting", entityId: inserted.id,
    after: { migration: "bank-history-clean-v3", bank_line_id: line.id } });
  return inserted.id;
}

async function cleanBankHistory({ unitId, userId }) {
  const summary = { superseded: 0, generated: 0 };

  // Staré bankovní větve zůstanou v deníku/auditu, ale nesmějí vstupovat
  // do hlavní knihy ani výkazů. Každý krok označí nejvýše jeden posting.
  const obsolete = await store.get(
    `SELECT DISTINCT p.id FROM posting p
     WHERE p.accounting_unit_id=?
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM bank_clean_posting cp WHERE cp.posting_id=p.id)
       AND (
         p.description LIKE 'Bankovní pohyb — %' OR
         p.description LIKE 'Bankovní pohyb čeká na doklad — %' OR
         p.description LIKE 'Zápůjčka od společníka — %' OR
         p.description LIKE 'Úhrada %' OR
         p.description LIKE 'OPRAVA %' OR
         p.description LIKE 'Vyrovnání 221 %' OR
         p.description LIKE 'Vyrovnání 365 %' OR
         EXISTS (SELECT 1 FROM posting_line pl JOIN chart_of_accounts ca ON ca.id=pl.account_id
                 WHERE pl.posting_id=p.id AND ca.account_number LIKE '354%')
       )
     ORDER BY p.id LIMIT 1`, [unitId]
  );
  if (obsolete) {
    await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)", [obsolete.id, "Nahrazeno čistou bankovní historií v3"]);
    summary.superseded = 1;
    return { ...summary, completed: false };
  }

  const line = await store.get(
    `SELECT b.*,d.doc_type,d.doc_number,d.id AS document_id FROM bank_statement_line b
     LEFT JOIN document d ON d.id=b.matched_document_id
     WHERE b.accounting_unit_id=? AND b.superseded_by_bank_line_id IS NULL AND b.external_ref IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bank_clean_posting cp WHERE cp.bank_line_id=b.id)
     ORDER BY b.statement_date,b.id LIMIT 1`, [unitId]
  );
  if (!line) return { ...summary, completed: true };

  const a221 = await account(unitId, "221");
  const amount = Math.abs(Number(line.amount));
  let other, description;
  if (Number(line.amount) > 0 && SHAREHOLDER.test(line.counterparty_name || "")) {
    other = await account(unitId, "365");
    description = `Zápůjčka od společníka — ${line.counterparty_name}`;
  } else if (line.doc_type === "faktura_vydana" && Number(line.amount) > 0) {
    other = await account(unitId, "311"); description = `Úhrada ${line.doc_number}`;
  } else if (line.doc_type === "faktura_prijata" && Number(line.amount) < 0) {
    other = await account(unitId, "321"); description = `Úhrada ${line.doc_number}`;
  } else if (/globaal elevate prod/i.test(line.counterparty_name || "")) {
    other = await account(unitId, "261"); description = "Vnitřní převod peněžních prostředků";
  } else if (/meta|claude|chatgpt|vast|vercel/i.test(line.counterparty_name || "")) {
    other = await account(unitId, "518"); description = `Online služba — ${line.counterparty_name || line.external_ref}`;
  } else {
    other = await account(unitId, Number(line.amount) > 0 ? "325" : "315");
    description = `Bankovní pohyb čeká na doklad — ${line.counterparty_name || line.external_ref}`;
  }
  const pairs = Number(line.amount) > 0
    ? [{ account_id: a221, side: "MD", amount }, { account_id: other, side: "D", amount }]
    : [{ account_id: other, side: "MD", amount }, { account_id: a221, side: "D", amount }];
  const postingId = await createPosting(unitId, userId, line, description, pairs, line.document_id || null);
  await store.run("INSERT INTO bank_clean_posting (bank_line_id,posting_id) VALUES (?,?)", [line.id, postingId]);
  await store.run("UPDATE bank_statement_line SET posting_id=? WHERE id=?", [postingId, line.id]);
  summary.generated = 1;
  return { ...summary, completed: false };
}

module.exports = { cleanBankHistory };
