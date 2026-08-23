const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

async function setup(t) {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const auth = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, auth.token);
  await f("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const period = (await (await f("/api/periods?unit=x")).json())[0];
  const contact = await (await f("/api/contacts", { method: "POST", body: JSON.stringify({ name: "Protistrana", contact_type: "odberatel" }) })).json();
  return { f, user: auth.user, period, contact };
}

async function createDoc(f, user, period, contact, docType) {
  return (await f("/api/documents", { method: "POST", body: JSON.stringify({
    doc_type: docType, contact_id: contact.id, period_id: period.id,
    issue_date: "2026-07-01", due_date: "2026-07-10", description: "test",
    total_amount: 1000, responsible_user_id: user.id,
  }) })).json();
}

test("párování vydané faktury vytvoří MD 221 / D 311", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await createDoc(f, user, period, contact, "faktura_vydana");
  const imported = await (await f("/api/bank/import", { method: "POST", body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-07-10", amount: 1000 }] }) })).json();
  const matched = await f(`/api/bank/${imported.inserted[0].id}/match`, { method: "POST", body: JSON.stringify({ document_id: doc.id, created_by: user.id }) });
  assert.equal(matched.status, 200);
  const store = require("../server/db");
  const lines = await store.all(`SELECT coa.account_number, pl.side, pl.amount FROM posting_line pl JOIN chart_of_accounts coa ON coa.id=pl.account_id WHERE pl.posting_id=? ORDER BY pl.id`, [(await matched.json()).settlement_posting_id]);
  assert.deepEqual(lines.map(({ account_number, side }) => [account_number, side]), [["221", "MD"], ["311", "D"]]);
});

test("párování přijaté faktury vytvoří MD 321 / D 221", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await createDoc(f, user, period, contact, "faktura_prijata");
  const imported = await (await f("/api/bank/import", { method: "POST", body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-07-10", amount: -1000 }] }) })).json();
  const matched = await f(`/api/bank/${imported.inserted[0].id}/match`, { method: "POST", body: JSON.stringify({ document_id: doc.id, created_by: user.id }) });
  assert.equal(matched.status, 200);
  const store = require("../server/db");
  const lines = await store.all(`SELECT coa.account_number, pl.side FROM posting_line pl JOIN chart_of_accounts coa ON coa.id=pl.account_id WHERE pl.posting_id=? ORDER BY pl.id`, [(await matched.json()).settlement_posting_id]);
  assert.deepEqual(lines.map(({ account_number, side }) => [account_number, side]), [["321", "MD"], ["221", "D"]]);
});

test("opačný směr platby se odmítne", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await createDoc(f, user, period, contact, "faktura_vydana");
  const imported = await (await f("/api/bank/import", { method: "POST", body: JSON.stringify({ bank_account: "221", lines: [{ statement_date: "2026-07-10", amount: -1000 }] }) })).json();
  const res = await f(`/api/bank/${imported.inserted[0].id}/match`, { method: "POST", body: JSON.stringify({ document_id: doc.id, created_by: user.id }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /příchozí/);
});

test("pokladna 211 nesmí klesnout pod nulu", async (t) => {
  const { f, user, period } = await setup(t);
  const accounts = await (await f("/api/accounts?unit=x")).json();
  const cash = accounts.find((a) => a.account_number === "211");
  const cost = accounts.find((a) => a.account_number === "518");
  const res = await f("/api/postings", { method: "POST", body: JSON.stringify({
    period_id: period.id, posting_date: "2026-07-01", description: "výdej bez hotovosti", created_by: user.id,
    lines: [{ account_id: cost.id, side: "MD", amount: 100 }, { account_id: cash.id, side: "D", amount: 100 }],
  }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Pokladna.*záporný/i);
});

test("záporný zůstatek 221 se v rozvaze reklasifikuje do krátkodobých závazků", async (t) => {
  const { f, user, period } = await setup(t);
  const accounts = await (await f("/api/accounts?unit=x")).json();
  const bank = accounts.find((a) => a.account_number === "221");
  const cost = accounts.find((a) => a.account_number === "518");
  assert.equal((await f("/api/postings", { method: "POST", body: JSON.stringify({
    period_id: period.id, posting_date: "2026-07-01", description: "kontokorent", created_by: user.id,
    lines: [{ account_id: cost.id, side: "MD", amount: 100 }, { account_id: bank.id, side: "D", amount: 100 }],
  }) })).status, 201);
  const balance = await (await f("/api/reports/rozvaha?unit=x&asOf=2026-07-31")).json();
  assert.equal(balance.polozky.find((r) => r.code === "C.IV.").castka, 0);
  assert.equal(balance.polozky.find((r) => r.code === "C.II.p").castka, 100);
  assert.ok(Math.abs(balance.kontrola.rozdil) < 0.01);
});
