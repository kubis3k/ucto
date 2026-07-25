const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const store = require("../db");
const { generateDocumentNumber, nextPostingNumber, writeAuditLog, assertPeriodOpen, assertMonthOpen, stornoPosting } = require("../lib/core");
const qrplatba = require("../lib/qrplatba");
const invoiceScan = require("../lib/invoiceScan");
const { buildInvoicePdf } = require("../lib/invoicePdf");
const mailer = require("../lib/mailer");
const attachmentStore = require("../lib/attachmentStore");
const { getRate } = require("../lib/cnbExchangeRate");
const router = express.Router();

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "text/csv", "application/vnd.ms-excel", "image/png", "image/jpeg"]);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

// memoryStorage (ne diskStorage) — obsah se předává attachmentStore, který
// rozhodne, jestli jde na objektové úložiště (web) nebo na lokální disk
// (desktop/vývoj). Limit 15 MB drží paměťovou náročnost pod kontrolou.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(new Error("Povolené formáty jsou pouze PDF a CSV."));
    cb(null, true);
  },
});

// GET /api/documents?unit=1&status=koncept&docType=faktura_vydana
router.get("/", async (req, res) => {
  const { unit, status, docType } = req.query;
  try {
    let where = "accounting_unit_id = ?";
    const params = [unit];
    if (status) { where += " AND status = ?"; params.push(status); }
    if (docType) { where += " AND doc_type = ?"; params.push(docType); }
    const rows = await store.all(`SELECT * FROM document WHERE ${where} ORDER BY issue_date DESC, id DESC`, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get("/:id", async (req, res) => {
  try {
    const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    const lines = await store.all("SELECT * FROM document_line WHERE document_id = ? ORDER BY line_no", [req.params.id]);
    res.json({ ...doc, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — vytvoření nového dokladu (koncept). Číslo se generuje automaticky.
router.post("/", async (req, res) => {
  const {
    accounting_unit_id, doc_type, contact_id, project_id, period_id, variable_symbol,
    issue_date, taxable_supply_date, due_date, description, total_amount, currency,
    is_vat_document, vat_base_amount, vat_rate, vat_amount, counterparty_dic,
    responsible_user_id, cash_payee_name, cash_payee_address, cash_payee_id_number,
    lines,
  } = req.body;

  try {
    const doc = await store.transaction(async () => {
      await assertPeriodOpen(period_id);
      await assertMonthOpen(accounting_unit_id, issue_date);
      const year = new Date(issue_date).getFullYear();
      const docNumber = await generateDocumentNumber(accounting_unit_id, doc_type, year);

      // Kurz vystavení cizoměnového dokladu (§ 24 odst. 6-7 ZoÚ) — "zamrzne" se
      // hned při vzniku dokladu. Výpadek ČNB NESMÍ zablokovat vytvoření dokladu
      // (uloží se NULL, doplní se ručně) — viz flow-state.md plán úkolu 4, krok 3.
      const cur = currency || "CZK";
      let fxRate = null, fxRateUnit = 1;
      if (cur !== "CZK") {
        const rate = await getRate(cur, issue_date).catch(() => null);
        if (rate) { fxRate = rate.rate; fxRateUnit = rate.unit; }
      }

      await store.run(
        `INSERT INTO document
          (accounting_unit_id, doc_type, doc_number, variable_symbol, contact_id, project_id, period_id,
           issue_date, taxable_supply_date, due_date, description, total_amount, currency, fx_rate, fx_rate_unit,
           is_vat_document, vat_base_amount, vat_rate, vat_amount, counterparty_dic,
           responsible_user_id, cash_payee_name, cash_payee_address, cash_payee_id_number)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accounting_unit_id, doc_type, docNumber, variable_symbol || null, contact_id || null, project_id || null, period_id,
         issue_date, taxable_supply_date || null, due_date || null, description, total_amount, cur, fxRate, fxRateUnit,
         is_vat_document ? 1 : 0, vat_base_amount || null, vat_rate || null, vat_amount || null, counterparty_dic || null,
         responsible_user_id, cash_payee_name || null, cash_payee_address || null, cash_payee_id_number || null]
      );
      const docId = (await store.get("SELECT last_insert_rowid() AS id")).id;

      if (Array.isArray(lines)) {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await store.run(
            `INSERT INTO document_line (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount, suggested_account_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [docId, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, l.line_amount, l.suggested_account_id || null]
          );
        }
      }

      await writeAuditLog({ unitId: accounting_unit_id, userId: responsible_user_id, action: "INSERT", table: "document", entityId: docId, after: { doc_number: docNumber, total_amount } });

      return store.get("SELECT * FROM document WHERE id = ?", [docId]);
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/documents/:id — editace; povoleno JEN pro doklady ve stavu 'koncept'
// (schválený/zaúčtovaný/stornovaný doklad se needituje — legitimní tok je přes
// storno). doc_number/doc_type/accounting_unit_id/period_id/status/
// responsible_user_id se needitují (identifikátory/workflow pole).
router.put("/:id", async (req, res) => {
  const {
    contact_id, project_id, variable_symbol, issue_date, taxable_supply_date, due_date,
    description, total_amount, currency, is_vat_document, vat_base_amount, vat_rate, vat_amount,
    counterparty_dic, cash_payee_name, cash_payee_address, cash_payee_id_number, lines,
  } = req.body;
  try {
    const existing = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!existing) return res.status(404).json({ error: "Doklad nenalezen" });
    if (existing.status !== "koncept") return res.status(400).json({ error: "Upravit lze jen doklad ve stavu koncept." });

    // FIX (A3): editace dokladu (i ve stavu koncept) nesmí projít, pokud jeho
    // datum spadá do uzavřeného období nebo uzamčeného měsíce — doklad mohl
    // vzniknout před uzavřením a zůstat konceptem. Dřív PUT nekontroloval nic.
    // Kontroluje se PŮVODNÍ i NOVÉ datum, ať nejde doklad z uzamčeného měsíce
    // "vyvést" přepsáním data ani naopak vložit do uzamčeného měsíce.
    await assertPeriodOpen(existing.period_id);
    await assertMonthOpen(req.user.accountingUnitId, existing.issue_date);
    if (issue_date && issue_date !== existing.issue_date) {
      await assertMonthOpen(req.user.accountingUnitId, issue_date);
    }

    const doc = await store.transaction(async () => {
      const newIssueDate = issue_date ?? existing.issue_date;
      const newCurrency = currency ?? existing.currency ?? "CZK";

      // FIX P2 (critic 2026-07-10, editace dokladu): bank.js /:id/match nemá
      // status guard, takže i doklad ve stavu 'koncept' lze spárovat s bankovním
      // pohybem před zaúčtováním. Pokud editace teď změní total_amount/currency,
      // dřívější spárování by tiše ukazovalo na nesprávnou částku. Systém NEMÁ
      // žádný "odpárovat" endpoint (dead-end pro uživatele), takže párování
      // raději rovnou ZRUŠÍME a napíšeme to do audit logu — bezpečnější než
      // tvrdě blokovat editaci nebo nechat nesedící matched_document_id.
      const amountOrCurrencyChanging =
        (total_amount !== undefined && total_amount !== existing.total_amount) ||
        (currency !== undefined && currency !== existing.currency);
      let unmatchedLineId = null;
      if (amountOrCurrencyChanging) {
        const matchedLine = await store.get("SELECT id FROM bank_statement_line WHERE matched_document_id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
        if (matchedLine) {
          await store.run("UPDATE bank_statement_line SET matched_document_id = NULL WHERE id = ?", [matchedLine.id]);
          unmatchedLineId = matchedLine.id;
        }
      }

      // Kurz vystavení (§ 24 odst. 6-7 ZoÚ) — přepočítat, jen když se mění na/uvnitř
      // cizí měny (nová měna je cizí NEBO doklad už v cizí měně byl a mění se datum
      // vyhotovení — kurz se váže na den vystavení). Stejná logika jako POST /
      // (viz výše) — VĚDOMĚ zkopírováno 1:1, ne vytaženo do sdílené funkce (malý rozsah).
      let fxRate = existing.fx_rate, fxRateUnit = existing.fx_rate_unit || 1;
      if (newCurrency !== "CZK") {
        const currencyChanged = currency !== undefined && currency !== existing.currency;
        const dateChangedForFx = issue_date !== undefined && issue_date !== existing.issue_date && existing.currency !== "CZK";
        if (currencyChanged || dateChangedForFx) {
          const rate = await getRate(newCurrency, newIssueDate).catch(() => null);
          if (rate) { fxRate = rate.rate; fxRateUnit = rate.unit; }
          else { fxRate = null; fxRateUnit = 1; }
        }
      } else {
        fxRate = null; fxRateUnit = 1;
      }

      await store.run(
        `UPDATE document SET
           contact_id=?, project_id=?, variable_symbol=?, issue_date=?, taxable_supply_date=?, due_date=?,
           description=?, total_amount=?, currency=?, fx_rate=?, fx_rate_unit=?,
           is_vat_document=?, vat_base_amount=?, vat_rate=?, vat_amount=?, counterparty_dic=?,
           cash_payee_name=?, cash_payee_address=?, cash_payee_id_number=?
         WHERE id=? AND accounting_unit_id=?`,
        [
          contact_id ?? existing.contact_id, project_id ?? existing.project_id, variable_symbol ?? existing.variable_symbol,
          newIssueDate, taxable_supply_date ?? existing.taxable_supply_date, due_date ?? existing.due_date,
          description ?? existing.description, total_amount ?? existing.total_amount, newCurrency, fxRate, fxRateUnit,
          is_vat_document === undefined ? existing.is_vat_document : (is_vat_document ? 1 : 0),
          vat_base_amount ?? existing.vat_base_amount, vat_rate ?? existing.vat_rate, vat_amount ?? existing.vat_amount,
          counterparty_dic ?? existing.counterparty_dic,
          cash_payee_name ?? existing.cash_payee_name, cash_payee_address ?? existing.cash_payee_address,
          cash_payee_id_number ?? existing.cash_payee_id_number,
          req.params.id, req.user.accountingUnitId,
        ]
      );

      if (Array.isArray(lines)) {
        await store.run("DELETE FROM document_line WHERE document_id = ?", [req.params.id]);
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await store.run(
            `INSERT INTO document_line (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount, suggested_account_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [req.params.id, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, l.line_amount, l.suggested_account_id || null]
          );
        }
      }

      await writeAuditLog({
        unitId: existing.accounting_unit_id, userId: req.user.id, action: "UPDATE", table: "document", entityId: req.params.id, before: existing,
        after: unmatchedLineId ? { unmatched_bank_line_id: unmatchedLineId, reason: "total_amount/currency změněny po spárování s bankou" } : undefined,
      });
      const updated = await store.get("SELECT * FROM document WHERE id = ?", [req.params.id]);
      const updatedLines = await store.all("SELECT * FROM document_line WHERE document_id = ? ORDER BY line_no", [req.params.id]);
      return { ...updated, lines: updatedLines, _unmatched_bank_line: unmatchedLineId };
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/approve — schválení (odpovědná osoba za zaúčtování, § 11 ZoÚ)
router.post("/:id/approve", async (req, res) => {
  const { approved_by } = req.body;
  try {
    const before = await store.get("SELECT * FROM document WHERE id = ? AND status = 'koncept' AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!before) return res.status(400).json({ error: "Doklad nelze schválit — buď neexistuje, nebo už není v konceptu." });

    await store.transaction(async () => {
      await store.run("UPDATE document SET status = 'schvaleny', approved_by = ?, approved_at = datetime('now') WHERE id = ? AND accounting_unit_id = ?", [approved_by, req.params.id, req.user.accountingUnitId]);
      await writeAuditLog({ unitId: before.accounting_unit_id, userId: approved_by, action: "APPROVE", table: "document", entityId: req.params.id, before, after: { status: "schvaleny" } });
    });
    res.json(await store.get("SELECT * FROM document WHERE id = ?", [req.params.id]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/storno — stornování dokladu (nemaže, jen mění stav a zaznamená důvod)
router.post("/:id/storno", async (req, res) => {
  const { reason, user_id } = req.body;
  try {
    const before = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!before) return res.status(404).json({ error: "Doklad nenalezen" });
    if (before.status === "stornovany") return res.status(400).json({ error: "Doklad je již stornovaný." });

    // FIX (A3): zámek se musí kontrolovat i tady, ne jen ve stornoPosting.
    // U NEZAÚČTOVANÉHO dokladu (koncept) žádné účetní zápisy neexistují, takže
    // by se do stornoPosting vůbec nedostalo a storno dokladu v uzavřeném
    // období by tichem prošlo. Rozhodnutí A3 je zakázat zápis do uzavřeného
    // období/uzamčeného měsíce bez ohledu na cestu.
    await assertPeriodOpen(before.period_id);
    await assertMonthOpen(req.user.accountingUnitId, before.issue_date);

    await store.transaction(async () => {
      // FIX P1 (critic 2026-07-09, agent-memory/critic/document_storno_ghost_posting.md):
      // storno dokladu musí zvrátit i navázané účetní zápisy (posting_line je
      // append-only, jinak by zůstaly "duchy" ve výkazech/hlavní knize i po
      // stornu zaúčtovaného dokladu). Stejná logika jako postings.js POST
      // /:id/storno — stornoPosting() vytvoří protichůdný zápis (MD<->D).
      // NOT EXISTS guard (critic 2026-07-09, double-storno gap): posting mohl už být
      // zvrácen dřív přes POST /api/postings/:id/storno — bez tohoto by ho document
      // storno našlo znovu (storno_of_posting_id IS NULL platí i pro už-zvrácený
      // originál) a zvrátilo podruhé, což by v hlavní knize nevrátilo nulu.
      const postings = await store.all(
        `SELECT id FROM posting p WHERE p.document_id = ? AND p.storno_of_posting_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM posting sp WHERE sp.storno_of_posting_id = p.id)`,
        [req.params.id]
      );
      for (const p of postings) {
        await stornoPosting(p.id, reason || "Storno dokladu", user_id, req.user.accountingUnitId);
      }
      await store.run("UPDATE document SET status = 'stornovany' WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
      await writeAuditLog({ unitId: before.accounting_unit_id, userId: user_id, action: "STORNO", table: "document", entityId: req.params.id, before, after: { status: "stornovany", reason, reversed_postings: postings.map((p) => p.id) } });
    });
    res.json(await store.get("SELECT * FROM document WHERE id = ?", [req.params.id]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/post — automatické zaúčtování dokladu podle
// předkontace (template_id). Ze šablony se odvodí účty MD/D a částky se
// naplní z dokladu (celková částka / základ DPH / výše DPH). Jedno kliknutí
// místo ručního zápisu — tak, jak to dělá Pohoda i Money S3.
router.post("/:id/post", async (req, res) => {
  const { template_id, created_by } = req.body;
  try {
    const posting = await store.transaction(async () => {
      const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
      if (!doc) throw new Error("Doklad nenalezen.");
      if (doc.status === "zauctovany") throw new Error("Doklad je již zaúčtovaný.");
      if (doc.status === "stornovany") throw new Error("Stornovaný doklad nelze zaúčtovat.");
      await assertPeriodOpen(doc.period_id);
      await assertMonthOpen(doc.accounting_unit_id, doc.issue_date);

      const tpl = await store.get("SELECT * FROM posting_template WHERE id = ? AND accounting_unit_id = ?", [template_id, doc.accounting_unit_id]);
      if (!tpl) throw new Error("Předkontace nenalezena.");
      const tplLines = await store.all("SELECT * FROM posting_template_line WHERE template_id = ?", [template_id]);

      // Přepočet do CZK při zaúčtování — total_amount NA DOKLADU zůstává v cizí
      // měně (kvůli faktuře/QR/invoice_payment, viz flow-state.md plán úkolu 4,
      // krok 4), přepočítá se až částka posting_line podle "zamrzlého" kurzu
      // vystavení (doc.fx_rate/doc.fx_rate_unit). MD=D kontrola platí dál, protože
      // všechny částky škálují stejným kurzem.
      const toCzk = (value) => {
        if (doc.currency && doc.currency !== "CZK" && doc.fx_rate) {
          return Math.round(value * (doc.fx_rate / (doc.fx_rate_unit || 1)) * 100) / 100;
        }
        return value;
      };
      // FIX P1 (critic 2026-07-10, kurzové rozdíly): zaklad/dph/celkem se NESMÍ
      // přepočítat na CZK NEZÁVISLE — nezávislé zaokrouhlení na 2 des. místa po
      // vynásobení kurzem běžně způsobí zaklad_czk + dph_czk != celkem_czk (o
      // haléř), a předkontace s oběma řádky (MD zaklad, MD dph, D celkem) by pak
      // routinně padala na "nevyrovnaný zápis" u každé cizoměnové faktury s DPH.
      // dph_czk je proto DOPOČÍTANÝ jako rozdíl celkem_czk-zaklad_czk, ne vlastní
      // nezávislé zaokrouhlení — garantuje přesný součet i po převodu měny.
      const zaklad_czk = toCzk(doc.vat_base_amount || 0);
      const celkem_czk = toCzk(doc.total_amount);
      const dph_czk = Math.round((celkem_czk - zaklad_czk) * 100) / 100;
      const amountFor = (src) => {
        if (src === "zaklad") return zaklad_czk;
        if (src === "dph") return dph_czk;
        return celkem_czk;
      };
      const lines = tplLines.map((tl) => ({ account_id: tl.account_id, side: tl.side, amount: amountFor(tl.amount_source) }))
        .filter((l) => l.amount > 0);

      const md = lines.filter((l) => l.side === "MD").reduce((s, l) => s + l.amount, 0);
      const d = lines.filter((l) => l.side === "D").reduce((s, l) => s + l.amount, 0);
      if (Math.abs(md - d) > 0.001) {
        throw new Error(`Předkontace by vytvořila nevyrovnaný zápis: MD = ${md.toFixed(2)}, D = ${d.toFixed(2)}. Zkontrolujte šablonu a DPH pole dokladu.`);
      }

      const postingNumber = await nextPostingNumber(doc.accounting_unit_id);
      await store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [doc.accounting_unit_id, doc.period_id, postingNumber, doc.id, doc.issue_date, `${doc.doc_number}: ${doc.description}`, created_by]
      );
      const postingId = (await store.get("SELECT last_insert_rowid() AS id")).id;
      for (const l of lines) {
        await store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount, project_id) VALUES (?,?,?,?,?)`,
          [postingId, l.account_id, l.side, l.amount, doc.project_id || null]);
      }
      await store.run("UPDATE document SET status = 'zauctovany' WHERE id = ? AND accounting_unit_id = ?", [doc.id, doc.accounting_unit_id]);
      await writeAuditLog({ unitId: doc.accounting_unit_id, userId: created_by, action: "POST", table: "document", entityId: doc.id, after: { posting_id: postingId, template: tpl.name } });
      return store.get("SELECT * FROM posting WHERE id = ?", [postingId]);
    });
    res.status(201).json(posting);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/documents/:id/qr — QR platba (SPD) pro doklad. IBAN se bere podle
// typu dokladu: u vydané faktury náš (příjem od odběratele), u přijaté/závazku
// IBAN dodavatele (úhrada dodavateli).
router.get("/:id/qr", async (req, res) => {
  try {
    const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });

    let iban, message;
    if (doc.doc_type === "faktura_prijata") {
      const contact = doc.contact_id ? await store.get("SELECT iban, bank_account FROM contact WHERE id = ?", [doc.contact_id]) : null;
      iban = contact?.iban;
      message = "Uhrada " + doc.doc_number;
    } else {
      const unit = await store.get("SELECT iban FROM accounting_unit WHERE id = ?", [doc.accounting_unit_id]);
      iban = unit?.iban;
      message = doc.description;
    }
    if (!iban) {
      return res.status(400).json({ error: "Chybí IBAN pro QR platbu. Doplňte IBAN v Nastavení (vydané faktury) nebo u kontaktu (přijaté faktury)." });
    }

    const { spayd, svg } = await qrplatba.generate({
      iban, amount: doc.total_amount, vs: doc.variable_symbol || doc.doc_number.replace(/\D/g, ""), message,
    });
    res.json({ spayd, svg });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Načte podklady pro PDF vydané faktury a ověří, že doklad patří
// přihlášené firmě (accounting_unit_id se řídí middleware v index.js).
async function loadInvoicePdfInputs(req) {
  const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
  if (!doc) throw Object.assign(new Error("Doklad nenalezen"), { status: 404 });
  if (doc.doc_type !== "faktura_vydana") throw Object.assign(new Error("Vizuál PDF je k dispozici jen pro vydané faktury."), { status: 400 });
  const [lines, unit, contact] = await Promise.all([
    store.all("SELECT * FROM document_line WHERE document_id = ? ORDER BY line_no", [doc.id]),
    store.get("SELECT * FROM accounting_unit WHERE id = ?", [doc.accounting_unit_id]),
    doc.contact_id ? store.get("SELECT * FROM contact WHERE id = ?", [doc.contact_id]) : null,
  ]);
  return { doc, lines, unit, contact };
}

// GET /api/documents/:id/pdf — vizuál vydané faktury ke stažení/náhledu.
router.get("/:id/pdf", async (req, res) => {
  try {
    const { doc, lines, unit, contact } = await loadInvoicePdfInputs(req);
    const pdfBuffer = await buildInvoicePdf({ doc, lines, unit, contact });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="faktura-${doc.doc_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST /api/documents/:id/send-email — { to?, subject?, message? } — vygeneruje
// PDF vydané faktury a odešle ho jako přílohu. Bez `to` se použije e-mail kontaktu.
router.post("/:id/send-email", async (req, res) => {
  try {
    const { doc, lines, unit, contact } = await loadInvoicePdfInputs(req);
    const to = req.body.to || contact?.email;
    if (!to) return res.status(400).json({ error: "Chybí e-mail adresáta — doplňte ho u kontaktu nebo zadejte přímo." });

    const pdfBuffer = await buildInvoicePdf({ doc, lines, unit, contact });
    const subject = req.body.subject || `Faktura č. ${doc.doc_number} — ${unit.name}`;
    const text = req.body.message || `Dobrý den,\n\nv příloze zasíláme fakturu č. ${doc.doc_number} na částku ${Number(doc.total_amount).toLocaleString("cs-CZ")} Kč se splatností ${doc.due_date || "—"}.\n\nS pozdravem,\n${unit.name}`;
    await mailer.sendInvoiceEmail({ to, subject, text, pdfBuffer, fileName: `faktura-${doc.doc_number}.pdf` });

    await writeAuditLog({ unitId: doc.accounting_unit_id, userId: req.user.id, action: "SEND_EMAIL", table: "document", entityId: doc.id, after: { to } });
    res.json({ ok: true, to });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// POST /api/documents/:id/attachments — upload PDF/CSV k existujícímu dokladu
router.post("/:id/attachments", async (req, res) => {
  const doc = await store.get("SELECT id FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
  if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });

  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Žádný soubor nebyl nahrán." });
    try {
      const saved = await attachmentStore.save({
        unitId: req.user.accountingUnitId,
        documentId: req.params.id,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
      });
      await store.run(
        `INSERT INTO document_attachment (document_id, file_name, mime_type, file_path, size_bytes, storage_backend, storage_url)
         VALUES (?,?,?,?,?,?,?)`,
        [req.params.id, req.file.originalname, req.file.mimetype, saved.file_path, saved.size_bytes,
         saved.storage_backend, saved.storage_url]
      );
      const id = (await store.get("SELECT last_insert_rowid() AS id")).id;
      store.persist();
      res.status(201).json(await store.get("SELECT id, document_id, file_name, mime_type, size_bytes, storage_backend, uploaded_at FROM document_attachment WHERE id = ?", [id]));
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
});

// GET /api/documents/:id/attachments — seznam příloh dokladu
router.get("/:id/attachments", async (req, res) => {
  try {
    const doc = await store.get("SELECT id FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    const rows = await store.all(
      "SELECT id, document_id, file_name, mime_type, size_bytes, uploaded_at FROM document_attachment WHERE document_id = ? ORDER BY uploaded_at DESC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/documents/attachments/:attachmentId/download — stažení přílohy
router.get("/attachments/:attachmentId/download", async (req, res) => {
  try {
    const attachment = await store.get(
      `SELECT da.* FROM document_attachment da
       JOIN document d ON d.id = da.document_id
       WHERE da.id = ? AND d.accounting_unit_id = ?`,
      [req.params.attachmentId, req.user.accountingUnitId]
    );
    if (!attachment) return res.status(404).json({ error: "Příloha nenalezena" });
    // attachmentStore rozliší backend (lokální disk vs. objektové úložiště)
    // a chybějící soubor hlásí jako err.status = 404.
    const content = await attachmentStore.load(attachment);
    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.file_name)}"`);
    if (content.stream) return content.stream.pipe(res);
    res.end(content.buffer);
  } catch (err) { res.status(err.status || 400).json({ error: err.message }); }
});

// POST /api/documents/:id/payment-link — vytvoří/vrátí trvalý odkaz na
// zaplacení vydané faktury přes Stripe (veřejná stránka /pay/:token,
// routes/stripe.js payPage). Za requireAuth (index.js) — jen přihlášený
// uživatel firmy může odkaz vygenerovat. Samotné placení (Stripe Checkout)
// je WEB-ONLY (potřebuje PUBLIC_BASE_URL), ale zápis pay_tokenu do DB
// funguje i bez Stripe klíčů — ověří se až při otevření /pay/:token.
router.post("/:id/payment-link", async (req, res) => {
  try {
    if (!process.env.PUBLIC_BASE_URL) {
      return res.status(500).json({ error: "Chybí PUBLIC_BASE_URL — platební odkazy fungují jen na webovém nasazení." });
    }
    const doc = await store.get("SELECT * FROM document WHERE id = ? AND accounting_unit_id = ?", [req.params.id, req.user.accountingUnitId]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    if (doc.doc_type !== "faktura_vydana") return res.status(400).json({ error: "Platební odkaz lze vygenerovat jen pro vydané faktury." });

    let payment = await store.get("SELECT * FROM invoice_payment WHERE document_id = ?", [doc.id]);
    if (!payment) {
      const payToken = crypto.randomBytes(24).toString("hex");
      await store.run(
        `INSERT INTO invoice_payment (accounting_unit_id, document_id, pay_token, amount, currency)
         VALUES (?,?,?,?,?)`,
        [doc.accounting_unit_id, doc.id, payToken, doc.total_amount, doc.currency || "CZK"]
      );
      payment = await store.get("SELECT * FROM invoice_payment WHERE document_id = ?", [doc.id]);
      await writeAuditLog({ unitId: doc.accounting_unit_id, userId: req.user.id, action: "INSERT", table: "invoice_payment", entityId: payment.id, after: { document_id: doc.id } });
    }
    const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
    res.json({ url: `${base}/pay/${payment.pay_token}`, status: payment.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/scan — vytáhne text z nahrané faktury (PDF/PNG/JPG) a
// zkusí rozpoznat pole dokladu (číslo, data, VS, částka, IČO/DIČ dodavatele).
// Nic se neukládá — jen návrh pro předvyplnění formuláře "Nový doklad".
//
// Dvě větve vstupu:
// - multipart/form-data (`file`) — PDF, čte se server-side přes pdf-parse
//   (extractText + extractFields), beze změny oproti dřívějšímu chování.
// - application/json ({ text }) — obrázek už byl rozpoznán OCR v browseru
//   (Tesseract.js, viz app.js ocrImageInBrowser) — fotka samotná server
//   NIKDY nevidí, jen výsledný text. Spustí se JEN extractFields(text).
const MAX_SCAN_TEXT_LENGTH = 1_000_000; // 1 MB — reálný OCR text je < 50 kB
router.post("/scan", (req, res) => {
  if (req.is("application/json")) {
    const text = req.body && req.body.text;
    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ error: "Chybí rozpoznaný text." });
    }
    if (text.length > MAX_SCAN_TEXT_LENGTH) {
      return res.status(400).json({ error: "Text je příliš dlouhý." });
    }
    const fields = invoiceScan.extractFields(text);
    return res.json({ fields, ocr_supported: true, text_preview: text.slice(0, 300) });
  }
  scanUpload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Chybí soubor." });
    try {
      const text = await invoiceScan.extractText(req.file.buffer, req.file.mimetype);
      const fields = invoiceScan.extractFields(text);
      res.json({ fields, ocr_supported: req.file.mimetype === "application/pdf", text_preview: text.slice(0, 300) });
    } catch (err2) {
      res.status(400).json({ error: "Nepodařilo se přečíst soubor: " + err2.message });
    }
  });
});

module.exports = router;
