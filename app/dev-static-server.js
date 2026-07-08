// Miniaturní statický server bez závislostí — slouží jen k ručnímu
// prohlížení renderer/ UI v běžném prohlížeči během vývoje (mimo Electron).
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "renderer");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

http.createServer((req, res) => {
  const filePath = path.join(ROOT, req.url === "/" ? "index.html" : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "text/plain" });
    res.end(data);
  });
}).listen(5173, () => console.log("Dev preview renderer na http://localhost:5173"));
