const CACHE_NAME = "news-reader-shell-v2";
// GitHub Pages はリポジトリ名のサブパス配下に置かれるため、ドメインルート基準の
// 絶対パスにすると全部404になり、addAll が失敗してSWが永久にアクティブにならない。
// Service Worker のスコープ基準で解決される相対パスにしておく。
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./newsFilter.js",
  "./manifest.json",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  // addAll は1つでも取得に失敗すると全体が reject され、インストールごと
  // 失敗する。1ファイルの取りこぼしでオフライン動作全体を落とさないよう、
  // 個別に追加して結果を集計する。
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(SHELL_FILES.map((file) => cache.add(file)));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        console.warn(`[news-reader] ${failed}/${SHELL_FILES.length} 件のキャッシュに失敗しました`);
      }
    })
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
