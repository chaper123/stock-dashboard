// 持股體檢（docs/PIVOT.md 第 5 節）與風險燈號（docs/INSIGHTS.md 3.3）：都在瀏覽器從 market-data、帳本與私人持股計算。
// 燈號是「該檢討了」的提醒，不是買賣訊號；門檻是預設值，使用者可以再調。
import { loadDaily, loadIndex, loadDividends, loadFx, loadSettings, loadCalendar } from "./data.js";
import { loadPortfolio } from "./portfolio.js";
import { loadFund, hasPrivate } from "./private.js";
import { lookThrough } from "./inside.js";
import { review009816, dayLabel } from "./outlook.js";
import { sma } from "./ta.js";
import { el, twd, shortDate, taipeiToday } from "./fmt.js";
import { NAMES } from "./config.js";
import { card } from "./ui.js";

const LAG_PP = 10, UNDER_SHARE = 0.6; // PIVOT 第 5 節：近 1 年落後基準超過 10 個百分點、六成以上交易日在 200 日均線下
const TSMC_WARN = 40, TSMC_CRIT = 50; // 台積電集中度（台股部位裡間接持有台積電的比例）
const FX_MOVE = 3; // 美元兌台幣單月變動 %

// 持股體檢的比較組合：第一個基準決定燈號
const PAIRS = [
  { code: "009816", market: "tw", benches: [{ tr: "TAIEX_TR", label: "加權報酬指數" }, { code: "0050", market: "tw", label: "0050" }] },
  { code: "00981A", market: "tw", benches: [{ code: "0050", market: "tw", label: "0050（主動對被動）" }] },
  { code: "GOOGL", market: "us", benches: [{ code: "VOO", market: "us", label: "VOO" }] },
  { code: "VOO", market: "us", benches: [{ macro: "SPX", label: "標普 500 價格指數" }] },
];

// 含息報酬指數：除息日那天用（收盤＋現金股利）÷ 前一天收盤。沒有配息資料就是價格報酬。
// 台股日線沒有還原分割（例如 0050 2025-06-18 一拆四）：台股漲跌幅限制 10%，單日剩一半以下只可能是分割，前一天收盤先除以倍數
function totalReturn(bars, events, tw) {
  const div = new Map((events || []).map((e) => [e.ex_date, Number(e.cash) || 0]));
  const out = [];
  let idx = 1;
  bars.forEach((b, i) => {
    if (i) {
      const prev = bars[i - 1].close, k = Math.round(prev / b.close);
      idx *= (b.close + (div.get(b.time) || 0)) / (tw && k >= 2 ? prev / k : prev);
    }
    out.push({ date: b.time, value: idx });
  });
  return out;
}
const at = (series, date) => {
  let v = null;
  for (const x of series) {
    if (x.date > date) break;
    v = x.value;
  }
  return v;
};

async function seriesOf(b, divs) {
  if (b.tr) return { s: await loadIndex(b.tr), withDiv: true };
  const market = b.macro ? "macro" : b.market;
  const bars = await loadDaily(market, b.macro || b.code);
  const ev = b.market === "tw" ? divs?.etfs?.[b.code]?.events : null;
  return { s: totalReturn(bars, ev, b.market === "tw"), bars, withDiv: b.market === "tw" };
}

// 一組體檢：期間＝近 1 年（資料不夠就從兩邊都有資料的第一天起）
async function checkPair(p, divs) {
  const mine = await seriesOf(p, divs);
  const today = mine.s.at(-1).date;
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const benches = [];
  for (const b of p.benches) {
    try {
      const bs = await seriesOf(b, divs);
      const start = [yearAgo, mine.s[0].date, bs.s[0].date].sort().at(-1);
      const r = (s) => (at(s, today) / at(s, start) - 1) * 100;
      benches.push({ label: b.label, start, mine: r(mine.s), bench: r(bs.s), withDiv: bs.withDiv });
    } catch (e) {
      benches.push({ label: b.label, error: e.message });
    }
  }
  // 自高點回落與 200 日均線下比例（價格）
  const bars = mine.bars;
  let peak = bars[0];
  for (const x of bars) if (x.close >= peak.close) peak = x;
  const dd = (bars.at(-1).close / peak.close - 1) * 100;
  const ma = new Map(sma(bars, 200).map((x) => [x.time, x.value]));
  const win = bars.filter((b) => b.time >= yearAgo && ma.has(b.time));
  const under = win.length >= 60 ? win.filter((b) => b.close < ma.get(b.time)).length / win.length : null;
  const main = benches[0];
  const lag = main && !main.error ? main.mine - main.bench : null;
  const hits = [lag != null && lag < -LAG_PP, under != null && under >= UNDER_SHARE].filter(Boolean).length;
  const light = lag == null ? "gray" : hits === 2 ? "red" : hits === 1 ? "yellow" : "green";
  return { ...p, today, benches, peak, dd, under, underDays: win.length, n: bars.length, lag, light, withDiv: mine.withDiv };
}

