// 私人 repo（chaper123/market-data-private）的 ETF 每日持股：在使用者自己的瀏覽器用 GitHub token 讀。
// 統一投信、凱基投信的網站都不允許轉載，所以持股不放公開的 market-data（2026-11-05 使用者決定）。
// token 只存在這台裝置的瀏覽器，只放在 Authorization 標頭送到 api.github.com：不放網址、不寫 console、不送到別的地方；
// service worker 不快取這個網域。建議用 fine-grained token：只選這個 repo、Contents 唯讀。
// 本機開發（localhost?dev）改讀 site/dev-data/private/（不進 git），不用 token。
import { el } from "./fmt.js";
import { IS_DEV } from "./config.js";

const KEY = "github.privateToken";
const API = "https://api.github.com/repos/chaper123/market-data-private/contents/data/";
const TIMEOUT_MS = 20000;
export const PRIVATE_NOTE = "持股資料來自投信網站，僅供本人參考，請勿轉發";

export function getToken() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}
function setToken(v) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
export const hasPrivate = () => IS_DEV || !!getToken();

export class PrivateError extends Error {}

async function fetchPrivate(path) {
  const token = getToken();
  if (!IS_DEV && !token) throw new PrivateError("還沒設定 GitHub token");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = IS_DEV
        ? await fetch(`dev-data/private/${path}`, { cache: "no-store", signal: ctl.signal })
        : await fetch(API + path, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" },
          cache: "no-store", signal: ctl.signal,
        });
    } catch (e) {
      throw new PrivateError(e.name === "AbortError" ? "連線逾時" : "連不上 GitHub（可能離線）");
    }
    if (res.status === 401) throw new PrivateError("token 無效或已過期，請換一個");
    // 沒權限的私人 repo，GitHub 回 404（不說 repo 存在）
    if (res.status === 404) throw new PrivateError("讀不到持股檔：token 可能沒選到 market-data-private，或沒有 Contents 讀取權限");
    if (res.status === 403 || res.status === 429) throw new PrivateError("GitHub 拒絕或查詢太頻繁，稍後再試");
    if (!res.ok) throw new PrivateError(`GitHub 回應 ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 每日持股歷史 CSV（沒有標題列）：日期,代號,名稱,股數,權重 → { dates（舊到新）, by: 日期 → Map(代號 → {...}) }
export function parseHistory(text) {
  const by = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [date, code, name, shares, weight] = line.trim().split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !code) continue;
    if (!by.has(date)) by.set(date, new Map());
    by.get(date).set(code, { code, name, shares: Number(shares), weight: Number(weight) });
  }
  return { dates: [...by.keys()].sort(), by };
}

// 一檔 ETF 的最新持股（JSON）＋歷史。同一次瀏覽只讀一次（重新整理時清掉）
const memo = new Map();
export function loadFund(code) {
  if (!memo.has(code)) {
    const p = Promise.all([fetchPrivate(`holdings/${code}.json`), fetchPrivate(`holdings/${code}_history.csv`)])
      .then(([j, csv]) => ({ doc: JSON.parse(j), hist: parseHistory(csv) }));
    memo.set(code, p);
    p.catch(() => memo.get(code) === p && memo.delete(code));
  }
  return memo.get(code);
}
export function clearPrivate() {
  memo.clear();
}

// 設定欄：輸入、更換、清除 token（畫面只顯示末四碼）。改了之後發出 refresh-request，外殼會重讀資料
export function privateSettings({ open = false } = {}) {
  const box = el("details", { class: "fugle-set", open });
  const draw = () => {
    const token = getToken();
    const input = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "貼上 GitHub token（github_pat_ 開頭）", "aria-label": "GitHub token" });
    const save = el("button", { class: "btn small", type: "button" }, token ? "更換" : "儲存");
    const clear = token && el("button", { class: "btn small", type: "button" }, "清除");
    const msg = el("span", { class: "tiny" });
    save.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) {
        msg.textContent = "請先貼上 token";
        return;
      }
      if (/\s/.test(v)) {
        msg.textContent = "token 不能有空白，請重新複製";
        return;
      }
      msg.textContent = setToken(v) ? "已儲存在這台裝置" : "這個瀏覽器不能儲存（可能是無痕模式）";
      input.value = "";
      clearPrivate();
      draw();
      document.dispatchEvent(new Event("refresh-request"));
    });
    clear?.addEventListener("click", () => {
      setToken(null);
      clearPrivate();
      draw();
      document.dispatchEvent(new Event("refresh-request"));
    });
    box.replaceChildren(
      el("summary", {}, `⚙ GitHub token（讀私人持股）：${token ? `已設定（…${token.slice(-4)}）` : "未設定"}`),
      el("p", { class: "tiny" }, "ETF 每日持股放在你的私人 repo。token 只存在這台裝置的瀏覽器，只送到 GitHub；清除瀏覽器資料就會不見，每台裝置要各設一次。",
        "請用只能讀 market-data-private 的 fine-grained token（Contents 唯讀）。"),
      el("div", { class: "row" }, input, save, clear, msg));
  };
  draw();
  return box;
}
