// 分析頁（docs/INSIGHTS.md 5.1，第 2 批）：台積電（最大的間接持股）、風險燈號、持股體檢。
// 數字都從 market-data（公開資料）、帳本與私人持股在瀏覽器計算，只描述已發生的事；燈號是「該檢討了」的提醒，不是買賣訊號。
import { loadDaily, loadStockInsti, loadStockMargin, loadHolders, loadRevenue, loadFx, loadHeadlines } from "../data.js";
import { fugleQuote, fugleUsable, fugleClosed, FUGLE_NOTE } from "../fugle.js";
import { fromPeak } from "../market.js";
import { bias } from "../ta.js";
import { loadCheckup, checkupTable, loadRisks, riskList } from "../checkup.js";
import { sortItems, timeOf, ago } from "../headlines.js";
import { el, price, int, shortDate, dateVs, extLink } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";

export async function render(root) {
  root.append(pageHeader("分析", "台積電、風險燈號、持股體檢。數字從公開資料與你的帳本計算，只描述已發生的事；燈號是「該檢討了」的提醒，不是買賣訊號。"));
  slot(root, tsmcCard);
  const ck = loadCheckup();
  slot(root, async () => card("風險燈號", riskList(await loadRisks(await ck)),
    el("p", { class: "tiny" }, "門檻是預設值（docs/INSIGHTS.md 3.3），想調整再說。灰色是資料不足或讀不到。")));
  slot(root, async () => card("持股體檢", checkupTable(await ck),
    el("p", { class: "tiny" }, "報酬：台股 ETF 含息（除息日把現金股利加回），美股只有價格；加權報酬指數含息，標普 500 是價格指數。期間是近 1 年，資料不夠就從兩邊都有資料的第一天起。",
      "燈號（PIVOT 第 5 節）：落後第一個基準超過 10 個百分點、近 1 年六成以上交易日在 200 日均線下，各算一項；一項黃燈、兩項紅燈。200 日均線要上市滿 200 個交易日才有（不夠就寫上市幾個交易日）；算得出來但不到一年的，括號寫實際算了幾天。")));
}

const lots = (shares) => shares / 1000;
const sgn = (v, f = (x) => int(Math.round(x))) => `${v >= 0 ? "+" : "−"}${f(Math.abs(v))}`;
const sinceNote = (first) => `資料從 ${shortDate(first)} 起`;

