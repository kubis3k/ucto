// Testy zámků účetního období a měsíce (§ 29-30 ZoÚ).
//
// Před opravou A3 se kontrola uzavřenosti dělala jen u 4 operací (vytvoření
// dokladu, zaúčtování, ruční zápis, odpis). Operace s NEPŘÍMÝM účetním
// dopadem — párování banky (generuje kurzové zápisy), rychlé zaúčtování
// pohybu, storno, přecenění kurzů, inventurní soupis, editace konceptu —
// ji obcházely. Tenhle soubor to hlídá u každé z nich.
//
// Rozhodnutí (A3): zápis do uzavřeného období nebo uzamčeného měsíce je
// ZAKÁZANÝ bez ohledu na cestu. Oprava se dělá opravným dokladem v aktuálním
// otevřeném období, ne zpětným zásahem do uzavřené historie.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

async function setup(t) {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);
  await f("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await f("/api/periods?unit=x")).json();
  const accounts = await (await f("/api/accounts?unit=x")).json();
  const contact = await (await f("/api/contacts", { method: "POST", body: JSON.stringify({ name: "Protistrana", contact_type: "odberatel" }) })).json();
  return { baseUrl, f, user: a.user, period: periods[0], accounts, contact };
}

function docBody({ contact, period, user, date = "2026-03-10", amount = 1000, type = "faktura_vydana" }) {
  return JSON.stringify({
    doc_type: type, contact_id: contact.id, period_id: period.id,
    issue_date: date, due_date: date, description: "test doklad",
    total_amount: amount, responsible_user_id: user.id,
  });
}

const lockMonth = (f, periodId, month, userId) =>
  f(`/api/periods/${periodId}/lock-month`, { method: "POST", body: JSON.stringify({ month, locked_by: userId }) });
const closePeriod = (f, periodId, userId) =>
  f(`/api/periods/${periodId}/close`, { method: "POST", body: JSON.stringify({ closed_by: userId }) });

