// 讀資料：每個來源各自讀、各自失敗。同一次瀏覽只讀一次（重新整理時清掉）。
import { SOURCES } from "./config.js";
import { parseCSV, parseTable, num } from "./csv.js";

const TIMEOUT_MS = 20000;
const memo = new Map();
const offline = new Map(); // 來源 → 離線時用的快取時間（service worker 給的）

export class DataError extends Error {
  constructor(source, message) {
    super(message);
    this.source = source;
  }
}

function once(key, fn) {
  if (!memo.has(key)) {
    const p = fn();
    memo.set(key, p);
    p.catch(() => memo.get(key) === p && memo.delete(key)); // 失敗的下次重讀
  }
  return memo.get(key);
}

export function clearCache() {
  memo.clear();
  offline.clear();
}
export const offlineSources = () => [...offline.entries()];

async function fetchText(url, source, csv = false) {
  if (!url) throw new DataError(source, "尚未設定資料網址");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, { cache: "no-store", signal: ctl.signal });
    } catch (e) {
      throw new DataError(source, e.name === "AbortError" ? "連線逾時" : "連不上（可能離線或網路被擋）");
    }
    if (!res.ok) throw new DataError(source, `HTTP ${res.status}`);
    if (res.headers.get("x-sw-offline")) offline.set(source, res.headers.get("x-sw-cached-at"));
    const text = await res.text();
    if (csv && /^\s*<(!doctype|html)/i.test(text)) {
      throw new DataError(source, "回傳的是網頁不是 CSV（試算表可能還沒發布）");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, source) {
  const text = await fetchText(url, source);
  try {
    return JSON.parse(text);
  } catch {
    throw new DataError(source, "JSON 格式錯誤");
  }
}

// 依表頭開頭找欄位（表頭有括號說明，例如「股數（券商確認）」）
const col = (row, prefix) => {
  const k = Object.keys(row).find((h) => h.startsWith(prefix));
  return k ? row[k] : "";
};

// ── 共用帳本 ───────────────────────────────────────────

export const loadSettings = () => once("settings", async () => {
  const src = "帳本「設定」";
  const rows = parseCSV(await fetchText(SOURCES.ledger.settings, src, true));
  // 前幾列是標題與說明，用 A 欄的項目名稱找值，不寫死列號
  const get = (name) => {
    const r = rows.find((x) => (x[0] || "").trim().startsWith(name));
    return r ? (r[1] || "").trim() : null;
  };
  const s = {
    pool: num(get("可用資金")),
    monthly: num(get("每月入金")),
    nextDeposit: get("下一次入金日"),
    lastBuy: get("最近一次買入日"),
    capTw: get("台股單次上限"),
    capUs: get("美股單次上限"),
  };
  if (s.pool == null) throw new DataError(src, "找不到「可用資金」這一列");
  return s;
});

export const loadHoldings = () => once("holdings", async () => {
  const src = "帳本「持倉」";
  const rows = parseTable(await fetchText(SOURCES.ledger.holdings, src, true));
  const list = rows.map((r) => ({
    market: col(r, "市場") === "美股" ? "us" : "tw",
    code: col(r, "代號"),
    name: col(r, "名稱"),
    shares: num(col(r, "股數（券商")),
    cost: num(col(r, "總成本")),
    currency: col(r, "幣別"),
    avg: num(col(r, "平均成本")),
    confirmed: col(r, "確認日"),
  })).filter((h) => h.code && h.shares > 0);
  if (!list.length) throw new DataError(src, "沒有讀到任何持倉列");
  return list;
});

export const loadTrades = () => once("trades", async () => {
  const src = "帳本「交易紀錄」";
  const rows = parseTable(await fetchText(SOURCES.ledger.trades, src, true));
  return rows.map((r) => ({
    date: col(r, "日期"),
    market: col(r, "市場") === "美股" ? "us" : "tw",
    code: col(r, "代號"),
    side: col(r, "買賣"),
    shares: num(col(r, "股數")),
    price: num(col(r, "成交價")),
    currency: col(r, "幣別"),
    twd: num(col(r, "台幣金額")),
    inPool: col(r, "計入資金池") === "是",
    note: col(r, "備註"),
  })).filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date) && t.code);
});

// ── 儀表板資料（排程寫入） ─────────────────────────────

const NOT_PUBLISHED = "「投資儀表板資料」試算表還沒發布到網路";

