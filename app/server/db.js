// =====================================================================
// db.js — dispatcher. Vybere implementaci úložiště podle prostředí:
// DATABASE_URL nastaveno -> Postgres (web/Vercel, db-pg.js), jinak
// sql.js (desktop/Electron, db-sqlite.js). Všechny ostatní moduly
// (routes/*, lib/*) importují jen "./db" nebo "../db" a nikdy neví,
// se kterým backendem ve skutečnosti mluví — obě implementace vystavují
// stejné async rozhraní (init/persist/all/get/run/transaction/getDb/getUserDataDir).
// =====================================================================
module.exports = process.env.DATABASE_URL ? require("./db-pg") : require("./db-sqlite");
