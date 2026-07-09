// =====================================================================
// api/index.js — Vercel serverless vstupní bod. Sestaví stejnou Express
// appku jako desktop appka (app/server/index.js -> buildApp()), jen bez
// app.listen() — Vercel appku volá přímo jako (req, res) handler.
//
// buildApp() se volá jen jednou za "teplou" instanci funkce (appPromise
// je modulová proměnná, přežívá mezi voláními na stejném běžícím
// containeru) — opakovaná inicializace DB schématu/seed dat při každém
// požadavku by byla zbytečně pomalá.
// =====================================================================
const { buildApp } = require("../app/server/index");

let appPromise = null;

module.exports = async (req, res) => {
  if (!appPromise) {
    appPromise = buildApp("/tmp");
  }
  try {
    const app = await appPromise;
    app(req, res);
  } catch (err) {
    appPromise = null; // příští požadavek to zkusí znovu inicializovat od nuly
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Server se nepodařilo spustit: " + err.message }));
  }
};
