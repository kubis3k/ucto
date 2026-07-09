const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/price-list?unit=1 — jen aktivní položky ceníku (číselník pro autofill řádků)
router.get("/", async (req, res) => {
  const { unit } = req.query;
  try {
    res.json(await store.all("SELECT * FROM price_list_item WHERE accounting_unit_id = ? AND active = 1 ORDER BY name", [unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/:id", async (req, res) => {
  try {
    const row = await store.get("SELECT * FROM price_list_item WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!row) return res.status(404).json({ error: "Položka ceníku nenalezena" });
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", async (req, res) => {
  const { accounting_unit_id, name, description, unit_price, unit, vat_rate } = req.body;
  try {
    await store.run(
      `INSERT INTO price_list_item (accounting_unit_id, name, description, unit_price, unit, vat_rate)
       VALUES (?,?,?,?,?,?)`,
      [accounting_unit_id, name, description || null, unit_price, unit || null, vat_rate || null]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM price_list_item WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put("/:id", async (req, res) => {
  const { name, description, unit_price, unit, vat_rate, active } = req.body;
  try {
    const existing = await store.get("SELECT * FROM price_list_item WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Položka ceníku nenalezena" });
    await store.run(
      `UPDATE price_list_item SET name=?, description=?, unit_price=?, unit=?, vat_rate=?, active=? WHERE id=? AND accounting_unit_id=?`,
      [name ?? existing.name, description ?? existing.description, unit_price ?? existing.unit_price,
       unit ?? existing.unit, vat_rate ?? existing.vat_rate,
       active === undefined ? existing.active : (active ? 1 : 0), req.params.id, req.user.accountingUnitId]
    );
    store.persist();
    res.json(await store.get("SELECT * FROM price_list_item WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Ceník je číselník (žádná účetní vazba) — hard delete povolen.
router.delete("/:id", async (req, res) => {
  try {
    await store.run("DELETE FROM price_list_item WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
