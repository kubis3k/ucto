const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const store = require("../db");
const { generateDocumentNumber, nextPostingNumber, writeAuditLog, assertPeriodOpen } = require("../lib/core");
const qrplatba = require("../lib/qrplatba");
const router = express.Router();

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "text/csv", "application/vnd.ms-excel"]);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function attachmentsDirFor(documentId) {
  const dir = path.join(store.getUserDataDir(), "attachments", String(documentId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, attachmentsDirFor(req.params.id)),
    filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) return cb(new Error("Povolené formáty jsou pouze PDF a CSV."));
    cb(null, true);
  },
});

// GET /api/documents?unit=1&status=koncept&docType=faktura_vydana
router.get("/", (req, res) => {
  const { unit, status, docType } = req.query;
  try {
    let where = "accounting_unit_id = ?";
    const params = [unit];
    if (status) { where += " AND status = ?"; params.push(status); }
    if (docType) { where += " AND doc_type = ?"; params.push(docType); }
    const rows = store.all(`SELECT * FROM document WHERE ${where} ORDER BY issue_date DESC, id DESC`, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/documents/:id
router.get("/:id", (req, res) => {
  try {
    const doc = store.get("SELECT * FROM document WHERE id = ?", [req.params.id]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });
    const lines = store.all("SELECT * FROM document_line WHERE document_id = ? ORDER BY line_no", [req.params.id]);
    res.json({ ...doc, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/documents — vytvoření nového dokladu (koncept). Číslo se generuje automaticky.
router.post("/", (req, res) => {
  const {
    accounting_unit_id, doc_type, contact_id, project_id, period_id, variable_symbol,
    issue_date, taxable_supply_date, due_date, description, total_amount,
    is_vat_document, vat_base_amount, vat_rate, vat_amount, counterparty_dic,
    responsible_user_id, cash_payee_name, cash_payee_address, cash_payee_id_number,
    lines,
  } = req.body;

  try {
    const doc = store.transaction(() => {
      assertPeriodOpen(period_id);
      const year = new Date(issue_date).getFullYear();
      const docNumber = generateDocumentNumber(accounting_unit_id, doc_type, year);

      store.run(
        `INSERT INTO document
          (accounting_unit_id, doc_type, doc_number, variable_symbol, contact_id, project_id, period_id,
           issue_date, taxable_supply_date, due_date, description, total_amount,
           is_vat_document, vat_base_amount, vat_rate, vat_amount, counterparty_dic,
           responsible_user_id, cash_payee_name, cash_payee_address, cash_payee_id_number)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [accounting_unit_id, doc_type, docNumber, variable_symbol || null, contact_id || null, project_id || null, period_id,
         issue_date, taxable_supply_date || null, due_date || null, description, total_amount,
         is_vat_document ? 1 : 0, vat_base_amount || null, vat_rate || null, vat_amount || null, counterparty_dic || null,
         responsible_user_id, cash_payee_name || null, cash_payee_address || null, cash_payee_id_number || null]
      );
      const docId = store.get("SELECT last_insert_rowid() AS id").id;

      if (Array.isArray(lines)) {
        lines.forEach((l, i) => {
          store.run(
            `INSERT INTO document_line (document_id, line_no, description, quantity, unit_price, vat_rate, line_amount, suggested_account_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [docId, i + 1, l.description, l.quantity || 1, l.unit_price, l.vat_rate || null, l.line_amount, l.suggested_account_id || null]
          );
        });
      }

      writeAuditLog({ unitId: accounting_unit_id, userId: responsible_user_id, action: "INSERT", table: "document", entityId: docId, after: { doc_number: docNumber, total_amount } });

      return store.get("SELECT * FROM document WHERE id = ?", [docId]);
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/approve — schválení (odpovědná osoba za zaúčtování, § 11 ZoÚ)
router.post("/:id/approve", (req, res) => {
  const { approved_by } = req.body;
  try {
    const before = store.get("SELECT * FROM document WHERE id = ? AND status = 'koncept'", [req.params.id]);
    if (!before) return res.status(400).json({ error: "Doklad nelze schválit — buď neexistuje, nebo už není v konceptu." });

    store.transaction(() => {
      store.run("UPDATE document SET status = 'schvaleny', approved_by = ?, approved_at = datetime('now') WHERE id = ?", [approved_by, req.params.id]);
      writeAuditLog({ unitId: before.accounting_unit_id, userId: approved_by, action: "APPROVE", table: "document", entityId: req.params.id, before, after: { status: "schvaleny" } });
    });
    res.json(store.get("SELECT * FROM document WHERE id = ?", [req.params.id]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/storno — stornování dokladu (nemaže, jen mění stav a zaznamená důvod)
router.post("/:id/storno", (req, res) => {
  const { reason, user_id } = req.body;
  try {
    const before = store.get("SELECT * FROM document WHERE id = ?", [req.params.id]);
    if (!before) return res.status(404).json({ error: "Doklad nenalezen" });
    if (before.status === "stornovany") return res.status(400).json({ error: "Doklad je již stornovaný." });

    store.transaction(() => {
      store.run("UPDATE document SET status = 'stornovany' WHERE id = ?", [req.params.id]);
      writeAuditLog({ unitId: before.accounting_unit_id, userId: user_id, action: "STORNO", table: "document", entityId: req.params.id, before, after: { status: "stornovany", reason } });
    });
    res.json(store.get("SELECT * FROM document WHERE id = ?", [req.params.id]));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/documents/:id/post — automatické zaúčtování dokladu podle
// předkontace (template_id). Ze šablony se odvodí účty MD/D a částky se
// naplní z dokladu (celková částka / základ DPH / výše DPH). Jedno kliknutí
// místo ručního zápisu — tak, jak to dělá Pohoda i Money S3.
router.post("/:id/post", (req, res) => {
  const { template_id, created_by } = req.body;
  try {
    const posting = store.transaction(() => {
      const doc = store.get("SELECT * FROM document WHERE id = ?", [req.params.id]);
      if (!doc) throw new Error("Doklad nenalezen.");
      if (doc.status === "zauctovany") throw new Error("Doklad je již zaúčtovaný.");
      if (doc.status === "stornovany") throw new Error("Stornovaný doklad nelze zaúčtovat.");
      assertPeriodOpen(doc.period_id);

      const tpl = store.get("SELECT * FROM posting_template WHERE id = ? AND accounting_unit_id = ?", [template_id, doc.accounting_unit_id]);
      if (!tpl) throw new Error("Předkontace nenalezena.");
      const tplLines = store.all("SELECT * FROM posting_template_line WHERE template_id = ?", [template_id]);

      const amountFor = (src) => {
        if (src === "zaklad") return doc.vat_base_amount || 0;
        if (src === "dph") return doc.vat_amount || 0;
        return doc.total_amount;
      };
      const lines = tplLines.map((tl) => ({ account_id: tl.account_id, side: tl.side, amount: amountFor(tl.amount_source) }))
        .filter((l) => l.amount > 0);

      const md = lines.filter((l) => l.side === "MD").reduce((s, l) => s + l.amount, 0);
      const d = lines.filter((l) => l.side === "D").reduce((s, l) => s + l.amount, 0);
      if (Math.abs(md - d) > 0.001) {
        throw new Error(`Předkontace by vytvořila nevyrovnaný zápis: MD = ${md.toFixed(2)}, D = ${d.toFixed(2)}. Zkontrolujte šablonu a DPH pole dokladu.`);
      }

      const postingNumber = nextPostingNumber(doc.accounting_unit_id);
      store.run(
        `INSERT INTO posting (accounting_unit_id, period_id, posting_number, document_id, posting_date, description, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [doc.accounting_unit_id, doc.period_id, postingNumber, doc.id, doc.issue_date, `${doc.doc_number}: ${doc.description}`, created_by]
      );
      const postingId = store.get("SELECT last_insert_rowid() AS id").id;
      for (const l of lines) {
        store.run(`INSERT INTO posting_line (posting_id, account_id, side, amount, project_id) VALUES (?,?,?,?,?)`,
          [postingId, l.account_id, l.side, l.amount, doc.project_id || null]);
      }
      store.run("UPDATE document SET status = 'zauctovany' WHERE id = ?", [doc.id]);
      writeAuditLog({ unitId: doc.accounting_unit_id, userId: created_by, action: "POST", table: "document", entityId: doc.id, after: { posting_id: postingId, template: tpl.name } });
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
    const doc = store.get("SELECT * FROM document WHERE id = ?", [req.params.id]);
    if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });

    let iban, message;
    if (doc.doc_type === "faktura_prijata") {
      const contact = doc.contact_id ? store.get("SELECT iban, bank_account FROM contact WHERE id = ?", [doc.contact_id]) : null;
      iban = contact?.iban;
      message = "Uhrada " + doc.doc_number;
    } else {
      const unit = store.get("SELECT iban FROM accounting_unit WHERE id = ?", [doc.accounting_unit_id]);
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

// POST /api/documents/:id/attachments — upload PDF/CSV k existujícímu dokladu
router.post("/:id/attachments", (req, res) => {
  const doc = store.get("SELECT id FROM document WHERE id = ?", [req.params.id]);
  if (!doc) return res.status(404).json({ error: "Doklad nenalezen" });

  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Žádný soubor nebyl nahrán." });
    try {
      store.run(
        `INSERT INTO document_attachment (document_id, file_name, mime_type, file_path, size_bytes)
         VALUES (?,?,?,?,?)`,
        [req.params.id, req.file.originalname, req.file.mimetype, req.file.path, req.file.size]
      );
      const id = store.get("SELECT last_insert_rowid() AS id").id;
      store.persist();
      res.status(201).json(store.get("SELECT id, document_id, file_name, mime_type, size_bytes, uploaded_at FROM document_attachment WHERE id = ?", [id]));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
});

// GET /api/documents/:id/attachments — seznam příloh dokladu
router.get("/:id/attachments", (req, res) => {
  try {
    const rows = store.all(
      "SELECT id, document_id, file_name, mime_type, size_bytes, uploaded_at FROM document_attachment WHERE document_id = ? ORDER BY uploaded_at DESC",
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/documents/attachments/:attachmentId/download — stažení přílohy
router.get("/attachments/:attachmentId/download", (req, res) => {
  try {
    const attachment = store.get("SELECT * FROM document_attachment WHERE id = ?", [req.params.attachmentId]);
    if (!attachment) return res.status(404).json({ error: "Příloha nenalezena" });
    if (!fs.existsSync(attachment.file_path)) return res.status(404).json({ error: "Soubor přílohy chybí na disku." });
    res.setHeader("Content-Type", attachment.mime_type);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(attachment.file_name)}"`);
    fs.createReadStream(attachment.file_path).pipe(res);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
