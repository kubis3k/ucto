const express = require("express");
const router = express.Router();

// =====================================================================
// ARES — Administrativní registr ekonomických subjektů (Ministerstvo financí).
// Veřejné REST API bez autentizace. Umožňuje vyhledat firmu podle IČO a
// automaticky předvyplnit název, adresu, DIČ a stav plátcovství DPH — tak,
// jak to dělá Pohoda, Money S3, iDoklad i Fakturoid.
//
// Pozn.: brief (kap. 8.3) uvádí externí napojení jako "mimo rozsah 1. fáze",
// ale uživatel si toto omezení výslovně přál ignorovat kvůli pohodlí.
// ARES je jen pro čtení (lookup), nijak nenarušuje nezávislost účetních dat.
// =====================================================================

const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty";

// GET /api/ares/:ico — vyhledání ekonomického subjektu podle IČO
router.get("/:ico", async (req, res) => {
  const ico = String(req.params.ico).replace(/\s/g, "");
  if (!/^\d{8}$/.test(ico)) {
    return res.status(400).json({ error: "IČO musí být 8 číslic." });
  }
  try {
    const response = await fetch(`${ARES_BASE}/${ico}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return res.status(404).json({ error: "Subjekt s tímto IČO nebyl v ARES nalezen." });
    if (!response.ok) return res.status(502).json({ error: `ARES vrátil chybu ${response.status}.` });

    const data = await response.json();
    const isVatPayer = data?.seznamRegistraci?.stavZdrojeDph === "AKTIVNI";

    res.json({
      ico: data.ico,
      name: data.obchodniJmeno,
      address: data?.sidlo?.textovaAdresa || null,
      dic: isVatPayer ? "CZ" + data.ico : null, // DIČ plátce DPH v ČR = CZ + IČO
      is_vat_payer: isVatPayer,
      legal_form: data?.pravniForma || null,
    });
  } catch (err) {
    if (err.name === "TimeoutError") return res.status(504).json({ error: "ARES neodpovídá (timeout). Zkuste to znovu, nebo zadejte údaje ručně." });
    res.status(502).json({ error: "Nepodařilo se spojit s ARES: " + err.message });
  }
});

// GET /api/ares/search/:query — fulltextové hledání podle názvu firmy (pro pohodlnější nalezení kontaktu)
router.get("/search/:query", async (req, res) => {
  const query = String(req.params.query).trim();
  if (query.length < 3) return res.status(400).json({ error: "Zadejte alespoň 3 znaky." });
  try {
    const response = await fetch(`${ARES_BASE}/vyhledat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ obchodniJmeno: query, pocet: 15, start: 0 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return res.status(502).json({ error: `ARES vrátil chybu ${response.status}.` });
    const data = await response.json();
    const results = (data.ekonomickeSubjekty || []).map((s) => ({
      ico: s.ico,
      name: s.obchodniJmeno,
      address: s?.sidlo?.textovaAdresa || null,
    }));
    res.json(results);
  } catch (err) {
    if (err.name === "TimeoutError") return res.status(504).json({ error: "ARES neodpovídá (timeout)." });
    res.status(502).json({ error: "Nepodařilo se spojit s ARES: " + err.message });
  }
});

module.exports = router;
