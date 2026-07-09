// =====================================================================
// stripe.js — platba vydané faktury přes Stripe Checkout (Apple/Google Pay
// automaticky). Dva samostatné routery, mountované v index.js NA DVOU
// RŮZNÝCH místech (viz index.js):
//   - `webhook`  -> /api/stripe/webhook, MUSÍ mít express.raw() middleware
//                   (podpis se verifikuje nad syrovým tělem, ne přes
//                   globální express.json() z index.js ř.25).
//   - `payPage`  -> /pay, veřejná stránka (žádný requireAuth) — trvalá
//                   adresa v PDF/e-mailu, session se generuje on-demand
//                   (Checkout Session URL expiruje za 24 h, proto se
//                   nesmí embedovat přímo — viz flow-state.md ROZHODNUTÍ).
// Bez STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET/PUBLIC_BASE_URL tyto routy
// vždy chybují (stejný princip jako lib/mailer.js SMTP_*) — žádný tichý mock.
// =====================================================================
const express = require("express");
const store = require("../db");
const { createBankStatementLine } = require("../lib/bankMovements");

function getStripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe není nakonfigurován — chybí STRIPE_SECRET_KEY.");
  }
  // eslint-disable-next-line global-require
  const Stripe = require("stripe");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function publicBaseUrl() {
  if (!process.env.PUBLIC_BASE_URL) {
    throw new Error("Chybí PUBLIC_BASE_URL — potřebné pro success/cancel URL a odkaz na zaplacení.");
  }
  return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
}

// ---------------------------------------------------------------------
// POST /api/stripe/webhook — mountovat s express.raw({type:'application/json'})
// PŘED globálním express.json() (index.js).
// ---------------------------------------------------------------------
const webhook = express.Router();

webhook.post("/", async (req, res) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("stripe webhook: chybí STRIPE_WEBHOOK_SECRET, odmítám.");
    return res.status(500).send("Stripe webhook není nakonfigurován.");
  }
  let event;
  try {
    const stripe = getStripeClient();
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("stripe webhook: neplatný podpis —", err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const payment = await store.get("SELECT * FROM invoice_payment WHERE stripe_session_id = ?", [session.id]);
      if (!payment) {
        console.warn(`stripe webhook: invoice_payment pro session ${session.id} nenalezen.`);
        return res.status(200).json({ ok: false, reason: "unknown_session" });
      }
      if (payment.status === "paid") {
        return res.status(200).json({ ok: true, already_paid: true });
      }

      const doc = await store.get("SELECT * FROM document WHERE id = ?", [payment.document_id]);
      const unit = doc ? await store.get("SELECT * FROM accounting_unit WHERE id = ?", [doc.accounting_unit_id]) : null;

      await store.transaction(async () => {
        await store.run(
          `UPDATE invoice_payment SET status = 'paid', paid_at = datetime('now'), stripe_payment_intent_id = ? WHERE id = ?`,
          [session.payment_intent || null, payment.id]
        );

        if (doc && unit && unit.bank_account) {
          const line = await createBankStatementLine({
            unitId: payment.accounting_unit_id,
            bankAccount: unit.bank_account,
            date: new Date().toISOString().slice(0, 10),
            amount: Math.abs(Number(doc.total_amount)),
            counterpartyName: "Stripe — platba faktury",
            variableSymbol: doc.variable_symbol || doc.doc_number.replace(/\D/g, ""),
            externalRef: session.payment_intent || session.id,
          });
          // Document/document_id už známe z metadata — přímé nastavení,
          // žádné fuzzy párování potřeba (na rozdíl od e-mailu/ruční banky).
          await store.run("UPDATE bank_statement_line SET matched_document_id = ? WHERE id = ?", [doc.id, line.id]);
        } else {
          console.warn(`stripe webhook: unit ${payment.accounting_unit_id} nemá nastavený bank_account — pohyb nebyl vytvořen, jen platba oznacena jako 'paid'.`);
        }
      });
      store.persist();
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("stripe webhook handler error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /pay/:token — veřejná stránka, vytvoří Checkout Session on-demand
// a přesměruje. GET /pay/:token/dekujeme — poděkovací stránka.
// ---------------------------------------------------------------------
const payPage = express.Router();

function paidHtml() {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Faktura je zaplacena</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;color:#111}
  .card{background:#fff;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:420px}
  h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#555}</style></head>
  <body><div class="card"><h1>Tato faktura je již zaplacena.</h1><p>Děkujeme, platba byla přijata.</p></div></body></html>`;
}

function thanksHtml() {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Děkujeme za platbu</title>
  <style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f8;color:#111}
  .card{background:#fff;padding:2.5rem 3rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:420px}
  h1{font-size:1.3rem;margin:0 0 .5rem}p{color:#555}</style></head>
  <body><div class="card"><h1>Děkujeme za platbu!</h1><p>Vaše platba byla úspěšně zpracována. Potvrzení dorazí e-mailem.</p></div></body></html>`;
}

payPage.get("/:token/dekujeme", (req, res) => {
  res.status(200).send(thanksHtml());
});

payPage.get("/:token", async (req, res) => {
  try {
    const payment = await store.get("SELECT * FROM invoice_payment WHERE pay_token = ?", [req.params.token]);
    if (!payment) return res.status(404).send("Platební odkaz nenalezen.");
    if (payment.status === "paid") return res.status(200).send(paidHtml());

    const doc = await store.get("SELECT * FROM document WHERE id = ?", [payment.document_id]);
    if (!doc) return res.status(404).send("Faktura nenalezena.");
    const lines = await store.all("SELECT * FROM document_line WHERE document_id = ? ORDER BY line_no", [doc.id]);

    const stripe = getStripeClient();
    const base = publicBaseUrl();
    const currency = (doc.currency || "CZK").toLowerCase();
    const lineItems = (lines.length ? lines : [{ description: doc.description, quantity: 1, unit_price: doc.total_amount }])
      .map((l) => ({
        quantity: Math.max(1, Math.round(l.quantity || 1)),
        price_data: {
          currency,
          unit_amount: Math.round((Number(l.unit_price) || 0) * 100),
          product_data: { name: (l.description || doc.description || `Faktura ${doc.doc_number}`).slice(0, 250) },
        },
      }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${base}/pay/${req.params.token}/dekujeme`,
      cancel_url: `${base}/pay/${req.params.token}`,
      metadata: { document_id: String(doc.id), pay_token: req.params.token },
    });

    await store.run("UPDATE invoice_payment SET stripe_session_id = ? WHERE id = ?", [session.id, payment.id]);
    store.persist();
    res.redirect(303, session.url);
  } catch (err) {
    console.error("pay page error:", err);
    res.status(400).send(`Nepodařilo se vytvořit platbu: ${err.message}`);
  }
});

module.exports = { webhook, payPage };
