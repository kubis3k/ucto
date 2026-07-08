const express = require("express");
const { pool } = require("../db");
const router = express.Router();

// GET /api/documents?unit=1&status=koncept
router.get("/", async (req, res) => {
  const { unit, status, docType } = req.query;
  try {
    const params = [unit];
    let where = "accounting_unit_id = $1";
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    if (docType) { params.push(docType); where += ` AND doc_type = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT * FROM document WHERE ${where} ORDER BY issue_date DESC`, params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get("/:id", async (req, res) => {
  try {
    const doc = await pool.query("SELECT * FROM document WHERE id = $1", [req.params.id]);
    if (doc.rows.length === 0) return res.status(404).json({ error: "Doklad nenalezen" });
    const lines = await pool.query(
      "SELECT * FROM document_line WHERE document_id = $1 ORDER BY line_no", [req.params.id]
    );
    res.json({ ...doc.rows[0], lines: lines.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents  — vytvoření nového dokladu (koncept)
// Číslo dokladu se generuje automaticky triggerem (viz 002_functions_triggers.sql),
// pokud doc_number není v těle požadavku uveden.
router.post("/", async (req, res) => {
  const {
    accounting_unit_id, doc_type, contact_id, project_id, period_id,
    issue_date, taxable_supply_date, due_date, description, total_amount,
    is_vat_document, vat_base_amount, vat_rate, vat_amount, responsible_user_id,
    lines, // volitelné pole položek [{description, quantity, unit_price, vat_rate, line_amount, suggested_account_id}]
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const docResult = await client.query(
      `INSERT INTO document
        (accounting_unit_id, doc_type, contact_id, project_id, period_id,
         issue_date, taxable_supply_date, due_date, description, total_amount,
         is_vat_document, vat_base_amount, vat_rate, vat_amount, responsible_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [accounting_unit_id, doc_type, contact_id, project_id, period_id,
       issue_date, taxable_supply_date, due_date, description, total_amount,
       is_vat_document || false, vat_base_amount, vat_rate, vat_amount, responsible_user_id]
    );
    const doc = docResult.rows[0];

    if (Array.isArray(lines)) {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        await client.query(
          `INSERT INTO document_line
            (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount, suggested_account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [doc.id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate, l.line_amount, l.suggested_account_id]
        );
      }
    }

    await client.query("COMMIT");
    res.status(201).json(doc);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/documents/:id/approve — schválení dokladu (odpovědná osoba za zaúčtování, § 11 ZoÚ)
router.post("/:id/approve", async (req, res) => {
  const { approved_by } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE document SET status = 'schvaleny', approved_by = $1, approved_at = now()
       WHERE id = $2 AND status = 'koncept' RETURNING *`,
      [approved_by, req.params.id]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: "Doklad nelze schválit — buď neexistuje, nebo už není v konceptu." });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
