const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/audit-log?unit=1&table=document&entityId=5 — nezměnitelný záznam všech úkonů (§ 33 odst. 8 ZoÚ)
router.get("/", (req, res) => {
  const { unit, table, entityId, limit } = req.query;
  try {
    let where = "accounting_unit_id = ?";
    const params = [unit];
    if (table) { where += " AND entity_table = ?"; params.push(table); }
    if (entityId) { where += " AND entity_id = ?"; params.push(entityId); }
    const rows = store.all(
      `SELECT * FROM audit_log WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      [...params, Number(limit) || 500]
    );
    res.json(rows.map((r) => ({
      ...r,
      before_data: r.before_data ? JSON.parse(r.before_data) : null,
      after_data: r.after_data ? JSON.parse(r.after_data) : null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
