const CACHE_NAME = "news-reader-shell-v2";
const SHELL_FILES = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/newsFilter.js",
  "/articleImage.js",
  "/manifest.json",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.url.includes("/api/")) return;
  // ニュース本体(自前APIやCORSプロキシ経由のRSS)は常に最新を取りに行くため、
  // アプリの見た目を構成する同一オリジンのファイルだけをキャッシュ対象にする
  if (new URL(request.url).origin !== self.location.origin) return;

  // アプリの見た目は更新のたびに変わりうるので、まずネットワークから
  // 最新版を取りに行き、オフライン時のみキャッシュにフォールバックする
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
