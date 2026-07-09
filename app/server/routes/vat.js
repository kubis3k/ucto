const express = require("express");
const store = require("../db");
const router = express.Router();

const KH_THRESHOLD = 10000; // § 100 ZDPH — kontrolní hlášení vyžaduje jednotlivou evidenci nad 10 000 Kč vč. daně

// GET /api/vat/ledger?unit=1&direction=uskutecnene
router.get("/ledger", async (req, res) => {
  const { unit, direction } = req.query;
  try {
    let where = "d.accounting_unit_id = ?";
    const params = [unit];
    if (direction) { where += " AND v.direction = ?"; params.push(direction); }
    res.json(await store.all(
      `SELECT v.*, d.doc_number, d.doc_type, c.name AS protistrana
       FROM vat_ledger_entry v
       JOIN document d ON d.id = v.document_id
       LEFT JOIN contact c ON c.id = d.contact_id
       WHERE ${where}
       ORDER BY v.duzp DESC`,
      params
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/vat/ledger — zápis do evidence pro DPH (§ 100 ZDPH), volá se po
// aktivaci plátcovství při zaúčtování daňového dokladu. Vynucuje DIČ nad limit KH.
router.post("/ledger", async (req, res) => {
  const { document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic, duzp } = req.body;
  try {
    const doc = await store.get("SELECT id FROM document WHERE id = ? AND accounting_unit_id = ?", [document_id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    const total = Number(vat_base) + Number(vat_amount);
    const requiresKh = total >= KH_THRESHOLD;
    if (requiresKh && !counterparty_dic) {
      return res.status(400).json({ error: `Doklad nad ${KH_THRESHOLD} Kč vč. daně vyžaduje pro kontrolní hlášení vyplnění DIČ protistrany (§ 100 ZDPH).` });
    }
    await store.run(
      `INSERT INTO vat_ledger_entry (document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic, duzp, requires_individual_kh)
       VALUES (?,?,?,?,?,?,?,?)`,
      [document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic || null, duzp, requiresKh ? 1 : 0]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM vat_ledger_entry WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/vat/priznani?unit=1&start=2026-01-01&end=2026-03-31 — podklad pro přiznání k DPH
router.get("/priznani", async (req, res) => {
  const { unit, start, end } = req.query;
  try {
    const summary = await store.get(
      `SELECT
         COALESCE(SUM(CASE WHEN v.direction='uskutecnene' THEN v.vat_base ELSE 0 END),0) AS zaklad_na_vystupu,
         COALESCE(SUM(CASE WHEN v.direction='uskutecnene' THEN v.vat_amount ELSE 0 END),0) AS dan_na_vystupu,
         COALESCE(SUM(CASE WHEN v.direction='prijate' THEN v.vat_base ELSE 0 END),0) AS zaklad_na_vstupu,
         COALESCE(SUM(CASE WHEN v.direction='prijate' THEN v.vat_amount ELSE 0 END),0) AS dan_na_vstupu
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ?`,
      [unit, start, end]
    );
    const vysledek = summary.dan_na_vystupu - summary.dan_na_vstupu; // kladné = k úhradě, záporné = nadměrný odpočet
    res.json({ ...summary, vysledna_dan: vysledek, typ: vysledek >= 0 ? "K ÚHRADĚ" : "NADMĚRNÝ ODPOČET" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/vat/kontrolni-hlaseni?unit=1&start=..&end=.. — jednotlivé doklady nad limit KH
router.get("/kontrolni-hlaseni", async (req, res) => {
  const { unit, start, end } = req.query;
  try {
    res.json(await store.all(
      `SELECT v.*, d.doc_number, d.doc_type, d.issue_date
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.requires_individual_kh = 1 AND v.duzp BETWEEN ? AND ?
       ORDER BY v.duzp`,
      [unit, start, end]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
