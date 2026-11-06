// 持股新聞（不經 AI）：market-data 第一層的 Google News／中央社標題，依持股分頁籤、照時間排。
// 預設（嚴格）：台股持股要標題提到；美股、大盤、總經只列主要媒體（Tier 1～2）。寬鬆：查詢找到的全部。
// 新聞頁 v4（docs/PROGRESS.md 第 12 項）。標題一律以純文字放進頁面，連結只接受 http/https（呼叫端用 extLink）。

// 標題比對用的名稱（market-data config.json 的查詢 id → 標題裡可能出現的寫法）
export const ALIAS = {
  "00981A": ["00981A", "統一台股增長", "瑤池金母"],
  "009816": ["009816", "凱基台灣TOP50", "TOP50"],
  GOOGL: ["Alphabet", "Google", "GOOGL"],
  MARKET: ["S&P 500", "VOO", "標普"],
};
// 查詢 id → 顯示的持股代號
const HOLD_OF = { "00981A": "00981A", "009816": "009816", GOOGL: "GOOGL", MARKET: "VOO" };
const MACRO_Q = ["FED", "TARIFF", "CHIPS", "TAIWAN"];
const MACRO_T = ["fed", "cpi", "jobs", "oil", "war", "tariff"];

const has = (x, q) => (x.queries || []).includes(q);
export const inTitle = (x, q) => (ALIAS[q] || [q]).some((a) => x.title.includes(a));
const major = (x) => x.tier <= 2;

// 分頁籤：[名稱, (標題, 寬鬆) → 要不要列]
export const TABS = [
  ["全部持股", (x, loose) => TABS[1][1](x, loose) || TABS[2][1](x, loose) || TABS[4][1](x, loose) || TABS[5][1](x, loose)],
  ["00981A", (x, loose) => has(x, "00981A") && (loose || inTitle(x, "00981A"))],
  ["009816", (x, loose) => has(x, "009816") && (loose || inTitle(x, "009816"))],
  ["台股大盤", (x, loose) => (has(x, "TWSE") || has(x, "2330")) && (loose || major(x))],
  ["VOO", (x, loose) => has(x, "MARKET") && (loose || (major(x) && inTitle(x, "MARKET")))],
  ["GOOGL", (x, loose) => has(x, "GOOGL") && (loose || (major(x) && inTitle(x, "GOOGL")))],
  ["國安基金", (x, loose) => has(x, "NSF") && (loose || major(x))],
  ["總經", (x, loose) => (MACRO_Q.some((q) => has(x, q)) || (x.topics || []).some((t) => MACRO_T.includes(t))) && (loose || major(x))],
];

// 這則跟哪些持股有關：[代號, 標題有沒有提到]
export const holdTags = (x) => Object.entries(HOLD_OF).filter(([q]) => has(x, q)).map(([q, c]) => [c, inTitle(x, q)]);

export const timeOf = (x) => Date.parse(`${x.published_taipei.replace(" ", "T")}:00+08:00`);

export function ago(t, now = Date.now()) {
  const m = Math.round((now - t) / 60000);
  return m < 60 ? `${Math.max(1, m)} 分鐘前` : m < 24 * 60 ? `${Math.round(m / 60)} 小時前` : `${Math.round(m / 1440)} 天前`;
}

// 新的在前；沒有時間的不列
export const sortItems = (items) => items.filter((x) => x.published_taipei && x.title)
  .sort((a, b) => b.published_taipei.localeCompare(a.published_taipei));

// 國安基金與政府護盤：標題提到的、官方或主要媒體（Tier 1～2）。「國家隊」也可能是運動新聞，只認台股相關查詢找到的
const NSF_WORDS = ["國安基金", "國家金融安定基金", "護盤", "救市", "限空", "公股行庫", "八大行庫", "國家隊"];
const TW_Q = ["NSF", "TWSE", "2330", "009816", "00981A"];
export const nsfNews = (items) => items.filter((x) => x.tier <= 2 && TW_Q.some((q) => has(x, q))
  && NSF_WORDS.some((w) => x.title.includes(w)));

// 國安基金現在有沒有在護盤：只看財政部新聞稿與主要媒體標題的明確用語，不推測。
// official：財政部公告（讀不到時傳 null）；media：nsfNews 篩過的主要媒體標題（新到舊）。
// 回傳 state：active 已決定進場（含「繼續／持續執行」）、considering 有消息但還沒正式決定、
// stopped 已停止、none 沒有進場公告、unknown 讀不到公告；另附依據 {date, title, link, by, media}
const OFFICIAL_RULES = [["stopped", /停止|結束|退場/], ["active", /啟動|繼續執行|持續執行/], ["considering", /不排除|臨時委員會/]];
const MEDIA_ACTIVE = /(決議|決定|宣布|拍板|啟動).{0,8}(進場|護盤|安定市場)/;
const MEDIA_CONSIDER = /不排除|臨時會|臨時委員會/;
const MEDIA_STOP = /停止|退場|結束/;
const fromMedia = (xs) => ({ date: xs[0].published_taipei.slice(0, 10), title: xs[0].title, link: xs[0].url || xs[0].link,
  by: [...new Set(xs.map((x) => x.source))].slice(0, 3).join("、"), media: true });

export function nsfStatus(official, media, today, now = Date.now()) {
  const age = (d) => (Date.parse(today) - Date.parse(d)) / 864e5;
  let st = { state: official ? "none" : "unknown" };
  for (const x of [...(official || [])].sort((a, b) => b.date.localeCompare(a.date))) {
    const hit = OFFICIAL_RULES.find(([, re]) => re.test(x.title));
    if (!hit || (hit[0] === "considering" && age(x.date) > 14)) continue;
    st = { state: hit[0], date: x.date, title: x.title, link: x.link, by: "財政部" };
    break;
  }
  if (st.state === "active") return st;
  // 比官方最後一次表態新、48 小時內的主要媒體標題
  const recent = media.filter((x) => now - timeOf(x) < 48 * 3600e3 && !MEDIA_STOP.test(x.title)
    && (!st.date || x.published_taipei.slice(0, 10) >= st.date));
  const act = recent.filter((x) => MEDIA_ACTIVE.test(x.title));
  // 兩家以上主要媒體都報已決議才算「會」；只有一家先算「未定」
  if (new Set(act.map((x) => x.source)).size >= 2) return { state: "active", ...fromMedia(act) };
  const con = act.length ? act : recent.filter((x) => MEDIA_CONSIDER.test(x.title));
  if (con.length && st.state !== "considering") return { state: "considering", ...fromMedia(con) };
  return st;
}

// 多家媒體都在報：最近 36 小時、跟持股或台股有關、不只一家報導，依報導家數
export function hotList(items, now = Date.now(), n = 8) {
  return items.filter((x) => x.also?.length && now - timeOf(x) < 36 * 3600e3
    && (TABS[0][1](x, false) || has(x, "TWSE") || has(x, "2330")))
    .sort((a, b) => b.also.length - a.also.length || b.published_taipei.localeCompare(a.published_taipei)).slice(0, n);
}
