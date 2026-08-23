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

  // Jeden bankovní řádek nesmí současně nést přímý náklad a úhradu již
  // zaúčtované přijaté faktury. To vzniklo např. u e-SIM 99 Kč: faktura
  // vytvořila MD 518 / D 321, úhrada MD 321 / D 221 a starší klasifikátor
  // navíc ponechal MD 518xxx / D 221. Vyřadíme pouze tento třetí zápis.
  const duplicateDirectExpense = await store.get(
    `SELECT cp.bank_line_id,cp.posting_id
     FROM bank_clean_posting cp
     JOIN bank_statement_line b ON b.id=cp.bank_line_id
     JOIN document d ON d.id=b.matched_document_id AND d.doc_type='faktura_prijata'
     JOIN posting settlement ON settlement.id=b.posting_id AND settlement.document_id=d.id
     JOIN posting direct ON direct.id=cp.posting_id
     WHERE b.accounting_unit_id=?
       AND settlement.id<>direct.id
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=direct.id)
       AND EXISTS (SELECT 1 FROM posting_line pl JOIN chart_of_accounts ca ON ca.id=pl.account_id
                   WHERE pl.posting_id=direct.id AND ca.account_number LIKE '518%')
     ORDER BY b.id LIMIT 1`, [unitId]
  );
  if (duplicateDirectExpense) {
    await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)",
      [duplicateDirectExpense.posting_id, "Duplicitní přímý náklad nahrazen úhradou zaúčtované přijaté faktury"]);
    await store.run("DELETE FROM bank_clean_posting WHERE bank_line_id=?", [duplicateDirectExpense.bank_line_id]);
    return { ...summary, superseded: 1, completed: false };
  }

  // Pokud už existuje zaúčtovaná přijatá faktura (MD náklad / D 321),
  // bankovní výdej nesmí vytvořit druhý náklad. U jednoznačné shody částky
  // nahradíme přímý bankovní náklad úhradou MD 321 / D 221.
  const directExpenses = await store.all(
    `SELECT cp.bank_line_id,cp.posting_id,b.amount,b.statement_date
     FROM bank_clean_posting cp
     JOIN bank_statement_line b ON b.id=cp.bank_line_id
     JOIN posting p ON p.id=cp.posting_id
     WHERE b.accounting_unit_id=? AND b.amount<0 AND b.matched_document_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
       AND EXISTS (SELECT 1 FROM posting_line pl JOIN chart_of_accounts ca ON ca.id=pl.account_id
                   WHERE pl.posting_id=p.id AND ca.account_number LIKE '518%')
     ORDER BY b.id`, [unitId]
  );
  let directExpense = null, matchedInvoiceId = null;
  for (const candidateExpense of directExpenses) {
    const candidates = await store.all(
      `SELECT d.id FROM document d
       WHERE d.accounting_unit_id=? AND d.doc_type='faktura_prijata'
         AND d.status='zauctovany' AND d.currency='CZK'
         AND ABS(d.total_amount-ABS(?)) < 0.01
         AND COALESCE((SELECT SUM(ABS(b2.amount)) FROM bank_statement_line b2
                       WHERE b2.matched_document_id=d.id
                         AND b2.superseded_by_bank_line_id IS NULL),0) < d.total_amount-0.01
       ORDER BY d.id`, [unitId, candidateExpense.amount]
    );
    if (candidates.length === 1) {
      directExpense = candidateExpense;
      matchedInvoiceId = candidates[0].id;
      break;
    }
  }
  if (directExpense) {
      await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)",
        [directExpense.posting_id, "Nahrazeno úhradou již zaúčtované přijaté faktury"]);
      await store.run("DELETE FROM bank_clean_posting WHERE bank_line_id=?", [directExpense.bank_line_id]);
      await store.run("DELETE FROM bank_clean_pending WHERE bank_line_id=?", [directExpense.bank_line_id]);
      await store.run("UPDATE bank_statement_line SET matched_document_id=?,posting_id=NULL WHERE id=?",
        [matchedInvoiceId, directExpense.bank_line_id]);
      return { ...summary, superseded: 1, completed: false };
  }

  // Starší čistá historie dávala všechny on-line platby přímo na syntetický
  // 518. Převedeme je na stabilní analytiky: SaaS, marketing, telekomunikace.
  const oldService = await store.get(
    `SELECT cp.bank_line_id,cp.posting_id,b.counterparty_name
     FROM bank_clean_posting cp
     JOIN bank_statement_line b ON b.id=cp.bank_line_id
     JOIN posting p ON p.id=cp.posting_id
     WHERE b.accounting_unit_id=?
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
       AND EXISTS (SELECT 1 FROM posting_line pl JOIN chart_of_accounts ca ON ca.id=pl.account_id
                   WHERE pl.posting_id=p.id AND ca.account_number='518')
       AND (LOWER(COALESCE(b.counterparty_name,'')) LIKE '%meta%'
         OR LOWER(COALESCE(b.counterparty_name,'')) LIKE '%vercel%'
         OR LOWER(COALESCE(b.counterparty_name,'')) LIKE '%vast%'
         OR LOWER(COALESCE(b.counterparty_name,'')) LIKE '%chatgpt%'
         OR LOWER(COALESCE(b.counterparty_name,'')) LIKE '%claude%'
         OR LOWER(COALESCE(b.counterparty_name,'')) LIKE '%mobil%')
     ORDER BY p.id LIMIT 1`, [unitId]
  );
  if (oldService) {
    await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)",
      [oldService.posting_id, "Převedeno na analytiku služeb"]);
    await store.run("DELETE FROM bank_clean_posting WHERE bank_line_id=?", [oldService.bank_line_id]);
    await store.run("DELETE FROM bank_clean_pending WHERE bank_line_id=?", [oldService.bank_line_id]);
    await store.run("UPDATE bank_statement_line SET posting_id=NULL WHERE id=?", [oldService.bank_line_id]);
    return { ...summary, superseded: 1, completed: false };
  }

  // Starší automatické párování mohlo vklad společníka spojit s fakturou
  // jen kvůli shodné částce. Vazbu i takto vzniklý čistý posting zrušíme a
  // řádek necháme znovu vytvořit bez document_id na účty 221/365.
  const shareholderCandidates = await store.all(
    `SELECT b.*,cp.posting_id AS clean_posting_id,p.document_id AS posting_document_id
     FROM bank_statement_line b
     LEFT JOIN bank_clean_posting cp ON cp.bank_line_id=b.id
     LEFT JOIN posting p ON p.id=cp.posting_id
     WHERE b.accounting_unit_id=? AND b.amount>0
       AND (b.matched_document_id IS NOT NULL OR p.document_id IS NOT NULL)
     ORDER BY b.id`, [unitId]
  );
  const wrongShareholder = shareholderCandidates.find((b) => SHAREHOLDER.test(b.counterparty_name || ""));
  if (wrongShareholder) {
    if (wrongShareholder.clean_posting_id) {
      const already = await store.get("SELECT posting_id FROM posting_supersession WHERE posting_id=?", [wrongShareholder.clean_posting_id]);
      if (!already) await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)",
        [wrongShareholder.clean_posting_id, "Vklad společníka byl chybně spárován s fakturou"]);
      await store.run("DELETE FROM bank_clean_posting WHERE bank_line_id=?", [wrongShareholder.id]);
    }
    await store.run("DELETE FROM bank_clean_pending WHERE bank_line_id=?", [wrongShareholder.id]);
    await store.run("UPDATE bank_statement_line SET matched_document_id=NULL,posting_id=NULL WHERE id=?", [wrongShareholder.id]);
    return { ...summary, superseded: wrongShareholder.clean_posting_id ? 1 : 0, completed: false };
  }

  // Samotný odchod na vlastní účet nedokládá, zda peníze dorazily do
  // pokladny, na jiný bankovní účet, nebo šlo o jiný účel. Starší migrace
  // jej automaticky dala na 261. Bez protistrany jej vrátíme uživateli k
  // volbě a účet 261 nenecháme uměle otevřený.
  const unresolvedTransfer = await store.get(
    `SELECT cp.bank_line_id,cp.posting_id FROM bank_clean_posting cp
     JOIN posting p ON p.id=cp.posting_id
     JOIN bank_statement_line b ON b.id=cp.bank_line_id
     WHERE p.accounting_unit_id=? AND p.description='Vnitřní převod peněžních prostředků'
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
     ORDER BY p.id LIMIT 1`, [unitId]
  );
  if (unresolvedTransfer) {
    await store.run("INSERT INTO posting_supersession (posting_id,reason) VALUES (?,?)",
      [unresolvedTransfer.posting_id, "Cíl vnitřního převodu nebyl doložen"]);
    await store.run("DELETE FROM bank_clean_posting WHERE bank_line_id=?", [unresolvedTransfer.bank_line_id]);
    const pending = await store.get("SELECT bank_line_id FROM bank_clean_pending WHERE bank_line_id=?", [unresolvedTransfer.bank_line_id]);
    if (!pending) await store.run("INSERT INTO bank_clean_pending (bank_line_id) VALUES (?)", [unresolvedTransfer.bank_line_id]);
    await store.run("UPDATE bank_statement_line SET posting_id=NULL WHERE id=?", [unresolvedTransfer.bank_line_id]);
    return { ...summary, superseded: 1, completed: false };
  }

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
         (LOWER(p.description) LIKE '%počáteční%bank%'
           AND EXISTS (SELECT 1 FROM posting_line opening_pl
             JOIN chart_of_accounts opening_ca ON opening_ca.id=opening_pl.account_id
             WHERE opening_pl.posting_id=p.id AND opening_ca.account_number LIKE '221%'
               AND ABS(opening_pl.amount-10000) < 0.01)) OR
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

  // Po opraveném opakovaném importu mohou čekající řádky nově získat vazbu
  // na doklad nebo rozpoznatelný název obchodníka. Vracejí se po jednom do
  // klasifikace, aniž by vznikl provizorní účetní zápis.
  const reconsider = await store.get(
    `SELECT pending.bank_line_id FROM bank_clean_pending pending
     JOIN bank_statement_line b ON b.id=pending.bank_line_id
     WHERE b.accounting_unit_id=? AND (
       b.matched_document_id IS NOT NULL OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%meta%' OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%claude%' OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%chatgpt%' OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%vast%' OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%vercel%' OR
       LOWER(COALESCE(b.counterparty_name,'')) LIKE '%mobil%'
     ) ORDER BY b.id LIMIT 1`, [unitId]
  );
  if (reconsider) {
    await store.run("DELETE FROM bank_clean_pending WHERE bank_line_id=?", [reconsider.bank_line_id]);
    return { ...summary, completed: false };
  }

  const line = await store.get(
    `SELECT b.*,d.doc_type,d.doc_number,d.id AS document_id FROM bank_statement_line b
     LEFT JOIN document d ON d.id=b.matched_document_id
     WHERE b.accounting_unit_id=? AND b.superseded_by_bank_line_id IS NULL AND b.external_ref IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM bank_clean_posting cp WHERE cp.bank_line_id=b.id)
       AND NOT EXISTS (SELECT 1 FROM bank_clean_pending pending WHERE pending.bank_line_id=b.id)
     ORDER BY b.statement_date,b.id LIMIT 1`, [unitId]
  );
  if (!line) return { ...summary, completed: true };

  const a221 = await account(unitId, "221");
  const amount = Math.abs(Number(line.amount));
  let other, description, documentId = line.document_id || null;
  if (Number(line.amount) > 0 && SHAREHOLDER.test(line.counterparty_name || "")) {
    other = await account(unitId, "365");
    description = `Zápůjčka od společníka — ${line.counterparty_name}`;
    documentId = null;
  } else if (line.doc_type === "faktura_vydana" && Number(line.amount) > 0) {
    other = await account(unitId, "311"); description = `Úhrada ${line.doc_number}`;
  } else if (line.doc_type === "faktura_prijata" && Number(line.amount) < 0) {
    other = await account(unitId, "321"); description = `Úhrada ${line.doc_number}`;
  } else if (/meta\s*pay|facebook|instagram/i.test(line.counterparty_name || "")) {
    other = await account(unitId, "518400"); description = `Reklama a marketing — ${line.counterparty_name || line.external_ref}`;
  } else if (/claude|anthropic|chatgpt|vast|vercel/i.test(line.counterparty_name || "")) {
    other = await account(unitId, "518300"); description = `Software / SaaS — ${line.counterparty_name || line.external_ref}`;
  } else if (/mobil\.cz|e-?sim|telekom|telefon/i.test(line.counterparty_name || "")) {
    other = await account(unitId, "518500"); description = `Telekomunikační služba — ${line.counterparty_name || line.external_ref}`;
  } else {
    // Neznámý pohyb není účetní případ bez zvolené kontace. Zůstává pouze
    // v bankovní frontě; pomocné účty 315/325 by jej po spárování zdvojily.
    await store.run("INSERT INTO bank_clean_pending (bank_line_id) VALUES (?)", [line.id]);
    await store.run("UPDATE bank_statement_line SET posting_id=NULL WHERE id=?", [line.id]);
    return { ...summary, completed: false };
  }
  const pairs = Number(line.amount) > 0
    ? [{ account_id: a221, side: "MD", amount }, { account_id: other, side: "D", amount }]
    : [{ account_id: other, side: "MD", amount }, { account_id: a221, side: "D", amount }];
  const postingId = await createPosting(unitId, userId, line, description, pairs, documentId);
  await store.run("INSERT INTO bank_clean_posting (bank_line_id,posting_id) VALUES (?,?)", [line.id, postingId]);
  await store.run("UPDATE bank_statement_line SET posting_id=? WHERE id=?", [postingId, line.id]);
  summary.generated = 1;
  return { ...summary, completed: false };
}

module.exports = { cleanBankHistory };
