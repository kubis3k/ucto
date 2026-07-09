// Sdílené testovací pomůcky — každý test soubor běží v node:test ve vlastním
// procesu, takže vlastní izolovaná sqlite DB (temp adresář) i vlastní
// require() cache (proto lze v jednom test souboru bezpečně require("../server/db")
// PO createTestServer() a mířit na stejnou instanci, kterou server právě inicializoval).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildApp } = require("../server/index");

async function createTestServer() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ucto-test-"));
  const app = await buildApp(tmpDir);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, tmpDir };
}

let counter = 0;
async function registerCompany(baseUrl, overrides = {}) {
  counter += 1;
  const res = await fetch(`${baseUrl}/api/auth/register-company`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_name: overrides.company_name || `Test Co ${counter}`,
      ico: overrides.ico || String(10000000 + counter),
      full_name: overrides.full_name || "Test User",
      email: overrides.email || `test${Date.now()}_${counter}@test.local`,
      password: overrides.password || "test-password-123",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("register-company failed: " + JSON.stringify(data));
  return data; // { user, token }
}

function authedFetch(baseUrl, token) {
  return (urlPath, opts = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
}

module.exports = { createTestServer, registerCompany, authedFetch };
