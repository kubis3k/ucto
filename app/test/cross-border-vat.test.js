// Testy mechanismu přeshraniční DPH — FÁZE B.
//
// CO TENHLE SOUBOR HLÍDÁ: že se systém NEPOKOUŠÍ rozhodovat za účetní. Klíčové
// testy nejsou "spočítá to správně", ale "dokud není daňové rozhodnutí
// potvrzené, systém odmítne cokoli vygenerovat". Kdyby někdo v budoucnu doplnil
// do kódu výchozí účty nebo výchozí mapování na řádky přiznání, spadne to tady.
//
// Fáze B se nesmí nasadit do produkce, dokud účetní nepotvrdí DPH_ROZHODNUTI.md.
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
  const contact = await (await f("/api/contacts", {
    method: "POST",
    body: JSON.stringify({ name: "Meta Platforms Ireland", contact_type: "dodavatel", dic: "IE9692928F" }),
  })).json();
  return { baseUrl, f, user: a.user, period: periods[0], accounts, contact };
}

// Přijatá služba z EU — přesně případ, který firma reálně má (Meta, Google, Stripe).
async function euServiceDoc(f, { contact, period, user, rate = 21 }) {
  const res = await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_prijata", contact_id: contact.id, period_id: period.id,
      issue_date: "2026-03-10", taxable_supply_date: "2026-03-10", due_date: "2026-03-20",
      description: "Reklama Meta", total_amount: 1000, responsible_user_id: user.id,
      is_vat_document: 1, vat_rate: rate, counterparty_dic: "IE9692928F",
      vat_regime: "reverse_charge_sluzba_eu",
    }),
  });
  return res.json();
}

const findAccount = (accounts, number) => accounts.find((a) => a.account_number === number);

test("režim plnění se na dokladu uloží a vrátí", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user });
  assert.equal(doc.vat_regime, "reverse_charge_sluzba_eu");

  // Neznámý režim musí být odmítnut — migrovaná SQLite DB nemá CHECK constraint,
  // takže tohle je jediná obrana.
  const bad = await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_prijata", contact_id: contact.id, period_id: period.id,
      issue_date: "2026-03-10", due_date: "2026-03-20", description: "x",
      total_amount: 100, responsible_user_id: user.id, vat_regime: "vymyslenyrezim",
    }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Neznámý režim/);
});

test("doklad bez uvedeného režimu zůstává tuzemský (žádná změna chování)", async (t) => {
  const { f, user, period, contact } = await setup(t);
  const doc = await (await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_vydana", contact_id: contact.id, period_id: period.id,
      issue_date: "2026-03-10", due_date: "2026-03-20", description: "tuzemsko",
      total_amount: 500, responsible_user_id: user.id,
    }),
  })).json();
  assert.equal(doc.vat_regime, "tuzemsko_standard");
});

test("samovyměření je odmítnuto, dokud účetní nepotvrdí konfiguraci režimu", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user });

  // 1) Bez jakékoli konfigurace
  const noConfig = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(noConfig.status, 409, "bez konfigurace se nesmí nic zaúčtovat");
  assert.match((await noConfig.json()).error, /nemá vyplněnou konfiguraci/);

  // 2) S účty, ale bez rozhodnutí o nároku na odpočet a bez potvrzení
  const out = findAccount(accounts, "343");
  assert.ok(out, "účtový rozvrh musí obsahovat 343");
  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id }),
  });
  const partial = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(partial.status, 409);
  const body = await partial.json();
  assert.ok(body.blockers.some((b) => /deduction_allowed je NULL/.test(b)), "musí hlásit nerozhodnutý odpočet");
  assert.ok(body.blockers.some((b) => /není potvrzená/.test(b)), "musí hlásit chybějící potvrzení");

  // 3) Vyplněné, ale NEpotvrzené — pořád ne.
  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, input_vat_account_id: out.id, deduction_allowed: 1 }),
  });
  const unconfirmed = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(unconfirmed.status, 409, "nepotvrzená konfigurace nesmí stačit");

  // Nic se nesmělo zaúčtovat.
  const postings = await (await f("/api/postings?unit=x")).json();
  assert.equal(postings.length, 0);
});

