// Service worker: caches the app shell for full offline use. GitHub API traffic is never cached here.
const CACHE = "bossboard-v3-3.0.1";
const SHELL = ["./", "index.html", "css/style.css", "js/app.js", "js/core.js", "js/sync.js", "js/github.js", "js/store.js",
  "manifest.json", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("bossboard-v3-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;  // api.github.com etc.: straight to network
  // stale-while-revalidate for the shell: instant offline start, picks up new deploys on the next load
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net; if (r) return r;
    if (e.request.mode === "navigate") return (await c.match("index.html")) || Response.error();
    return Response.error();
  }));
});