export const loadArchive = () => once("archive", async () => {
  const src = "儀表板「報告存檔」";
  if (!SOURCES.dash.archive) throw new DataError(src, NOT_PUBLISHED);
  const rows = parseTable(await fetchText(SOURCES.dash.archive, src, true));
  return rows.map((r) => {
    let json = null, jsonError = null;
    try {
      json = JSON.parse(col(r, "精簡JSON"));
    } catch {
      jsonError = "精簡 JSON 無法解析";
    }
    return {
      generatedAt: col(r, "產生時間"),
      market: col(r, "市場"),
      dataDate: col(r, "資料日"),
      engine: col(r, "engine"),
      pool: num(col(r, "可用資金")),
      cap: num(col(r, "本次上限")),
      total: num(col(r, "規則參考合計")),
      json,
      jsonError,
      report: col(r, "報告全文"),
    };
  }).filter((r) => r.generatedAt && r.market).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
});

// 每個市場最新一次：資料日最新，同一資料日取產生時間最新（重跑會多一組列）
export function latestRun(archive, market) {
  let best = null;
  for (const r of archive) {
    if (r.market !== market || !r.json) continue;
    if (!best || r.dataDate > best.dataDate || (r.dataDate === best.dataDate && r.generatedAt > best.generatedAt)) best = r;
  }
  return best;
}

// 報告裡的「**一句話**：…」
export function oneLiner(report) {
  const m = /\*\*一句話\*\*\s*[：:]\s*(.+)/.exec(report || "");
  return m ? m[1].replace(/\*\*/g, "").trim() : null;
}

export const loadNews = () => once("news", async () => {
  const src = "儀表板「新聞」";
  if (!SOURCES.dash.news) throw new DataError(src, NOT_PUBLISHED);
  const rows = parseTable(await fetchText(SOURCES.dash.news, src, true)).map((r) => ({
    generatedAt: col(r, "產生時間"),
    dataDate: col(r, "資料日"),
    category: col(r, "類別"),
    market: col(r, "市場"),
    symbol: col(r, "標的"),
    eventId: col(r, "事件ID"),
    eventTime: col(r, "事件時間"),
    source: col(r, "來源"),
    tier: num(col(r, "等級")),
    verify: col(r, "查證"),
    url: col(r, "原文網址"),
    fact: col(r, "事實"),
    impact: col(r, "影響"),
    flag: col(r, "建議旗標") || "none",
    reason: col(r, "理由"),
    related: col(r, "其他相關標的"),
  })).filter((r) => r.generatedAt && r.dataDate);
  if (!rows.length) return { dataDate: null, generatedAt: null, rows: [] };
  // 最新資料日裡產生時間最新的那一組
  const dataDate = rows.reduce((m, r) => (r.dataDate > m ? r.dataDate : m), "");
  const generatedAt = rows.filter((r) => r.dataDate === dataDate).reduce((m, r) => (r.generatedAt > m ? r.generatedAt : m), "");
  return { dataDate, generatedAt, rows: rows.filter((r) => r.dataDate === dataDate && r.generatedAt === generatedAt) };
});

// ── market-data ───────────────────────────────────────

const md = (path) => SOURCES.market + path;

export const loadMeta = () => once("meta", () => fetchJson(md("meta.json"), "market-data meta.json"));

// 日線：date,volume,open,high,low,close（無表頭）
export const loadDaily = (market, code) => once(`daily:${market}:${code}`, async () => {
  const path = market === "us" ? `us/${code}.csv` : `tw/${code}_norm.csv`;
  const src = `${code} 日線`;
  const bars = [];
  for (const r of parseCSV(await fetchText(md(path), src))) {
    // Yahoo 的歷史價有浮點雜訊（686.2899780273438），四捨五入到 4 位
    const [time, volume, open, high, low, close] = [r[0], ...r.slice(1, 6).map((x) => Math.round(Number(x) * 1e4) / 1e4)];
    if (/^\d{4}-\d{2}-\d{2}$/.test(time) && [open, high, low, close].every(Number.isFinite)) {
      bars.push({ time, open, high, low, close, volume });
    }
  }
  if (!bars.length) throw new DataError(src, "沒有可用的 K 棒");
  bars.sort((a, b) => a.time.localeCompare(b.time));
  return bars;
});

export const loadIntraday = () => once("intraday", () => fetchJson(md("tw/intraday.json"), "台股盤中快照"));
export const loadFearGreed = () => once("fg", () => fetchJson(md("sentiment/cnn_fear_greed.json"), "CNN 恐懼貪婪"));

// 兩欄（date,value[,…]）的逐日序列
const loadSeries = (path, src) => once(`series:${path}`, async () => {
  const out = [];
  for (const r of parseCSV(await fetchText(md(path), src))) {
    const v = Number(r[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(v)) out.push({ date: r[0], value: v, extra: r[2] });
  }
  if (!out.length) throw new DataError(src, "沒有資料");
  return out;
});
export const loadFearGreedHistory = () => loadSeries("sentiment/cnn_fear_greed.csv", "恐懼貪婪歷史");
export const loadVix = () => loadSeries("sentiment/taifex_vix.csv", "台指 VIX");
export const loadFx = () => loadSeries("fx/usdtwd_mid.csv", "美元兌台幣");
