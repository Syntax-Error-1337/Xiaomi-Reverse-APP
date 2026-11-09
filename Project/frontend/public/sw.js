// pressid-sw v2 — cycle 41: bump CACHE to evict pre-cycle-39 stale shell (cache-first
// served old index.html otherwise). install skipWaiting + activate clients.claim +
// purge of non-matching caches keep deploys safe; /api passthrough + navigation
// fallback to cached index.html intact.
const CACHE = "pressid-v2";
const SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api")) return; // network passthrough, no intercept
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit;
      return fetch(event.request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      }).catch(() => {
        if (event.request.mode === "navigate") return caches.match("/index.html");
        throw new Error("offline");
      });
    })
  );
});
