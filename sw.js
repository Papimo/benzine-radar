// Service worker (alleen statische versie): app werkt offline met de laatst opgehaalde prijzen.
// data/*.json: eerst netwerk, anders cache · eigen bestanden: cache + op de achtergrond verversen ·
// bibliotheken/lettertypen van CDN: cache · routes/adressen/kaarttegels: altijd live (niet gecachet).
const CACHE = "br-v1.1.1";
const SHELL = ["./", "index.html", "style.css", "app.js", "mapstyle.js", "static-api.js", "manifest.webmanifest", "icon.svg", "data/prices.json", "data/stats.json"];
const CDN = ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  const put = (res) => { if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (url.origin === location.origin && url.pathname.includes("/data/")) {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then(put).catch(() => hit);
      return hit || net;
    }));
  } else if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
  }
});
