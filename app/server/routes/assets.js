const express = require("express");
const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen } = require("../lib/core");
const router = express.Router();

// GET /api/assets?unit=1 — karty dlouhodobého majetku se zůstatkovou cenou (kap. 5.7 brief)
router.get("/", async (req, res) => {
  try {
    const assets = await store.all("SELECT * FROM fixed_asset WHERE accounting_unit_id = ? ORDER BY acquisition_date", [req.query.unit]);
    const withBalance = [];
    for (const a of assets) {
      const dep = await store.get("SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entry WHERE fixed_asset_id = ?", [a.id]);
      withBalance.push({ ...a, accumulated_depreciation: dep.total, net_book_value: a.acquisition_cost - dep.total });
    }
    res.json(withBalance);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", async (req, res) => {
  const { name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id, residual_value } = req.body;
  try {
    await store.run(
      `INSERT INTO fixed_asset (accounting_unit_id, name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id, residual_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.accountingUnitId, name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id || null, residual_value || 0]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM fixed_asset WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/assets/:id/depreciate — vypočte a zaúčtuje měsíční rovnoměrný odpis
// za dané období (551 Odpisy / 082 Oprávky). Kap. 5.7 brief.
router.post("/:id/depreciate", async (req, res) => {
  const { period_id, entry_date, created_by } = req.body;
  try {
    const result = await store.transaction(async () => {
      await assertPeriodOpen(period_id);
      await assertMonthOpen(req.user.accountingUnitId, entry_date);
      const asset = await store.get("SELECT * FROM fixed_asset WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
      if (!asset) throw new Error("Majetková karta nenalezena.");
      if (!asset.depreciation_account_id) throw new Error("Majetková karta nemá nastavený účet oprávek (082).");

      const monthlyAmount = (asset.acquisition_cost - asset.residual_value) / asset.useful_life_months;
      const alreadyDepreciated = (await store.get("SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entry WHERE fixed_asset_id = ?", [asset.id])).total;
      const remaining = asset.acquisition_cost - asset.residual_value - alreadyDepreciated;
      const amount = Math.min(monthlyAmount, remaining);
      if (amount <= 0) throw new Error("Majetek je již plně odepsán.");

      const postingNumber = await nextPostingNumber(asset.accounting_unit_id);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?)`,
        [asset.accounting_unit_id, period_id, postingNumber, entry_date, `Odpis majetku: ${asset.name}`, created_by]
      );
      const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;

      // Zaúčtování: MD 551 (Odpisy), D 082 (Oprávky) — účet majetku (022) se odpisem nemění.
      const depreciationExpenseAccount = await store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = '551'",
        [asset.accounting_unit_id]
      );
      const expenseAccountId = depreciationExpenseAccount ? depreciationExpenseAccount.id : asset.account_id;

      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, expenseAccountId, "MD", amount]);
      await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, asset.depreciation_account_id, "D", amount]);

      await store.run(
        `INSERT INTO depreciation_entry (fixed_asset_id, period_id, entry_date, amount, posting_id) VALUES (?,?,?,?,?)`,
        [asset.id, period_id, entry_date, amount, postingId]
      );

      await writeAuditLog({ unitId: asset.accounting_unit_id, userId: created_by, action: "INSERT", table: "depreciation_entry", entityId: asset.id, after: { amount, posting_id: postingId } });

      return { posting_id: postingId, amount };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
