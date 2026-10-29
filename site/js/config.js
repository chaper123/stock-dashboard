// 資料來源設定。網址與分頁 gid 的說明見 docs/DATA_SOURCES.md。

// Google Sheet「發布到網路」的 CSV
const sheetCsv = (pub, gid) =>
  `https://docs.google.com/spreadsheets/d/e/${pub}/pub?gid=${gid}&single=true&output=csv`;

// 共用帳本（2026-10-16 發布）
const LEDGER_PUB = "2PACX-1vTkKjwqp4RAA2kJ6YPKCHVZCdv8fkUJOS8_S4elsyFQB6nnLs1_oA5S_CHJXbKNc7yJiYlmu0tRcAnH";
// 「投資儀表板資料（排程寫入）」（2026-10-27 發布；null 時網站顯示「尚未發布」）
const DASH_PUB = "2PACX-1vRhvnwZeDHTngUJNE92xxFi2cBvrZrBsiCAtrefaDzMfaR268oMF5wmC5b0E77T0yqR6fPEx71PAvlh";
// 新聞：正式「新聞」分頁（gid 5，2026-10-28 建立）與「測試_新聞」（gid 4）都讀，取資料日較新的，同一天以正式為準。
// 切換當天正式分頁還空著也不會空白；正式版穩定後把測試那一項拿掉
const NEWS_TABS = [[5, "新聞"], [4, "測試_新聞"]];

// 本機開發：localhost 加 ?dev 時改讀 site/dev-data/（不進 git）。只在本機有效，線上網址不能被參數換掉
const DEV = ["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("dev");

export const SOURCES = {
  ledger: {
    settings: sheetCsv(LEDGER_PUB, 0),
    trades: sheetCsv(LEDGER_PUB, 1),
    holdings: sheetCsv(LEDGER_PUB, 2),
  },
  dash: {
    archive: DEV ? "dev-data/archive.csv" : DASH_PUB && sheetCsv(DASH_PUB, 0),
    news: DEV ? [{ url: "dev-data/news.csv", label: "本機測試" }]
      : DASH_PUB && NEWS_TABS.map(([gid, label]) => ({ url: sheetCsv(DASH_PUB, gid), label })),
  },
  market: "https://raw.githubusercontent.com/chaper123/market-data/main/data/",
};

export const IS_DEV = DEV;

// K 線的均線天數
export const MA = { us: [50, 200], tw: [20, 60] };

// 代號中文名稱（只用來顯示）
export const NAMES = {
  VOO: "先鋒標普500 ETF", GOOGL: "Alphabet", NVDA: "輝達", TSLA: "特斯拉", SPCX: "SpaceX", AAPL: "蘋果",
  "009816": "凱基台灣TOP50", "00981A": "主動統一台股增長",
  "0056": "元大高股息", "00878": "國泰永續高股息", "00919": "群益台灣精選高息",
};

// K 線頁與盤中區塊追蹤的標的（2026-10-30 轉型：00411A 移出；美股 VOO、GOOGL 持有，其餘只追蹤）
export const TRACK = { tw: ["009816", "00981A"], us: ["VOO", "GOOGL", "NVDA", "TSLA", "SPCX", "AAPL"] };

export const MARKET_LABEL = { us: "美股", tw: "台股" };
