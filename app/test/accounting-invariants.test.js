// Testy jádra podvojného účetnictví — nejdůležitější invarianty, které musí
// platit VŽDY, protože na nich stojí důvěryhodnost celého systému:
// MD = D, append-only (§ 33a ZoÚ), a storno jako jediný povolený způsob
// zvrácení zápisu.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

test("double-entry balance is enforced", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const a = await registerCompany(baseUrl);
  const fetchA = authedFetch(baseUrl, a.token);

  await fetchA("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await fetchA("/api/periods?unit=x")).json();
  const accounts = await (await fetchA("/api/accounts?unit=x")).json();
  assert.ok(accounts.length >= 2, "seed chart of accounts should have at least 2 accounts");

  await t.test("unbalanced posting is rejected (MD != D)", async () => {
    const res = await fetchA("/api/postings", {
      method: "POST",
      body: JSON.stringify({
        period_id: periods[0].id, posting_date: "2026-07-01", description: "unbalanced", created_by: a.user.id,
        lines: [{ account_id: accounts[0].id, side: "MD", amount: 100 }, { account_id: accounts[1].id, side: "D", amount: 50 }],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /vyrovnan|MD = D/i);
  });

  await t.test("balanced posting succeeds", async () => {
    const res = await fetchA("/api/postings", {
      method: "POST",
      body: JSON.stringify({
        period_id: periods[0].id, posting_date: "2026-07-01", description: "balanced", created_by: a.user.id,
        lines: [{ account_id: accounts[0].id, side: "MD", amount: 100 }, { account_id: accounts[1].id, side: "D", amount: 100 }],
      }),
    });
    assert.equal(res.status, 201);
  });

  await t.test("posting into a closed period is rejected", async () => {
    // Nové období, rovnou uzavřít, pak zkusit zapsat do něj.
    await fetchA("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2027, start_date: "2027-01-01", end_date: "2027-12-31" }) });
    const allPeriods = await (await fetchA("/api/periods?unit=x")).json();
    const p2027 = allPeriods.find((p) => p.fiscal_year === 2027);
    await fetchA(`/api/periods/${p2027.id}/close`, { method: "POST", body: JSON.stringify({ closed_by: a.user.id }) });

    const res = await fetchA("/api/postings", {
      method: "POST",
      body: JSON.stringify({
        period_id: p2027.id, posting_date: "2027-06-01", description: "should fail", created_by: a.user.id,
        lines: [{ account_id: accounts[0].id, side: "MD", amount: 10 }, { account_id: accounts[1].id, side: "D", amount: 10 }],
      }),
    });
    assert.equal(res.status, 400);
  });
});

test("append-only compliance + storno correctness", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  // Require AFTER createTestServer() — stejný proces = stejná store instance,
  // kterou server.buildApp() právě inicializoval (viz komentář v helpers.js).
  const store = require("../server/db");
  const core = require("../server/lib/core");

  const a = await registerCompany(baseUrl);
  const fetchA = authedFetch(baseUrl, a.token);
  await fetchA("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await fetchA("/api/periods?unit=x")).json();
  const accounts = await (await fetchA("/api/accounts?unit=x")).json();

  const posting = await (await fetchA("/api/postings", {
    method: "POST",
    body: JSON.stringify({
      period_id: periods[0].id, posting_date: "2026-07-01", description: "test entry", created_by: a.user.id,
      lines: [{ account_id: accounts[0].id, side: "MD", amount: 500 }, { account_id: accounts[1].id, side: "D", amount: 500 }],
    }),
  })).json();

  await t.test("posting cannot be deleted directly", async () => {
    await assert.rejects(() => store.run("DELETE FROM posting WHERE id = ?", [posting.id]), /append-only/i);
  });

  await t.test("posting cannot be updated directly", async () => {
    await assert.rejects(() => store.run("UPDATE posting SET description = 'hacked' WHERE id = ?", [posting.id]), /append-only/i);
  });

  await t.test("posting_line cannot be deleted or updated directly", async () => {
    const lines = await store.all("SELECT * FROM posting_line WHERE posting_id = ?", [posting.id]);
    await assert.rejects(() => store.run("DELETE FROM posting_line WHERE id = ?", [lines[0].id]), /append-only/i);
    await assert.rejects(() => store.run("UPDATE posting_line SET amount = 999 WHERE id = ?", [lines[0].id]), /append-only/i);
  });

  await t.test("audit_log cannot be deleted or updated directly", async () => {
    const log = await store.get("SELECT id FROM audit_log WHERE entity_id = ? AND entity_table = 'posting'", [posting.id]);
    assert.ok(log, "posting creation should have written an audit_log row");
    await assert.rejects(() => store.run("DELETE FROM audit_log WHERE id = ?", [log.id]), /append-only/i);
    await assert.rejects(() => store.run("UPDATE audit_log SET action = 'HACKED' WHERE id = ?", [log.id]), /append-only/i);
  });

  await t.test("stornoPosting creates a correctly reversed counter-entry", async () => {
    const newPostingId = await core.stornoPosting(posting.id, "test storno", a.user.id);
    const newLines = await store.all("SELECT * FROM posting_line WHERE posting_id = ?", [newPostingId]);
    const origLines = await store.all("SELECT * FROM posting_line WHERE posting_id = ?", [posting.id]);

    const md = newLines.filter((l) => l.side === "MD").reduce((s, l) => s + l.amount, 0);
    const d = newLines.filter((l) => l.side === "D").reduce((s, l) => s + l.amount, 0);
    assert.equal(md, 500);
    assert.equal(d, 500);
    for (const ol of origLines) {
      const counter = newLines.find((l) => l.account_id === ol.account_id);
      assert.ok(counter, `counter-entry line missing for account ${ol.account_id}`);
      assert.notEqual(counter.side, ol.side, "storno line side should be flipped vs original");
    }

    const newPosting = await store.get("SELECT * FROM posting WHERE id = ?", [newPostingId]);
    assert.equal(newPosting.storno_of_posting_id, posting.id);
  });
});

test("document number sequence is sequential per type/year, not reused across companies", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const core = require("../server/lib/core");

  const a = await registerCompany(baseUrl);
  const b = await registerCompany(baseUrl);

  const n1 = await core.generateDocumentNumber(a.user.accounting_unit_id, "faktura_vydana", 2026);
  const n2 = await core.generateDocumentNumber(a.user.accounting_unit_id, "faktura_vydana", 2026);
  assert.equal(n1, "FV-2026-0001");
  assert.equal(n2, "FV-2026-0002");

  // Company B's sequence must start fresh at 1, independent of company A's.
  const bn1 = await core.generateDocumentNumber(b.user.accounting_unit_id, "faktura_vydana", 2026);
  assert.equal(bn1, "FV-2026-0001");
});
