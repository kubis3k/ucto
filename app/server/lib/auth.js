// =====================================================================
// auth.js — hesla (bcrypt), JWT session token, middleware requireAuth.
//
// Token se předává jako "Authorization: Bearer <token>" header (ne cookie).
// Důvod: v Electronu se renderer načítá přes file:// (origin "null") a volá
// http://127.0.0.1:PORT — to je z pohledu prohlížeče cross-site požadavek,
// takže by cookie s SameSite=Lax/None nešla spolehlivě nastavit/odeslat
// zpět (ověřeno end-to-end testem). Bearer token v Authorization headeru
// tento problém nemá a funguje stejně v Electronu, ve vývoji i na webu.
//
// JWT_SECRET: na webu (Vercel) se očekává env proměnná. Na desktopu
// (Electron) uživatel žádné env proměnné nenastavuje, proto se tajný klíč
// při prvním běhu vygeneruje a uloží do userData adresáře — přežije
// restart appky.
// =====================================================================
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const store = require("../db");

const TOKEN_TTL = "30d";
let cachedSecret = null;

function getJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;

  const userDataDir = store.getUserDataDir();
  const secretPath = path.join(userDataDir, "jwt-secret.txt");
  if (fs.existsSync(secretPath)) {
    cachedSecret = fs.readFileSync(secretPath, "utf-8").trim();
  } else {
    cachedSecret = require("crypto").randomBytes(48).toString("hex");
    fs.writeFileSync(secretPath, cachedSecret, "utf-8");
  }
  return cachedSecret;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

function signSession(user) {
  return jwt.sign(
    { userId: user.id, accountingUnitId: user.accounting_unit_id, role: user.role },
    getJwtSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

// Middleware — vyžaduje platný Bearer token, naplní req.user = {id, accountingUnitId, role}.
// Nasazuje se na vše pod /api KROMĚ /api/auth/*.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Nejste přihlášeni." });
  try {
    const payload = jwt.verify(token, getJwtSecret());
    req.user = { id: payload.userId, accountingUnitId: payload.accountingUnitId, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Neplatná nebo vypršelá session." });
  }
}

// "state" pro OIDC (BankID) redirect flow — místo server-side session úložiště
// (nevhodné pro serverless) se do state zakóduje podepsaný JWT s krátkou
// platností nesoucí accounting_unit_id, ke kterému se přihlašování vztahuje.
// typ: "bankid_state" odlišuje tento token od běžné přihlašovací session.
function signState(payload) {
  return jwt.sign({ ...payload, typ: "bankid_state" }, getJwtSecret(), { expiresIn: "10m" });
}

function verifyState(token) {
  const payload = jwt.verify(token, getJwtSecret());
  if (payload.typ !== "bankid_state") throw new Error("Neplatný typ state tokenu.");
  return payload;
}

module.exports = { hashPassword, verifyPassword, signSession, signState, verifyState, requireAuth };
