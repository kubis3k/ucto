// =====================================================================
// attachmentStore.js — jednotné úložiště příloh dokladů (document_attachment).
//
// PROČ EXISTUJE (§ 8 ZoÚ, průkaznost): ve webové verzi běží appka na Vercel
// serverless, kde `getUserDataDir()` vrací `os.tmpdir()` — dočasný disk
// instance. Příloha nahraná na jedné instanci tam po jejím zhasnutí prostě
// není. Ztracená příloha = ztracená průkaznost dokladu, proto se přílohy
// ukládají do objektového úložiště (Vercel Blob), ne na disk funkce.
//
// DVA BACKENDY, JEDNO ROZHRANÍ:
//   "blob" — Vercel Blob. Aktivní, když je nastaven BLOB_READ_WRITE_TOKEN.
//   "fs"   — lokální filesystem pod getUserDataDir(). Fallback pro desktop
//            a lokální vývoj/testy, aby šlo pracovat i offline bez tokenu.
// Který backend řádek použil, se ukládá do `document_attachment.storage_backend`,
// takže staré (fs) i nové (blob) řádky fungují vedle sebe bez migrace dat.
//
// `file_path` se záměrně recykluje jako "klíč v úložišti" (u fs absolutní
// cesta, u blob `pathname` v Blobu). Sloupec je NOT NULL a SQLite neumí
// ALTER TABLE ... DROP NOT NULL, takže přidat nullable sloupec a nechat
// file_path prázdné by znamenalo přestavbu tabulky. Recyklace je čistší.
// =====================================================================
const fs = require("fs");
const path = require("path");
const store = require("../db");

// Lazy require — @vercel/blob nemusí být nainstalované v každém prostředí
// (např. desktop build, kde se přílohy ukládají lokálně). Bez blob tokenu
// se modul vůbec nenačítá.
let blobClientOverride = null;
function getBlobClient() {
  if (blobClientOverride) return blobClientOverride;
  return require("@vercel/blob");
}

// Testovací seam — testy si podstrčí fake klienta, aby se dal ověřit
// "přežije smazání lokálního disku" bez skutečného Vercel účtu.
function __setBlobClientForTests(client) {
  blobClientOverride = client;
}

function isBlobConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || blobClientOverride);
}

function safeName(fileName) {
  return String(fileName || "soubor").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function fsDirFor(documentId) {
  const dir = path.join(store.getUserDataDir(), "attachments", String(documentId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Uloží obsah přílohy a vrátí metadata k zapsání do DB.
// unitId je součástí klíče, aby byly přílohy různých firem v úložišti
// oddělené i na úrovni cesty (audit/ruční prohlídka blobu).
async function save({ unitId, documentId, fileName, mimeType, buffer }) {
  const stamped = `${Date.now()}_${safeName(fileName)}`;

  if (isBlobConfigured()) {
    const { put } = getBlobClient();
    const key = `attachments/${unitId}/${documentId}/${stamped}`;
    const result = await put(key, buffer, {
      access: "public",
      contentType: mimeType,
      // Klíč musí zůstat přesně takový, jaký si uložíme do DB — jinak
      // bychom po náhodné příponě Vercelu nedokázali soubor znovu najít.
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return {
      storage_backend: "blob",
      file_path: key,
      storage_url: result.url,
      size_bytes: buffer.length,
    };
  }

  const dir = fsDirFor(documentId);
  const full = path.join(dir, stamped);
  fs.writeFileSync(full, buffer);
  return {
    storage_backend: "fs",
    file_path: full,
    storage_url: null,
    size_bytes: buffer.length,
  };
}

// Vrátí { stream } nebo { buffer } podle backendu. Volající streamuje do
// odpovědi. Chybějící soubor hlásí jako chybu se `status: 404`, ať routa
// nemusí rozlišovat backendy.
async function load(attachment) {
  const backend = attachment.storage_backend || "fs";

  if (backend === "blob") {
    // Čte se přes URL uloženou při nahrání; pokud chybí (starší řádek),
    // dohledá se v Blobu podle klíče.
    let url = attachment.storage_url;
    if (!url) {
      const { head } = getBlobClient();
      const meta = await head(attachment.file_path, { token: process.env.BLOB_READ_WRITE_TOKEN }).catch(() => null);
      url = meta && meta.url;
    }
    if (!url) throw Object.assign(new Error("Soubor přílohy nebyl v úložišti nalezen."), { status: 404 });
    const res = await fetch(url);
    if (!res.ok) throw Object.assign(new Error(`Přílohu se nepodařilo načíst z úložiště (HTTP ${res.status}).`), { status: 502 });
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  }

  if (!attachment.file_path || !fs.existsSync(attachment.file_path)) {
    throw Object.assign(new Error("Soubor přílohy chybí na disku."), { status: 404 });
  }
  return { stream: fs.createReadStream(attachment.file_path) };
}

module.exports = { save, load, isBlobConfigured, __setBlobClientForTests };
