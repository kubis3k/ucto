// =====================================================================
// offers.js — Nabídky (offer/offer_line). SCHVÁLENĚ separátní tabulka,
// ne doc_type na `document` — nabídky nejsou účetní záznam a nesmí
// tečou do výkazů/DPH (viz .claude/agent-memory/architect/
// accounting-doc-invariants.md). Číslo nabídky (NAB) ale sdílí
// document_number_sequence přes generateDocumentNumber(unit,'nabidka',rok).
// =====================================================================
const express = require("express");
const store = require("../db");
const { generateDocumentNumber, writeAuditLog } = require("../lib/core");
const { resolvePeriodForDate } = require("../lib/recurring");
const { buildOfferPdf } = require("../lib/invoicePdf");
const mailer = require("../lib/mailer");
const router = express.Router();

// GET /api/offers?unit=1&status=koncept
router.get("/", async (req, res) => {
  const { unit, status } = req.query;
  try {
    let where = "accounting_unit_id = ?";
    const params = [unit];
    if (status) { where += " AND status = ?"; params.push(status); }
    res.json(await store.all(`SELECT * FROM offer WHERE ${where} ORDER BY issue_date DESC, id DESC`, params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const offer = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!offer) return res.status(404).json({ error: "Nabídka nenalezena" });
    const lines = await store.all("SELECT * FROM offer_line WHERE offer_id = ? ORDER BY line_no", [req.params.id]);
    res.json({ ...offer, lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/offers — vytvoření nabídky (koncept), číslo přes NAB řadu.
router.post("/", async (req, res) => {
  const {
    accounting_unit_id, contact_id, project_id, issue_date, valid_until, description,
    is_vat_document, vat_base_amount, vat_rate, vat_amount, responsible_user_id, lines,
  } = req.body;
  try {
    const offer = await store.transaction(async () => {
      const year = new Date(issue_date).getFullYear();
      const offerNumber = await generateDocumentNumber(accounting_unit_id, "nabidka", year);
      const totalAmount = Array.isArray(lines) && lines.length
        ? lines.reduce((s, l) => s + (l.quantity || 1) * l.unit_price, 0)
        : 0;

      await store.run(
        `INSERT INTO offer
          (accounting_unit_id, offer_number, contact_id, project_id, issue_date, valid_until, description,
           total_amount, is_vat_document, vat_base_amount, vat_rate, vat_amount, responsible_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accounting_unit_id, offerNumber, contact_id || null, project_id || null, issue_date, valid_until || null,
         description || null, totalAmount, is_vat_document ? 1 : 0, vat_base_amount || null, vat_rate || null,
         vat_amount || null, responsible_user_id || req.user.id]
      );
      const offerId = (await store.get("SELECT last_insert_rowid() AS id")).id;

      if (Array.isArray(lines)) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const lineAmount = (l.quantity || 1) * l.unit_price;
          await store.run(
            `INSERT INTO offer_line (offer_id, line_no, description, quantity, unit_price, vat_rate, line_amount)
             VALUES (?,?,?,?,?,?,?)`,
            [offerId, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, lineAmount]
          );
        }
      }

      await writeAuditLog({ unitId: accounting_unit_id, userId: req.user.id, action: "INSERT", table: "offer", entityId: offerId, after: { offer_number: offerNumber, total_amount: totalAmount } });
      return store.get("SELECT * FROM offer WHERE id = ?", [offerId]);
    });
    res.status(201).json(offer);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT /api/offers/:id — editace; blokováno pro převedené nabídky.
router.put("/:id", async (req, res) => {
  const { contact_id, project_id, issue_date, valid_until, description, is_vat_document, vat_base_amount, vat_rate, vat_amount, lines } = req.body;
  try {
    const existing = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Nabídka nenalezena" });
    if (existing.status === "prevedena") return res.status(400).json({ error: "Nabídka je již převedena na fakturu — nelze upravit." });

    const offer = await store.transaction(async () => {
      const totalAmount = Array.isArray(lines) && lines.length
        ? lines.reduce((s, l) => s + (l.quantity || 1) * l.unit_price, 0)
        : existing.total_amount;

      await store.run(
        `UPDATE offer SET contact_id=?, project_id=?, issue_date=?, valid_until=?, description=?, total_amount=?,
           is_vat_document=?, vat_base_amount=?, vat_rate=?, vat_amount=?, updated_at=datetime('now') WHERE id=? AND accounting_unit_id=?`,
        [contact_id ?? existing.contact_id, project_id ?? existing.project_id, issue_date ?? existing.issue_date,
         valid_until ?? existing.valid_until, description ?? existing.description, totalAmount,
         is_vat_document === undefined ? existing.is_vat_document : (is_vat_document ? 1 : 0),
         vat_base_amount ?? existing.vat_base_amount, vat_rate ?? existing.vat_rate, vat_amount ?? existing.vat_amount,
         req.params.id, req.user.accountingUnitId]
      );

      if (Array.isArray(lines)) {
        await store.run("DELETE FROM offer_line WHERE offer_id = ?", [req.params.id]);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const lineAmount = (l.quantity || 1) * l.unit_price;
          await store.run(
            `INSERT INTO offer_line (offer_id, line_no, description, quantity, unit_price, vat_rate, line_amount)
             VALUES (?,?,?,?,?,?,?)`,
            [req.params.id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, lineAmount]
          );
        }
      }
      await writeAuditLog({ unitId: existing.accounting_unit_id, userId: req.user.id, action: "UPDATE", table: "offer", entityId: req.params.id, before: existing });
      return store.get("SELECT * FROM offer WHERE id = ?", [req.params.id]);
    });
    res.json(offer);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH /api/offers/:id/status — { status }
router.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
  const allowed = ["koncept", "odeslana", "prijata", "odmitnuta"];
  if (!allowed.includes(status)) return res.status(400).json({ error: `Neplatný status. Povolené: ${allowed.join(", ")}` });
  try {
    const existing = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Nabídka nenalezena" });
    if (existing.status === "prevedena") return res.status(400).json({ error: "Nabídka je již převedena na fakturu — status nelze měnit." });

    await store.run("UPDATE offer SET status = ?, updated_at = datetime('now') WHERE id = ? AND accounting_unit_id = ?", [status, req.params.id, req.user.accountingUnitId]);
    await writeAuditLog({ unitId: existing.accounting_unit_id, userId: req.user.id, action: "STATUS", table: "offer", entityId: req.params.id, before: { status: existing.status }, after: { status } });
    res.json(await store.get("SELECT * FROM offer WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/offers/:id — blokováno pro převedené nabídky.
router.delete("/:id", async (req, res) => {
  try {
    const existing = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Nabídka nenalezena" });
    if (existing.status === "prevedena") return res.status(400).json({ error: "Nabídka je již převedena na fakturu — nelze smazat." });
    await store.run("DELETE FROM offer_line WHERE offer_id = ?", [req.params.id]);
    await store.run("DELETE FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

async function loadOfferPdfInputs(req) {
  const offer = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
  if (!offer) throw Object.assign(new Error("Nabídka nenalezena"), { status: 404 });
  const [lines, unit, contact] = await Promise.all([
    store.all("SELECT * FROM offer_line WHERE offer_id = ? ORDER BY line_no", [offer.id]),
    store.get("SELECT * FROM accounting_unit WHERE id = ?", [offer.accounting_unit_id]),
    offer.contact_id ? store.get("SELECT * FROM contact WHERE id = ?", [offer.contact_id]) : null,
  ]);
  return { offer, lines, unit, contact };
}

// GET /api/offers/:id/pdf
router.get("/:id/pdf", async (req, res) => {
  try {
    const { offer, lines, unit, contact } = await loadOfferPdfInputs(req);
    const pdfBuffer = await buildOfferPdf({ offer, lines, unit, contact });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="nabidka-${offer.offer_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// POST /api/offers/:id/send-email
router.post("/:id/send-email", async (req, res) => {
  try {
    const { offer, lines, unit, contact } = await loadOfferPdfInputs(req);
    const to = req.body.to || contact?.email;
    if (!to) return res.status(400).json({ error: "Chybí e-mail adresáta — doplňte ho u kontaktu nebo zadejte přímo." });

    const pdfBuffer = await buildOfferPdf({ offer, lines, unit, contact });
    const subject = req.body.subject || `Cenová nabídka č. ${offer.offer_number} — ${unit.name}`;
    const text = req.body.message || `Dobrý den,\n\nv příloze zasíláme cenovou nabídku č. ${offer.offer_number} na částku ${Number(offer.total_amount).toLocaleString("cs-CZ")} Kč, platnou do ${offer.valid_until || "—"}.\n\nS pozdravem,\n${unit.name}`;
    await mailer.sendInvoiceEmail({ to, subject, text, pdfBuffer, fileName: `nabidka-${offer.offer_number}.pdf` });

    await writeAuditLog({ unitId: offer.accounting_unit_id, userId: req.user.id, action: "SEND_EMAIL", table: "offer", entityId: offer.id, after: { to } });
    res.json({ ok: true, to });
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// POST /api/offers/:id/convert — převod nabídky na vydanou fakturu (koncept).
// Respektuje period-lock: pokud pro dnešní datum chybí/je uzavřené období, vrátí chybu.
router.post("/:id/convert", async (req, res) => {
  try {
    const offer = await store.get("SELECT * FROM offer WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!offer) return res.status(404).json({ error: "Nabídka nenalezena" });
    if (offer.status === "prevedena") return res.status(400).json({ error: "Nabídka je již převedena na fakturu." });

    const today = new Date().toISOString().slice(0, 10);
    const period = await resolvePeriodForDate(offer.accounting_unit_id, today);
    if (!period) return res.status(400).json({ error: "Pro dnešní datum neexistuje účetní období — nelze vytvořit fakturu." });
    if (period.status === "uzavrene") return res.status(400).json({ error: "Účetní období je uzavřené — nelze vytvořit fakturu." });

    const lines = await store.all("SELECT * FROM offer_line WHERE offer_id = ? ORDER BY line_no", [offer.id]);

    const doc = await store.transaction(async () => {
      const year = new Date(today).getFullYear();
      const docNumber = await generateDocumentNumber(offer.accounting_unit_id, "faktura_vydana", year);
      // FIX P2 (critic 2026-07-09): kopírovat currency z nabídky (jinak
      // defaultuje na CZK bez ohledu na měnu nabídky) a due_date. Nabídka
      // nemá vlastní koncept splatnosti — jako nejbližší dostupné datum
      // použijeme valid_until (platnost nabídky); pokud chybí, due_date
      // zůstane NULL (žádné jiné pole na offer k odvození nenÍ — zapsáno
      // do agent-memory jako known-approximation, ne přesný přepočet).
      // taxable_supply_date offer také nemá — necháváme NULL.
      await store.run(
        `INSERT INTO document
          (accounting_unit_id, doc_type, doc_number, contact_id, project_id, period_id,
           issue_date, due_date, description, total_amount, currency, is_vat_document, vat_base_amount, vat_rate, vat_amount,
           responsible_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [offer.accounting_unit_id, "faktura_vydana", docNumber, offer.contact_id, offer.project_id, period.id,
         today, offer.valid_until || null, offer.description || `Fakturace dle nabídky ${offer.offer_number}`, offer.total_amount,
         offer.currency || "CZK", offer.is_vat_document, offer.vat_base_amount, offer.vat_rate, offer.vat_amount, req.user.id]
      );
      const docId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await store.run(
          `INSERT INTO document_line (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount)
           VALUES (?,?,?,?,?,?,?)`,
          [docId, i + 1, l.description, l.quantity, l.unit_price, l.vat_rate, l.line_amount]
        );
      }
      await store.run("UPDATE offer SET status = 'prevedena', converted_document_id = ?, updated_at = datetime('now') WHERE id = ?", [docId, offer.id]);
      await writeAuditLog({ unitId: offer.accounting_unit_id, userId: req.user.id, action: "CONVERT", table: "offer", entityId: offer.id, after: { converted_document_id: docId, doc_number: docNumber } });
      return store.get("SELECT * FROM document WHERE id = ?", [docId]);
    });
    res.status(201).json(doc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
