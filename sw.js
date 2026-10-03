// Minimal service worker — makes Plate installable and loads the shell fast.
// Network-first so you always get the latest app; falls back to cache offline.
const CACHE = "plate-v5";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never cache API or auth calls.
  if (url.pathname.startsWith("/api/") || url.host.includes("supabase") || url.host.includes("anthropic")) return;
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then((res) => {
      // Only keep good answers: caching a 404 or a server error would replace
      // the working copy the app falls back to offline. (Cross-origin library
      // files come back "opaque" with status 0; they are kept as before.)
      if (res.ok || res.type === "opaque") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});
