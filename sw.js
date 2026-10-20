// 天窗离线外壳：页面与脚本先走网络，断网时用缓存
const C = "tianchuang-v6";
const SHELL = ["./", "index.html", "app.js", "vendor/nostr.bundle.js", "vendor/i18n.js", "vendor/marked.min.js", "vendor/purify.min.js", "vendor/qrcode.js", "vendor/jsQR.js", "manifest.webmanifest", "icons/apple-touch-icon.png", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request).then((r) => r || caches.match("index.html"))));
});
