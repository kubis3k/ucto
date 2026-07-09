// =====================================================================
// recurring.js — generování faktur (koncept) z šablon `recurring_invoice`.
// Vždy generuje 'koncept' (schvaluje člověk) a nikdy neobchází
// period-lock (viz .claude/state/flow-state.md INVARIANTY) — pokud pro
// due datum chybí nebo je uzavřené účetní období, řádek se přeskočí a
// zapíše se do audit_log (SCHVÁLENO uživatelem, žádné tiché ticho).
// =====================================================================
const store = require("../db");
const { generateDocumentNumber, writeAuditLog } = require("./core");

// Posune datum o interval, ale klamuje den v měsíci na poslední den cílového
// měsíce, pokud by jinak "přetekl" (např. 31.1. + měsíčně by s setUTCMonth
// skočilo na 3.3., přeskočilo únor — takhle skončí na 28./29.2.).
function addInterval(dateISO, interval) {
  const d = new Date(dateISO + "T00:00:00Z");
  const day = d.getUTCDate();
  let monthsToAdd;
  if (interval === "mesicne") monthsToAdd = 1;
  else if (interval === "ctvrtletne") monthsToAdd = 3;
  else if (interval === "rocne") monthsToAdd = 12;
  else throw new Error(`Neznámý interval: ${interval}`);

  const targetMonthIndex = d.getUTCMonth() + monthsToAdd;
  const targetYear = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return new Date(Date.UTC(targetYear, normalizedMonth, clampedDay)).toISOString().slice(0, 10);
}

// Vrátí účetní období (jakéhokoli stavu) pokrývající dané datum, nebo null
// pokud žádné neexistuje. Volající si sám rozliší "chybí" vs. "uzavřené".
async function resolvePeriodForDate(unitId, dateISO) {
  const period = await store.get(
    `SELECT * FROM accounting_period WHERE accounting_unit_id = ? AND start_date <= ? AND end_date >= ? ORDER BY fiscal_year DESC LIMIT 1`,
    [unitId, dateISO, dateISO]
  );
  return period || null;
}

// Najde nejstaršího aktivního uživatele firmy — automaticky generovaná
// faktura potřebuje NOT NULL responsible_user_id, ale recurring_invoice
// žádného konkrétního uživatele neváže. ODCHYLKA od plánu (nebylo v plánu
// specifikováno), zdůvodněno v reportu.
async function fallbackResponsibleUser(unitId) {
  const user = await store.get(
    `SELECT id FROM app_user WHERE accounting_unit_id = ? AND active = 1 ORDER BY id LIMIT 1`,
    [unitId]
  );
  if (!user) throw new Error("Firma nemá žádného aktivního uživatele — nelze vygenerovat fakturu.");
  return user.id;
}

// Vygeneruje jednu fakturu (koncept) z šablony pro konkrétní due datum.
async function generateOneInvoice(tpl, dueDateISO, lines) {
  const period = await resolvePeriodForDate(tpl.accounting_unit_id, dueDateISO);
  if (!period) {
    await writeAuditLog({
      unitId: tpl.accounting_unit_id, action: "RECURRING_SKIP", table: "recurring_invoice", entityId: tpl.id,
      after: { reason: "no_period", due_date: dueDateISO },
    });
    return { skipped: true, reason: "no_period", due_date: dueDateISO };
  }
  if (period.status === "uzavrene") {
    await writeAuditLog({
      unitId: tpl.accounting_unit_id, action: "RECURRING_SKIP", table: "recurring_invoice", entityId: tpl.id,
      after: { reason: "period_closed", due_date: dueDateISO, period_id: period.id },
    });
    return { skipped: true, reason: "period_closed", due_date: dueDateISO };
  }

  const responsibleUserId = await fallbackResponsibleUser(tpl.accounting_unit_id);
  const year = new Date(dueDateISO).getFullYear();
  const totalAmount = lines.reduce((s, l) => s + (l.quantity || 1) * l.unit_price, 0);

  const docId = await store.transaction(async () => {
    const docNumber = await generateDocumentNumber(tpl.accounting_unit_id, "faktura_vydana", year);
    await store.run(
      `INSERT INTO document
        (accounting_unit_id, doc_type, doc_number, contact_id, project_id, period_id,
         issue_date, due_date, description, total_amount, is_vat_document, vat_rate,
         responsible_user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tpl.accounting_unit_id, "faktura_vydana", docNumber, tpl.contact_id || null, tpl.project_id || null, period.id,
       dueDateISO, dueDateISO, tpl.description || tpl.name, totalAmount, tpl.is_vat_document ? 1 : 0, tpl.vat_rate || null,
       responsibleUserId]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const lineAmount = (l.quantity || 1) * l.unit_price;
      await store.run(
        `INSERT INTO document_line (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, lineAmount]
      );
    }
    await writeAuditLog({
      unitId: tpl.accounting_unit_id, userId: responsibleUserId, action: "RECURRING_GENERATE", table: "document",
      entityId: id, after: { doc_number: docNumber, recurring_invoice_id: tpl.id, due_date: dueDateISO },
    });
    return id;
  });
  return { skipped: false, document_id: docId, due_date: dueDateISO };
}

// Hlavní vstupní bod — projde všechny aktivní šablony s next_run_date <= asOfISO
// a doplní zmeškané faktury CATCH-UP smyčkou (jedna faktura na každé zmeškané
// due datum, ne jen jednu celkem). Vrací {created:[...], skipped:[...]}.
async function generateDueRecurringInvoices(asOfISO) {
  const created = [];
  const skipped = [];
  const templates = await store.all(`SELECT * FROM recurring_invoice WHERE active = 1 AND next_run_date <= ?`, [asOfISO]);

  for (const tpl of templates) {
    const lines = await store.all(
      `SELECT description, quantity, unit_price, vat_rate FROM recurring_invoice_line WHERE recurring_invoice_id = ? ORDER BY line_no`,
      [tpl.id]
    );
    if (!lines.length) continue;

    let nextRun = tpl.next_run_date;
    let occurrencesDone = tpl.occurrences_done;
    let active = tpl.active;

    while (nextRun <= asOfISO && active) {
      if (tpl.end_date && nextRun > tpl.end_date) { active = 0; break; }
      if (tpl.max_occurrences && occurrencesDone >= tpl.max_occurrences) { active = 0; break; }

      const result = await generateOneInvoice(tpl, nextRun, lines);
      if (result.skipped) skipped.push({ recurring_invoice_id: tpl.id, ...result });
      else {
        created.push({ recurring_invoice_id: tpl.id, ...result });
        occurrencesDone += 1;
      }
      nextRun = addInterval(nextRun, tpl.interval);
    }

    if (tpl.max_occurrences && occurrencesDone >= tpl.max_occurrences) active = 0;
    if (tpl.end_date && nextRun > tpl.end_date) active = 0;

    await store.run(
      `UPDATE recurring_invoice SET next_run_date = ?, occurrences_done = ?, active = ?, last_generated_at = datetime('now') WHERE id = ?`,
      [nextRun, occurrencesDone, active ? 1 : 0, tpl.id]
    );
    store.persist();
  }

  return { created, skipped };
}

module.exports = { resolvePeriodForDate, generateDueRecurringInvoices };