export async function loadCheckup() {
  const divs = await loadDividends().catch(() => null);
  const rs = await Promise.allSettled(PAIRS.map((p) => checkPair(p, divs)));
  return rs.map((r, i) => (r.status === "fulfilled" ? r.value : { ...PAIRS[i], error: r.reason?.message || "讀不到" }));
}

const LIGHT = { green: "綠燈", yellow: "黃燈", red: "紅燈", gray: "資料不足", info: "提醒" };
export const dot = (light) => el("span", { class: `lt lt-${light}`, role: "img", "aria-label": LIGHT[light] });
const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
const fullDate = (d) => d.replaceAll("-", "/");
// 200 日線下：不到約一年（240 天）就標實際算了幾天；上市不到 200 個交易日還沒有 200 日均線
const underText = (c) => (c.under != null ? `${Math.round(c.under * 100)}%${c.underDays < 240 ? `（${c.underDays} 天）` : ""}`
  : c.n < 200 ? `上市才 ${c.n} 個交易日` : `資料不足（${c.underDays} 天）`);

// 持股體檢表
export function checkupTable(list) {
  return el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
    el("thead", {}, el("tr", {}, ["", "標的", "比較基準", "期間", "報酬", "基準", "差距", "離高點", "200 日線下"]
      .map((h, i) => el("th", { class: i > 3 ? "r" : "" }, h)))),
    el("tbody", {}, list.flatMap((c) => {
      if (c.error) return [el("tr", {}, el("td", {}, dot("gray")), el("td", {}, c.code), el("td", { colspan: 7 }, `讀不到（${c.error}）`))];
      return c.benches.map((b, i) => el("tr", {},
        el("td", {}, i === 0 ? dot(c.light) : ""),
        el("td", {}, i === 0 ? `${c.code} ${NAMES[c.code] || ""}` : ""),
        el("td", {}, b.label),
        el("td", {}, b.error ? "—" : `${fullDate(b.start)} 起`),
        ...(b.error ? [el("td", { class: "r", colspan: 3 }, `讀不到（${b.error}）`)]
          : [el("td", { class: "r" }, `${pp(b.mine)}%`), el("td", { class: "r" }, `${pp(b.bench)}%`),
            el("td", { class: `r ${b.mine - b.bench < 0 ? "down" : "up"}` }, `${pp(b.mine - b.bench)}`)]),
        el("td", { class: "r" }, i === 0 ? `−${Math.abs(c.dd).toFixed(1)}%` : ""),
        el("td", { class: "r" }, i === 0 ? underText(c) : "")));
    }))));
}

