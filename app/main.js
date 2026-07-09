// =====================================================================
// main.js — Electron hlavní proces. TENKÝ KLIENT (Varianta A, 2026-07-09):
// appka NEMÁ vlastní databázi ani embedded server — načítá živou webovou
// appku (stejná codebase, nasazená na Vercelu jako api/index.js + statické
// rewrites, viz vercel.json) přímo přes loadURL(). Offline = read-only
// cache poslední stažené odpovědi přes Service Worker (app/renderer/sw.js),
// NIKDY offline zápis — žádný lokální sync/outbox, jeden zdroj pravdy (web).
//
// Vercel Deployment Protection: web běží za SSO branou, obchází se přes
// "Protection Bypass for Automation" token — připojen jako query param při
// prvním loadURL, Vercel z něj nastaví cookie `_vercel_jwt` (7 dní), která
// pak platí pro všechny další requesty ze stejné Electron session (cookies
// jsou perzistentní v userData). Token žije v `desktop-config.json`
// (gitignored, NENÍ v repu) — viz README/handoff pro jak ho získat znovu.
// =====================================================================
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let mainWindow;

function loadDesktopConfig() {
  const configPath = path.join(__dirname, "desktop-config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Chybí app/desktop-config.json (webBaseUrl + bypassToken). Soubor je gitignored, ` +
      `musí existovat lokálně před buildem — viz .claude/state/flow-state.md pro postup.`
    );
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function bootUrl(config) {
  const base = config.webBaseUrl.replace(/\/+$/, "");
  // bypassToken je jen pro Vercel Deployment Protection (SSO brána na preview
  // URL) — produkční vlastní domény tuto ochranu obvykle nemají, pak je
  // bypassToken prázdný a URL zůstává čistá.
  if (!config.bypassToken) return `${base}/`;
  return `${base}/?x-vercel-protection-bypass=${encodeURIComponent(config.bypassToken)}&x-vercel-set-bypass-cookie=true`;
}

function offlineFallbackHtml() {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!DOCTYPE html><html lang="cs"><head><meta charset="utf-8">
    <title>Globaal Elevate — Účetní systém</title>
    <style>
      body { background:#0b0d12; color:#f5f6f8; font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
        display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; }
      .box { max-width: 380px; }
      h1 { font-size: 18px; margin-bottom: 8px; }
      p { color:#9aa1b0; font-size: 13px; line-height:1.6; }
      button { margin-top: 18px; background:#4f6bff; color:#fff; border:none; border-radius:9px;
        padding:10px 18px; font-size:13px; cursor:pointer; }
      button:hover { background:#3f58e6; }
    </style></head><body>
      <div class="box">
        <h1>Nelze se připojit</h1>
        <p>Appka potřebuje internetové připojení — je tenký klient nad webovou verzí.
        Zkontrolujte připojení a zkuste to znovu. Dříve načtená data (jen ke čtení)
        zůstávají dostupná, pokud se appka aspoň jednou úspěšně načetla.</p>
        <button onclick="location.reload()">Zkusit znovu</button>
      </div>
    </body></html>`)
  );
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Globaal Elevate — Účetní systém",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);

  let config;
  try {
    config = loadDesktopConfig();
    mainWindow.loadURL(bootUrl(config));
  } catch (err) {
    console.error("desktop-config:", err.message);
    mainWindow.loadURL(offlineFallbackHtml());
  }

  // Pád načítání (offline, DNS, timeout, ...) — zobrazit srozumitelnou
  // stránku s tlačítkem retry, ne prázdné bílé okno Electronu.
  mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED — typicky vlastní navigace pryč, ne skutečná chyba
    console.error(`did-fail-load: ${errorCode} ${errorDescription} (${validatedURL})`);
    mainWindow.loadURL(offlineFallbackHtml());
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Přeposílá console.log/error z rendereru do hlavního procesu — usnadňuje
  // diagnostiku, protože desktopová appka nemá vždy otevřené DevTools.
  mainWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
