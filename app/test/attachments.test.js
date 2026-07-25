// Testy perzistence příloh dokladů (§ 8 ZoÚ — průkaznost).
// Podstata problému: na Vercel serverless je disk funkce dočasný, takže
// příloha uložená na lokální disk po zhasnutí instance zmizí. Proto se
// produkčně ukládá do objektového úložiště (Vercel Blob) — viz
// lib/attachmentStore.js.
//
// Skutečný Vercel Blob se v testu volat nedá (potřeboval by účet a token),
// takže se podstrčí fake klient, který drží obsah v paměti procesu. To je
// dostatečné: ověřuje se PRÁVĚ TO, že download nečte z lokálního disku —
// disk se v testu úmyslně smaže.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTestServer, registerCompany, authedFetch } = require("./helpers");

// Minimální fake Vercel Blob — put() uloží do Mapy, "URL" je data: URI, aby
// ho fetch() v attachmentStore.load() dokázal načíst bez sítě.
function makeFakeBlob() {
  const blobs = new Map();
  return {
    blobs,
    put: async (key, buffer, opts) => {
      blobs.set(key, { buffer: Buffer.from(buffer), contentType: opts?.contentType });
      const b64 = Buffer.from(buffer).toString("base64");
      return { url: `data:${opts?.contentType || "application/octet-stream"};base64,${b64}`, pathname: key };
    },
    head: async (key) => {
      const hit = blobs.get(key);
      if (!hit) throw new Error("not found");
      return { url: `data:${hit.contentType};base64,${hit.buffer.toString("base64")}`, pathname: key };
    },
  };
}

async function makeDocument(f, user) {
  await f("/api/periods", { method: "POST", body: JSON.stringify({ fiscal_year: 2026, start_date: "2026-01-01", end_date: "2026-12-31" }) });
  const periods = await (await f("/api/periods?unit=x")).json();
  const contact = await (await f("/api/contacts", { method: "POST", body: JSON.stringify({ name: "Odberatel", contact_type: "odberatel" }) })).json();
  return (await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_vydana", contact_id: contact.id, period_id: periods[0].id,
      issue_date: "2026-07-01", due_date: "2026-07-15", description: "s prilohou",
      total_amount: 1000, responsible_user_id: user.id,
    }),
  })).json();
}

// Multipart tělo se skládá ručně — bez další npm závislosti (FormData v Node
// 18+ by šla použít, ale tímhle je test nezávislý na verzi runtime).
function multipartBody(fileName, mimeType, content) {
  const boundary = "----testboundary" + Date.now();
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    boundary,
    buffer: Buffer.concat([Buffer.from(head), Buffer.from(content), Buffer.from(tail)]),
  };
}

async function uploadAttachment(baseUrl, token, docId, fileName, content) {
  const { boundary, buffer } = multipartBody(fileName, "application/pdf", content);
  const res = await fetch(`${baseUrl}/api/documents/${docId}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: buffer,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("příloha uložená do objektového úložiště přežije smazání lokálního disku", async (t) => {
  const { server, baseUrl, tmpDir } = await createTestServer();
  t.after(() => server.close());
  const attachmentStore = require("../server/lib/attachmentStore");
  const fake = makeFakeBlob();
  attachmentStore.__setBlobClientForTests(fake);
  t.after(() => attachmentStore.__setBlobClientForTests(null));

  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);
  const doc = await makeDocument(f, a.user);

  const PDF = "%PDF-1.4 testovaci obsah prilohy";
  const up = await uploadAttachment(baseUrl, a.token, doc.id, "faktura.pdf", PDF);
  assert.equal(up.status, 201);
  assert.equal(up.body.storage_backend, "blob", "s nakonfigurovaným úložištěm se musí použít backend 'blob'");

  // Na lokálním disku nesmí zůstat nic — právě to je podstata opravy.
  const localDir = path.join(tmpDir, "attachments");
  assert.ok(!fs.existsSync(localDir), "s blob backendem se nesmí zapisovat na dočasný disk");

  // Simulace nové serverless instance: dočasný disk je pryč.
  fs.rmSync(localDir, { recursive: true, force: true });

  const list = await (await f(`/api/documents/${doc.id}/attachments`)).json();
  assert.equal(list.length, 1);

  const dl = await f(`/api/documents/attachments/${list[0].id}/download`);
  assert.equal(dl.status, 200, "příloha musí být stažitelná i po zmizení lokálního disku");
  assert.equal(await dl.text(), PDF, "obsah přílohy musí být beze změny");
});

test("bez konfigurovaného úložiště funguje fallback na lokální disk", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const attachmentStore = require("../server/lib/attachmentStore");
  attachmentStore.__setBlobClientForTests(null); // žádný blob → fs fallback
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  t.after(() => { if (hadToken) process.env.BLOB_READ_WRITE_TOKEN = hadToken; });

  const a = await registerCompany(baseUrl);
  const f = authedFetch(baseUrl, a.token);
  const doc = await makeDocument(f, a.user);

  const PDF = "%PDF-1.4 lokalni fallback";
  const up = await uploadAttachment(baseUrl, a.token, doc.id, "lokal.pdf", PDF);
  assert.equal(up.status, 201);
  assert.equal(up.body.storage_backend, "fs");

  const list = await (await f(`/api/documents/${doc.id}/attachments`)).json();
  const dl = await f(`/api/documents/attachments/${list[0].id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), PDF);
});

test("firma B nestáhne přílohu firmy A", async (t) => {
  const { server, baseUrl } = await createTestServer();
  t.after(() => server.close());
  const attachmentStore = require("../server/lib/attachmentStore");
  attachmentStore.__setBlobClientForTests(makeFakeBlob());
  t.after(() => attachmentStore.__setBlobClientForTests(null));

  const a = await registerCompany(baseUrl);
  const b = await registerCompany(baseUrl);
  const fA = authedFetch(baseUrl, a.token);
  const fB = authedFetch(baseUrl, b.token);

  const doc = await makeDocument(fA, a.user);
  await uploadAttachment(baseUrl, a.token, doc.id, "tajne.pdf", "%PDF-1.4 tajny obsah");
  const list = await (await fA(`/api/documents/${doc.id}/attachments`)).json();
  assert.equal(list.length, 1);

  const asB = await fB(`/api/documents/attachments/${list[0].id}/download`);
  assert.equal(asB.status, 404, "cizí firma nesmí stáhnout přílohu");

  const listAsB = await fB(`/api/documents/${doc.id}/attachments`);
  assert.equal(listAsB.status, 404, "cizí firma nesmí ani vylistovat přílohy");

  const upAsB = await uploadAttachment(baseUrl, b.token, doc.id, "podvrh.pdf", "%PDF-1.4 podvrh");
  assert.equal(upAsB.status, 404, "cizí firma nesmí nahrát přílohu k cizímu dokladu");
});
