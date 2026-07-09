const express = require("express");
const store = require("../db");
const { writeAuditLog } = require("../lib/core");
const { accountNaturalBalance } = require("../lib/reports");
const router = express.Router();

// GET /api/inventory?unit=1 — historie inventarizací
router.get("/", async (req, res) => {
  try {
    res.json(await store.all("SELECT * FROM inventory_check WHERE accounting_unit_id = ? ORDER BY as_of_date DESC", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/inventory/generate — vygeneruje inventurní soupis k rozvahovému dni
// (zůstatky rozvahových účtů majetku, pohledávek, závazků, pokladny — § 29-30 ZoÚ)
router.post("/generate", async (req, res) => {
  const { period_id, as_of_date, created_by, note } = req.body;
  const accounting_unit_id = req.user.accountingUnitId;
  try {
    const result = await store.transaction(async () => {
      await store.run(
        `INSERT INTO inventory_check (accounting_unit_id, period_id, as_of_date, created_by, note) VALUES (?,?,?,?,?)`,
        [accounting_unit_id, period_id, as_of_date, created_by, note || null]
      );
      const checkId = (await store.get("SELECT last_insert_rowid() AS id")).id;

      const accounts = await store.all(
        `SELECT id FROM chart_of_accounts
         WHERE accounting_unit_id = ? AND account_type IN ('rozvahovy_aktivni','rozvahovy_pasivni') AND parent_account_id IS NULL`,
        [accounting_unit_id]
      );
      for (const acc of accounts) {
        const balance = await accountNaturalBalance(acc.id, as_of_date);
        await store.run(
          `INSERT INTO inventory_check_line (inventory_check_id, account_id, book_balance) VALUES (?,?,?)`,
          [checkId, acc.id, balance]
        );
      }

      await writeAuditLog({ unitId: accounting_unit_id, userId: created_by, action: "INSERT", table: "inventory_check", entityId: checkId, after: { as_of_date } });
      return checkId;
    });
    const lines = await store.all(
      `SELECT il.*, coa.account_number, coa.name AS account_name
       FROM inventory_check_line il JOIN chart_of_accounts coa ON coa.id = il.account_id
       WHERE inventory_check_id = ? ORDER BY coa.account_number`,
      [result]
    );
    res.status(201).json({ ...(await store.get("SELECT * FROM inventory_check WHERE id = ?", [result])), lines });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/inventory/:id — detail inventurního soupisu
router.get("/:id", async (req, res) => {
  try {
    const header = await store.get("SELECT * FROM inventory_check WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!header) return res.status(404).json({ error: "Inventurní soupis nenalezen" });
    const lines = await store.all(
      `SELECT il.*, coa.account_number, coa.name AS account_name
       FROM inventory_check_line il JOIN chart_of_accounts coa ON coa.id = il.account_id
       WHERE inventory_check_id = ? ORDER BY coa.account_number`,
      [req.params.id]
    );
    res.json({ ...header, lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/inventory/:id/lines/:lineId — zápis skutečného (fyzického) stavu při odsouhlasení
router.put("/:id/lines/:lineId", async (req, res) => {
  const { physical_balance, note } = req.body;
  try {
    const line = await store.get(
      `SELECT icl.* FROM inventory_check_line icl
       JOIN inventory_check ic ON ic.id = icl.inventory_check_id
       WHERE icl.id = ? AND icl.inventory_check_id = ? AND ic.accounting_unit_id = ?`,
      [req.params.lineId, req.params.id, req.user.accountingUnitId]
    );
    if (!line) return res.status(404).json({ error: "Řádek soupisu nenalezen" });
    const difference = Number(physical_balance) - line.book_balance;
    await store.run(
      `UPDATE inventory_check_line SET physical_balance = ?, difference = ?, note = ? WHERE id = ?`,
      [physical_balance, difference, note || null, req.params.lineId]
    );
    store.persist();
    res.json(await store.get("SELECT * FROM inventory_check_line WHERE id = ?", [req.params.lineId]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
