const express = require("express");
const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertPeriodOpen } = require("../lib/core");
const router = express.Router();

// GET /api/assets?unit=1 — karty dlouhodobého majetku se zůstatkovou cenou (kap. 5.7 brief)
router.get("/", (req, res) => {
  try {
    const assets = store.all("SELECT * FROM fixed_asset WHERE accounting_unit_id = ? ORDER BY acquisition_date", [req.query.unit]);
    const withBalance = assets.map((a) => {
      const dep = store.get("SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entry WHERE fixed_asset_id = ?", [a.id]);
      return { ...a, accumulated_depreciation: dep.total, net_book_value: a.acquisition_cost - dep.total };
    });
    res.json(withBalance);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", (req, res) => {
  const { accounting_unit_id, name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id, residual_value } = req.body;
  try {
    store.run(
      `INSERT INTO fixed_asset (accounting_unit_id, name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id, residual_value)
       VALUES (?,?,?,?,?,?,?,?)`,
      [accounting_unit_id, name, acquisition_cost, acquisition_date, useful_life_months, account_id, depreciation_account_id || null, residual_value || 0]
    );
    const id = store.get("SELECT last_insert_rowid() AS id").id;
    store.persist();
    res.status(201).json(store.get("SELECT * FROM fixed_asset WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/assets/:id/depreciate — vypočte a zaúčtuje měsíční rovnoměrný odpis
// za dané období (551 Odpisy / 082 Oprávky). Kap. 5.7 brief.
router.post("/:id/depreciate", (req, res) => {
  const { period_id, entry_date, created_by } = req.body;
  try {
    const result = store.transaction(() => {
      assertPeriodOpen(period_id);
      const asset = store.get("SELECT * FROM fixed_asset WHERE id = ?", [req.params.id]);
      if (!asset) throw new Error("Majetková karta nenalezena.");
      if (!asset.depreciation_account_id) throw new Error("Majetková karta nemá nastavený účet oprávek (082).");

      const monthlyAmount = (asset.acquisition_cost - asset.residual_value) / asset.useful_life_months;
      const alreadyDepreciated = store.get("SELECT COALESCE(SUM(amount),0) AS total FROM depreciation_entry WHERE fixed_asset_id = ?", [asset.id]).total;
      const remaining = asset.acquisition_cost - asset.residual_value - alreadyDepreciated;
      const amount = Math.min(monthlyAmount, remaining);
      if (amount <= 0) throw new Error("Majetek je již plně odepsán.");

      const postingNumber = nextPostingNumber(asset.accounting_unit_id);
      store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?)`,
        [asset.accounting_unit_id, period_id, postingNumber, entry_date, `Odpis majetku: ${asset.name}`, created_by]
      );
      const postingId = store.get("SELECT last_insert_rowid() AS id").id;

      // Zaúčtování: MD 551 (Odpisy), D 082 (Oprávky) — účet majetku (022) se odpisem nemění.
      const depreciationExpenseAccount = store.get(
        "SELECT id FROM chart_of_accounts WHERE accounting_unit_id = ? AND account_number = '551'",
        [asset.accounting_unit_id]
      );
      const expenseAccountId = depreciationExpenseAccount ? depreciationExpenseAccount.id : asset.account_id;

      store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, expenseAccountId, "MD", amount]);
      store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount) VALUES (?,?,?,?)`, [postingId, asset.depreciation_account_id, "D", amount]);

      store.run(
        `INSERT INTO depreciation_entry (fixed_asset_id, period_id, entry_date, amount, posting_id) VALUES (?,?,?,?,?)`,
        [asset.id, period_id, entry_date, amount, postingId]
      );

      writeAuditLog({ unitId: asset.accounting_unit_id, userId: created_by, action: "INSERT", table: "depreciation_entry", entityId: asset.id, after: { amount, posting_id: postingId } });

      return { posting_id: postingId, amount };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
