const express = require("express");
const store = require("../db");
const { nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen, stornoPosting } = require("../lib/core");
const router = express.Router();

// GET /api/postings?unit=1
router.get("/", async (req, res) => {
  try {
    const rows = await store.all(
      `SELECT * FROM posting p WHERE accounting_unit_id = ?
       AND NOT EXISTS (SELECT 1 FROM posting_supersession ps WHERE ps.posting_id=p.id)
       ORDER BY posting_date DESC, posting_number DESC`,
      [req.query.unit]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/postings — zaúčtování (hlavička + řádky). MD musí == D, jinak transakce spadne.
router.post("/", async (req, res) => {
  const { accounting_unit_id, period_id, document_id, posting_date, description, created_by, lines } = req.body;

  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: "Účetní zápis musí mít alespoň dva řádky (MD a D)." });
  }

  try {
    const posting = await store.transaction(async () => {
      await assertPeriodOpen(period_id);
      await assertMonthOpen(accounting_unit_id, posting_date);

      const md = lines.filter((l) => l.side === "MD").reduce((s, l) => s + Number(l.amount), 0);
      const d = lines.filter((l) => l.side === "D").reduce((s, l) => s + Number(l.amount), 0);
      if (Math.abs(md - d) > 0.001) {
        throw new Error(`Účetní zápis není vyrovnaný: MD = ${md.toFixed(2)}, D = ${d.toFixed(2)}. Podvojné účetnictví vyžaduje MD = D.`);
      }

      const postingNumber = await nextPostingNumber(accounting_unit_id);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [accounting_unit_id, period_id, postingNumber, document_id || null, posting_date, description, created_by]
      );
      const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;

      for (const l of lines) {
        await store.run(
          `INSERT INTO posting_line (posting_id, account_id, side, amount, project_id) VALUES (?,?,?,?,?)`,
          [postingId, l.account_id, l.side, l.amount, l.project_id || null]
        );
      }

      if (document_id) {
        await store.run(`UPDATE document SET status = 'zauctovany' WHERE id = ? AND status IN ('koncept','schvaleny')`, [document_id]);
      }

      await writeAuditLog({ unitId: accounting_unit_id, userId: created_by, action: "INSERT", table: "posting", entityId: postingId, after: { posting_number: postingNumber, md, d } });

      return await store.get("SELECT * FROM posting WHERE id = ?", [postingId]);
    });
    res.status(201).json(posting);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/postings/:id — detail zápisu s řádky
router.get("/:id", async (req, res) => {
  try {
    const header = await store.get("SELECT * FROM posting WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!header) return res.status(404).json({ error: "Zápis nenalezen" });
    const lines = await store.all(
      `SELECT pl.*, coa.account_number, coa.name AS account_name
       FROM posting_line pl JOIN chart_of_accounts coa ON coa.id = pl.account_id
       WHERE posting_id = ?`,
      [req.params.id]
    );
    res.json({ ...header, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/postings/:id/storno — jediný povolený způsob "zrušení" zápisu.
router.post("/:id/storno", async (req, res) => {
  const { reason, created_by } = req.body;
  try {
    const newId = await store.transaction(async () => stornoPosting(req.params.id, reason, created_by, req.user.accountingUnitId));
    res.status(201).json({ storno_posting_id: newId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Klasický update/delete záměrně bez endpointu — API vrstva ani nenabízí
// akci, kterou by databázový trigger stejně odmítl (§ 33a ZoÚ).

module.exports = router;
