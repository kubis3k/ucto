// =====================================================================
// inbound-email.js — Postmark Inbound webhook (routing: MailboxHash =
// token přiřazený firmě přes bank_inbound_mailbox, ekvivalent Fakturoidí
// "bank.X.Y@..." adresy). MUSÍ být mountnutý PŘED requireAuth (index.js)
// — nemá uživatelskou session, autentizace vlastním HTTP Basic Auth vs
// POSTMARK_INBOUND_TOKEN (stejný vzor jako CRON_SECRET v cron.js: bez env
// proměnné VŽDY odmítni, nikdy tichý bypass).
// =====================================================================
const express = require("express");
const store = require("../db");
const { parseBankEmail } = require("../lib/bankEmailParser");
const { createBankStatementLine, autoMatchLine } = require("../lib/bankMovements");
const router = express.Router();

function checkBasicAuth(req) {
  const expected = process.env.POSTMARK_INBOUND_TOKEN;
  if (!expected) return false; // bez env proměnné vždy odmítni (žádný bypass)
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const sepIndex = decoded.indexOf(":");
  const password = sepIndex === -1 ? decoded : decoded.slice(sepIndex + 1);
  // Postmark posílá creds jako user:pass v URL adresy webhooku — porovnáváme
  // heslo (nebo celý decoded string, pokud je token nastaven bez username).
  return password === expected || decoded === expected;
}

// POST /api/inbound/bank-email — Postmark Inbound JSON payload.
router.post("/bank-email", async (req, res) => {
  if (!checkBasicAuth(req)) {
    console.warn("inbound-email: neautorizovaný pokus o doručení webhooku.");
    return res.status(401).json({ error: "Neautorizováno." });
  }
  try {
    const payload = req.body || {};
    const mailboxHash = payload.MailboxHash;
    const mailbox = mailboxHash
      ? await store.get("SELECT * FROM bank_inbound_mailbox WHERE token = ?", [mailboxHash])
      : null;

    if (!mailbox) {
      // Neznámý/chybějící token -> 200, aby Postmark neretryoval doručení
      // (plán: "neznámý token → 200 (aby Postmark neretryoval) + log").
      console.warn(`inbound-email: neznámý MailboxHash '${mailboxHash}', e-mail zahozen.`);
      return res.status(200).json({ ok: false, reason: "unknown_mailbox" });
    }

    const subject = payload.Subject || "";
    const textBody = payload.TextBody || payload.StrippedTextReply || "";
    const parsed = parseBankEmail(subject, textBody);

    if (parsed.amount === null) {
      console.warn(`inbound-email: nepodařilo se rozpoznat částku (unit ${mailbox.accounting_unit_id}, MessageID ${payload.MessageID}).`);
      return res.status(200).json({ ok: false, reason: "unparsable" });
    }

    const line = await createBankStatementLine({
      unitId: mailbox.accounting_unit_id,
      bankAccount: mailbox.bank_account,
      date: new Date().toISOString().slice(0, 10),
      amount: parsed.amount,
      counterpartyName: parsed.counterpartyName,
      variableSymbol: parsed.variableSymbol,
      externalRef: payload.MessageID || null,
    });
    await autoMatchLine(line.id, mailbox.accounting_unit_id);
    store.persist();
    res.status(200).json({ ok: true, bank_line_id: line.id });
  } catch (err) {
    console.error("inbound-email error:", err);
    // I chyba se vrací 200 — Postmark by jinak retryoval stejný e-mail znovu;
    // idempotence přes external_ref/MessageID stejně chrání proti duplicitám,
    // takže případný ruční re-import po opravě chyby je bezpečný.
    res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