test("po potvrzení konfigurace vznikne vyrovnaný zápis samovyměření a evidence DPH", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user });
  const out = findAccount(accounts, "343");

  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({
      output_vat_account_id: out.id, input_vat_account_id: out.id,
      deduction_allowed: 1, include_in_summary_report: 0,
      vat_return_row: "uskutecnene=Veta1:p_sl23_e,dan_psl23_e|prijate=Veta4:odp_tuz23",
      confirm: true,
    }),
  });

  const res = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(res.status, 201);
  const result = await res.json();
  assert.equal(result.vat_base, 1000);
  assert.equal(result.vat_amount, 210);
  assert.equal(result.deduction_claimed, true);

  const detail = await (await f(`/api/postings/${result.posting_id}`)).json();
  const md = detail.lines.filter((l) => l.side === "MD").reduce((s, l) => s + l.amount, 0);
  const d = detail.lines.filter((l) => l.side === "D").reduce((s, l) => s + l.amount, 0);
  assert.equal(md, d, "zápis musí být vyrovnaný");
  assert.equal(md, 210);

  // Evidence pro DPH: daň na výstupu + nárok na odpočet, oba s režimem a VAT ID
  // rozdělenými na stát a číslo (kvůli souhrnnému hlášení).
  const ledger = await (await f("/api/vat/ledger?unit=x")).json();
  assert.equal(ledger.length, 2);
  for (const e of ledger) {
    assert.equal(e.vat_regime, "reverse_charge_sluzba_eu");
    assert.equal(e.counterparty_country, "IE");
    assert.equal(e.counterparty_vat_id, "9692928F");
  }

  // Druhé samovyměření téhož dokladu = dvojí daň, musí být odmítnuto.
  const again = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /už existuje nestornovaný zápis/);
});

test("samovyměření bez vyplněné sazby se neodhaduje", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user, rate: 0 });
  const out = findAccount(accounts, "343");
  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, input_vat_account_id: out.id, deduction_allowed: 1, confirm: true }),
  });
  const res = await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /sazbu.*musí zadat účetní/i);
});

test("přiznání k DPH nezahrne přeshraniční plnění bez potvrzeného mapování, ale upozorní", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user });
  const out = findAccount(accounts, "343");

  // Konfigurace potvrzená, ale BEZ mapování na řádek přiznání.
  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, input_vat_account_id: out.id, deduction_allowed: 1, confirm: true }),
  });
  assert.equal((await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" })).status, 201);

  await f("/api/units/" + user.accounting_unit_id, {
    method: "PATCH",
    body: JSON.stringify({ dic: "CZ24972070", ufo_code: "451" }),
  });

  const res = await f("/api/vat/priznani/xml?rok=2026&mesic=3");
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.equal(res.headers.get("X-Nepokryty-Rezim"), "true", "chybějící mapování musí být signalizováno");
  assert.match(xml, /UPOZORNĚNÍ/, "XML musí obsahovat viditelné upozornění");
  assert.match(xml, /Přijatá služba z EU/);
  // Neuhádnuté hodnoty se do řádků NESMÍ dostat.
  assert.match(xml, /<Veta2\/>/);
  // A hlavně: samovyměřený odpočet nesmí propadnout do tuzemského řádku 40.
  assert.match(xml, /odp_tuz23="0\.00"/);
});

test("souhrnné hlášení se nevygeneruje, dokud účetní nepotvrdí, co do něj patří", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const doc = await euServiceDoc(f, { contact, period, user });
  const out = findAccount(accounts, "343");
  await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, input_vat_account_id: out.id, deduction_allowed: 1, confirm: true }),
  });
  assert.equal((await f(`/api/vat/self-assessment/${doc.id}`, { method: "POST" })).status, 201);
  await f("/api/units/" + user.accounting_unit_id, {
    method: "PATCH",
    body: JSON.stringify({ dic: "CZ24972070", ufo_code: "451" }),
  });

  // include_in_summary_report zůstalo nerozhodnuté (NULL) → prázdné hlášení + varování.
  const data = await (await f("/api/vat/souhrnne-hlaseni?rok=2026&mesic=3")).json();
  assert.equal(data.rows.length, 0);
  assert.ok(data.warnings.some((w) => /není rozhodnuto/.test(w)));

  const xml = await f("/api/vat/souhrnne-hlaseni/xml?rok=2026&mesic=3");
  assert.equal(xml.status, 400, "bez rozhodnutí se hlášení negeneruje");
});

