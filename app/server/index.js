// =====================================================================
// index.js — sestavení Express aplikace. buildApp() vrací appku bez
// listen() (použije Vercel serverless entry point, viz ../../api/index.js);
// start(userDataDir, port) navíc appku spustí na loopbacku — volá se
// z Electron main procesu i samostatně přes `node server/index.js`
// pro vývoj/testování bez Electronu (viz package.json → "dev:server").
// =====================================================================
const express = require("express");
const path = require("path");
const store = require("./db");
const { seed } = require("./seed");
const { ensureChartOfAccounts } = require("./lib/chartOfAccountsSeed");
const { ensureCompanyDirectors, fixPlaceholderIco } = require("./lib/companySetup");
const { requireAuth } = require("./lib/auth");

async function buildApp(userDataDir) {
  await store.init(userDataDir);
  await seed();
  await ensureChartOfAccounts(store); // doplní nové účty i do dříve nainstalovaných appek
  await fixPlaceholderIco(store);
  await ensureCompanyDirectors(store);
  store.persist();

  const app = express();

  // Stripe webhook MUSÍ mít raw body (podpis se verifikuje nad syrovým
  // tělem) — mountnutý PŘED globálním express.json() níže, jinak by ho
  // json() middleware parsoval dřív, než se dostane k routě (index.js
  // INVARIANTY: webhook endpointy vlastní autentizace, ne requireAuth).
  app.use("/api/stripe/webhook", express.raw({ type: "application/json" }), require("./routes/stripe").webhook);

  app.use(express.json());

  // Renderer se v Electronu načítá přes file:// (origin "null"), na webu je
  // to stejný origin jako statický frontend. Přihlašování jede přes Bearer
  // token (Authorization header), ne cookie, takže Allow-Credentials/echo
  // originu tu není potřeba.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const authRoutes = require("./routes/auth");
  app.use("/api/auth", authRoutes);

  // Cron endpoint (Vercel Cron) — vlastní CRON_SECRET autentizace, MUSÍ být
  // mountovaný před requireAuth, protože cron nemá uživatelskou session.
  app.use("/api/cron", require("./routes/cron"));

  // Bankovní e-mail parsing (Postmark Inbound) a veřejná platební stránka —
  // stejný vzor jako cron.js: VEŘEJNÉ (bez requireAuth), ale s vlastní
  // autentizací/tokenem uvnitř routy (Basic Auth vs POSTMARK_INBOUND_TOKEN /
  // pay_token vs invoice_payment). WEB-ONLY featury (viz flow-state.md).
  app.use("/api/inbound", require("./routes/inbound-email"));
  app.use("/pay", require("./routes/stripe").payPage);

  app.use("/api", requireAuth);
  // Bezpečnostní zámek: routy níže dřív četly accounting_unit_id/unit
  // přímo od klienta (query/body) — klient si tak mohl vyžádat data jiné
  // firmy. Teď se tato hodnota vždy přepíše na firmu z přihlášené session,
  // takže klientem posílaná hodnota (pokud vůbec nějaká) je ignorována.
  app.use("/api", (req, res, next) => {
    req.query.unit = req.user.accountingUnitId;
    if (req.body && typeof req.body === "object") req.body.accounting_unit_id = req.user.accountingUnitId;
    next();
  });
  app.use("/api/documents", require("./routes/documents"));
  app.use("/api/postings", require("./routes/postings"));
  app.use("/api/reports", require("./routes/reports"));
  app.use("/api/contacts", require("./routes/contacts"));
  app.use("/api/projects", require("./routes/projects"));
  app.use("/api/assets", require("./routes/assets"));
  app.use("/api/bank", require("./routes/bank"));
  app.use("/api/vat", require("./routes/vat"));
  app.use("/api/audit-log", require("./routes/auditlog"));
  app.use("/api/inventory", require("./routes/inventory"));
  app.use("/api/export", require("./routes/export"));
  app.use("/api/ares", require("./routes/ares"));
  app.use("/api/templates", require("./routes/templates"));
  app.use("/api/price-list", require("./routes/pricelist"));
  app.use("/api/offers", require("./routes/offers"));
  app.use("/api/recurring", require("./routes/recurring"));
  app.use("/api", require("./routes/misc")); // /api/accounts, /api/periods, /api/units, /api/users

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  return app;
}

async function start(userDataDir, port) {
  const app = await buildApp(userDataDir);
  return new Promise((resolve) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// Samostatné spuštění pro vývoj (mimo Electron): ukládá DB do ./.devdata
if (require.main === module) {
  const devDataDir = path.join(__dirname, "..", ".devdata");
  require("fs").mkdirSync(devDataDir, { recursive: true });
  start(devDataDir, process.env.PORT || 4000).then(() => {
    console.log(`Ucetni API (dev mode) běží na http://localhost:${process.env.PORT || 4000}`);
  });
}

module.exports = { start, buildApp };
