const express = require("express");
const store = require("../db");
const { generateDphDp3Xml, generateKontrolniHlaseniXml } = require("../lib/eDaneXml");
const router = express.Router();

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

    const rows = await store.all(
      `SELECT v.direction, v.vat_rate, SUM(v.vat_base) AS base, SUM(v.vat_amount) AS tax
       FROM vat_ledger_entry v JOIN document d ON d.id = v.document_id
       WHERE d.accounting_unit_id = ? AND v.duzp BETWEEN ? AND ?
       GROUP BY v.direction, v.vat_rate`,
      [req.user.accountingUnitId, zdobdOd, zdobdDo]
    );
    const zero = { base: 0, tax: 0 };
    const agg = { out23: { ...zero }, out5: { ...zero }, in23: { ...zero }, in5: { ...zero }, unmapped: [] };
    for (const r of rows) {
      const bucket = { 21: "23", 12: "5" }[Math.round(Number(r.vat_rate))];
      const key = (r.direction === "uskutecnene" ? "out" : "in") + bucket;
      if (bucket && agg[key]) { agg[key].base += Number(r.base); agg[key].tax += Number(r.tax); }
      else agg.unmapped.push(r);
    }

    const xml = generateDphDp3Xml({ unit, rok: req.query.rok, mesic, ctvrt, zdobdOd, zdobdDo, agg, dPoddp: today() });
    if (agg.unmapped.length) res.setHeader("X-Nepokryta-Sazba", "true"); // upozornění pro frontend, viz app.js
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

module.exports = router;