test("souhrnné hlášení se vygeneruje, když účetní režim i kód plnění potvrdí", async (t) => {
  const { f, user, period, contact, accounts } = await setup(t);
  const out = findAccount(accounts, "343");

  // Poskytnutá služba do EU — plnění, které do hlášení podle číselníku XSD
  // (k_pln_eu = 3) míří. I tak to systém udělá jen proto, že to účetní zadala.
  await f("/api/vat/regimes/sluzba_eu_poskytnuta", {
    method: "PUT",
    body: JSON.stringify({
      output_vat_account_id: out.id, input_vat_account_id: out.id, deduction_allowed: 0,
      include_in_summary_report: 1, summary_report_code: "3", confirm: true,
    }),
  });

  const doc = await (await f("/api/documents", {
    method: "POST",
    body: JSON.stringify({
      doc_type: "faktura_vydana", contact_id: contact.id, period_id: period.id,
      issue_date: "2026-03-15", taxable_supply_date: "2026-03-15", due_date: "2026-03-25",
      description: "Služba do EU", total_amount: 50000, responsible_user_id: user.id,
      is_vat_document: 1, vat_rate: 0, counterparty_dic: "IE9692928F",
      vat_regime: "sluzba_eu_poskytnuta",
    }),
  })).json();

  // Evidenční řádek zapíšeme přes veřejné API evidence DPH (poskytnutá služba
  // do EU se nesamovyměřuje, daň odvádí odběratel).
  const led = await f("/api/vat/ledger", {
    method: "POST",
    body: JSON.stringify({
      document_id: doc.id, direction: "uskutecnene", vat_base: 50000, vat_rate: 0,
      vat_amount: 0, counterparty_dic: "IE9692928F", duzp: "2026-03-15",
    }),
  });
  assert.equal(led.status, 201);
  // Řádek zapsaný přes obecné API nese výchozí režim, proto ho pro tento test
  // převedeme na režim dokladu — v produkci to udělá zaúčtování dokladu.
  const storeMod = require("../server/db");
  await storeMod.run(
    "UPDATE vat_ledger_entry SET vat_regime = ?, counterparty_country = ?, counterparty_vat_id = ? WHERE document_id = ?",
    ["sluzba_eu_poskytnuta", "IE", "9692928F", doc.id]
  );

  await f("/api/units/" + user.accounting_unit_id, {
    method: "PATCH",
    body: JSON.stringify({ dic: "CZ24972070", ufo_code: "451" }),
  });

  const data = await (await f("/api/vat/souhrnne-hlaseni?rok=2026&mesic=3")).json();
  assert.equal(data.rows.length, 1);
  assert.deepEqual(data.rows[0], { country: "IE", vat_id: "9692928F", code: "3", count: 1, value: 50000 });

  const res = await f("/api/vat/souhrnne-hlaseni/xml?rok=2026&mesic=3");
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<DPHSHV verzePis="1">/);
  assert.match(xml, /k_uladis="DPH"/);
  assert.match(xml, /dokument="SHV"/);
  assert.match(xml, /shvies_forma="R"/);
  assert.match(xml, /k_stat="IE" c_vat="9692928F" k_pln_eu="3" pln_pocet="1" pln_hodnota="50000"/);
});

test("chybné mapování na řádek přiznání je odmítnuto při zadávání", async (t) => {
  const { f, accounts } = await setup(t);
  const out = findAccount(accounts, "343");
  const res = await f("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, vat_return_row: "Veta1:tohle_neexistuje" }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /neexistuje/);
});

test("identifikovaná osoba se ukládá do nastavení firmy", async (t) => {
  const { f, user } = await setup(t);
  const updated = await (await f("/api/units/" + user.accounting_unit_id, {
    method: "PATCH",
    body: JSON.stringify({ identifikovana_osoba: 1, identifikovana_osoba_od: "2026-03-01" }),
  })).json();
  assert.equal(updated.identifikovana_osoba, 1);
  assert.equal(updated.identifikovana_osoba_od, "2026-03-01");
});

test("konfiguraci režimů DPH nesmí měnit role bez účetního oprávnění", async (t) => {
  const { baseUrl, f, accounts } = await setup(t);
  const out = findAccount(accounts, "343");
  const invite = await (await f("/api/auth/invite", {
    method: "POST", body: JSON.stringify({ email: "ctenar@test.local", role: "ctenar" }),
  })).json();
  const token = invite.invite_url.split("=")[1];
  const accepted = await (await fetch(`${baseUrl}/api/auth/accept-invite`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, full_name: "Čtenář", password: "ctenarovoheslo1" }),
  })).json();

  const fc = authedFetch(baseUrl, accepted.token);
  const res = await fc("/api/vat/regimes/reverse_charge_sluzba_eu", {
    method: "PUT",
    body: JSON.stringify({ output_vat_account_id: out.id, confirm: true }),
  });
  assert.ok(res.status === 403, `čtenář nesmí potvrzovat daňová rozhodnutí (dostal ${res.status})`);
});
