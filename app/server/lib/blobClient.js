// =====================================================================
// blobClient.js — jediné místo, kde se sahá na @vercel/blob.
//
// Lazy require: balíček nemusí být v každém prostředí nainstalovaný (desktop
// build ho nepotřebuje, přílohy tam jdou na lokální disk), takže se načítá
// teprve když je opravdu potřeba. Zároveň jeden testovací seam pro celý
// projekt — testy si podstrčí fake klienta a nepotřebují Vercel účet.
//
// Používá lib/attachmentStore.js (přílohy dokladů) a lib/backup.js (zálohy).
// =====================================================================
let override = null;

function setForTests(client) {
  override = client;
}

function isConfigured() {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || override);
}

function get() {
  if (override) return override;
  return require("@vercel/blob");
}

function token() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

module.exports = { get, isConfigured, setForTests, token };
