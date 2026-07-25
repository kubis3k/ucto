// Testy fail-closed režimu BankID (A5).
//
// Původní stav: BANKID_MODE měl default "mock". V mock režimu /bankid/start
// veřejně vrátil jména jednatelů podle IČO (veřejná informace) a
// /bankid/callback pak vydal ADMIN session komukoli, kdo to jméno zopakoval.
// Produkce to měla nastavené na "live", ale bezpečnost celého přihlašování
// tak visela na jedné env proměnné — kdyby se ztratila, systém se tiše otevře.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany } = require("./helpers");

function withEnv(t, changes) {
  const previous = {};
  for (const [k, v] of Object.entries(changes)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("BankID: bez BANKID_MODE se přihlášení odmítne (nespadne do mocku)", async (t) => {
  withEnv(t, { BANKID_MODE: undefined, NODE_ENV: "production" });
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl, { ico: "77770001" });

  const start = await fetch(`${baseUrl}/api/auth/bankid/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ico: "77770001" }),
  });
  assert.equal(start.status, 501, "bez konfigurace musí BankID odmítnout, ne nabídnout mock");
  const body = await start.json();
  assert.ok(!body.directors, "nesmí prozradit jména jednatelů");

  const callback = await fetch(`${baseUrl}/api/auth/bankid/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accounting_unit_id: a.user.accounting_unit_id, full_name: "Kdokoli", email: "x@test.local" }),
  });
  assert.equal(callback.status, 501, "mock callback nesmí vydat session");
});

test("BankID: mock je v produkčním NODE_ENV zakázaný", async (t) => {
  withEnv(t, { BANKID_MODE: "mock", NODE_ENV: "production" });
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  await registerCompany(baseUrl, { ico: "77770002" });

  const start = await fetch(`${baseUrl}/api/auth/bankid/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ico: "77770002" }),
  });
  assert.equal(start.status, 501, "mock v produkci musí být odmítnut");
});

test("BankID: mock funguje mimo produkci (vývoj/test)", async (t) => {
  withEnv(t, { BANKID_MODE: "mock", NODE_ENV: "test" });
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  await registerCompany(baseUrl, { ico: "77770003" });

  const start = await fetch(`${baseUrl}/api/auth/bankid/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ico: "77770003" }),
  });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).mode, "mock");
});