test("párování banky je odmítnuto v uzamčeném měsíci", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();
  const imported = await (await f("/api/bank/import", {
    method: "POST",
    body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-03-15", amount: 1000 }] }),
  })).json();

  assert.equal((await lockMonth(f, period.id, 3, user.id)).status, 200);

  const res = await f(`/api/bank/${imported.inserted[0].id}/match`, {
    method: "POST", body: JSON.stringify({ document_id: doc.id, created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzamčen|uzavřené/i);
});

test("párování banky je odmítnuto v uzavřeném období", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();
  const imported = await (await f("/api/bank/import", {
    method: "POST",
    body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-03-15", amount: 1000 }] }),
  })).json();

  assert.equal((await closePeriod(f, period.id, user.id)).status, 200);

  const res = await f(`/api/bank/${imported.inserted[0].id}/match`, {
    method: "POST", body: JSON.stringify({ document_id: doc.id, created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzavřené|uzamčen/i);
});

test("rychlé zaúčtování pohybu (quick-post) je odmítnuto v uzamčeném měsíci", async (t) => {
  const { f, user, period, accounts } = await setup(t);
  const imported = await (await f("/api/bank/import", {
    method: "POST",
    body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-04-05", amount: -250, counterparty_name: "Poplatek" }] }),
  })).json();

  assert.equal((await lockMonth(f, period.id, 4, user.id)).status, 200);

  const res = await f(`/api/bank/${imported.inserted[0].id}/quick-post`, {
    method: "POST", body: JSON.stringify({ account_id: accounts[0].id, created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzamčen/i);
});

test("quick-post účtuje do období, do kterého datum pohybu patří", async (t) => {
  const { f, user, accounts } = await setup(t);
  // Druhé (novější) období — dřív se bralo "nejnovější otevřené" bez ohledu
  // na datum pohybu, takže zápis z roku 2026 mohl spadnout do období 2027.
  await f("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2027, start_date: "2027-01-01", end_date: "2027-12-31" }) });
  const periods = await (await f("/api/periods?unit=x")).json();
  const p2026 = periods.find((p) => p.fiscal_year === 2026);

  const imported = await (await f("/api/bank/import", {
    method: "POST",
    body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-05-20", amount: -100, counterparty_name: "Poplatek" }] }),
  })).json();

  const res = await f(`/api/bank/${imported.inserted[0].id}/quick-post`, {
    method: "POST", body: JSON.stringify({ account_id: accounts[0].id, created_by: user.id }),
  });
  assert.equal(res.status, 201);

  const postings = await (await f("/api/postings?unit=x")).json();
  const created = postings.find((p) => p.posting_date === "2026-05-20");
  assert.ok(created, "zápis musí existovat");
  assert.equal(created.period_id, p2026.id, "zápis musí patřit do období 2026, ne 2027");
});

test("storno účetního zápisu je odmítnuto v uzavřeném období", async (t) => {
  const { f, user, period, accounts } = await setup(t);
  const posting = await (await f("/api/postings", {
    method: "POST",
    body: JSON.stringify({
      period_id: period.id, posting_date: "2026-03-01", description: "zapis", created_by: user.id,
      lines: [{ account_id: accounts[0].id, side: "MD", amount: 300 }, { account_id: accounts[1].id, side: "D", amount: 300 }],
    }),
  })).json();

  assert.equal((await closePeriod(f, period.id, user.id)).status, 200);

  const res = await f(`/api/postings/${posting.id}/storno`, {
    method: "POST", body: JSON.stringify({ reason: "oprava", created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzavřené/i);
});

test("storno dokladu je odmítnuto v uzavřeném období", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();

  assert.equal((await closePeriod(f, period.id, user.id)).status, 200);

  const res = await f(`/api/documents/${doc.id}/storno`, {
    method: "POST", body: JSON.stringify({ reason: "oprava", user_id: user.id }),
  });
  assert.equal(res.status, 400);
});

test("přecenění kurzů je odmítnuto v uzamčeném měsíci", async (t) => {
  const { f, user, period } = await setup(t);
  assert.equal((await lockMonth(f, period.id, 12, user.id)).status, 200);

  const res = await f("/api/reports/precenit-kurzove", {
    method: "POST", body: JSON.stringify({ asOf: "2026-12-31", created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzamčen/i);
});

test("inventurní soupis nelze vygenerovat v uzavřeném období", async (t) => {
  const { f, user, period } = await setup(t);
  assert.equal((await closePeriod(f, period.id, user.id)).status, 200);

  const res = await f("/api/inventory/generate", {
    method: "POST", body: JSON.stringify({ period_id: period.id, as_of_date: "2026-12-31", created_by: user.id }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzavřené/i);
});

test("editace konceptu je odmítnuta v uzamčeném měsíci", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();
  assert.equal(doc.status, "koncept");

  assert.equal((await lockMonth(f, period.id, 3, user.id)).status, 200);

  const res = await f(`/api/documents/${doc.id}`, {
    method: "PUT", body: JSON.stringify({ description: "prepsano po uzavreni", total_amount: 9999 }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /uzamčen/i);
});

test("schválený doklad nelze upravit — vynuceno databázovým triggerem", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const store = require("../server/db");
  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();

  const appr = await f(`/api/documents/${doc.id}/approve`, { method: "POST", body: JSON.stringify({ approved_by: user.id }) });
  assert.equal(appr.status, 200);

  // Přímý UPDATE obchází aplikační vrstvu — musí ho zastavit trigger.
  await assert.rejects(
    () => store.run("UPDATE document SET description = 'podvrh' WHERE id = ?", [doc.id]),
    /schválený, zaúčtovaný nebo stornovaný/,
    "trigger musí blokovat editaci schváleného dokladu"
  );

  // A přes API taky (tam to hlídá status guard).
  const viaApi = await f(`/api/documents/${doc.id}`, { method: "PUT", body: JSON.stringify({ description: "podvrh" }) });
  assert.equal(viaApi.status, 400);
});

test("regrese: schválený doklad jde dál zaúčtovat i stornovat", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const tpl = await (await f("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name: "Test predkontace", doc_type: "faktura_vydana",
      lines: [
        { account_id: accounts[0].id, side: "MD", amount_source: "celkem" },
        { account_id: accounts[1].id, side: "D", amount_source: "celkem" },
      ],
    }),
  })).json();

  const doc = await (await f("/api/documents", { method: "POST", body: docBody({ contact, period, user }) })).json();
  assert.equal((await f(`/api/documents/${doc.id}/approve`, { method: "POST", body: JSON.stringify({ approved_by: user.id }) })).status, 200);

  // Přechod schvaleny -> zauctovany mění status, takže trigger (který hlídá
  // jen změny SE STEJNÝM statusem) ho pustit musí.
  const posted = await f(`/api/documents/${doc.id}/post`, {
    method: "POST", body: JSON.stringify({ template_id: tpl.id, created_by: user.id }),
  });
  assert.equal(posted.status, 201, "zaúčtování schváleného dokladu musí projít");

  const stornoed = await f(`/api/documents/${doc.id}/storno`, {
    method: "POST", body: JSON.stringify({ reason: "test", user_id: user.id }),
  });
  assert.equal(stornoed.status, 200, "storno zaúčtovaného dokladu musí projít");
});
