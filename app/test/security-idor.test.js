// Regresní testy pro IDOR opravy (2026-07-09 audit) — dvě samostatné firmy,
// firma B nesmí být schopná číst/měnit/mazat data firmy A jen podle uhodnutého
// nebo inkrementovaného ID. Bez těchto testů by se stejná chyba mohla vrátit
// při budoucí úpravě routy beze změny (ověřeno ručně přes fetch skript při
// auditu, tady formalizováno jako trvalý regresní test).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

test("cross-tenant IDOR protection", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());

  const a = await registerCompany(baseUrl);
  const b = await registerCompany(baseUrl);
  const fetchA = authedFetch(baseUrl, a.token);
  const fetchB = authedFetch(baseUrl, b.token);

  await fetchA("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await fetchA("/api/periods?unit=x")).json();
  const contact = await (await fetchA("/api/contacts", {
    method: "POST", body: JSON.stringify({ name: "A Customer", contact_type: "odberatel" }),
  })).json();
  const doc = await (await fetchA("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_vydana", contact_id: contact.id, period_id: periods[0].id,
      issue_date: "2026-07-01", due_date: "2026-07-15", description: "A invoice",
      total_amount: 1000, responsible_user_id: a.user.id,
    }),
  })).json();

  await t.test("company B cannot read company A's document", async () => {
    const res = await fetchB(`/api/documents/${doc.id}`);
    assert.equal(res.status, 404);
  });

  await t.test("company B cannot read company A's contact", async () => {
    const res = await fetchB(`/api/contacts/${contact.id}`);
    assert.equal(res.status, 404);
  });

  await t.test("company B cannot storno company A's document", async () => {
    const res = await fetchB(`/api/documents/${doc.id}/storno`, {
      method: "POST", body: JSON.stringify({ reason: "malicious", user_id: b.user.id }),
    });
    assert.equal(res.status, 404);
  });

  await t.test("company B cannot approve company A's document", async () => {
    const res = await fetchB(`/api/documents/${doc.id}/approve`, {
      method: "POST", body: JSON.stringify({ approved_by: b.user.id }),
    });
    assert.equal(res.status, 400);
  });

  await t.test("company B cannot close company A's accounting period", async () => {
    const res = await fetchB(`/api/periods/${periods[0].id}/close`, {
      method: "POST", body: JSON.stringify({ closed_by: b.user.id }),
    });
    assert.equal(res.status, 400);
    const before = await (await fetchA(`/api/periods?unit=x`)).json();
    assert.equal(before[0].status, "otevrene");
  });

  await t.test("company B cannot download company A's document PDF", async () => {
    const res = await fetchB(`/api/documents/${doc.id}/pdf`);
    assert.equal(res.status, 404);
  });

  await t.test("company A can still access its own document (no regression)", async () => {
    const res = await fetchA(`/api/documents/${doc.id}`);
    assert.equal(res.status, 200);
  });

  // Regrese k opravě z 2026-07-21: POST /api/postings/:id/storno dohledávalo
  // zápis jen `WHERE id = ?`, takže firma B mohla vytvořit stornovací zápis
  // v účetnictví firmy A pouhým uhádnutím číselného ID. Path parametr globální
  // middleware v index.js nepřepisuje, proto to musí řešit sama routa/core.
  await t.test("company B cannot storno company A's accounting entry", async () => {
    const accounts = await (await fetchA("/api/accounts?unit=x")).json();
    const posting = await (await fetchA("/api/postings", {
      method: "POST",
      body: JSON.stringify({
        period_id: periods[0].id, posting_date: "2026-07-02", description: "A entry", created_by: a.user.id,
        lines: [{ account_id: accounts[0].id, side: "MD", amount: 250 }, { account_id: accounts[1].id, side: "D", amount: 250 }],
      }),
    })).json();

    const res = await fetchB(`/api/postings/${posting.id}/storno`, {
      method: "POST", body: JSON.stringify({ reason: "malicious", created_by: b.user.id }),
    });
    assert.equal(res.status, 400);

    // Žádný stornovací protizápis nesmí vzniknout.
    const journalA = await (await fetchA("/api/postings?unit=x")).json();
    const stornos = journalA.filter((p) => p.storno_of_posting_id === posting.id);
    assert.equal(stornos.length, 0, "storno firmy B nesmí vytvořit protizápis u firmy A");

    // Vlastník ho stornovat smí (kontrola, že jsme to nezamkli všem).
    const own = await fetchA(`/api/postings/${posting.id}/storno`, {
      method: "POST", body: JSON.stringify({ reason: "legit", created_by: a.user.id }),
    });
    assert.equal(own.status, 201);
  });

  await t.test("GET /api/users nevrací password_hash", async () => {
    const users = await (await fetchA("/api/users?unit=x")).json();
    assert.ok(users.length >= 1, "firma A musí mít aspoň jednoho uživatele");
    for (const u of users) {
      assert.ok(!("password_hash" in u), "odpověď nesmí obsahovat password_hash");
    }
    assert.ok(users[0].email, "běžná pole musí zůstat (email)");
    assert.ok(users[0].role, "běžná pole musí zůstat (role)");
  });
});
