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
    nextMonthly: num(get("下月定投")),
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

// 定投金額的變更紀錄：[{ ym: "2026-11", amount: 3000 }]，由舊到新。某個月用生效月份不晚於它的最後一列
export const loadDca = () => once("dca", async () => {
  const src = "帳本「定投金額」";
  const rows = parseTable(await fetchText(SOURCES.ledger.dca, src, true));
  const list = rows.map((r) => {
    const m = /^(\d{4})[-/](\d{1,2})/.exec(col(r, "生效月份").trim());
    return m ? { ym: `${m[1]}-${m[2].padStart(2, "0")}`, amount: num(col(r, "每月定投")) } : null;
  }).filter((x) => x && x.amount != null).sort((a, b) => a.ym.localeCompare(b.ym));
  if (!list.length) throw new DataError(src, "沒有讀到定投金額");
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
    settle: num(col(r, "交割金額")), // 原幣、含費（美股是美元）
    inPool: col(r, "計入資金池") === "是",
    note: col(r, "備註"),
    time: col(r, "成交時間"),
    tax: num(col(r, "交易稅")),
    fee: num(col(r, "手續費")),
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

// 新聞分頁的一列 → 物件
const newsRow = (r) => ({
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
});

// 最新資料日裡產生時間最新的那一組（同一天重跑會多一組列）。
// v3 一天兩組（晨間 08:40、午間 11:30）：最新一組是午間時，再補當天較早那組的事件列（同事件ID 以較新的為準）；
// 摘要、重點、今日一句、盤中、話題、紀律、總經總結只用最新一組（NEWS_ROUTINE 第 11、12 節）；情緒、社群、展望、經理人方向只有晨間寫，算事件列。
// 重點列沿用事件列的事件ID，比對重複時不算它們，否則晨間的事件列會被午間的重點蓋掉
const LATEST_ONLY = new Set(["摘要", "重點", "今日一句", "盤中", "話題", "紀律", "總經總結"]);
export function latestNewsGroup(rows) {
  if (!rows.length) return { dataDate: null, generatedAt: null, rows: [] };
  const dataDate = rows.reduce((m, r) => (r.dataDate > m ? r.dataDate : m), "");
  const day = rows.filter((r) => r.dataDate === dataDate);
  const generatedAt = day.reduce((m, r) => (r.generatedAt > m ? r.generatedAt : m), "");
  const latest = day.filter((r) => r.generatedAt === generatedAt);
  const noon = latest.some((r) => r.category === "摘要" && /^午間/.test(r.fact));
  if (!noon) return { dataDate, generatedAt, rows: latest };
  const ids = new Set(latest.filter((r) => !LATEST_ONLY.has(r.category)).map((r) => r.eventId));
  const older = day.filter((r) => r.generatedAt !== generatedAt && !LATEST_ONLY.has(r.category) && r.eventId && !ids.has(r.eventId));
  const newest = new Map();
  for (const r of older) if (!newest.has(r.eventId) || r.generatedAt > newest.get(r.eventId)) newest.set(r.eventId, r.generatedAt);
  return { dataDate, generatedAt, rows: [...latest, ...older.filter((r) => r.generatedAt === newest.get(r.eventId))] };
}

// 正式與測試分頁都讀，取資料日較新的（同一天以清單前面的正式分頁為準）；label 是採用的分頁名稱
export const loadNews = () => once("news", async () => {
  const tabs = SOURCES.dash.news;
  if (!tabs) throw new DataError("儀表板「新聞」", NOT_PUBLISHED);
  const results = await Promise.allSettled(tabs.map(async (t) => latestNewsGroup(
    parseTable(await fetchText(t.url, `儀表板「${t.label}」`, true)).map(newsRow).filter((r) => r.generatedAt && r.dataDate))));
  let best = null;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value.rows.length && (!best || r.value.dataDate > best.dataDate)) best = { ...r.value, label: tabs[i].label };
  });
  if (best) return best;
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  return { dataDate: null, generatedAt: null, rows: [], label: tabs[0].label };
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

// 證交所 MIS 盤中快照、盤中淨值、台指 VIX 已停用（2026-11，條款不允許程式下載後公開）；盤中價改用 js/fugle.js
export const loadCalendar = () => once("calendar", () => fetchJson(md("calendar/calendar.json"), "行事曆"));
export const loadDividends = () => once("dividends", () => fetchJson(md("dividends/tw_etf.json"), "ETF 配息"));
export const loadTopics = () => once("topics", () => fetchJson(md("news/topics.json"), "新聞話題統計"));
export const loadFearGreed = () => once("fg", () => fetchJson(md("sentiment/cnn_fear_greed.json"), "CNN 恐懼貪婪"));
// 新聞標題（第一層，最近 72 小時，約 2 MB；GitHub 傳輸時會壓縮）。格式見 market-data README「新聞標題格式」
export const loadHeadlines = () => once("headlines", () => fetchJson(md("news/headlines.json"), "新聞標題"));
// 國安基金官方新聞稿（財政部「國家金融安定基金訊息」列表，2026-11-06 起）：items[].date、title、link
export const loadNsf = () => once("nsf", () => fetchJson(md("news/nsf.json"), "國安基金新聞稿"));

// 集中市場三大法人買賣差額（元）：date,dealer_self,dealer_hedge,trust,foreign,foreign_dealer,total
export const loadMarketInsti = () => once("market-insti", async () => {
  const out = [];
  for (const r of parseCSV(await fetchText(md("chips/tw_market_insti.csv"), "三大法人"))) {
    const [date, , , trust, foreign, foreignDealer, total] = [r[0], ...r.slice(1, 7).map(Number)];
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && [trust, foreign, total].every(Number.isFinite)) out.push({ date, trust, foreign, foreignDealer, total });
  }
  if (!out.length) throw new DataError("三大法人", "沒有資料");
  return out.sort((a, b) => a.date.localeCompare(b.date));
});

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
export const loadFx = () => loadSeries("fx/usdtwd_mid.csv", "美元兌台幣");

// ETF 每日淨值與收盤折溢價：date,code,nav,close,premium_pct,source（2026-11 起停止更新，呼叫端要檢查日期）
export const loadNavHistory = () => once("navhist", async () => {
  const out = [];
  for (const r of parseCSV(await fetchText(md("tw/nav_history.csv"), "ETF 淨值"))) {
    const prem = Number(r[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[1] && Number.isFinite(prem)) out.push({ date: r[0], code: r[1], nav: Number(r[2]), premium: prem });
  }
  return out;
});

// 指數日線（data/index/）：TAIEX.csv 是 date,open,high,low,close,量,值（7 欄）；TAIEX_TR.csv 是 date,close（2 欄）
export const loadIndex = (name) => once(`index:${name}`, async () => {
  const src = `指數 ${name}`;
  const out = [];
  for (const r of parseCSV(await fetchText(md(`index/${name}.csv`), src))) {
    const v = Number(r.length >= 7 ? r[4] : r[1]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(v)) out.push({ date: r[0], value: v });
  }
  if (!out.length) throw new DataError(src, "沒有資料");
  return out.sort((a, b) => a.date.localeCompare(b.date));
});
