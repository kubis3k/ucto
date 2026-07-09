// =====================================================================
// sw.js — Service Worker pro tenký klient (Varianta A, 2026-07-09).
// Web (Vercel) je JEDINÝ zdroj pravdy — appka nikdy nezapisuje offline.
// Tento SW dělá dvě věci:
//   1. GET /api/*  — network-first, úspěšnou odpověď uloží do cache.
//      Offline (fetch selže) → vrátí poslední uloženou odpověď, pokud
//      existuje (= "read-only cache poslední stažená data"). Bez cache
//      → chyba proletí normálně (žádné tiché prázdno).
//   2. Appka samotná (/, /app.js, /style.css) — cache-first (rychlejší
//      start), na pozadí se pokusí obnovit z sítě pro příště.
// VŠECHNY ostatní requesty (zejména POST/PUT/PATCH/DELETE — zápisy) se
// NEDOTÝKAJÍ — jde přímo network, offline = normální chyba fetch(), ŽÁDNÉ
// tiché fronty/outbox. To je záměr Varianty A, ne opomenutí.
// =====================================================================
const SHELL_CACHE = "ucto-shell-v1";
const API_CACHE = "ucto-api-v1";
const SHELL_FILES = ["/", "/app.js", "/style.css"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // zápisy: netrhat se do toho, network napřímo

  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(API_CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || Promise.reject(new Error("offline, žádná cache"))))
    );
    return;
  }

  if (SHELL_FILES.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
