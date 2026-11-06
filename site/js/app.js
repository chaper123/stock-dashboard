// 外殼：分頁切換（#/overview…）、重新整理、深淺色、離線提示、service worker。
import { clearCache, offlineSources } from "./data.js";
import { clearFugle } from "./fugle.js";
import { clearPrivate } from "./private.js";
import { IS_DEV } from "./config.js";
import { el, taipeiTime } from "./fmt.js";
import { loading, errorBox } from "./ui.js";

const ROUTES = {
  overview: { title: "總覽", load: () => import("./pages/overview.js") },
  holdings: { title: "持倉", load: () => import("./pages/holdings.js") },
  record: { title: "記帳", load: () => import("./pages/record.js") },
  funds: { title: "資金", load: () => import("./pages/funds.js") },
  news: { title: "新聞", load: () => import("./pages/news.js") },
  reports: { title: "報告歷史", load: () => import("./pages/reports.js") },
  charts: { title: "K 線", load: () => import("./pages/charts.js") },
};

const view = document.getElementById("view");
const banner = document.getElementById("banner");
let seq = 0;

async function route() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  const key = ROUTES[name] ? name : "overview";
  const arg = decodeURIComponent(rest.join("/"));
  for (const a of document.querySelectorAll("nav.tabs a")) {
    if (a.dataset.route === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.title = `${ROUTES[key].title}｜股票儀表板`;
  const token = ++seq;
  view.replaceChildren(loading());
  try {
    const mod = await ROUTES[key].load();
    if (token !== seq) return;
    view.replaceChildren();
    await mod.render(view, { arg, alive: () => token === seq });
  } catch (e) {
    console.error(e);
    if (token === seq) view.replaceChildren(errorBox(e, route));
  }
  updateBanner();
}

function updateBanner() {
  const parts = [];
  if (IS_DEV) parts.push("本機測試：儀表板資料讀 site/dev-data/（不是線上資料）");
  if (!navigator.onLine) parts.push("目前離線");
  const off = offlineSources();
  if (off.length) {
    const at = off.map(([, t]) => t).filter(Boolean).sort()[0];
    parts.push(`顯示上次成功讀取的資料${at ? `（${taipeiTime(at)}）` : ""}：${off.map(([s]) => s).join("、")}`);
  }
  banner.hidden = !parts.length;
  banner.replaceChildren(...parts.map((p) => el("div", {}, p)));
}

// 深淺色：跟系統 → 深色 → 淺色
const THEMES = ["auto", "dark", "light"];
const THEME_LABEL = { auto: "跟系統", dark: "深色", light: "淺色" };
function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    return null;
  }
}
function applyTheme(t) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = document.getElementById("theme");
  btn.textContent = `◐ ${THEME_LABEL[t]}`;
  btn.setAttribute("aria-label", `配色：${THEME_LABEL[t]}（點一下切換）`);
  document.dispatchEvent(new Event("themechange"));
}
let theme = THEMES.includes(store("theme")) ? store("theme") : "auto";
applyTheme(theme);
document.getElementById("theme").addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  store("theme", theme);
  applyTheme(theme);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => document.dispatchEvent(new Event("themechange")));

function refresh() {
  clearCache();
  clearFugle();
  clearPrivate();
  route();
}
document.getElementById("refresh").addEventListener("click", refresh);
document.addEventListener("refresh-request", refresh);
window.addEventListener("hashchange", route);
window.addEventListener("online", updateBanner);
window.addEventListener("offline", updateBanner);
document.addEventListener("data-settled", updateBanner);

// 回到最上面：往下捲超過一個畫面才出現（每一頁都有）
const toTop = el("button", { class: "to-top", type: "button", "aria-label": "回到最上面", title: "回到最上面", hidden: true }, "↑ 頂端");
toTop.addEventListener("click", () => {
  scrollTo({ top: 0 });
  document.querySelector("main")?.focus({ preventScroll: true });
});
document.body.append(toTop);
const updateToTop = () => { toTop.hidden = scrollY < 400; };
window.addEventListener("scroll", updateToTop, { passive: true });
window.addEventListener("hashchange", updateToTop);

if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("nosw")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

route();
