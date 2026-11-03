// 富果行情（Fugle Market Data API）盤中報價：在使用者自己的瀏覽器查，金鑰只存在這台裝置。
// 證交所 MIS 與富果的條款都不允許把行情放進公開的 market-data，所以不經過 repo（2026-11 使用者決定）。
// 金鑰只放在 X-API-KEY 標頭：不放網址、不寫 console、不送到別的地方；service worker 也不快取這個網域。
// 不自動輪詢（基本用戶每分鐘 60 次）：開頁查一次，另有手動「更新」。
import { el, taipeiToday } from "./fmt.js";

const KEY = "fugle.apiKey";
const BASE = "https://api.fugle.tw/marketdata/v1.0/stock/intraday/quote/";
export const FUGLE_NOTE = "富果行情，僅供本人參考，請勿轉發";
// 網站要查的代號：兩檔 ETF 與加權指數（富果的指數代號 IX0001）
export const FUGLE_SYMBOLS = ["009816", "00981A", "IX0001"];

export function getKey() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}
function setKey(v) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

class FugleError extends Error {}

async function quote(symbol, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    let res;
    try {
      res = await fetch(BASE + encodeURIComponent(symbol), { headers: { "X-API-KEY": key }, cache: "no-store", signal: ctl.signal });
    } catch {
      throw new FugleError("連不上富果");
    }
    if (res.status === 401 || res.status === 403) throw new FugleError("金鑰無效或沒有權限");
    if (res.status === 429) throw new FugleError("查詢太頻繁，稍後再按更新");
    if (!res.ok) throw new FugleError(`富果回應 ${res.status}`);
    const q = await res.json();
    const price = [q.lastPrice, q.closePrice, q.lastTrade?.price].find(Number.isFinite);
    if (!Number.isFinite(price)) throw new FugleError("回應沒有價格");
    // lastUpdated 是微秒
    const t = Number.isFinite(q.lastUpdated) ? new Date(q.lastUpdated / 1000) : null;
    return {
      symbol, name: q.name, date: q.date, price, prev: q.previousClose ?? q.referencePrice,
      change: q.change, changePct: q.changePercent, closed: !!q.isClose, time: t,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 一次查全部代號；每檔各自成功或失敗。沒有金鑰回傳 null
let memo = null;
export function loadFugle() {
  const key = getKey();
  if (!key) return Promise.resolve(null);
  memo ??= Promise.allSettled(FUGLE_SYMBOLS.map((s) => quote(s, key))).then((rs) => {
    const out = { at: new Date(), quotes: {}, errors: {} };
    rs.forEach((r, i) => {
      if (r.status === "fulfilled") out.quotes[FUGLE_SYMBOLS[i]] = r.value;
      else out.errors[FUGLE_SYMBOLS[i]] = r.reason?.message || "查詢失敗";
    });
    return out;
  });
  return memo;
}
export function clearFugle() {
  memo = null;
}

// 今天的富果報價（日期是今天才算；盤前、休市日回傳 null，呼叫端退回前一交易日收盤）
export async function fugleToday(symbol) {
  const f = await loadFugle().catch(() => null);
  const q = f?.quotes?.[symbol];
  return q && q.date === taipeiToday() ? q : null;
}

const hhmm = (t) => (t ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t) : "");
export const quoteTime = (q) => (q.closed ? `今天收盤 ${hhmm(q.time)}` : `今天 ${hhmm(q.time)}`);

// 設定欄：輸入、更換、清除金鑰（畫面只顯示末四碼）。改了之後發出 refresh-request，外殼會重讀資料
export function fugleSettings() {
  const box = el("details", { class: "fugle-set" });
  const draw = () => {
    const key = getKey();
    const input = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "貼上富果 API 金鑰", "aria-label": "富果 API 金鑰" });
    const save = el("button", { class: "btn small", type: "button" }, key ? "更換" : "儲存");
    const clear = key && el("button", { class: "btn small", type: "button" }, "清除");
    const msg = el("span", { class: "tiny" });
    save.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) {
        msg.textContent = "請先貼上金鑰";
        return;
      }
      msg.textContent = setKey(v) ? "已儲存在這台裝置" : "這個瀏覽器不能儲存（可能是無痕模式）";
      input.value = "";
      clearFugle();
      draw();
      document.dispatchEvent(new Event("refresh-request"));
    });
    clear?.addEventListener("click", () => {
      setKey(null);
      clearFugle();
      draw();
      document.dispatchEvent(new Event("refresh-request"));
    });
    box.replaceChildren(
      el("summary", {}, `⚙ 富果金鑰：${key ? `已設定（…${key.slice(-4)}）` : "未設定"}`),
      el("p", { class: "tiny" }, "盤中價用富果行情 API 在你的瀏覽器查。金鑰只存在這台裝置的瀏覽器，只送到富果；清除瀏覽器資料就會不見。"),
      el("div", { class: "row" }, input, save, clear, msg));
  };
  draw();
  return box;
}
