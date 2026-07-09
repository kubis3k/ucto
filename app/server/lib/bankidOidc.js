// =====================================================================
// bankidOidc.js — reálný OIDC klient pro BankID (BANKID_MODE=live).
// Discovery dokument se stahuje jednou a cachuje (endpointy se v praxi
// neměnní); token endpoint podporuje jen client_secret_post (ne Basic
// auth) — potvrzeno z reálného discovery dokumentu sandboxu.
//
// Bezpečnostní zjednodušení: identita se získává voláním userinfo
// endpointu s access_tokenem (přímé HTTPS spojení k BankID autentizované
// naším client_secret), ne lokální verifikací podpisu id_tokenu přes JWKS.
// Pro produkční nasazení nad citlivějšími daty by šlo doplnit ověření
// podpisu id_tokenu (jwks_uri v discovery), zde to považujeme za
// dostatečné vzhledem k tomu, že jde jen o ověření jména jednatele.
// =====================================================================
const crypto = require("crypto");

let discoveryCache = null;

function getIssuer() {
  return process.env.BANKID_ISSUER || "https://oidc.sandbox.bankid.cz";
}

async function getDiscovery() {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(`${getIssuer()}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`BankID discovery dokument nedostupný (HTTP ${res.status}).`);
  discoveryCache = await res.json();
  return discoveryCache;
}

async function buildAuthorizeUrl({ state }) {
  const discovery = await getDiscovery();
  const params = new URLSearchParams({
    client_id: process.env.BANKID_CLIENT_ID,
    redirect_uri: process.env.BANKID_REDIRECT_URI,
    response_type: "code",
    scope: "openid profile.name profile.email",
    state,
    nonce: crypto.randomBytes(16).toString("hex"),
    acr_values: "loa3",
    prompt: "login",
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const discovery = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.BANKID_REDIRECT_URI,
    client_id: process.env.BANKID_CLIENT_ID,
    client_secret: process.env.BANKID_CLIENT_SECRET,
  });
  const res = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`BankID token endpoint: ${data.error_description || data.error || res.status}`);
  return data; // { access_token, id_token, token_type, expires_in, ... }
}

async function fetchUserInfo(accessToken) {
  const discovery = await getDiscovery();
  const res = await fetch(discovery.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`BankID userinfo endpoint vrátil HTTP ${res.status}.`);

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/jwt") || (text.split(".").length === 3 && !contentType.includes("json"))) {
    // Signed JWT response (userinfo_signing_alg_values_supported) — payload je prostřední base64url segment.
    const payload = text.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  }
  return JSON.parse(text);
}

module.exports = { buildAuthorizeUrl, exchangeCodeForToken, fetchUserInfo };
