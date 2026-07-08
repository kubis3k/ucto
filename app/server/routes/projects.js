const express = require("express");
const store = require("../db");
const router = express.Router();

// GET /api/projects?unit=1 — se souhrnem nákladů/výnosů pro analytické sledování ziskovosti akcí
router.get("/", (req, res) => {
  try {
    const projects = store.all("SELECT * FROM project WHERE accounting_unit_id = ? ORDER BY start_date DESC", [req.query.unit]);
    const withTotals = projects.map((p) => {
      const totals = store.get(
        `SELECT
           COALESCE(SUM(CASE WHEN coa.account_type='vysledkovy_naklad' AND pl.side='MD' THEN pl.amount ELSE 0 END),0) AS naklady,
           COALESCE(SUM(CASE WHEN coa.account_type='vysledkovy_vynos'  AND pl.side='D'  THEN pl.amount ELSE 0 END),0) AS vynosy
         FROM posting_line pl
         JOIN chart_of_accounts coa ON coa.id = pl.account_id
         WHERE pl.project_id = ?`,
        [p.id]
      );
      return { ...p, naklady: totals.naklady, vynosy: totals.vynosy, vysledek: totals.vynosy - totals.naklady };
    });
    res.json(withTotals);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", (req, res) => {
  const { accounting_unit_id, code, name, budget, start_date, end_date } = req.body;
  try {
    store.run(
      `INSERT INTO project (accounting_unit_id, code, name, budget, start_date, end_date) VALUES (?,?,?,?,?,?)`,
      [accounting_unit_id, code, name, budget || null, start_date || null, end_date || null]
    );
    const id = store.get("SELECT last_insert_rowid() AS id").id;
    store.persist();
    res.status(201).json(store.get("SELECT * FROM project WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put("/:id", (req, res) => {
  const { name, budget, start_date, end_date, active } = req.body;
  try {
    const existing = store.get("SELECT * FROM project WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Projekt nenalezen" });
    store.run(
      `UPDATE project SET name=?, budget=?, start_date=?, end_date=?, active=? WHERE id=?`,
      [name ?? existing.name, budget ?? existing.budget, start_date ?? existing.start_date,
       end_date ?? existing.end_date, active === undefined ? existing.active : (active ? 1 : 0), req.params.id]
    );
    store.persist();
    res.json(store.get("SELECT * FROM project WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete("/:id", (req, res) => {
  try {
    const existing = store.get("SELECT * FROM project WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Projekt nenalezen" });

    const docCount = store.get("SELECT COUNT(*) AS n FROM document WHERE project_id = ?", [req.params.id]).n;
    const postingCount = store.get("SELECT COUNT(*) AS n FROM posting_line WHERE project_id = ?", [req.params.id]).n;
    if (docCount > 0 || postingCount > 0) {
      return res.status(409).json({
        error: "Projekt má napojené doklady nebo účetní zápisy — nelze trvale smazat, pouze deaktivovat.",
      });
    }

    store.run("DELETE FROM project WHERE id = ?", [req.params.id]);
    store.persist();
    res.status(204).end();
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
