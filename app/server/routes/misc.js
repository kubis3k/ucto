const express = require("express");
const store = require("../db");
const { writeAuditLog } = require("../lib/core");
const router = express.Router();

// GET /api/accounts?unit=1
router.get("/accounts", (req, res) => {
  try {
    res.json(store.all("SELECT * FROM chart_of_accounts WHERE accounting_unit_id = ? ORDER BY account_number", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — přidání účtu do rozvrhu (konfigurace, kap. 5.3 brief)
router.post("/accounts", (req, res) => {
  const { accounting_unit_id, account_number, parent_account_id, name, account_class, account_type } = req.body;
  try {
    store.run(
      `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
       VALUES (?,?,?,?,?,?)`,
      [accounting_unit_id, account_number, parent_account_id || null, name, account_class, account_type]
    );
    const id = store.get("SELECT last_insert_rowid() AS id").id;
    store.persist();
    res.status(201).json(store.get("SELECT * FROM chart_of_accounts WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/periods?unit=1
router.get("/periods", (req, res) => {
  try {
    res.json(store.all("SELECT * FROM accounting_period WHERE accounting_unit_id = ? ORDER BY fiscal_year", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/periods — otevření nového účetního období
router.post("/periods", (req, res) => {
  const { accounting_unit_id, fiscal_year, start_date, end_date } = req.body;
  try {
    store.run(
      `INSERT INTO accounting_period (accounting_unit_id, fiscal_year, start_date, end_date, status) VALUES (?,?,?,?,'otevrene')`,
      [accounting_unit_id, fiscal_year, start_date, end_date]
    );
    const id = store.get("SELECT last_insert_rowid() AS id").id;
    store.persist();
    res.status(201).json(store.get("SELECT * FROM accounting_period WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/periods/:id/close — roční uzávěrka (§ 29-30 ZoÚ). Po zavolání
// systém odmítne jakýkoli další zápis s datem v tomto období.
router.post("/periods/:id/close", (req, res) => {
  const { closed_by } = req.body;
  try {
    const before = store.get("SELECT * FROM accounting_period WHERE id = ? AND status = 'otevrene'", [req.params.id]);
    if (!before) return res.status(400).json({ error: "Období nelze uzavřít — buď neexistuje, nebo je již uzavřené." });

    store.transaction(() => {
      store.run("UPDATE accounting_period SET status = 'uzavrene', closed_at = datetime('now'), closed_by = ? WHERE id = ?", [closed_by, req.params.id]);
      writeAuditLog({ unitId: before.accounting_unit_id, userId: closed_by, action: "PERIOD_CLOSE", table: "accounting_period", entityId: req.params.id, before, after: { status: "uzavrene" } });
    });
    res.json(store.get("SELECT * FROM accounting_period WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/units — vlastní účetní jednotka přihlášeného uživatele (jen jedna
// v poli, kvůli zpětné kompatibilitě s rendererem — NIKDY ne cizí firmy).
router.get("/units", (req, res) => {
  try {
    res.json(store.all("SELECT * FROM accounting_unit WHERE id = ?", [req.user.accountingUnitId]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/units/:id — přepínač "Plátce DPH: ano/ne" apod. (kap. 3.2 brief)
router.patch("/units/:id", (req, res) => {
  const { is_vat_payer, vat_payer_since, accounting_mode, name, dic, unit_category, iban, bank_account } = req.body;
  try {
    if (Number(req.params.id) !== req.user.accountingUnitId) return res.status(403).json({ error: "Nemáte oprávnění upravovat jinou firmu." });
    const before = store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Účetní jednotka nenalezena" });

    store.run(
      `UPDATE accounting_unit SET
        is_vat_payer = COALESCE(?, is_vat_payer),
        vat_payer_since = COALESCE(?, vat_payer_since),
        accounting_mode = COALESCE(?, accounting_mode),
        name = COALESCE(?, name),
        dic = COALESCE(?, dic),
        unit_category = COALESCE(?, unit_category),
        iban = COALESCE(?, iban),
        bank_account = COALESCE(?, bank_account)
       WHERE id = ?`,
      [is_vat_payer === undefined ? null : (is_vat_payer ? 1 : 0), vat_payer_since || null,
       accounting_mode || null, name || null, dic || null, unit_category || null,
       iban || null, bank_account || null, req.params.id]
    );
    store.persist();
    writeAuditLog({ unitId: req.params.id, action: "UPDATE", table: "accounting_unit", entityId: req.params.id, before, after: req.body });
    res.json(store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/users?unit=1
router.get("/users", (req, res) => {
  try {
    res.json(store.all("SELECT * FROM app_user WHERE accounting_unit_id = ? ORDER BY id", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users — přidání uživatele s rolí (kap. 5.10 brief — zadavatel/schvalovatel)
router.post("/users", (req, res) => {
  const { accounting_unit_id, full_name, email, role } = req.body;
  try {
    store.run(
      `INSERT INTO app_user (accounting_unit_id, full_name, email, role) VALUES (?,?,?,?)`,
      [accounting_unit_id, full_name, email, role || "zadavatel"]
    );
    const id = store.get("SELECT last_insert_rowid() AS id").id;
    store.persist();
    res.status(201).json(store.get("SELECT * FROM app_user WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
