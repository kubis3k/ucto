// Tenký klient (Varianta A, 2026-07-09): appka se teď načítá přímo z webové
// domény (main.js loadURL), takže "/api" je SAME-ORIGIN — index.html si ho
// spočítá sám (viz inline bootstrap skript), preload nemá co přepisovat.
//
// Část B (electron-updater, 2026-07-10): jediné, co preload teď dělá, je
// vystavit web stránce (app.js) můstek k nativní aktualizaci Electron shellu.
// V browseru (web verze appky) `window.desktopUpdater` neexistuje — app.js
// to musí ověřit před použitím.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUpdater", {
  onReady: (cb) => ipcRenderer.on("update-ready", () => cb()),
  restart: () => ipcRenderer.send("restart-and-install"),
});
