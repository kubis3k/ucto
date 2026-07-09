const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/contacts?unit=1&type=odberatel
router.get("/", async (req, res) => {
  const { unit, type } = req.query;
  try {
    let where = "accounting_unit_id = ?";
    const params = [unit];
    if (type) { where += " AND contact_type = ?"; params.push(type); }
    res.json(await store.all(`SELECT * FROM contact WHERE ${where} ORDER BY name`, params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const row = await store.get("SELECT * FROM contact WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!row) return res.status(404).json({ error: "Kontakt nenalezen" });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", async (req, res) => {
  const { name, contact_type, ico, dic, is_vat_payer, address, bank_account, iban, email } = req.body;
  try {
    await store.run(
      `INSERT INTO contact (accounting_unit_id, name, contact_type, ico, dic, is_vat_payer, address, bank_account, iban, email)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.user.accountingUnitId, name, contact_type, ico || null, dic || null, is_vat_payer ? 1 : 0, address || null, bank_account || null, iban || null, email || null]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM contact WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put("/:id", async (req, res) => {
  const { name, contact_type, ico, dic, is_vat_payer, address, bank_account, email } = req.body;
  try {
    const existing = await store.get("SELECT * FROM contact WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Kontakt nenalezen" });
    await store.run(
      `UPDATE contact SET name=?, contact_type=?, ico=?, dic=?, is_vat_payer=?, address=?, bank_account=?, email=? WHERE id=? AND accounting_unit_id=?`,
      [name ?? existing.name, contact_type ?? existing.contact_type, ico ?? existing.ico, dic ?? existing.dic,
       is_vat_payer === undefined ? existing.is_vat_payer : (is_vat_payer ? 1 : 0),
       address ?? existing.address, bank_account ?? existing.bank_account, email ?? existing.email, req.params.id, req.user.accountingUnitId]
    );
    store.persist();
    res.json(await store.get("SELECT * FROM contact WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Kontakty nejsou účetní záznam ve smyslu § 33a ZoÚ, takže mazání je povoleno
// (jde o číselník) — pouze pokud na kontakt neexistují žádné doklady.
router.delete("/:id", async (req, res) => {
  try {
    const contact = await store.get("SELECT id FROM contact WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!contact) return res.status(404).json({ error: "Kontakt nenalezen" });
    const inUse = await store.get("SELECT COUNT(*) AS cnt FROM document WHERE contact_id = ?", [req.params.id]);
    if (inUse.cnt > 0) return res.status(400).json({ error: "Kontakt nelze smazat — je použit na dokladech." });
    await store.run("DELETE FROM contact WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
