// =====================================================================
// recurring.js — CRUD šablon pravidelných faktur + manuální spuštění
// generování ("Generovat nyní"). Skutečnou generovací logiku (catch-up,
// period-lock skip+audit) má lib/recurring.js — tady jen CRUD nad
// recurring_invoice/recurring_invoice_line.
// =====================================================================
const express = require("express");
const store = require("../db");
const { generateDueRecurringInvoices } = require("../lib/recurring");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    res.json(await store.all("SELECT * FROM recurring_invoice WHERE accounting_unit_id = ? ORDER BY name", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const tpl = await store.get("SELECT * FROM recurring_invoice WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!tpl) return res.status(404).json({ error: "Šablona nenalezena" });
    const lines = await store.all("SELECT * FROM recurring_invoice_line WHERE recurring_invoice_id = ? ORDER BY line_no", [req.params.id]);
    res.json({ ...tpl, lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", async (req, res) => {
  const {
    accounting_unit_id, name, contact_id, project_id, interval, next_run_date, start_date, end_date,
    max_occurrences, description, is_vat_document, vat_rate, currency, lines,
  } = req.body;
  try {
    const tpl = await store.transaction(async () => {
      await store.run(
        `INSERT INTO recurring_invoice
          (accounting_unit_id, name, contact_id, project_id, interval, next_run_date, start_date, end_date,
           max_occurrences, description, is_vat_document, vat_rate, currency)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accounting_unit_id, name, contact_id || null, project_id || null, interval, next_run_date,
         start_date || null, end_date || null, max_occurrences || null, description || null,
         is_vat_document ? 1 : 0, vat_rate || null, currency || "CZK"]
      );
      const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
      if (Array.isArray(lines)) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await store.run(
            `INSERT INTO recurring_invoice_line (recurring_invoice_id, line_no, description, quantity, unit_price, vat_rate)
             VALUES (?,?,?,?,?,?)`,
            [id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null]
          );
        }
      }
      return store.get("SELECT * FROM recurring_invoice WHERE id = ?", [id]);
    });
    res.status(201).json(tpl);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put("/:id", async (req, res) => {
  const { name, contact_id, project_id, interval, next_run_date, start_date, end_date, max_occurrences, description, is_vat_document, vat_rate, currency, active, lines } = req.body;
  try {
    const existing = await store.get("SELECT * FROM recurring_invoice WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Šablona nenalezena" });

    const tpl = await store.transaction(async () => {
      await store.run(
        `UPDATE recurring_invoice SET name=?, contact_id=?, project_id=?, interval=?, next_run_date=?, start_date=?,
           end_date=?, max_occurrences=?, description=?, is_vat_document=?, vat_rate=?, currency=?, active=? WHERE id=? AND accounting_unit_id=?`,
        [name ?? existing.name, contact_id ?? existing.contact_id, project_id ?? existing.project_id,
         interval ?? existing.interval, next_run_date ?? existing.next_run_date, start_date ?? existing.start_date,
         end_date ?? existing.end_date, max_occurrences ?? existing.max_occurrences, description ?? existing.description,
         is_vat_document === undefined ? existing.is_vat_document : (is_vat_document ? 1 : 0),
         vat_rate ?? existing.vat_rate, currency ?? existing.currency,
         active === undefined ? existing.active : (active ? 1 : 0), req.params.id, req.user.accountingUnitId]
      );
      if (Array.isArray(lines)) {
        await store.run("DELETE FROM recurring_invoice_line WHERE recurring_invoice_id = ?", [req.params.id]);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await store.run(
            `INSERT INTO recurring_invoice_line (recurring_invoice_id, line_no, description, quantity, unit_price, vat_rate)
             VALUES (?,?,?,?,?,?)`,
            [req.params.id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null]
          );
        }
      }
      return store.get("SELECT * FROM recurring_invoice WHERE id = ?", [req.params.id]);
    });
    res.json(tpl);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const existing = await store.get("SELECT id FROM recurring_invoice WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Šablona nenalezena" });
    await store.run("DELETE FROM recurring_invoice_line WHERE recurring_invoice_id = ?", [req.params.id]);
    await store.run("DELETE FROM recurring_invoice WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/recurring/:id/run-now — vynutí generování bez ohledu na next_run_date
// (posune next_run_date na dnešek pro tuto šablonu, pak zavolá catch-up generátor).
router.post("/:id/run-now", async (req, res) => {
  try {
    const tpl = await store.get("SELECT * FROM recurring_invoice WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.query.unit]);
    if (!tpl) return res.status(404).json({ error: "Šablona nenalezena" });
    const today = new Date().toISOString().slice(0, 10);
    if (tpl.next_run_date > today) {
      await store.run("UPDATE recurring_invoice SET next_run_date = ? WHERE id = ?", [today, tpl.id]);
    }
    const result = await generateDueRecurringInvoices(today);
    store.persist();
    const mine = {
      created: result.created.filter((c) => String(c.recurring_invoice_id) === String(req.params.id)),
      skipped: result.skipped.filter((c) => String(c.recurring_invoice_id) === String(req.params.id)),
    };
    res.json(mine);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
