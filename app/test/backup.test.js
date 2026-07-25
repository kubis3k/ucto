// Testy aplikační zálohy (§ 8 ZoÚ — trvalost účetních záznamů).
// Ověřuje se: ochrana cron endpointu, že záloha obsahuje data VŠECH firem
// a všech tabulek (ne jen zadrátovaného výběru), a že z archivu jde stav
// rekonstruovat.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

function makeFakeBlob() {
  const blobs = new Map();
  return {
    blobs,
    put: async (key, buffer, opts) => {
      blobs.set(key, { buffer: Buffer.from(buffer), uploadedAt: new Date().toISOString() });
      return { url: `https://fake.blob/${key}`, pathname: key };
    },
    list: async ({ prefix }) => ({
      blobs: [...blobs.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ pathname: k, url: `https://fake.blob/${k}`, uploadedAt: v.uploadedAt })),
    }),
    del: async (url) => {
      const key = String(url).replace("https://fake.blob/", "");
      blobs.delete(key);
    },
  };
}

async function seedCompanyWithData(baseUrl) {
  const c = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, c.token);
  await f("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await f("/api/periods?unit=x")).json();
  const contact = await (await f("/api/contacts", { method: "POST", body: JSON.stringify({ name: `Kontakt ${c.user.id}`, contact_type: "odberatel" }) })).json();
  await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_vydana", contact_id: contact.id, period_id: periods[0].id,
      issue_date: "2026-07-01", due_date: "2026-07-15", description: `doklad firmy ${c.user.id}`,
      total_amount: 4200, responsible_user_id: c.user.id,
    }),
  });
  return c;
}

test("cron záloha: ochrana tokenem", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const had = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "tajny-cron-token";
  t.after(() => { if (had === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = had; });

  const bez = await fetch(`${baseUrl}/api/cron/backup`);
  assert.equal(bez.status, 401, "bez tokenu musí být odmítnuto");

  const spatny = await fetch(`${baseUrl}/api/cron/backup`, { headers: { Authorization: "Bearer spatny" } });
  assert.equal(spatny.status, 401, "se špatným tokenem musí být odmítnuto");
});

test("cron záloha: bez nastaveného CRON_SECRET vždy odmítne (žádný bypass)", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const had = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  t.after(() => { if (had !== undefined) process.env.CRON_SECRET = had; });

  const res = await fetch(`${baseUrl}/api/cron/backup`, { headers: { Authorization: "Bearer cokoli" } });
  assert.equal(res.status, 401);
});

test("záloha obsahuje data všech firem a všech tabulek", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const blobClient = require("../server/lib/blobClient");
  const fake = makeFakeBlob();
  blobClient.setForTests(fake);
  t.after(() => blobClient.setForTests(null));

  const had = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "tajny-cron-token";
  t.after(() => { if (had === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = had; });

  const a = await seedCompanyWithData(baseUrl);
  const b = await seedCompanyWithData(baseUrl);

  const res = await fetch(`${baseUrl}/api/cron/backup`, { headers: { Authorization: "Bearer tajny-cron-token" } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.backup.key.startsWith("backups/"), "záloha má jít do prefixu backups/");

  // Archiv musí být reálně v úložišti a obsahovat obě firmy.
  const stored = fake.blobs.get(body.backup.key);
  assert.ok(stored, "archiv musí být v úložišti");
  const snapshot = JSON.parse(stored.buffer.toString("utf-8"));

  assert.ok(snapshot.table_count >= 30, `očekáváno 30+ tabulek, je ${snapshot.table_count}`);
  const units = snapshot.data.accounting_unit.map((u) => u.id);
  assert.ok(units.includes(a.user.accounting_unit_id), "musí obsahovat firmu A");
  assert.ok(units.includes(b.user.accounting_unit_id), "musí obsahovat firmu B");

  // Klíčové účetní tabulky nesmí být prázdné ani chybět.
  for (const t of ["document", "chart_of_accounts", "accounting_period", "app_user", "audit_log"]) {
    assert.ok(Array.isArray(snapshot.data[t]), `tabulka ${t} musí být v záloze`);
    assert.ok(snapshot.data[t].length > 0, `tabulka ${t} nesmí být v záloze prázdná`);
  }
  assert.equal(snapshot.data.document.length, 2, "oba doklady (z obou firem)");
});

test("ze zálohy jde rekonstruovat stav (kontrola úplnosti snapshotu)", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const store = require("../server/db");
  const backup = require("../server/lib/backup");

  await seedCompanyWithData(baseUrl);
  const snapshot = await backup.collectSnapshot();

  // Snapshot musí odpovídat živé DB tabulka po tabulce — kdyby collectSnapshot
  // nějakou tabulku vynechal, obnova by tiše ztratila data.
  const tables = await store.listTables();
  for (const table of tables) {
    const live = await store.all(`SELECT COUNT(*) AS n FROM ${table}`);
    const liveCount = Number(live[0].n);
    assert.ok(snapshot.data[table], `tabulka ${table} chybí ve snapshotu`);
    assert.equal(snapshot.data[table].length, liveCount, `počet řádků v ${table} nesouhlasí`);
    assert.equal(snapshot.row_counts[table], liveCount, `row_counts pro ${table} nesouhlasí`);
  }
});

test("retence maže jen zálohy starší než lhůta", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const blobClient = require("../server/lib/blobClient");
  const backup = require("../server/lib/backup");
  const fake = makeFakeBlob();
  blobClient.setForTests(fake);
  t.after(() => blobClient.setForTests(null));

  const had = process.env.BACKUP_RETENTION_DAYS;
  process.env.BACKUP_RETENTION_DAYS = "30";
  t.after(() => { if (had === undefined) delete process.env.BACKUP_RETENTION_DAYS; else process.env.BACKUP_RETENTION_DAYS = had; });

  const dnyZpet = (n) => new Date(Date.now() - n * 86400000).toISOString();
  fake.blobs.set("backups/stara.json", { buffer: Buffer.from("{}"), uploadedAt: dnyZpet(100) });
  fake.blobs.set("backups/na-hrane.json", { buffer: Buffer.from("{}"), uploadedAt: dnyZpet(10) });
  fake.blobs.set("attachments/nesmi-se-dotknout.pdf", { buffer: Buffer.from("x"), uploadedAt: dnyZpet(100) });

  const result = await backup.pruneOldBackups();
  assert.equal(result.retention_days, 30);
  assert.ok(result.deleted.includes("backups/stara.json"), "stará záloha se má smazat");
  assert.ok(!fake.blobs.has("backups/stara.json"));
  assert.ok(fake.blobs.has("backups/na-hrane.json"), "záloha v retenci musí zůstat");
  assert.ok(fake.blobs.has("attachments/nesmi-se-dotknout.pdf"), "retence se nesmí dotknout příloh");
});

test("bez objektového úložiště záloha hlásí chybu, netváří se že proběhla", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const blobClient = require("../server/lib/blobClient");
  blobClient.setForTests(null);
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const had = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "tajny-cron-token";
  t.after(() => {
    if (hadToken) process.env.BLOB_READ_WRITE_TOKEN = hadToken;
    if (had === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = had;
  });

  const res = await fetch(`${baseUrl}/api/cron/backup`, { headers: { Authorization: "Bearer tajny-cron-token" } });
  assert.equal(res.status, 503, "nenakonfigurovaná záloha musí selhat viditelně");
  const body = await res.json();
  assert.match(body.error, /BLOB_READ_WRITE_TOKEN/);
});
