// =====================================================================
// db-pg.js — stejné rozhraní jako db.js (get/all/run/transaction/persist/
// getUserDataDir), ale nad reálným Postgresem (pg Pool) pro webové
// nasazení (Vercel + Neon/Supabase). Aktivuje se, když je nastavená
// proměnná DATABASE_URL (viz index.js).
//
// Klíčový rozdíl oproti sql.js: Postgres je vždy asynchronní a používá
// connection pool, ne jedno sdílené in-memory spojení. Aby route kód
// mohl beze změny volat store.get/all/run i uvnitř store.transaction(fn),
// aniž by mu route explicitně předával "client" objekt, používáme
// AsyncLocalStorage — každé volání store.transaction() si "zapůjčí"
// jedno spojení z poolu a napojí ho na aktuální async kontext; get/all/run
// pak automaticky použijí toto spojení, pokud běží uvnitř transakce,
// jinak sáhnou přímo do poolu. Bez tohoto mechanismu by souběžné
// požadavky různých firem mohly omylem sdílet cizí transakci.
// =====================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Pool } = require("pg");
const { AsyncLocalStorage } = require("async_hooks");

let pool = null;
const txContext = new AsyncLocalStorage();

async function init() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
  const schemaSql = fs.readFileSync(path.join(__dirname, "schema-pg.sql"), "utf-8");
  await pool.query(schemaSql);
  return pool;
}

// Vercel serverless nemá trvalý disk — použije se dočasný adresář (přežije
// jen po dobu běhu jedné instance). Přílohy dokladů proto na webu prozatím
// nejsou trvale perzistentní, viz komentář v schema-pg.sql u document_attachment.
function getUserDataDir() {
  return os.tmpdir();
}

function persist() {
  // no-op — Postgres commituje zápisy okamžitě, není co ukládat na disk.
}

// Přeloží SQLite-styl dotaz (pozicní "?", last_insert_rowid(), datetime('now'))
// na Postgres ekvivalent ("$1,$2,...", lastval(), now()).
function translateQuery(sql) {
  let i = 0;
  return sql
    .replace(/\?/g, () => `$${++i}`)
    .replace(/last_insert_rowid\(\)/gi, "lastval()")
    .replace(/datetime\('now'\)/gi, "now()");
}

function getExecutor() {
  return txContext.getStore() || pool;
}

async function all(sql, params = []) {
  const executor = getExecutor();
  const result = await executor.query(translateQuery(sql), params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

async function run(sql, params = []) {
  const executor = getExecutor();
  const result = await executor.query(translateQuery(sql), params);
  return { lastInsertRowid: undefined, changes: result.rowCount };
}

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await txContext.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function getDb() {
  return pool;
}

module.exports = { init, persist, all, get, run, transaction, getDb, getUserDataDir };
