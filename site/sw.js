// Service worker：離線也看得到上次成功讀取的資料。
// - 網站本身：先連網，失敗才用快取（部署新版後立刻生效）
// - CDN 函式庫（網址有固定版本）：先用快取
// - 資料（market-data、Google Sheet）：先連網（8 秒逾時），成功就存一份並記下時間；失敗時回快取，
//   加上 x-sw-offline 標頭，頁面據此顯示「顯示上次成功讀取的資料」
const VERSION = "2026-10-29";
const SHELL = `shell-${VERSION}`;
const LIBS = "libs-v1";
const DATA = "data-v1";
const NET_TIMEOUT_MS = 8000;

const SHELL_FILES = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/app.js", "js/config.js", "js/csv.js", "js/data.js", "js/fmt.js", "js/gauge.js", "js/news.js", "js/portfolio.js", "js/ui.js",
  "js/pages/overview.js", "js/pages/plan.js", "js/pages/holdings.js", "js/pages/news.js", "js/pages/reports.js",
  "js/pages/charts.js", "js/pages/chain.js",
  "icons/icon.svg", "icons/icon-192.png",
];
const LIB_FILES = [
  "https://cdn.jsdelivr.net/npm/dompurify@3.4.17/dist/purify.min.js",
  "https://cdn.jsdelivr.net/npm/marked@18.1.1/lib/marked.umd.js",
  "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js",
];
const DATA_HOSTS = ["raw.githubusercontent.com", "docs.google.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    const libs = await caches.open(LIBS);
    // 函式庫預先快取失敗不影響安裝（第一次用到時還會再存）
    await Promise.allSettled(LIB_FILES.map((u) => libs.add(new Request(u, { mode: "cors" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("shell-") && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes("/dev-data/")) return;
    event.respondWith(shell(req));
  } else if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(lib(req));
  } else if (DATA_HOSTS.includes(url.hostname) || url.hostname.endsWith(".googleusercontent.com")) {
    event.respondWith(data(req));
  }
});

async function shell(req) {
  const cache = await caches.open(SHELL);
  try {
    // 每次都向伺服器確認（GitHub Pages 給 max-age=600，不確認的話部署後最多 10 分鐘還是舊檔）
    const fresh = req.mode === "navigate"
      ? new Request(req.url, { cache: "no-cache", credentials: "same-origin" })
      : new Request(req, { cache: "no-cache" });
    const res = await fetch(fresh);
    if (res.ok && res.type === "basic") cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === "navigate" && ((await cache.match("index.html")) || (await cache.match("./"))));
    if (hit) return hit;
    throw e;
  }
}

async function lib(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "cors") cache.put(req, res.clone());
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function copyWith(res, extra) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
}

async function data(req) {
  const cache = await caches.open(DATA);
  try {
    const res = await withTimeout(fetch(req), NET_TIMEOUT_MS);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (res.ok) cache.put(req.url, await copyWith(res, { "x-sw-cached-at": new Date().toISOString() }));
    return res;
  } catch (e) {
    const hit = await cache.match(req.url);
    if (hit) return copyWith(hit, { "x-sw-offline": "1" });
    throw e;
  }
}
