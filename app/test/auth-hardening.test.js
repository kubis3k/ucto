// Testy uzavření cesty k zabrání účtu (A4).
//
// Původní stav:
//   - POST /api/auth/set-password byl veřejný a stačilo znát e-mail uživatele
//     bez hesla → kdokoli si takový účet zabral a získal plnou session.
//   - POST /api/users zakládal uživatele BEZ hesla, čímž ten e-mail znovu
//     zpřístupnil. Dvojice těch dvou byla použitelná jako přihlašovací obchvat.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

// Uživatel bez hesla — přesně ten stav, který dřív šel zabrat.
async function makePasswordlessUser(unitId, email) {
  const store = require("../server/db");
  await store.run(
    "INSERT INTO app_user (accounting_unit_id, full_name, email, role) VALUES (?,?,?,?)",
    [unitId, "Bez hesla", email, "zadavatel"]
  );
  const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
  return store.get("SELECT * FROM app_user WHERE id = ?", [id]);
}

test("set-password: bez pozvánky ani session nelze zabrat účet bez hesla", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const victim = await makePasswordlessUser(a.user.accounting_unit_id, "bezhesla@test.local");

  const res = await fetch(`${baseUrl}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: victim.email, password: "utocnikovoheslo" }),
  });
  assert.equal(res.status, 403, "veřejné nastavení hesla musí být odmítnuto");

  // A účet skutečně nesmí být zabraný — heslo zůstává nenastavené.
  const store = require("../server/db");
  const after = await store.get("SELECT password_hash FROM app_user WHERE id = ?", [victim.id]);
  assert.equal(after.password_hash, null, "heslo se nesmělo nastavit");
});

test("set-password: s pozvánkou na stejný e-mail projde a pozvánka se spotřebuje", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);
  const legacy = await makePasswordlessUser(a.user.accounting_unit_id, "legacy@test.local");

  const invite = await (await f("/api/auth/invite", {
    method: "POST", body: JSON.stringify({ email: legacy.email, role: "ucetni" }),
  })).json();
  const token = invite.invite_url.split("=")[1];

  const ok = await fetch(`${baseUrl}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: legacy.email, password: "spravneheslo123", token }),
  });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).token, "musí vrátit session token");

  // Pozvánka je jednorázová.
  const again = await fetch(`${baseUrl}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: legacy.email, password: "jineheslo123", token }),
  });
  assert.equal(again.status, 403, "použitá pozvánka nesmí projít znovu");
});

test("set-password: pozvánku na cizí e-mail nelze použít", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);
  const victim = await makePasswordlessUser(a.user.accounting_unit_id, "obet@test.local");

  const invite = await (await f("/api/auth/invite", {
    method: "POST", body: JSON.stringify({ email: "nekdojiny@test.local", role: "zadavatel" }),
  })).json();
  const token = invite.invite_url.split("=")[1];

  const res = await fetch(`${baseUrl}/api/auth/set-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: victim.email, password: "utocnikovoheslo", token }),
  });
  assert.equal(res.status, 403, "pozvánka na jiný e-mail nesmí projít");
});

test("přidání uživatele bez hesla je zrušené — jedinou cestou je pozvánka", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);

  const res = await f("/api/users", {
    method: "POST",
    body: JSON.stringify({ full_name: "Novy", email: "novy@test.local", role: "admin" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /pozvánk/i, "chyba má nasměrovat na pozvánky");

  // Nic se nesmělo založit.
  const users = await (await f("/api/users?unit=x")).json();
  assert.ok(!users.some((u) => u.email === "novy@test.local"), "uživatel nesmí vzniknout");
});

test("pozvánkový flow funguje end-to-end: invite → accept → login", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);

  const invite = await (await f("/api/auth/invite", {
    method: "POST", body: JSON.stringify({ email: "kolega@test.local", role: "ucetni" }),
  })).json();
  const token = invite.invite_url.split("=")[1];

  const accepted = await fetch(`${baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, full_name: "Kolega Novák", password: "kolegovoheslo1" }),
  });
  assert.equal(accepted.status, 201);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.user.role, "ucetni", "role z pozvánky se musí přenést");
  assert.equal(acceptedBody.user.accounting_unit_id, a.user.accounting_unit_id, "musí být ve stejné firmě");

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "kolega@test.local", password: "kolegovoheslo1" }),
  });
  assert.equal(login.status, 200, "kolega se musí umět přihlásit");
});
