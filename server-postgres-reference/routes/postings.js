const express = require("express");
const { pool } = require("../db");
const router = express.Router();

// POST /api/postings — zaúčtování (hlavička + řádky v jedné transakci).
// Databázový trigger check_posting_balanced() na COMMIT ověří MD = D;
// pokud nesedí, celá transakce spadne a nic se nezapíše (viz test v SQL vrstvě).
router.post("/", async (req, res) => {
  const { accounting_unit_id, period_id, document_id, posting_date, description, created_by, lines } = req.body;

  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: "Účetní zápis musí mít alespoň dva řádky (MD a D)." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const posting = await client.query(
      `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
       VALUES ($1,$2,0,$3,$4,$5,$6) RETURNING *`,
      [accounting_unit_id, period_id, document_id || null, posting_date, description, created_by]
    );
    const postingId = posting.rows[0].id;

    for (const l of lines) {
      await client.query(
        `INSERT INTO posting_line (posting_id, account_id, side, amount, project_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [postingId, l.account_id, l.side, l.amount, l.project_id || null]
      );
    }

    // Pokud je posting vázán na doklad, po úspěšném zaúčtování ho označíme
    if (document_id) {
      await client.query(
        `UPDATE document SET status = 'zauctovany' WHERE id = $1 AND status IN ('koncept','schvaleny')`,
        [document_id]
      );
    }

    await client.query("COMMIT");   // zde se vyhodnotí DEFERRED constraint trigger (vyrovnanost MD=D)
    res.status(201).json(posting.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    // Business-rule chyby z triggerů (nevyrovnaný zápis, uzavřené období) vrací srozumitelnou hlášku
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/postings/:id — detail zápisu s řádky
router.get("/:id", async (req, res) => {
  try {
    const header = await pool.query("SELECT * FROM posting WHERE id = $1", [req.params.id]);
    if (header.rows.length === 0) return res.status(404).json({ error: "Zápis nenalezen" });
    const lines = await pool.query(
      `SELECT pl.*, coa.account_number, coa.name AS account_name
       FROM posting_line pl JOIN chart_of_accounts coa ON coa.id = pl.account_id
       WHERE posting_id = $1`, [req.params.id]
    );
    res.json({ ...header.rows[0], lines: lines.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/postings/:id/storno — jediný povolený způsob "zrušení" zápisu.
// Volá SQL funkci storno_posting() — fyzicky nic nemaže, jen zapíše protichůdný zápis.
router.post("/:id/storno", async (req, res) => {
  const { reason, created_by } = req.body;
  try {
    const { rows } = await pool.query(
      "SELECT storno_posting($1, $2, $3) AS new_posting_id",
      [req.params.id, reason, created_by]
    );
    res.status(201).json({ storno_posting_id: rows[0].new_posting_id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pokusy o klasický update/delete jsou záměrně BEZ endpointu — API vrstva
// neumožňuje ani nabídnout akci, kterou by databáze stejně odmítla (§ 33a ZoÚ).

module.exports = router;
