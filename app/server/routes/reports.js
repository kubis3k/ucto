const express = require("express");
const store = require("../db");
const reports = require("../lib/reports");
const { writeAuditLog } = require("../lib/core");
const { buildStatementPdf } = require("../lib/statementPdf");
const { preceniOtevrenePohledavkyZavazky } = require("../lib/fxRevaluation");
const router = express.Router();

// GET /api/reports/hlavni-kniha?unit=1&asOf=2026-12-31
router.get("/hlavni-kniha", async (req, res) => {
  try {
    res.json(await reports.hlavniKniha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/rozvaha?unit=1&asOf=2026-12-31
router.get("/rozvaha", async (req, res) => {
  try {
    const { polozky, kontrola } = await reports.rozvaha(req.query.unit, req.query.asOf || new Date().toISOString().slice(0, 10));
    res.json({ polozky, kontrola });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/vysledovka?unit=1&period=1
router.get("/vysledovka", async (req, res) => {
  try {
    res.json(await reports.vysledovka(req.query.unit, req.query.period));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/obrat-dph?unit=1
router.get("/obrat-dph", async (req, res) => {
  try {
    res.json(await reports.obratDph(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/pohledavky-zavazky?unit=1
router.get("/pohledavky-zavazky", async (req, res) => {
  try {
    res.json(await reports.knihaPohledavkyZavazky(req.query.unit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/priloha?unit=1&period=1 — aktuální text přílohy + živě
// dopočítaná auto data (majetek, po splatnosti). unit se řídí middleware
// v index.js (req.user.accountingUnitId), period_id se navíc ověří scope.
router.get("/priloha", async (req, res) => {
  try {
    const unitId = req.user.accountingUnitId;
    const periodId = req.query.period;
    const period = await store.get(
      "SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?",
      [periodId, unitId]
    );
    if (!period) return res.status(404).json({ error: "Účetní období nenalezeno." });
    const note = await store.get(
      "SELECT * FROM financial_statement_note WHERE accounting_unit_id = ? AND period_id = ?",
      [unitId, periodId]
    );
    const auto = await reports.prilohaAutoData(unitId, periodId, period.end_date);
    res.json({ note: note || null, auto });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/reports/priloha — { period, userId, pouzite_ucetni_metody,
// informace_majetek_komentar, pohledavky_zavazky_komentar,
// udalosti_po_rozvahovem_dni, prumerny_pocet_zamestnancu, doplnujici_informace }
// UPSERT aktuálního textu + append-only snapshot verze + audit_log.
router.put("/priloha", async (req, res) => {
  const unitId = req.user.accountingUnitId;
  const {
    period, userId,
    pouzite_ucetni_metody, informace_majetek_komentar, pohledavky_zavazky_komentar,
    udalosti_po_rozvahovem_dni, prumerny_pocet_zamestnancu, doplnujici_informace,
  } = req.body;
  try {
    const result = await store.transaction(async () => {
      const periodRow = await store.get(
        "SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?",
        [period, unitId]
      );
      if (!periodRow) throw new Error("Účetní období nenalezeno.");

      const existing = await store.get(
        "SELECT * FROM financial_statement_note WHERE accounting_unit_id = ? AND period_id = ?",
        [unitId, period]
      );
      const nextVersion = (existing?.version || 0) + 1;

      const fields = {
        pouzite_ucetni_metody: pouzite_ucetni_metody || null,
        informace_majetek_komentar: informace_majetek_komentar || null,
        pohledavky_zavazky_komentar: pohledavky_zavazky_komentar || null,
        udalosti_po_rozvahovem_dni: udalosti_po_rozvahovem_dni || null,
        prumerny_pocet_zamestnancu: prumerny_pocet_zamestnancu === "" || prumerny_pocet_zamestnancu == null
          ? null : Number(prumerny_pocet_zamestnancu),
        doplnujici_informace: doplnujici_informace || null,
      };

      await store.run(
        `INSERT INTO financial_statement_note
           (accounting_unit_id, period_id, pouzite_ucetni_metody, informace_majetek_komentar,
            pohledavky_zavazky_komentar, udalosti_po_rozvahovem_dni, prumerny_pocet_zamestnancu,
            doplnujici_informace, version, updated_at, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)
         ON CONFLICT (accounting_unit_id, period_id) DO UPDATE SET
           pouzite_ucetni_metody = excluded.pouzite_ucetni_metody,
           informace_majetek_komentar = excluded.informace_majetek_komentar,
           pohledavky_zavazky_komentar = excluded.pohledavky_zavazky_komentar,
           udalosti_po_rozvahovem_dni = excluded.udalosti_po_rozvahovem_dni,
           prumerny_pocet_zamestnancu = excluded.prumerny_pocet_zamestnancu,
           doplnujici_informace = excluded.doplnujici_informace,
           version = excluded.version,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [unitId, period, fields.pouzite_ucetni_metody, fields.informace_majetek_komentar,
         fields.pohledavky_zavazky_komentar, fields.udalosti_po_rozvahovem_dni,
         fields.prumerny_pocet_zamestnancu, fields.doplnujici_informace, nextVersion, userId || null]
      );

      const note = await store.get(
        "SELECT * FROM financial_statement_note WHERE accounting_unit_id = ? AND period_id = ?",
        [unitId, period]
      );

      await store.run(
        `INSERT INTO financial_statement_note_version
           (note_id, accounting_unit_id, period_id, version, snapshot_json, created_by)
         VALUES (?,?,?,?,?,?)`,
        [note.id, unitId, period, nextVersion, JSON.stringify(fields), userId || null]
      );

      await writeAuditLog({
        unitId, userId, action: "UPDATE", table: "financial_statement_note",
        entityId: note.id, before: existing || null, after: note,
      });

      return note;
    });
    store.persist();
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/reports/priloha/versions?unit=1&period=1 — historie verzí (nejnovější první)
router.get("/priloha/versions", async (req, res) => {
  try {
    const unitId = req.user.accountingUnitId;
    const versions = await store.all(
      `SELECT * FROM financial_statement_note_version
       WHERE accounting_unit_id = ? AND period_id = ? ORDER BY version DESC`,
      [unitId, req.query.period]
    );
    res.json(versions);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/reports/zaverka.pdf?unit=1&period=1&asOf=2026-12-31 — kompletní
// účetní závěrka (rozvaha + výsledovka + příloha) v jednom PDF pro sbírku listin.
router.get("/zaverka.pdf", async (req, res) => {
  try {
    const unitId = req.user.accountingUnitId;
    const periodId = req.query.period;
    const period = await store.get(
      "SELECT * FROM accounting_period WHERE id = ? AND accounting_unit_id = ?",
      [periodId, unitId]
    );
    if (!period) return res.status(404).json({ error: "Účetní období nenalezeno." });
    const asOfDate = req.query.asOf || period.end_date;
    const unit = await store.get("SELECT * FROM accounting_unit WHERE id = ?", [unitId]);

    const [rozvahaData, vysledovkaData, note, auto] = await Promise.all([
      reports.rozvaha(unitId, asOfDate),
      reports.vysledovka(unitId, periodId, asOfDate),
      store.get("SELECT * FROM financial_statement_note WHERE accounting_unit_id = ? AND period_id = ?", [unitId, periodId]),
      reports.prilohaAutoData(unitId, periodId, asOfDate),
    ]);

    const pdfBuffer = await buildStatementPdf({
      unit, period, rozvaha: rozvahaData, vysledovka: vysledovkaData, note: note || null, auto,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="zaverka-${period.fiscal_year}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// POST /api/reports/precenit-kurzove?unit=1 — { asOf, created_by } — přecenění
// otevřených cizoměnových pohledávek/závazků k rozvahovému dni (§ 24 odst. 6-7
// ZoÚ). Explicitní akce, idempotentní (viz lib/fxRevaluation.js). Scope na
// accounting_unit_id přes req.user (INVARIANT).
router.post("/precenit-kurzove", async (req, res) => {
  const unitId = req.user.accountingUnitId;
  const { asOf, created_by } = req.body;
  if (!asOf) return res.status(400).json({ error: "Chybí rozvahový den (asOf)." });
  try {
    const result = await store.transaction(() => preceniOtevrenePohledavkyZavazky(unitId, asOf, created_by || req.user.id));
    store.persist();
    res.json({ rozvahovy_den: asOf, vysledky: result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
