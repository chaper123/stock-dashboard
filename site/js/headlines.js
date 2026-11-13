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

// ── R15 新聞去噪（docs/R15_R18.md）：VOO 的新聞分三類，只看標題與既有欄位，不經 AI。
//   market 大盤事件（講美股大盤、S&P 500、總經）；peer 別的標的（標題主角是別檔 ETF 或個股）；advice 理財與預測文。
//   判斷不出來的一律 market：寧可多顯示，不要誤藏。peer 先於 advice 檢查（標題主角是別檔 ETF 時，不管它在賣什麼都算別的標的）。
export const VOO_KIND_LABEL = { peer: "別的標的", advice: "理財與預測文" };

// VOO 自己的寫法：標題有這些就不算 peer（「Vanguard S&P 500 ETF」「VOO」是 VOO 本人，Vanguard 500 Index 是同一檔的另一種寫法）
const VOO_SELF = /\bVOO\b|Vanguard\s+(?:S&P\s*500|500\s+Index)/i;

// 括號或交易所前綴裡的代號：「(SPY)」「(NYSEARCA:IVV)」「(SPY.US)」。VOO、總經縮寫、指數代號不算
const TICKER_PAREN = /\(\s*(?:[A-Z]{3,10}\s*:\s*)?\$?([A-Z]{2,5})(?:\.[A-Z]{1,2})?\s*\)/g;
const TICKER_PREFIX = /\b(?:NYSEARCA|NYSEAMERICAN|NYSE|NASDAQ|BATS|AMEX|CBOE)\s*:\s*([A-Z]{1,5})\b/g;
const NOT_TICKER = new Set(["VOO", "SPX", "GSPC", "DJI", "DJIA", "IXIC", "NDX", "VIX", // 指數與波動率
  "CPI", "PCE", "PPI", "GDP", "PMI", "ISM", "NFP", "FOMC", "FED", "SEC", "FDA", "FTC", "DOJ", // 總經與機構縮寫
  "OPEC", "NATO", "WTO", "IMF", "ECB", "BOJ", "BOE", "PBOC",
  "AI", "US", "UK", "EU", "EV", "ETF", "IPO", "CEO", "CFO", "USD", "EUR", "JPY", "CNY", "TWD", // 常見縮寫與幣別
  "AP", "WSJ", "CNBC", "BBC"]); // 通訊社與媒體的署名
// 盤勢快報的版型（期貨、盤前、Stock Market Today）：括號裡的代號只是順帶點名的個股，整則還是大盤，不算 peer
const MARKET_REPORT = /\bfutures\b|\bpremarket\b|\bstock market (?:today|midday|news)\b|\bmarkets? (?:live|wrap)\b/i;
// 別家 ETF 的發行商品牌：SPDR、iShares、Invesco、ProShares、Direxion 等
const PEER_BRAND = /\b(?:SPDR|iShares|Invesco|ProShares|Direxion|WisdomTree|VanEck|Global X|First Trust|Roundhill|YieldMax|Defiance)\b/i;
// 別檔 Vanguard 基金：「Vanguard ETF」「Vanguard Index Funds」（VOO 自己的寫法在 VOO_SELF 先排除了）
const OTHER_VANGUARD = /\bVanguard\b(?:\s+[\w&.-]+){0,4}?\s+(?:ETFs?|Index Funds?|Funds?)\b/i;
// 機構買賣的例行稿句型：「Shares Sold by」「Acquires New Stake in」「Boosts Position in」「Buys $15.2 Million More Apple」「What … Bought」
const FILING = [
  /\bShares?\s+(?:Sold|Bought|Purchased|Acquired)\s+by\b/i,
  /\b(?:Acquires?|Buys|Purchases?|Sells|Sold|Trims?|Boosts?|Raises?|Lowers?|Cuts?|Lifts?|Increases?|Decreases?|Reduces?|Adds?|Grows?|Takes|Opens)\b.{0,30}\b(?:Stake|Position|Holdings?)\s+(?:in|of)\b/i,
  /\b(?:Purchases?|Buys|Sells|Sold|Acquires?|Bought)\b.{0,25}\bShares of\b/i,
  /\bShares of\b.{0,80}\b(?:Bought|Sold|Purchased|Acquired)\b/i,
  /\b(?:Buys|Sells|Adds|Trims)\s+\$[\d.,]+\s*(?:Million|Billion|M|B)\b/i,
  /\bWhat\b.{0,60}\b(?:Bought|Sold|Buys|Sells):/i,
];
// 「別的 ETF 勝過 S&P 500」的比較稿：動詞緊接 S&P 500，而且標題有 ETF／基金。
// 只認 ETF 與基金：「Nasdaq 勝過 S&P 500」「平均個股勝過 S&P 500」「歐股勝過 S&P 500」是在講大盤，不能收起來
const BEATS_INDEX = /\b(?:beat(?:s|ing)?|outperform(?:s|ed|ing)?|outpac(?:e|es|ed|ing)|crush(?:es|ed|ing)?|obliterat(?:e|es|ed|ing)|trounc(?:e|es|ed|ing))\s+(?:the\s+)?S&P\s*500\b|\bS&P\s*500\s+a\s+run\s+for\s+its\s+money/i;
const ETF_OR_FUND = /\b(?:ETFs?|funds?)\b/i;
// 台灣 ETF 代號（00646、00929…）：別檔 ETF；使用者自己的 009816、00981A 不算
const TW_ETF_CODE = /\b00\d{3,4}[A-Z]?\b/g;
const OWN_ETF = new Set(["009816", "00981A"]);

