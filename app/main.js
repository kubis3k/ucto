// =====================================================================
// main.js — Electron hlavní proces. Spouští embedded Express server
// (sql.js databáze uložená v uživatelském datovém adresáři, aby přežila
// aktualizace aplikace) a otevírá okno s renderer UI.
// =====================================================================
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const { start } = require("./server/index");

const PORT = 4317;
let mainWindow;
let httpServer;

async function createWindow() {
  const userDataDir = app.getPath("userData");
  httpServer = await start(userDataDir, PORT);

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
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

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
  if (httpServer) httpServer.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Global exposed to preload so renderer knows which port the embedded API uses
global.API_PORT = PORT;
