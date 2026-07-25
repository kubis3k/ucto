const express = require("express");
const crypto = require("crypto");
const store = require("../db");
const { insertAccounts } = require("../lib/chartOfAccountsSeed");
const { hashPassword, verifyPassword, signSession, signState, verifyState, verifySessionToken, requireAuth } = require("../lib/auth");
const bankidOidc = require("../lib/bankidOidc");
const router = express.Router();

function publicUser(user) {
  return { id: user.id, accounting_unit_id: user.accounting_unit_id, full_name: user.full_name, email: user.email, role: user.role, bankid_verified: !!user.bankid_verified };
}

// POST /api/auth/register-company — založení nové firmy + první uživatel (jednatel/admin)
router.post("/register-company", async (req, res) => {
  const {
    company_name, ico, dic, full_name, email, password,
    company_address, company_email, company_phone, logo_data_url, stamp_data_url, signature_data_url,
  } = req.body;
  if (!company_name || !ico || !full_name || !email || !password) {
    return res.status(400).json({ error: "Vyplňte název firmy, IČO, jméno, e-mail a heslo." });
  }
  if (password.length < 8) return res.status(400).json({ error: "Heslo musí mít alespoň 8 znaků." });

  try {
    const result = await store.transaction(async () => {
      await store.run(
        `INSERT INTO accounting_unit
          (name, ico, dic, accounting_mode, unit_category, is_vat_payer, fiscal_year_start_month,
           address, email, phone, logo_data_url, stamp_data_url, signature_data_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [company_name, ico, dic || null, "podvojne_ucetnictvi", "mikro", 0, 1,
         company_address || null, company_email || null, company_phone || null,
         logo_data_url || null, stamp_data_url || null, signature_data_url || null]
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

// POST /api/auth/set-password — nastavení hesla existujícímu účtu.
//
// FIX (A4, 2026-07-21): endpoint byl VEŘEJNÝ a stačilo znát e-mail uživatele,
// který ještě heslo neměl — kdokoli si tak mohl takový účet zabrat a získat
// plnou session. Nově vyžaduje jedno ze dvou:
//   a) `token` platné nepoužité pozvánky vystavené na TENTÝŽ e-mail
//      (cesta pro účty vzniklé před zavedením hesel — admin vystaví pozvánku),
//   b) přihlášenou session téhož uživatele (změna vlastního hesla).
// Pozvánka se použitím spotřebuje (used_at), takže je jednorázová.
router.post("/set-password", async (req, res) => {
  const { email, password, token } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Zadejte e-mail a heslo." });
  if (password.length < 8) return res.status(400).json({ error: "Heslo musí mít alespoň 8 znaků." });
  try {
    const user = await store.get("SELECT * FROM app_user WHERE email = ? AND active = 1", [email]);
    if (!user) return res.status(404).json({ error: "Uživatel s tímto e-mailem nenalezen." });

    // Autorizace: pozvánka na stejný e-mail, nebo vlastní platná session.
    let invite = null;
    let viaSession = false;
    if (token) {
      invite = await store.get(
        "SELECT * FROM company_invite WHERE token = ? AND used_at IS NULL AND email = ?",
        [token, email]
      );
      if (!invite) return res.status(403).json({ error: "Pozvánka nenalezena, už byla použita, nebo je na jiný e-mail." });
    } else {
      const header = req.headers.authorization || "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
      const session = bearer ? verifySessionToken(bearer) : null;
      if (!session || session.userId !== user.id) {
        return res.status(403).json({
          error: "Heslo lze nastavit jen přes pozvánku od administrátora, nebo po přihlášení (změna vlastního hesla).",
        });
      }
      viaSession = true;
    }

    // Bez pozvánky (tedy jen s vlastní session) nejde přepsat heslo, které
    // už existuje, cizí cestou — vlastní změna hesla je ale v pořádku.
    if (user.password_hash && !viaSession && !invite) {
      return res.status(409).json({ error: "Tento účet už má heslo nastaveno — použijte přihlášení." });
    }

    const passwordHash = await hashPassword(password);
    await store.transaction(async () => {
      await store.run("UPDATE app_user SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
      if (invite) await store.run("UPDATE company_invite SET used_at = datetime('now') WHERE id = ?", [invite.id]);
    });
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
// BankID ověření jednatele — feature-flag BANKID_MODE=live|mock (env), fail-closed.
// V "mock" režimu se místo reálného OAuth přesměrování vrátí přímo
// seznam jednatelů firmy — frontend nabídne jejich výběr. V "live" režimu
// (BANKID_CLIENT_ID/SECRET/REDIRECT_URI nastavené) se přesměruje na
// skutečný BankID OIDC flow — viz lib/bankidOidc.js a handleBankidOidcCallback
// níže (ta se mountuje na kořenovou cestu "/", protože přesně tak byl u
// BankID zaregistrovaný redirect_uri).
// ---------------------------------------------------------------------
// FIX (A5, 2026-07-21): FAIL-CLOSED. Dřív byl default "mock", což znamenalo,
// že bez nastavené proměnné se BankID tichem přepnulo do režimu, ve kterém
// /bankid/start veřejně vrátí jména jednatelů podle IČO (veřejná informace)
// a /bankid/callback pak vydá ADMIN session komukoli, kdo to jméno zopakuje.
// Produkce to měla správně nastavené na "live", ale bezpečnost celého
// přihlašování tak visela na jedné env proměnné — kdyby se při budoucím
// nasazení ztratila, systém by se tiše otevřel.
//
// Nově: režim se NEODHADUJE. Bez explicitního BANKID_MODE se BankID odmítne
// (501). Mock je navíc povolený jen mimo produkci — v produkčním NODE_ENV
// je zakázaný i při výslovném BANKID_MODE=mock.
function resolveBankidMode() {
  const configured = process.env.BANKID_MODE;
  if (!configured) return { mode: null, reason: "BankID není nakonfigurováno — chybí proměnná BANKID_MODE (live|mock)." };
  if (configured === "live") return { mode: "live" };
  if (configured === "mock") {
    if (process.env.NODE_ENV === "production") {
      return { mode: null, reason: "BankID v režimu mock je v produkci zakázán — nastavte BANKID_MODE=live." };
    }
    return { mode: "mock" };
  }
  return { mode: null, reason: `Neznámý BANKID_MODE '${configured}' — povolené hodnoty jsou live nebo mock.` };
}

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
  // Režim se řeší PŘED dohledáním firmy — jinak by odpověď 404/200 prozradila,
  // které IČO je v systému, i když je BankID vypnuté.
  const { mode, reason } = resolveBankidMode();
  if (!mode) return res.status(501).json({ error: reason });

  const { ico } = req.body;
  const unit = await store.get("SELECT id, name, ico FROM accounting_unit WHERE ico = ?", [ico]);
  if (!unit) return res.status(404).json({ error: "Firma s tímto IČO není v systému zaregistrována." });

  if (mode === "live") {
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
// Tohle je čistě mock cesta (živý flow končí v /bankid/token-verify), takže
// musí být zavřená všude, kde mock není výslovně povolený — jinak by stačilo
// znát IČO a jméno jednatele k získání admin session.
router.post("/bankid/callback", async (req, res) => {
  const { mode, reason } = resolveBankidMode();
  if (mode !== "mock") {
    return res.status(501).json({ error: reason || "Mock BankID není povolený — použijte živé přihlášení." });
  }
  try {
    const user = await verifyAndUpsertBankidUser(req.body);
    res.json({ user: publicUser(user), token: signSession(user) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "Uživatel s tímto e-mailem už existuje pod jiným jménem." });
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST /api/auth/bankid/token-verify — implicit flow: frontend předá access_token z hash fragmentu
router.post("/bankid/token-verify", async (req, res) => {
  const { mode, reason } = resolveBankidMode();
  if (mode !== "live") return res.status(501).json({ error: reason || "Živé BankID není nakonfigurováno." });
  const { access_token, state } = req.body;
  if (!access_token) return res.status(400).json({ error: "Chybí access_token." });
  try {
    const { accountingUnitId } = verifyState(state);
    const profile = await bankidOidc.fetchUserInfo(access_token);
    const fullName = profile.name || `${profile.given_name || ""} ${profile.family_name || ""}`.trim();
    const user = await verifyAndUpsertBankidUser({ accounting_unit_id: accountingUnitId, full_name: fullName, email: profile.email });
    res.json({ user: publicUser(user), token: signSession(user) });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "Uživatel s tímto e-mailem už existuje pod jiným jménem." });
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