const codesOf = (t, re) => [...t.matchAll(re)].map((m) => m[1] ?? m[0]);

function isPeer(t) {
  if (VOO_SELF.test(t)) return false;
  const tickers = [...codesOf(t, TICKER_PAREN), ...codesOf(t, TICKER_PREFIX)].filter((c) => !NOT_TICKER.has(c));
  if (tickers.length && !MARKET_REPORT.test(t)) return true;
  if (PEER_BRAND.test(t) || OTHER_VANGUARD.test(t) || FILING.some((re) => re.test(t))) return true;
  if (BEATS_INDEX.test(t) && ETF_OR_FUND.test(t)) return true;
  return codesOf(t, TW_ETF_CODE).some((c) => !OWN_ETF.has(c));
}

// 理財與預測文（英文）：每一條抓一種句型
const ADVICE_EN = [
  // 該不該買：「Stocks to Buy」「Time to Buy」「Buy Now」「a Buy」「Should You Buy」「Top Pick」「must-buy」（單獨的「to buy」可能是併購新聞，不算）
  /\b(?:(?:stocks?|etfs?|funds?)\s+to\s+(?:buy|own|hold)|time to (?:buy|sell|invest)|buy now|buy and hold|a (?:strong |good |top )?buy|should (?:you|i|investors) (?:buy|invest|sell|own|hold)|worth (?:buying|owning)|top picks?|must[- ](?:buys?|own))\b/i,
  // 幾檔最佳：「Best … ETFs」
  /\bbest\b.{0,30}\b(?:etfs?|stocks?|funds?|investments?)\b/i,
  // 目標價與預測：「Price Target」「Stock Forecast」「target at 8,900」「year-end target」「Prediction:」
  /\bprice targets?\b|\b(?:stock|price)\s+(?:forecast|prediction)s?\b|\btargets?\s+(?:at|of|to)\s+[\d$]|\b(?:year-?end|end-20\d\d)\s+(?:S&P\s*500\s+)?targets?\b|\bprediction:/i,
  // 歷史告訴我們：「History Says／Points to」「Historically」「Here's What (Usually) Followed」
  /\bhistory\s+(?:says|shows|suggests|tells|repeats|points|favou?rs|warns|hints|teaches)\b|\bhistorically\b|\bhere['’]?s what (?:usually |typically |has |have )?(?:happened|followed|came|happens|comes)\b/i,
  // 退休與被動收入：「401(k)」「IRA」「Roth」「retirement」「passive income」
  /401\(k\)|\b(?:IRAs?|Roth|retire(?:es?|ment|d)?|passive income|nest egg|social security)\b/i,
  // 教你怎麼做：「your portfolio」「protect your」「3 Ways to」「1 Investing Step」「How Investors Can Prepare」
  /\b(?:your (?:portfolio|savings|retirement|money)|protect (?:your|his|her)|how (?:to|investors can|you can)\s+(?:\w+\s+){0,2}(?:invest|prepare|protect|profit|build|save|retire)|\d+\s+(?:\w+\s+){0,2}(?:ways?|steps?|moves?|tips?|mistakes?))\b/i,
];
// 理財與預測文（中文）：該不該買、推薦、存股、退休、被動收入、目標價與預測、歷史怎麼說
const ADVICE_ZH = /該不該買|不該買|該買|值不值得|值得(?:買|投資|入手)|要不要買|必買|買什麼|買哪|怎麼買|推薦|存股|定期定額|退休|被動收入|目標價|預測|歷史(?:告訴|顯示|證明|上)/;
// 標題提到「明年以後」的年份：「in 2027」「for 2027」「by June 2027」「end-2027」是在講未來的預測，不是現在發生的事
const FUTURE_YEAR = /(?:\b(?:in|for|by|through|until)\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+)?|\bend-|\byear-end\s+)(20\d\d)\b/gi;
const futureYear = (x) => {
  const now = Number((x.published_taipei || "").slice(0, 4));
  return now > 0 && [...x.title.matchAll(FUTURE_YEAR)].some((m) => Number(m[1]) > now);
};

export function vooKind(x) {
  const t = x.title || "";
  if (isPeer(t)) return "peer";
  if (ADVICE_EN.some((re) => re.test(t)) || ADVICE_ZH.test(t) || futureYear(x)) return "advice";
  return "market";
}

// 這則在這個分頁裡算哪一類，要不要收進摺疊。只有 VOO 分頁、以及全部持股裡「只因為 VOO 才列進來」的項目套用；
// 其他分頁、也跟 GOOGL／00981A／009816 有關的項目一律 market（不收起來）。寬鬆模式照樣分類，摺疊裡仍可展開看
export function foldKind(tabName, x, loose = false) {
  if (!has(x, "MARKET")) return "market";
  if (tabName === "VOO") return vooKind(x);
  if (tabName === "全部持股" && !["00981A", "009816", "GOOGL"].some((n) => TABS.find(([m]) => m === n)[1](x, loose))) return vooKind(x);
  return "market";
}

// 多家媒體都在報：最近 36 小時、跟持股或台股有關、不只一家報導，依報導家數
export function hotList(items, now = Date.now(), n = 8) {
  return items.filter((x) => x.also?.length && now - timeOf(x) < 36 * 3600e3
    && (TABS[0][1](x, false) || has(x, "TWSE") || has(x, "2330")))
    .sort((a, b) => b.also.length - a.also.length || b.published_taipei.localeCompare(a.published_taipei)).slice(0, n);
}