// 風險燈號：[{ key, light, label, text }]
export async function loadRisks(checkup) {
  const today = taipeiToday();
  const [pR, aR, bR, fxR, sR, calR] = await Promise.allSettled([
    loadPortfolio(), hasPrivate() ? loadFund("00981A") : Promise.reject(new Error("no-token")),
    hasPrivate() ? loadFund("009816") : Promise.reject(new Error("no-token")), loadFx(), loadSettings(), loadCalendar()]);
  const out = [];

  // 1. 台積電集中度（ETF 市值 × 成分股權重）
  if (!hasPrivate()) {
    out.push({ key: "tsmc", light: "gray", label: "台積電集中度", text: "要在新聞頁「你的 ETF 裡面在變什麼」設定 GitHub token 才算得出來。" });
  } else if (pR.status === "fulfilled" && aR.status === "fulfilled" && bR.status === "fulfilled") {
    const lt = lookThrough(pR.value.positions, { "00981A": aR.value.doc, "009816": bR.value.doc }, ["00981A", "009816"]);
    const t = lt.items?.find((x) => x.code === "2330");
    if (t && lt.total) {
      const share = (t.value / lt.total) * 100;
      out.push({ key: "tsmc", light: share >= TSMC_CRIT ? "red" : share >= TSMC_WARN ? "yellow" : "green", label: "台積電集中度",
        text: `台股部位 ${twd(lt.total)} 裡約 ${twd(t.value)}（${share.toFixed(1)}%）是台積電（${t.via.map((v) => `${v.code} ${v.weight.toFixed(1)}%`).join("、")}）。超過 ${TSMC_WARN}% 黃燈、${TSMC_CRIT}% 紅燈。`,
        value: share });
    } else out.push({ key: "tsmc", light: "gray", label: "台積電集中度", text: "帳本沒有台股持倉或持股資料不完整。" });
  } else {
    const r = [pR, aR, bR].find((x) => x.status === "rejected");
    out.push({ key: "tsmc", light: "gray", label: "台積電集中度", text: `讀不到（${r?.reason?.message || "未知原因"}）。` });
  }

  // 2. 00981A 主動式 ETF（持股體檢）
  const a = checkup?.find((c) => c.code === "00981A");
  if (a && !a.error) {
    const b = a.benches[0];
    out.push({ key: "00981A", light: a.light, label: "00981A 主動式 ETF",
      text: `${fullDate(b.start)} 起 ${pp(b.mine)}%，0050 ${pp(b.bench)}%（差 ${pp(b.mine - b.bench)} 個百分點）；200 日線下 ${underText(a)}。落後超過 ${LAG_PP} 個百分點、或六成以上交易日在 200 日線下各算一項，一項黃燈、兩項紅燈。` });
  } else out.push({ key: "00981A", light: "gray", label: "00981A 主動式 ETF", text: `讀不到（${a?.error || "未知原因"}）。` });

  // 3. 009816 成分股審核
  if (calR.status === "fulfilled") {
    const next = review009816(today, new Set(calR.value.tw_market?.closed || []));
    if (next) {
      const days = Math.round((Date.parse(next.effective) - Date.parse(today)) / 86400000);
      out.push({ key: "review", light: days <= 14 ? "info" : "green", label: "009816 成分股審核",
        text: `下一次約 ${dayLabel(next.effective)} 收盤後生效${next.estimate ? "（預估）" : ""}${days <= 14 ? `，還有 ${days} 天` : ""}。照指數規則換股，不用動作。` });
    }
  }

  // 4. 美元兌台幣（美股部位）
  if (fxR.status === "fulfilled" && fxR.value.length > 22) {
    const f = fxR.value, last = f.at(-1), prev = f.at(-22);
    const chg = (last.value / prev.value - 1) * 100;
    out.push({ key: "fx", light: Math.abs(chg) > FX_MOVE ? "yellow" : "green", label: "美元兌台幣（美股部位）",
      text: `1 美元換 ${last.value.toFixed(2)} 台幣（${shortDate(last.date)}），比約一個月前（${shortDate(prev.date)} ${prev.value.toFixed(2)}）${chg >= 0 ? "多" : "少"} ${Math.abs(chg).toFixed(1)}%：`
        + `${chg >= 0 ? "美元變貴、台幣變弱，美股部位換回台幣變多（之後買美股要付更多台幣）" : "美元變便宜、台幣變強，美股部位換回台幣變少（之後買美股比較划算）"}。單月變動超過 ${FX_MOVE}% 黃燈。` });
  }

  // 5. 可用資金（帳本）
  if (sR.status === "fulfilled" && sR.value.pool != null) {
    const pool = sR.value.pool;
    out.push({ key: "pool", light: pool < 0 ? "red" : "green", label: "可用資金（帳本）",
      text: pool < 0 ? `${twd(pool)}：投入超過入金，帳上是負的。` : `${twd(pool)}。投入後接近 0 是正常的；變成負的才亮紅燈。` });
  }
  return out;
}

export function riskList(risks) {
  return el("ul", { class: "risk-list" }, risks.map((r) => el("li", {}, dot(r.light),
    el("div", {}, el("strong", {}, r.label), el("div", { class: "small" }, r.text)))));
}

// 首頁的風險燈號卡（摘要；細節在分析頁）
export async function riskCard() {
  const risks = await loadRisks(await loadCheckup());
  return card("風險燈號", riskList(risks), el("p", { class: "small" }, el("a", { href: "#/analysis" }, "看分析頁（台積電、持股體檢）→")));
}
