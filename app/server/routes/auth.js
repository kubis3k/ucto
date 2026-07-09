const express = require("express");
const crypto = require("crypto");
const store = require("../db");
const { insertAccounts } = require("../lib/chartOfAccountsSeed");
const { hashPassword, verifyPassword, signSession, signState, verifyState, requireAuth } = require("../lib/auth");
const bankidOidc = require("../lib/bankidOidc");
const router = express.Router();

function publicUser(user) {
  return { id: user.id, accounting_unit_id: user.accounting_unit_id, full_name: user.full_name, email: user.email, role: user.role, bankid_verified: !!user.bankid_verified };
}

// POST /api/auth/register-company — založení nové firmy + první uživatel (jednatel/admin)
router.post("/register-company", async (req, res) => {
  const { company_name, ico, dic, full_name, email, password } = req.body;
  if (!company_name || !ico || !full_name || !email || !password) {
    return res.status(400).json({ error: "Vyplňte název firmy, IČO, jméno, e-mail a heslo." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Heslo musí mít alespoň 8 znaků." });

  try {
    const result = await store.transaction(async () => {
      await store.run(
        `INSERT INTO accounting_unit (name, ico, dic, accounting_mode, unit_category, is_vat_payer, fiscal_year_start_month)
         VALUES (?,?,?,?,?,?,?)`,
        [company_name, ico, dic || null, "podvojne_ucetnictvi", "mikro", 0, 1]
      );
      const unitId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      await insertAccounts(store, unitId);

      const passwordHash = await hashPassword(password);
      await store.run(
        `INSERT INTO app_user (accounting_unit_id, full_name, email, role, password_hash) VALUES (?,?,?,?,?)`,
        [unitId, full_name, email, "admin", passwordHash]
      );
      const userId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      return await store.get("SELECT * FROM app_user WHERE id = ?", [userId]);
    });
    store.persist();
    res.status(201).json({ user: publicUser(result), token: signSession(result) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "Firma s tímto IČO nebo uživatel s tímto e-mailem už existuje." });
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await store.get("SELECT * FROM app_user WHERE email = ? AND active = 1", [email]);
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: "Nesprávný e-mail nebo heslo." });
    res.json({ user: publicUser(user), token: signSession(user) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/auth/set-password — "aktivace" existujícího uživatele bez hesla
// (přechod appek, kde uživatelé byli dřív jen jméno/e-mail bez přihlašování —
// typicky ten seedovaný "Luigi" účet). Funguje jen jednou, dokud heslo není nastaveno.
router.post("/set-password", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Zadejte e-mail a heslo." });
  if (password.length < 8) return res.status(400).json({ error: "Heslo musí mít alespoň 8 znaků." });
  try {
    const user = await store.get("SELECT * FROM app_user WHERE email = ? AND active = 1", [email]);
    if (!user) return res.status(404).json({ error: "Uživatel s tímto e-mailem nenalezen." });
    if (user.password_hash) return res.status(409).json({ error: "Tento účet už má heslo nastaveno — použijte přihlášení." });
    const passwordHash = await hashPassword(password);
    await store.run("UPDATE app_user SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
    store.persist();
    const updated = await store.get("SELECT * FROM app_user WHERE id = ?", [user.id]);
    res.json({ user: publicUser(updated), token: signSession(updated) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/auth/logout — u Bearer tokenu není server-side co mazat,
// klient token jednoduše zahodí (localStorage) a přestane ho posílat.
router.post("/logout", (req, res) => {
  res.json({ ok: true });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
  const user = await store.get("SELECT * FROM app_user WHERE id = ?", [req.user.id]);
  if (!user) return res.status(401).json({ error: "Uživatel neexistuje." });
  const unit = await store.get("SELECT id, name, ico, dic FROM accounting_unit WHERE id = ?", [user.accounting_unit_id]);
  res.json({ user: publicUser(user), unit });
});

// POST /api/auth/invite — pozvání kolegy/společníka do stejné firmy (jen admin/jednatel)
router.post("/invite", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Pouze admin/jednatel může zvát kolegy." });
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: "Zadejte e-mail kolegy." });
  try {
    const token = crypto.randomBytes(24).toString("hex");
    await store.run(
      `INSERT INTO company_invite (accounting_unit_id, email, token, role, invited_by) VALUES (?,?,?,?,?)`,
      [req.user.accountingUnitId, email, token, role || "zadavatel", req.user.id]
    );
    store.persist();
    // Bez napojeného e-mailového serveru se odkaz předává manuálně (zkopírovat a poslat kolegovi).
    res.status(201).json({ token, invite_url: `/#accept-invite=${token}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/auth/accept-invite — kolega nastaví heslo a získá přístup ke stejné firmě
router.post("/accept-invite", async (req, res) => {
  const { token, full_name, password } = req.body;
  if (!token || !full_name || !password) return res.status(400).json({ error: "Chybí token, jméno nebo heslo." });
  if (password.length < 8) return res.status(400).json({ error: "Heslo musí mít alespoň 8 znaků." });
  try {
    const invite = await store.get("SELECT * FROM company_invite WHERE token = ? AND used_at IS NULL", [token]);
    if (!invite) return res.status(404).json({ error: "Pozvánka nenalezena nebo už byla použita." });

    const result = await store.transaction(async () => {
      const passwordHash = await hashPassword(password);
      await store.run(
        `INSERT INTO app_user (accounting_unit_id, full_name, email, role, password_hash) VALUES (?,?,?,?,?)`,
        [invite.accounting_unit_id, full_name, invite.email, invite.role, passwordHash]
      );
      const userId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      await store.run("UPDATE company_invite SET used_at = datetime('now') WHERE id = ?", [invite.id]);
      return await store.get("SELECT * FROM app_user WHERE id = ?", [userId]);
    });
    store.persist();
    res.status(201).json({ user: publicUser(result), token: signSession(result) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "Uživatel s tímto e-mailem už existuje." });
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// BankID ověření jednatele — feature-flag BANKID_MODE=mock|live (env).
// V "mock" režimu se místo reálného OAuth přesměrování vrátí přímo
// seznam jednatelů firmy — frontend nabídne jejich výběr. V "live" režimu
// (BANKID_CLIENT_ID/SECRET/REDIRECT_URI nastavené) se přesměruje na
// skutečný BankID OIDC flow — viz lib/bankidOidc.js a handleBankidOidcCallback
// níže (ta se mountuje na kořenovou cestu "/", protože přesně tak byl u
// BankID zaregistrovaný redirect_uri).
// ---------------------------------------------------------------------
const BANKID_MODE = process.env.BANKID_MODE || "mock";

// Sdílená logika ověření jména jednatele + vytvoření/aktualizace uživatele —
// používá jak mock JSON callback, tak reálný OIDC redirect callback.
async function verifyAndUpsertBankidUser({ accounting_unit_id, full_name, email }) {
  const unit = await store.get("SELECT id FROM accounting_unit WHERE id = ?", [accounting_unit_id]);
  if (!unit) throw Object.assign(new Error("Firma nenalezena."), { status: 404 });

  const directors = (await store.all("SELECT full_name FROM company_director WHERE accounting_unit_id = ?", [accounting_unit_id]))
    .map((d) => d.full_name.trim().toLowerCase());
  if (!directors.includes(String(full_name || "").trim().toLowerCase())) {
    throw Object.assign(new Error("Nejste evidovaný jednatel této firmy."), { status: 403 });
  }

  let user = await store.get("SELECT * FROM app_user WHERE accounting_unit_id = ? AND full_name = ?", [accounting_unit_id, full_name]);
  if (!user) {
    if (!email) throw Object.assign(new Error("Pro první přihlášení přes BankID je potřeba e-mail z profilu."), { status: 400 });
    await store.run(
      `INSERT INTO app_user (accounting_unit_id, full_name, email, role, bankid_verified) VALUES (?,?,?,?,1)`,
      [accounting_unit_id, full_name, email, "admin"]
    );
    const userId = (await store.get("SELECT last_insert_rowid() AS id")).id;
    user = await store.get("SELECT * FROM app_user WHERE id = ?", [userId]);
  } else if (!user.bankid_verified) {
    await store.run("UPDATE app_user SET bankid_verified = 1 WHERE id = ?", [user.id]);
    user = await store.get("SELECT * FROM app_user WHERE id = ?", [user.id]);
  }
  store.persist();
  return user;
}

// POST /api/auth/bankid/start — { ico }
router.post("/bankid/start", async (req, res) => {
  const { ico } = req.body;
  const unit = await store.get("SELECT id, name, ico FROM accounting_unit WHERE ico = ?", [ico]);
  if (!unit) return res.status(404).json({ error: "Firma s tímto IČO není v systému zaregistrována." });

  if (BANKID_MODE === "live") {
    if (!process.env.BANKID_CLIENT_ID || !process.env.BANKID_REDIRECT_URI) {
      return res.status(501).json({ error: "BankID (live) není nakonfigurováno — chybí BANKID_CLIENT_ID/BANKID_REDIRECT_URI." });
    }
    try {
      const state = signState({ accountingUnitId: unit.id });
      const redirect = await bankidOidc.buildAuthorizeUrl({ state });
      return res.json({ mode: "live", redirect });
    } catch (err) {
      return res.status(502).json({ error: "Nepodařilo se sestavit BankID přihlášení: " + err.message });
    }
  }

  const directors = (await store.all("SELECT full_name FROM company_director WHERE accounting_unit_id = ?", [unit.id])).map((d) => d.full_name);
  res.json({ mode: "mock", accounting_unit_id: unit.id, company_name: unit.name, directors });
});

// POST /api/auth/bankid/callback (mock) — { accounting_unit_id, full_name, email? }
router.post("/bankid/callback", async (req, res) => {
  try {
    const user = await verifyAndUpsertBankidUser(req.body);
    res.json({ user: publicUser(user), token: signSession(user) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "Uživatel s tímto e-mailem už existuje pod jiným jménem." });
    res.status(err.status || 400).json({ error: err.message });
  }
});

// GET / (jen když ?code nebo ?error je v query — viz vercel.json a index.js) —
// reálný OIDC redirect callback z BankID. redirect_uri je zaregistrovaný jako
// kořen domény, ne /api/auth/..., proto se to mountuje jinde (index.js), ale
// logika žije tady vedle zbytku BankID kódu.
async function handleBankidOidcCallback(req, res) {
  const redirectWithError = (message) => res.redirect(`/#bankid-error=${encodeURIComponent(message)}`);

  if (req.query.error) {
    return redirectWithError(req.query.error_description || req.query.error);
  }
  try {
    const { accountingUnitId } = verifyState(req.query.state);
    const tokens = await bankidOidc.exchangeCodeForToken(req.query.code);
    const profile = await bankidOidc.fetchUserInfo(tokens.access_token);
    const fullName = profile.name || `${profile.given_name || ""} ${profile.family_name || ""}`.trim();

    const user = await verifyAndUpsertBankidUser({ accounting_unit_id: accountingUnitId, full_name: fullName, email: profile.email });
    const token = signSession(user);
    res.redirect(`/#bankid-login=${token}`);
  } catch (err) {
    redirectWithError(err.message);
  }
}

module.exports = router;
module.exports.handleBankidOidcCallback = handleBankidOidcCallback;
