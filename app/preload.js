const { contextBridge } = require("electron");

// Renderer běží izolovaně (contextIsolation) a nemá přístup k Node.js API.
// Jediné, co potřebuje, je vědět, na jakém portu běží embedded Express server.
contextBridge.exposeInMainWorld("ucetnictvi", {
  apiBase: "http://127.0.0.1:4317/api",
});
