const express = require("express");
const store = require("../db");
const { generateDphDp3Xml, generateKontrolniHlaseniXml, generateSouhrnneHlaseniXml, parseVatReturnMapping } = require("../lib/eDaneXml");
const { requireRole } = require("../lib/auth");
const regimes = require("../lib/vatRegimes");
const selfAssessment = require("../lib/vatSelfAssessment");
const router = express.Router();

const ADMIN_OR_ACCOUNTANT = requireRole("admin", "ucetni");
const DOMESTIC = regimes.DEFAULT_REGIME;

const KH_THRESHOLD = 10000; // § 100 ZDPH — kontrolní hlášení vyžaduje jednotlivou evidenci nad 10 000 Kč vč. daně

// rok+mesic nebo rok+ctvrt -> přesné datumové rozpětí období (první/poslední den),
// aby zdobd_od/zdobd_do v XML vždy odpovídalo zadanému mesic/ctvrt (žádné dohadování
// typu období z libovolného rozsahu datumů). Počítáno čistě z kalendářních čísel
// (bez Date/toISOString) — ty procházejí lokální→UTC převodem a na stroji s jiným
// časovým pásmem než ČR by posunuly první/poslední den o den mimo (reálně nalezeno
// při testu: 1.7. se převedlo na 30.6.).
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function lastDayOfMonth(y, m) { return m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]; }
function pad2(n) { return String(n).padStart(2, "0"); }
function ymd(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }

function periodRange({ rok, mesic, ctvrt }) {
  const y = Number(rok);
  if (mesic) {
    const m = Number(mesic);
    return { zdobdOd: ymd(y, m, 1), zdobdDo: ymd(y, m, lastDayOfMonth(y, m)), mesic: m, ctvrt: null };
  }
  const q = Number(ctvrt);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = q * 3;
  return { zdobdOd: ymd(y, startMonth, 1), zdobdDo: ymd(y, endMonth, lastDayOfMonth(y, endMonth)), mesic: null, ctvrt: q };
}
function today() {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

// GET /api/vat/ledger?unit=1&direction=uskutecnene
router.get("/ledger", async (req, res) => {
  const { unit, direction } = req.query;
  try {
    let where = "d.accounting_unit_id = ?";
    const params = [unit];
    if (direction) { where += " AND v.direction = ?"; params.push(direction); }
    res.json(await store.all(
      `SELECT v.*, d.doc_number, d.doc_type, c.name AS protistrana
       FROM vat_ledger_entry v
       JOIN document d ON d.id = v.document_id
       LEFT JOIN contact c ON c.id = d.contact_id
       WHERE ${where}
       ORDER BY v.duzp DESC`,
      params
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/vat/ledger — zápis do evidence pro DPH (§ 100 ZDPH), volá se po
// aktivaci plátcovství při zaúčtování daňového dokladu. Vynucuje DIČ nad limit KH.
router.post("/ledger", async (req, res) => {
  const { document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic, duzp } = req.body;
  try {
    const doc = await store.get("SELECT id FROM document WHERE id = ? AND accounting_unit_id = ?", [document_id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    const total = Number(vat_base) + Number(vat_amount);
    const requiresKh = total >= KH_THRESHOLD;
    if (requiresKh && !counterparty_dic) {
      return res.status(400).json({ error: `Doklad nad ${KH_THRESHOLD} Kč vč. daně vyžaduje pro kontrolní hlášení vyplnění DIČ protistrany (§ 100 ZDPH).` });
    }
    await store.run(
      `INSERT INTO vat_ledger_entry (document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic, duzp, requires_individual_kh)
       VALUES (?,?,?,?,?,?,?,?)`,
      [document_id, direction, vat_base, vat_rate, vat_amount, counterparty_dic || null, duzp, requiresKh ? 1 : 0]
    );
    const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
    store.persist();
    res.status(201).json(await store.get("SELECT * FROM vat_ledger_entry WHERE id = ?", [id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/vat/priznani?unit=1&start=2026-01-01&end=2026-03-31 — podklad pro přiznání k DPH
router.get("/priznani", async (req, res) => {
  const { unit, start, end } = req.query;
  try {
    const summary = await store.get(
      `SELECT
         COALESCE(SUM(CASE WHEN v.direction='uskutecnene' THEN v.vat_base ELSE 0 END),0) AS zaklad_na_vystupu,
         COALESCE(SUM(CASE WHEN v.direction='uskutecnene' THEN v.vat_amount ELSE 0 END),0) AS dan_na_vystupu,
         COALESCE(SUM(CASE WHEN v.direction='prijate' THEN v.vat_base ELSE 0 END),0) AS zaklad_na_vstupu,
         COALESCE(SUM(CASE WHEN v.direction='prijate' THEN v.vat_amount ELSE 0 END),0) AS dan_na_vstupu
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ?`,
      [unit, start, end]
    );
    const vysledek = summary.dan_na_vystupu - summary.dan_na_vstupu; // kladné = k úhradě, záporné = nadměrný odpočet
    res.json({ ...summary, vysledna_dan: vysledek, typ: vysledek >= 0 ? "K ÚHRADĚ" : "NADMĚRNÝ ODPOČET" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/vat/kontrolni-hlaseni?unit=1&start=..&end=.. — jednotlivé doklady nad limit KH
router.get("/kontrolni-hlaseni", async (req, res) => {
  const { unit, start, end } = req.query;
  try {
    res.json(await store.all(
      `SELECT v.*, d.doc_number, d.doc_type, d.issue_date
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.requires_individual_kh = 1 AND v.duzp BETWEEN ? AND ?
       ORDER BY v.duzp`,
      [unit, start, end]
    ));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/vat/priznani/xml?rok=2026&mesic=7  (nebo &ctvrt=3 místo mesic)
// XML podklad pro Přiznání k DPH (DPHDP3) — ke stažení a nahrání na MOJE daně/EPO.
// Rozsah: jen tuzemská plnění se standardní (21 %) a první sníženou (12 %) sazbou,
// viz komentář v lib/eDaneXml.js. Před podáním nutná kontrola s účetní/daňovým poradcem.
router.get("/priznani/xml", async (req, res) => {
  try {
    const unit = await store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.user.accountingUnitId]);
    if (!unit.dic || !unit.ufo_code) {
      return res.status(400).json({ error: "Pro elektronické podání vyplňte v Nastavení DIČ a kód finančního úřadu." });
    }
    const { zdobdOd, zdobdDo, mesic, ctvrt } = periodRange(req.query);

    // Tuzemský standard jde do dosavadních řádků (obrat23/dan23/odp_tuz23...).
    // Přeshraniční režimy se z tohoto součtu VYLUČUJÍ a řeší se přes potvrzené
    // mapování níže — jinak by se např. odpočet ze samovyměření objevil zároveň
    // v tuzemském řádku 40 i v řádku přeshraničním, tedy dvakrát.
    const rows = await store.all(
      `SELECT v.direction, v.vat_rate, SUM(v.vat_base) AS base, SUM(v.vat_amount) AS tax
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ? AND v.vat_regime = ?
       GROUP BY v.direction, v.vat_rate`,
      [req.user.accountingUnitId, zdobdOd, zdobdDo, DOMESTIC]
    );
    const zero = { base: 0, tax: 0 };
    const agg = { out23: { ...zero }, out5: { ...zero }, in23: { ...zero }, in5: { ...zero }, unmapped: [] };
    for (const r of rows) {
      const bucket = { 21: "23", 12: "5" }[Math.round(Number(r.vat_rate))];
      const key = (r.direction === "uskutecnene" ? "out" : "in") + bucket;
      if (bucket && agg[key]) { agg[key].base += Number(r.base); agg[key].tax += Number(r.tax); }
      else agg.unmapped.push(r);
    }

    const crossBorder = await crossBorderRows(req.user.accountingUnitId, zdobdOd, zdobdDo);
    const xml = generateDphDp3Xml({ unit, rok: req.query.rok, mesic, ctvrt, zdobdOd, zdobdDo, agg, dPoddp: today(), crossBorder });
    if (agg.unmapped.length) res.setHeader("X-Nepokryta-Sazba", "true"); // upozornění pro frontend, viz app.js
    if (crossBorder.some((c) => !c.mapping)) res.setHeader("X-Nepokryty-Rezim", "true");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="DPHDP3_${req.query.rok}_${mesic || "Q" + ctvrt}.xml"`);
    res.send(xml);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/vat/kontrolni-hlaseni/xml?rok=2026&mesic=7 — XML podklad pro Kontrolní
// hlášení (DPHKH1), jen doklady nad limit KH (§ 100 ZDPH). Stejné omezení rozsahu
// jako u DPHDP3 výše.
router.get("/kontrolni-hlaseni/xml", async (req, res) => {
  try {
    const unit = await store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.user.accountingUnitId]);
    if (!unit.dic || !unit.ufo_code) {
      return res.status(400).json({ error: "Pro elektronické podání vyplňte v Nastavení DIČ a kód finančního úřadu." });
    }
    const { zdobdOd, zdobdDo, mesic, ctvrt } = periodRange(req.query);

    const entries = await store.all(
      `SELECT v.*, d.doc_number
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.requires_individual_kh = 1 AND v.duzp BETWEEN ? AND ?
       ORDER BY v.duzp`,
      [req.user.accountingUnitId, zdobdOd, zdobdDo]
    );
    const missingDic = entries.filter((e) => !e.counterparty_dic);
    if (missingDic.length) {
      return res.status(400).json({ error: `${missingDic.length} doklad(ů) nad limit KH chybí DIČ protistrany — doplňte v evidenci DPH před generováním XML.` });
    }

    const xml = generateKontrolniHlaseniXml({ unit, rok: req.query.rok, mesic, ctvrt, zdobdOd, zdobdDo, entries, dPoddp: today() });
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="DPHKH1_${req.query.rok}_${mesic || "Q" + ctvrt}.xml"`);
    res.send(xml);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// FÁZE B — přeshraniční DPH. Mechanismus je tady, daňová rozhodnutí ne:
// všechno, co je právně sporné, si zadává účetní do vat_regime_config a musí to
// potvrdit. Viz DPH_ROZHODNUTI.md.
// ---------------------------------------------------------------------------

// Přeshraniční plnění za období, každé s mapováním z konfigurace (nebo bez něj).
async function crossBorderRows(unitId, start, end) {
  const rows = await store.all(
    `SELECT v.vat_regime, v.direction, SUM(v.vat_base) AS base, SUM(v.vat_amount) AS tax
     FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
     WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ? AND v.vat_regime <> ?
     GROUP BY v.vat_regime, v.direction`,
    [unitId, start, end, DOMESTIC]
  );
  const configs = await store.all(
    "SELECT vat_regime, vat_return_row, confirmed_at FROM vat_regime_config WHERE accounting_unit_id = ?",
    [unitId]
  );
  const byRegime = new Map(configs.map((c) => [c.vat_regime, c]));
  return rows.map((r) => {
    const cfg = byRegime.get(r.vat_regime);
    const meta = regimes.get(r.vat_regime);
    return {
      regime: r.vat_regime,
      label: meta ? meta.label : r.vat_regime,
      direction: r.direction,
      base: Number(r.base) || 0,
      tax: Number(r.tax) || 0,
      // Nepotvrzenou konfiguraci úmyslně ignorujeme — rozpracované mapování
      // nesmí propadnout do podání.
      mapping: cfg && cfg.confirmed_at ? cfg.vat_return_row : null,
    };
  });
}

// GET /api/vat/regimes — katalog režimů + stav konfigurace (co ještě chybí).
router.get("/regimes", async (req, res) => {
  try {
    res.json(await selfAssessment.listConfig(req.user.accountingUnitId));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/vat/regimes/:regime — účetní zadává účty a daňové důsledky režimu.
// `confirm: true` znamená "potvrzuji, že to takhle je" — bez toho mechanismus
// samovyměření zůstane vypnutý.
router.put("/regimes/:regime", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  const unitId = req.user.accountingUnitId;
  try {
    const regime = regimes.assertKnown(req.params.regime);
    const {
      output_vat_account_id, input_vat_account_id, deduction_allowed,
      include_in_summary_report, summary_report_code, vat_return_row, note, confirm,
    } = req.body;

    // Mapování na přiznání validujeme hned — chyba v konfiguraci se má projevit
    // při zadávání, ne až při generování podání.
    if (vat_return_row) parseVatReturnMapping(vat_return_row);

    for (const [field, value] of [["output_vat_account_id", output_vat_account_id], ["input_vat_account_id", input_vat_account_id]]) {
      if (value === null || value === undefined || value === "") continue;
      const acc = await store.get("SELECT id FROM chart_of_accounts WHERE id = ? AND accounting_unit_id = ?", [value, unitId]);
      if (!acc) return res.status(400).json({ error: `${field}: účet nepatří této účetní jednotce.` });
    }

    const tri = (v) => (v === null || v === undefined || v === "" ? null : Number(v) ? 1 : 0);
    const existing = await selfAssessment.getConfig(unitId, regime);
    const confirmedAt = confirm ? new Date().toISOString().slice(0, 19).replace("T", " ") : (existing ? existing.confirmed_at : null);
    const confirmedBy = confirm ? req.user.id : (existing ? existing.confirmed_by : null);

    if (existing) {
      await store.run(
        `UPDATE vat_regime_config SET output_vat_account_id=?, input_vat_account_id=?, deduction_allowed=?,
           include_in_summary_report=?, summary_report_code=?, vat_return_row=?, note=?, confirmed_at=?, confirmed_by=?
         WHERE id = ?`,
        [output_vat_account_id || null, input_vat_account_id || null, tri(deduction_allowed),
         tri(include_in_summary_report), summary_report_code || null, vat_return_row || null,
         note || null, confirmedAt, confirmedBy, existing.id]
      );
    } else {
      await store.run(
        `INSERT INTO vat_regime_config (accounting_unit_id, vat_regime, output_vat_account_id, input_vat_account_id,
           deduction_allowed, include_in_summary_report, summary_report_code, vat_return_row, note, confirmed_at, confirmed_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [unitId, regime, output_vat_account_id || null, input_vat_account_id || null, tri(deduction_allowed),
         tri(include_in_summary_report), summary_report_code || null, vat_return_row || null,
         note || null, confirmedAt, confirmedBy]
      );
    }
    store.persist();
    const saved = await selfAssessment.getConfig(unitId, regime);
    res.json({ config: saved, blockers: selfAssessment.configBlockers(saved, regime) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/vat/self-assessment/:documentId — vygeneruje zápis samovyměření.
// Odmítne se, dokud účetní nepotvrdí konfiguraci režimu (HTTP 409 + výpis toho,
// co chybí).
router.post("/self-assessment/:documentId", ADMIN_OR_ACCOUNTANT, async (req, res) => {
  try {
    const result = await store.transaction(async () =>
      selfAssessment.generateSelfAssessmentPosting({
        documentId: req.params.documentId,
        unitId: req.user.accountingUnitId,
        userId: req.user.id,
      })
    );
    store.persist();
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, blockers: err.blockers });
  }
});

// GET /api/vat/souhrnne-hlaseni?rok=2026&mesic=7 — podklad pro souhrnné hlášení
// (§ 102 ZDPH). Do hlášení jdou POUZE režimy, u kterých účetní potvrdila
// `include_in_summary_report = 1` a doplnila `summary_report_code` (kód plnění
// k_pln_eu dle dphshv_epo2.xsd). Systém sám nerozhoduje, co tam patří.
async function summaryReportData(unitId, start, end) {
  const configs = await store.all(
    "SELECT * FROM vat_regime_config WHERE accounting_unit_id = ? AND confirmed_at IS NOT NULL",
    [unitId]
  );
  const included = configs.filter((c) => Number(c.include_in_summary_report) === 1);
  const warnings = [];
  const undecided = configs.filter((c) => c.include_in_summary_report === null || c.include_in_summary_report === undefined);
  for (const c of undecided) {
    warnings.push(`Režim ${c.vat_regime}: není rozhodnuto, zda patří do souhrnného hlášení — plnění není zahrnuto.`);
  }
  const missingCode = included.filter((c) => !c.summary_report_code);
  for (const c of missingCode) {
    warnings.push(`Režim ${c.vat_regime}: má být v souhrnném hlášení, ale chybí kód plnění (k_pln_eu) — plnění není zahrnuto.`);
  }

  const usable = included.filter((c) => c.summary_report_code);
  if (!usable.length) {
    return { rows: [], warnings, configured_regimes: [] };
  }
  const placeholders = usable.map(() => "?").join(",");
  const entries = await store.all(
    `SELECT v.vat_regime, v.counterparty_country, v.counterparty_vat_id, v.counterparty_dic,
            v.vat_base, v.document_id
     FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
     WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ?
       AND v.direction = 'uskutecnene' AND v.vat_regime IN (${placeholders})`,
    [unitId, start, end, ...usable.map((c) => c.vat_regime)]
  );
  const codeOf = new Map(usable.map((c) => [c.vat_regime, c.summary_report_code]));

  // Agregace na (stát, VAT ID, kód plnění) — jeden řádek VetaR na kombinaci,
  // pln_pocet = počet dokladů, pln_hodnota = součet základů (celé Kč).
  const acc = new Map();
  for (const e of entries) {
    const split = e.counterparty_vat_id
      ? { country: e.counterparty_country, vatId: e.counterparty_vat_id }
      : selfAssessment.splitVatId(e.counterparty_dic);
    if (!split.country || !split.vatId) {
      warnings.push(`Doklad id ${e.document_id}: chybí VAT ID protistrany včetně předčíslí státu — řádek nelze do hlášení uvést.`);
      continue;
    }
    const code = codeOf.get(e.vat_regime);
    const key = `${split.country}|${split.vatId}|${code}`;
    const prev = acc.get(key) || { country: split.country, vat_id: split.vatId, code, count: 0, value: 0 };
    prev.count += 1;
    prev.value += Number(e.vat_base) || 0;
    acc.set(key, prev);
  }
  return { rows: [...acc.values()], warnings, configured_regimes: usable.map((c) => ({ vat_regime: c.vat_regime, code: c.summary_report_code })) };
}

router.get("/souhrnne-hlaseni", async (req, res) => {
  try {
    const { zdobdOd, zdobdDo } = periodRange(req.query);
    const data = await summaryReportData(req.user.accountingUnitId, zdobdOd, zdobdDo);
    res.json({ obdobi: { od: zdobdOd, do: zdobdDo }, ...data });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get("/souhrnne-hlaseni/xml", async (req, res) => {
  try {
    const unit = await store.get("SELECT * FROM accounting_unit WHERE id = ?", [req.user.accountingUnitId]);
    if (!unit.dic || !unit.ufo_code) {
      return res.status(400).json({ error: "Pro elektronické podání vyplňte v Nastavení DIČ a kód finančního úřadu." });
    }
    const { zdobdOd, zdobdDo, mesic, ctvrt } = periodRange(req.query);
    const { rows, warnings } = await summaryReportData(req.user.accountingUnitId, zdobdOd, zdobdDo);
    if (!rows.length) {
      return res.status(400).json({
        error: "Za zadané období není co do souhrnného hlášení uvést. Zkontrolujte nastavení režimů DPH — dokud účetní nepotvrdí, které režimy do hlášení patří, systém hlášení negeneruje.",
        warnings,
      });
    }
    const xml = generateSouhrnneHlaseniXml({ unit, rok: req.query.rok, mesic, ctvrt, rows, dPoddp: today(), warnings });
    if (warnings.length) res.setHeader("X-Nepokryty-Rezim", "true");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="DPHSHV_${req.query.rok}_${mesic || "Q" + ctvrt}.xml"`);
    res.send(xml);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
