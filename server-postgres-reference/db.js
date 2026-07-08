const { Pool } = require("pg");

// Připojení k databázi. V produkci nastavit přes proměnné prostředí (.env),
// zde pro lokální vývoj/test natvrdo.
const pool = new Pool({
  host: "localhost",
  user: "postgres",
  password: "localdev",
  database: "globaal_prod",
  options: "-c search_path=ucetnictvi",
});

module.exports = { pool };
