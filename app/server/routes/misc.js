const express = require("express");
const store = require("../db");
const { writeAuditLog } = require("../lib/core");
const { requireRole } = require("../lib/auth");
const router = express.Router();

// Administrativní/závažné úkony — jen admin a účetní (viz lib/auth.js
// requireRole pro zdůvodnění modelu rolí). Odemčení měsíce zůstává nejtvrdší
// (jen admin), protože ruší už provedenou uzávěrku.
const ADMIN_OR_ACCOUNTANT = requireRole("admin", "ucetni");

// GET /api/accounts?unit=1
router.get("/accounts", async (req, res) => {
  try {
    res.json(await store.all("SELECT * FROM chart_of_accounts WHERE accounting_unit_id = ? ORDER BY account_number", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/accounts — přidání účtu do rozvrhu (konfigurace, kap. 5.3 brief)
router.post("/accounts", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const { accounting_unit_id, account_number, parent_account_id, name, account_class, account_type } = req.body;
  try {
    await store.run(
      `INSERT INTO chart_of_accounts (accounting_unit_id, account_number, parent_account_id, name, account_class, account_type)
       VALUES (?,?,?,?,?,?)`,
      [accounting_unit_id, account_number, parent_account_id || null, name, account_class, account_type]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM chart_of_accounts WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/periods?unit=1
router.get("/periods", async (req, res) => {
  try {
    res.json(await store.all("SELECT * FROM accounting_period WHERE accounting_unit_id = ? ORDER BY fiscal_year", [req.query.unit]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/periods — otevření nového účetního období
router.post("/periods", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const { accounting_unit_id, fiscal_year, start_date, end_date } = req.body;
  try {
    await store.run(
      `INSERT INTO accounting_period (accounting_unit_id, fiscal_year, start_date, end_date, status) VALUES (?,?,?,?,'otevrene')`,
      [accounting_unit_id, fiscal_year, start_date, end_date]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM accounting_period WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/periods/:id/close — roční uzávěrka (§ 29-30 ZoÚ). Po zavolání
// systém odmítne jakýkoli další zápis s datem v tomto období.
router.post("/periods/:id/close", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const { closed_by } = req.body;
  try {
    const before = await store.get("SELECT * FROM accounting_period WHERE id = ? AND status = 'otevrene' AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!before) return res.status(400).json({ error: "Období nelze uzavřít — buď neexistuje, nebo je již uzavřené." });

    await store.transaction(async () => {
      await store.run("UPDATE accounting_period SET status = 'uzavrene', closed_at = datetime('now'), closed_by = ? WHERE id = ? AND accounting_unit_id = ?", [closed_by, req.params.id, req.user.accountingUnitId]);
      await writeAuditLog({ unitId: before.accounting_unit_id, userId: closed_by, action: "PERIOD_CLOSE", table: "accounting_period", entityId: req.params.id, before, after: { status: "uzavrene" } });
    });
    res.json(await store.get("SELECT * FROM accounting_period WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/periods/:id/month-locks — přehled uzamčených měsíců daného období
router.get("/periods/:id/month-locks", async (req, res) => {
  try {
    const period = await store.get("SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!period) return res.status(404).json({ error: "Účetní období nenalezeno." });
    res.json(await store.all(
      "SELECT * FROM period_month_lock WHERE accounting_unit_id = ? AND fiscal_year = ? ORDER BY month",
      [req.user.accountingUnitId, period.fiscal_year]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/periods/:id/lock-month — { month, locked_by } — měsíční uzávěrka
// (tvrdý zámek na úrovni měsíce, viz trg_document_month_lock/trg_posting_month_lock
// v schema.sql/schema-pg.sql — nelze obejít přes API, je to na úrovni DB triggeru).
router.post("/periods/:id/lock-month", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const { month, locked_by } = req.body;
  try {
    const period = await store.get("SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!period) return res.status(404).json({ error: "Účetní období nenalezeno." });
    const m = Number(month);
    if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ error: "Neplatný měsíc (1-12)." });

    await store.run(
      `INSERT INTO period_month_lock (accounting_unit_id, fiscal_year, month, locked_at, locked_by, unlocked_at, unlocked_by)
       VALUES (?,?,?,datetime('now'),?,NULL,NULL)
       ON CONFLICT (accounting_unit_id, fiscal_year, month) DO UPDATE SET
         locked_at = excluded.locked_at, locked_by = excluded.locked_by, unlocked_at = NULL, unlocked_by = NULL`,
      [req.user.accountingUnitId, period.fiscal_year, m, locked_by || req.user.id]
    );
    store.persist();
    await writeAuditLog({ unitId: req.user.accountingUnitId, userId: locked_by || req.user.id, action: "MONTH_LOCK", table: "period_month_lock", entityId: null, after: { fiscal_year: period.fiscal_year, month: m } });
    res.json(await store.get("SELECT * FROM period_month_lock WHERE accounting_unit_id = ? AND fiscal_year = ? AND month = ?", [req.user.accountingUnitId, period.fiscal_year, m]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/periods/:id/unlock-month — { month, unlocked_by } — jen admin/jednatel
router.post("/periods/:id/unlock-month", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Odemknout měsíc může jen admin/jednatel." });
  const { month, unlocked_by } = req.body;
  try {
    const period = await store.get("SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!period) return res.status(404).json({ error: "Účetní období nenalezeno." });
    const m = Number(month);
    const before = await store.get("SELECT * FROM period_month_lock WHERE accounting_unit_id = ? AND fiscal_year = ? AND month = ? AND unlocked_at IS NULL", [req.user.accountingUnitId, period.fiscal_year, m]);
    if (!before) return res.status(400).json({ error: "Měsíc není uzamčený." });

    await store.run(
      "UPDATE period_month_lock SET unlocked_at = datetime('now'), unlocked_by = ? WHERE id = ?",
      [unlocked_by || req.user.id, before.id]
    );
    store.persist();
    await writeAuditLog({ unitId: req.user.accountingUnitId, userId: unlocked_by || req.user.id, action: "MONTH_UNLOCK", table: "period_month_lock", entityId: before.id, before, after: { unlocked: true } });
    res.json(await store.get("SELECT * FROM period_month_lock WHERE id = ?", [before.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/units — vlastní účetní jednotka přihlášeného uživatele (jen jedna
// v poli, kvůli zpětné kompatibilitě s rendererem — NIKDY ne cizí firmy).
router.get("/units", async (req, res) => {
  try {
    res.json(await store.all("SELECT * FROM accounting_unit WHERE id = ?", [req.user.accountingUnitId]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/units/:id — přepínač "Plátce DPH: ano/ne" apod. (kap. 3.2 brief)
router.patch("/units/:id", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const {
    is_vat_payer, vat_payer_since, accounting_mode, name, dic, unit_category, iban, bank_account,
    address, email, phone, logo_data_url, stamp_data_url, signature_data_url,
    ufo_code, fs_street, fs_house_number, fs_orientation_number, fs_city, fs_zip,
    identifikovana_osoba, identifikovana_osoba_od,
  } = req.body;
  try {
    if (Number(req.params.id) !== req.user.accountingUnitId) return res.status(403).json({ error: "Nemáte oprávnění upravovat jinou firmu." });
    const before = await store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Účetní jednotka nenalezena" });

    await store.run(
      `UPDATE accounting_unit SET
        is_vat_payer = COALESCE(?, is_vat_payer),
        vat_payer_since = COALESCE(?, vat_payer_since),
        accounting_mode = COALESCE(?, accounting_mode),
        name = COALESCE(?, name),
        dic = COALESCE(?, dic),
        unit_category = COALESCE(?, unit_category),
        iban = COALESCE(?, iban),
        bank_account = COALESCE(?, bank_account),
        address = COALESCE(?, address),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        logo_data_url = COALESCE(?, logo_data_url),
        stamp_data_url = COALESCE(?, stamp_data_url),
        signature_data_url = COALESCE(?, signature_data_url),
        ufo_code = COALESCE(?, ufo_code),
        fs_street = COALESCE(?, fs_street),
        fs_house_number = COALESCE(?, fs_house_number),
        fs_orientation_number = COALESCE(?, fs_orientation_number),
        fs_city = COALESCE(?, fs_city),
        fs_zip = COALESCE(?, fs_zip),
        identifikovana_osoba = COALESCE(?, identifikovana_osoba),
        identifikovana_osoba_od = COALESCE(?, identifikovana_osoba_od)
       WHERE id = ?`,
      [is_vat_payer === undefined ? null : (is_vat_payer ? 1 : 0), vat_payer_since || null,
       accounting_mode || null, name || null, dic || null, unit_category || null,
       iban || null, bank_account || null, address || null, email || null, phone || null,
       logo_data_url || null, stamp_data_url || null, signature_data_url || null,
       ufo_code || null, fs_street || null, fs_house_number || null, fs_orientation_number || null,
       fs_city || null, fs_zip || null,
       // Identifikovaná osoba (§ 6g-6i ZDPH) — stav se přepíná vědomě, proto
       // stejný vzor jako u is_vat_payer: undefined = neměnit, 0 i 1 uložit.
       identifikovana_osoba === undefined ? null : (identifikovana_osoba ? 1 : 0),
       identifikovana_osoba_od || null,
       req.params.id]
    );
    store.persist();
    await writeAuditLog({ unitId: req.params.id, action: "UPDATE", table: "accounting_unit", entityId: req.params.id, before, after: req.body });
    res.json(await store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.params.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/users?unit=1
// FIX (2026-07-21, revize dokumentace): výslovný výčet sloupců místo SELECT * —
// to dřív posílalo do API odpovědi i `password_hash` (bcrypt) všech kolegů.
// Hash hesla nepatří do žádné odpovědi, ani v rámci vlastní firmy.
router.get("/users", async (req, res) => {
  try {
    res.json(await store.all(
      `SELECT id, accounting_unit_id, full_name, email, role, active, bankid_verified
       FROM app_user WHERE accounting_unit_id = ? ORDER BY id`,
      [req.query.unit]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/users — přidání uživatele s rolí (kap. 5.10 brief — zadavatel/schvalovatel)
// POST /api/users — ZRUŠENO (A4, 2026-07-21).
//
// Endpoint zakládal uživatele BEZ HESLA. Takový účet si pak mohl zabrat kdokoli,
// kdo znal jeho e-mail, přes tehdy veřejný /api/auth/set-password — přidání
// kolegy tedy vyrábělo volně obsaditelný účet. Jediná podporovaná cesta je
// pozvánka: admin vystaví /api/auth/invite a kolega si přes odkaz
// (/api/auth/accept-invite) sám nastaví heslo. Účet tak nikdy neexistuje
// ve stavu "bez hesla".
//
// Routa zůstává (místo smazání), aby starší klient dostal srozumitelné
// vysvětlení, ne 404.
router.post("/users", requireRole("admin"), async (req, res) => {
  res.status(400).json({
    error: "Přidávání uživatelů přímo bylo zrušeno — zakládalo účet bez hesla, který si mohl zabrat kdokoli se znalostí e-mailu. Použijte pozvánku (Nastavení → Pozvat kolegu).",
  });
});

module.exports = router;