async function tsmcCard() {
  const [barsR, instR, marR, holdR, revR, adrR, fxR, fqR, hR] = await Promise.allSettled([
    loadDaily("tw", "2330"), loadStockInsti("2330"), loadStockMargin("2330"), loadHolders("2330"), loadRevenue("2330"),
    loadDaily("macro", "TSM"), loadFx(), fugleQuote("2330"), loadHeadlines()]);
  const title = "台積電（2330）";
  if (barsR.status !== "fulfilled") return card(title, notice("warn", `讀不到台積電日線（${barsR.reason?.message || "未知原因"}）`));
  const failed = [];

  // 股價：market-data 日線，加上比它新的富果報價
  let bars = barsR.value, qNote = null;
  const q = fqR.status === "fulfilled" ? fqR.value : null;
  if (fugleUsable(q, bars.at(-1).time) && q.date > bars.at(-1).time) {
    bars = [...bars, { time: q.date, open: q.open, high: q.high, low: q.low, close: q.price }];
    qNote = fugleClosed(q) ? "收盤（富果）" : "盤中（富果）";
  }
  const last = bars.at(-1), prev = bars.at(-2);
  const chg = (last.close / prev.close - 1) * 100;
  const pk = fromPeak(bars.slice(-250).map((b) => ({ date: b.time, value: b.close }))); // 近一年（約 250 個交易日）
  const b20 = bias(bars, 20).get(last.time), b60 = bias(bars, 60).get(last.time);
  const rows = [kv("股價", `${price(last.close)}（${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%）`,
    `${shortDate(last.time)} ${qNote || "收盤"}；近一年高點 ${dateVs(pk.peak.date, last.time)} ${price(pk.peak.value)}，離高點 ${pk.dd < 0 ? "−" : ""}${Math.abs(pk.dd).toFixed(1)}%`
    + (b20 != null ? `；比 MA20 ${b20 >= 0 ? "高" : "低"} ${Math.abs(b20).toFixed(1)}%、MA60 ${b60 >= 0 ? "高" : "低"} ${Math.abs(b60 ?? 0).toFixed(1)}%` : ""))];

  // ADR 溢價：紐約收盤 × 美元兌台幣 ÷ 5（1 股 ADR＝5 股普通股）對同一天（或之前最近）的台股收盤
  if (adrR.status === "fulfilled" && fxR.status === "fulfilled") {
    const a = adrR.value.at(-1);
    const tw = [...barsR.value].reverse().find((b) => b.time <= a.time);
    const fx = [...fxR.value].reverse().find((x) => x.date <= a.time);
    if (tw && fx) {
      const prem = ((a.close * fx.value) / 5 / tw.close - 1) * 100;
      rows.push(kv("ADR 溢價", `${prem >= 0 ? "+" : "−"}${Math.abs(prem).toFixed(1)}%`,
        `TSM ${shortDate(a.time)} 紐約收盤 ${a.close.toFixed(2)} 美元 × ${fx.value.toFixed(2)} ÷ 5 ＝ ${price(+(a.close * fx.value / 5).toFixed(1))}，對台股 ${shortDate(tw.time)} 收盤 ${price(tw.close)}；紐約比台股晚 13 小時收盤，常常先反映隔夜消息`));
    }
  } else failed.push("ADR");

  // 三大法人（張）
  let who = [];
  if (instR.status === "fulfilled" && instR.value.length) {
    const xs = instR.value;
    const l = xs.at(-1), sell = l.foreign < 0;
    let streak = 0;
    for (let i = xs.length - 1; i >= 0 && xs[i].foreign !== 0 && (xs[i].foreign < 0) === sell; i--) streak++;
    const sum = (n, k) => xs.slice(-n).reduce((s, x) => s + x[k], 0);
    const capped = streak === xs.length;
    who.push(`外資${sell ? "賣超" : "買超"}連 ${streak}${capped ? " 天以上" : " 天"}`);
    rows.push(kv("三大法人", `外資 ${sgn(lots(l.foreign))} 張`,
      `${shortDate(l.date)}：投信 ${sgn(lots(l.trust))}、自營商 ${sgn(lots(l.dealer))} 張。外資${sell ? "賣超" : "買超"}連 ${streak} 天${capped ? `（${sinceNote(xs[0].date)}，可能更久）` : ""}；`
      + `近 5 個交易日外資 ${sgn(lots(sum(5, "foreign")))}、投信 ${sgn(lots(sum(5, "trust")))} 張`
      + (xs.length >= 20 ? `；近 20 個交易日外資 ${sgn(lots(sum(20, "foreign")))} 張` : "")));
  } else failed.push("三大法人");

  // 融資融券（張）
  if (marR.status === "fulfilled" && marR.value.length) {
    const m = marR.value, l = m.at(-1), p5 = m.at(-6);
    rows.push(kv("融資融券", `融資 ${int(l.margin)} 張`,
      `${shortDate(l.date)}；融券 ${int(l.short)} 張` + (p5 ? `；融資近 5 個交易日 ${sgn(l.margin - p5.margin)} 張` : "")));
    if (p5) who.push(`融資 5 日 ${sgn(l.margin - p5.margin)} 張`);
  } else failed.push("融資融券");

  // 集保股權分散：千張大戶（分級 15）、50 張以下散戶（分級 1～8）
  if (holdR.status === "fulfilled" && holdR.value.length) {
    const byDate = new Map();
    for (const x of holdR.value) {
      if (!byDate.has(x.date)) byDate.set(x.date, []);
      byDate.get(x.date).push(x);
    }
    const dates = [...byDate.keys()].sort();
    const stat = (d) => {
      const g = byDate.get(d);
      const big = g.find((x) => x.level === 15), small = g.filter((x) => x.level >= 1 && x.level <= 8);
      return { big: big?.pct, bigN: big?.people, small: small.reduce((s, x) => s + x.pct, 0), smallN: small.reduce((s, x) => s + x.people, 0) };
    };
    const now = stat(dates.at(-1)), before = dates.length > 1 ? stat(dates.at(-2)) : null;
    const d = (a, b) => (b == null ? "" : `（比上週 ${a - b >= 0 ? "+" : "−"}${Math.abs(a - b).toFixed(2)} 個百分點）`);
    rows.push(kv("大戶與散戶", `千張大戶 ${now.big?.toFixed(2)}%`,
      `${shortDate(dates.at(-1))} 集保：千張以上大戶 ${int(now.bigN)} 人持有 ${now.big?.toFixed(2)}%${d(now.big, before?.big)}；50 張以下散戶 ${int(now.smallN)} 人持有 ${now.small.toFixed(2)}%${d(now.small, before?.small)}`
      + (before ? "" : "。每週一份，從 2026-11 起累積，下週起才有變化")));
    if (before) who.push(`千張大戶 ${now.big - before.big >= 0 ? "+" : "−"}${Math.abs(now.big - before.big).toFixed(2)} 個百分點`);
  } else failed.push("集保股權分散");

  // 月營收
  if (revR.status === "fulfilled" && revR.value.length) {
    const r = [...revR.value].sort((a, b) => a.month.localeCompare(b.month));
    const l = r.at(-1), p = r.at(-2);
    const ly = r.find((x) => x.month === `${Number(l.month.slice(0, 4)) - 1}${l.month.slice(4)}`);
    const yi = (v) => `${(v / 1e8).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 億`;
    const g = (a, b) => (b ? `${a >= b ? "+" : "−"}${Math.abs((a / b - 1) * 100).toFixed(1)}%` : "—");
    rows.push(kv("月營收", `${l.month.replace("-", "/")} ${yi(l.revenue)}`, `比上月 ${g(l.revenue, p?.revenue)}、比去年同月 ${g(l.revenue, ly?.revenue)}（每月 10 日前公布上個月）`));
  } else failed.push("月營收");

  // 最近兩天主要媒體（Tier 1～2）標題提到台積電的
  let news = null;
  if (hR.status === "fulfilled") {
    const now = Date.now();
    const items = sortItems(hR.value.items || []).filter((x) => x.tier <= 2 && /台積電|TSMC|Taiwan Semiconductor/i.test(x.title)
      && now - timeOf(x) < 48 * 3600e3).slice(0, 5);
    if (items.length) {
      news = el("details", { class: "more" }, el("summary", {}, `主要媒體最近 48 小時（${items.length} 則）`),
        el("ul", { class: "small" }, items.map((x) => el("li", {}, extLink(x.url || x.link, x.title), el("span", { class: "tiny" }, `　${x.source}・${ago(timeOf(x), now)}`)))));
    }
  }

  return card(title,
    who.length > 0 && el("p", { class: "small" }, el("strong", {}, "誰在買賣："), who.join("；"), "。"),
    rows, news,
    failed.length > 0 && el("p", { class: "tiny" }, `讀不到：${failed.join("、")}。`),
    el("p", { class: "tiny" }, `資料：日線、三大法人、融資融券、月營收來自證交所與公開資訊觀測站（經 FinMind）；大戶與散戶來自集保結算所開放資料（金管會證期局，政府資料開放授權條款第 1 版）；ADR 來自 Yahoo、匯率台灣銀行。${qNote ? `${FUGLE_NOTE}。` : ""}只描述已發生的事，法人與大戶的「看法」讀不到，只看實際買賣與持股變化。`));
}

const kv = (k, v, sub) => el("div", { class: "kv" }, el("span", { class: "k" }, k, sub && el("div", { class: "tiny" }, sub)), el("span", { class: "v" }, v));
