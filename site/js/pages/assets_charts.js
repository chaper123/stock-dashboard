// 資產頁的時間序列圖（Lightweight Charts，可縮放平移）：資產走勢、累計損益與每日損益、投資報酬率對比較標的。
// 一整塊共用 ctx 的期間選擇（pages/assets.js）：換期間時各卡 ctx.onChange 的函式會被呼叫，重新設定資料與可見範圍。
import { loadSettings, loadTrades, loadHoldings, loadDaily, loadDca, loadFx, loadIndex, loadDividends, loadIncome } from "../data.js";
import { assetTrend } from "../cash.js";
import { loadPerformance, attribution } from "../perf.js";
import { periodStart, periodPnl, daysFrom, periodLabel, valuesAt, etfIndex, rebase } from "../assets.js";
import { el, twd, pct, signed, tone, shortDate, shares, isNum } from "../fmt.js";
import { card, notice } from "../ui.js";
import { NAMES } from "../config.js";
import { loadStatus, statusLine } from "../status.js";
import { loadLW, cssVar, alpha, timeChart, mountChart } from "../lw.js";

const md = (d) => shortDate(d);
// 縱軸：負數寫成「−NT$1,000」（twd 會寫成 NT$-1,000）
const twdFmt = { type: "custom", formatter: (x) => (x < 0 ? "−" : "") + twd(Math.abs(x)), minMove: 1 };

// 切換用的一排 chip：items 是 [key, 標籤]，選到時呼叫 pick(key)
function chipRow(items, current, pick, label) {
  const row = el("div", { class: "chips", role: "group", "aria-label": label, style: { margin: "4px 0 0" } });
  for (const [k, text] of items) {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": String(k === current), "data-k": k }, text);
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      for (const x of row.children) x.setAttribute("aria-pressed", String(x === b));
      pick(k);
    });
    row.append(b);
  }
  return row;
}

// 圖下面「游標那天」的一行字：離開圖就回到最後一天
function followCrosshair(chart, last, show) {
  show(last);
  chart.subscribeCrosshairMove((p) => show(typeof p.time === "string" ? p.time : last));
}

// ── 總資產走勢要的資料（算法在 cash.js 的 assetTrend）：交易過、現在還持有的每一檔日線，有美股才讀匯率 ──
async function loadAssetTrend() {
  try {
    // 其他入帳讀不到＝null：可用資金排不出來，只畫持倉市值（assetTrend 會寫原因）；還沒接上時 loadIncome 回傳 { configured: false }，當 0
    const [settings, trades, holdings, dca, income] = await Promise.all([loadSettings(), loadTrades(), loadHoldings(), loadDca().catch(() => null),
      loadIncome().catch(() => null)]);
    const kinds = new Map();
    for (const h of holdings) kinds.set(`${h.market}:${h.code}`, h);
    for (const t of trades) if (t.side === "買進" || t.side === "賣出") kinds.set(`${t.market}:${t.code}`, t);
    const need = [...kinds.values()];
    const loaded = await Promise.all(need.map((x) => loadDaily(x.market, x.code).catch(() => null)));
    const bars = Object.fromEntries(need.map((x, i) => [x.code, loaded[i]]).filter(([, b]) => b));
    const fxRows = need.some((x) => x.market === "us") ? await loadFx().catch(() => null) : null;
    const unread = need.filter((x, i) => !loaded[i]).map((x) => `${x.code} 的日線`);
    return { a: assetTrend({ settings, trades, holdings, bars, fxRows, dca, income }), unread };
  } catch (e) {
    return { a: null, unread: [], error: e.message || String(e) };
  }
}

// ── 資產走勢（ASSETS_PAGE 2.1）──
// 持倉市值（實線）加投入成本（灰色虛線）；切到「總資產」換成持倉市值＋可用資金（assetTrend，從基準日起算），虛線是對照線
export async function trendCard(ctx) {
  const [LW, perf, { a, unread, error }] = await Promise.all([loadLW(), loadPerformance(), loadAssetTrend()]);
  const totalOk = !!a?.ok;
  let mode = "hold";
  const box = el("div", { class: "lw-box", role: "img", "aria-label": "資產走勢折線圖，可用滑鼠滾輪或兩指縮放、拖曳平移" });
  const info = el("p", { class: "small" });
  const notes = el("div");
  const byDate = new Map((totalOk ? a.days : []).map((x) => [x.date, x]));
  const perfByDate = new Map(perf.days.map((x) => [x.date, x]));
  const lastDate = perf.last;

  // 圖下面一行：MM/DD 收盤：持倉 X；可用資金 Y；總資產 Z
  const show = (date) => {
    const t = byDate.get(date), p = perfByDate.get(date);
    let text;
    if (t) {
      text = a.hasCash ? `${md(date)} 收盤：持倉 ${twd(t.hold)}；可用資金 ${twd(t.cash)}；總資產 ${twd(t.total)}`
        : `${md(date)} 收盤：持倉 ${twd(t.hold)}；可用資金、總資產先不算（${a.cashReason}）`;
    } else if (p) {
      text = totalOk ? `${md(date)} 收盤：持倉 ${twd(p.value)}；可用資金與總資產從基準日 ${md(a.first.date)} 才有`
        : `${md(date)} 收盤：持倉 ${twd(p.value)}；可用資金與總資產先不算（${error ? `讀取失敗：${error}` : `缺 ${[...unread, ...(a?.missing ?? [])].join("、")}`}）`;
    } else text = "";
    info.textContent = text;
  };

  const draw = () => {
    const v = cssVar();
    const start = periodStart(ctx.period, perf.first, perf.last);
    const chart = timeChart(LW, box, { rightPriceScale: { borderColor: v("--axis"), minimumWidth: 64 } });
    const lineOpts = { priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true, priceFormat: twdFmt };
    const dashed = { ...lineOpts, color: v("--muted"), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, lastValueVisible: false, crosshairMarkerVisible: false };
    let n = 0;
    const note = [];
    if (mode === "total" && totalOk) {
      const from = start < a.first.date ? a.first.date : start;
      if (start < a.first.date) note.push(`總資產只從基準日 ${md(a.first.date)} 起算（期間「${periodLabel(ctx.period)}」的起點更早）。`);
      const days = a.days.filter((x) => x.date >= from);
      chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--accent"), lineWidth: 2, title: a.hasCash ? "總資產" : "持倉市值" })
        .setData(days.map((x) => ({ time: x.date, value: x.total })));
      if (a.hasCash) {
        chart.addSeries(LW.LineSeries, { ...dashed, title: "對照線" }).setData(days.map((x) => ({ time: x.date, value: x.line })));
      } else note.push(`可用資金先不畫：${a.cashReason}。這張圖只有持倉市值。`);
      n = days.length;
    } else {
      const days = daysFrom(perf.days, start);
      chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--accent"), lineWidth: 2, title: "持倉市值" })
        .setData(days.map((x) => ({ time: x.date, value: x.value })));
      chart.addSeries(LW.LineSeries, { ...dashed, title: "投入成本" }).setData(days.map((x) => ({ time: x.date, value: x.invested })));
      n = days.length;
    }
    chart.timeScale().fitContent();
    followCrosshair(chart, lastDate, show);
    notes.replaceChildren(...[
      ...note.map((t) => el("p", { class: "tiny" }, t)),
      mode === "total" && unread.length > 0 && notice("info", `有 ${unread.length} 檔的日線讀不到：${unread.join("、")}（沒有持股的日子不影響）。`),
      el("p", { class: "tiny" }, mode === "total" && totalOk
        ? (a.hasCash ? "實線是總資產（持倉市值＋可用資金），灰色虛線是對照線（基準日的總資產加上之後已入帳的入金），兩條線的差就是投資損益。" : "")
        : "實線是持倉市值（台股收盤、美股換台幣，不含可用資金），灰色虛線是投入成本（累計投入，賣出會減少）。",
        "最後一天用收盤價算，跟其他卡用的即時價可能有一點差。圖可以用滾輪或兩指縮放、拖曳平移。"),
      n < 2 && el("p", { class: "small" }, "這個期間只有一個交易日，等有更多資料再看走勢。")].filter(Boolean));
    return chart;
  };

  const mount = mountChart(box, ctx.alive, draw);
  const chips = chipRow([["hold", "持倉市值"], ["total", "總資產（含可用資金）"]], mode, (k) => {
    mode = k;
    mount.redraw();
  }, "資產走勢的算法");
  if (!totalOk) {
    chips.lastChild.setAttribute("aria-disabled", "true");
    chips.lastChild.title = "缺資料，總資產先不算";
  }
  ctx.onChange(() => mount.redraw());
  const head = el("h2", {}, "資產走勢", el("span", { class: "head-note" }, `持倉市值 ${twd(perf.value)}`));
  return card(null, head, chips,
    !totalOk && notice("info", el("strong", {}, "總資產先不畫"),
      `：${error ? `讀取失敗（${error}）` : `缺 ${[...unread, ...(a?.missing ?? [])].join("、")}`}。缺的資料不補 0，補上後會自動出現。`),
    box, info, notes);
}

// ── 累計損益與每日損益（ASSETS_PAGE 2.2）──
// 上：累計損益折線（0 以上紅、以下綠，Baseline 系列）；下：每日損益柱狀圖。兩張在同一個圖的上下兩格，時間軸一起縮放平移
export async function pnlCard(ctx) {
  const [LW, perf] = await Promise.all([loadLW(), loadPerformance()]);
  const box = el("div", { class: "lw-box tall", role: "img", "aria-label": "累計損益折線與每日損益柱狀圖，可用滑鼠滾輪或兩指縮放、拖曳平移" });
  const info = el("p", { class: "small" });
  const sum = el("span", { class: "head-note" });
  let rows = [];
  const byDate = new Map();
  const show = (date) => {
    const r = byDate.get(date);
    if (!r) {
      info.textContent = "";
      return;
    }
    info.replaceChildren(`${md(date)}　當天損益 `, r.pnl == null ? "—" : el("strong", { class: tone(r.pnl) }, signed(r.pnl, twd)),
      "　累計 ", el("strong", { class: tone(r.cum) }, signed(r.cum, twd)));
  };
  const setRows = () => {
    const start = periodStart(ctx.period, perf.first, perf.last);
    rows = periodPnl(perf.days, start);
    byDate.clear();
    for (const r of rows) byDate.set(r.date, r);
    const total = rows.at(-1)?.cum;
    sum.replaceChildren(`${periodLabel(ctx.period)} `, isNum(total) ? el("strong", { class: tone(total) }, signed(total, twd)) : "—");
  };
  const draw = () => {
    setRows();
    const v = cssVar();
    const up = v("--up"), down = v("--down");
    const chart = timeChart(LW, box, { rightPriceScale: { borderColor: v("--axis"), minimumWidth: 64 } });
    const cum = chart.addSeries(LW.BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: up, topFillColor1: alpha(up, 0.28), topFillColor2: alpha(up, 0.05),
      bottomLineColor: down, bottomFillColor1: alpha(down, 0.05), bottomFillColor2: alpha(down, 0.28),
      lineWidth: 2, priceLineVisible: false, priceFormat: twdFmt,
    }, 0);
    cum.setData(rows.map((r) => ({ time: r.date, value: r.cum })));
    const bars = chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: twdFmt }, 1);
    bars.setData(rows.filter((r) => r.pnl != null).map((r) => ({ time: r.date, value: r.pnl, color: r.pnl >= 0 ? up : down })));
    const [p0, p1] = chart.panes();
    p0.setStretchFactor(3);
    p1.setStretchFactor(2);
    chart.timeScale().fitContent();
    if (rows.length) followCrosshair(chart, rows.at(-1).date, show);
    return chart;
  };
  const mount = mountChart(box, ctx.alive, draw);
  ctx.onChange(() => mount.redraw()); // draw 會先重算 rows，標題旁的金額跟著更新
  setRows();
  return card(null, el("h2", {}, "累計損益與每日損益", sum), box, info,
    el("p", { class: "tiny" }, "損益含手續費與匯率變動、含已領的台股 ETF 現金股利（稅前）、美股配息（扣稅後實收）與手續費折抵。每日損益＝當天收盤市值 − 前一天收盤市值 − 當天投入（賣出算負的）＋ 當天股利與其他入帳；"
      + "累計損益從期間的第一天歸 0（選「全部」時第一天買進當天的損益也算），所以全部期間的累計損益＝持倉市值 − 累計投入 ＋ 已領股利與其他入帳。"
      + "上下兩張圖的時間軸一起縮放、平移。"));
}

// ── 投資報酬率對比較標的（ASSETS_PAGE 2.3，原 K 線頁的「組合對大盤」）──
// 組合的時間加權報酬（扣掉投入的影響，期間起點＝0%）一條線，加一條比較線：加權報酬指數（含股利）、0050、009816、00981A 四選一，
// 每個選項顯示那個標的同一期間的報酬。ETF 的比較線是收盤價加除息的現金股利（算法同 perf.js 對持股的處理）；沒有配息資料的只用價格
const BENCH = [["tr", "加權報酬指數"], ["0050", "0050"], ["009816", "009816"], ["00981A", "00981A"]];

export async function compareCard(ctx) {
  const codes = BENCH.filter(([k]) => k !== "tr").map(([k]) => k);
  const [LW, perf, tr, divs, S, ...etfBars] = await Promise.all([loadLW(), loadPerformance(), loadIndex("TAIEX_TR").catch((e) => e),
    loadDividends().catch(() => null), loadStatus(), ...codes.map((c) => loadDaily("tw", c).catch((e) => e))]);
  const trOk = Array.isArray(tr);
  const dates = perf.days.map((d) => d.date);
  const mineIdx = perf.days.map((d) => d.index);
  const series = {}; // 每個標的在 perf 每一天的指數（任意基準，用 rebase 換成期間起點 0%）
  const lastDay = {}; // 每個標的資料的最後一天
  const problems = []; // 讀不到的標的
  if (trOk) {
    series.tr = valuesAt(tr, dates);
    lastDay.tr = tr.at(-1).date;
  } else problems.push(`加權報酬指數（${tr.message}）`);
  const hasDiv = {};
  codes.forEach((c, i) => {
    const bars = etfBars[i];
    if (!Array.isArray(bars)) {
      problems.push(`${c} 的日線（${bars.message}）`);
      return;
    }
    const events = divs?.etfs?.[c]?.events || [];
    hasDiv[c] = events.length > 0;
    const idx = etfIndex(bars, events.map((e) => ({ date: e.ex_date, cash: e.cash })), dates);
    if (!idx) {
      problems.push(`${c} 的日線在 ${dates[0].replaceAll("-", "/")} 之前沒有資料`);
      return;
    }
    series[c] = idx;
    lastDay[c] = bars.at(-1).time;
  });
  const trAt = (d) => (trOk ? valuesAt(tr, [d])[0] : null);
  const noDiv = (k) => k !== "tr" && !hasDiv[k];
  const avail = BENCH.filter(([k]) => series[k]);
  let pick = avail[0]?.[0] ?? null;

  const box = el("div", { class: "lw-box", role: "img", "aria-label": "組合與比較標的的累積報酬折線圖，可用滑鼠滾輪或兩指縮放、拖曳平移" });
  const stats = el("div", { class: "chart-legend" });
  const why = el("details", { class: "more" });
  const startIdx = () => Math.max(0, dates.findIndex((d) => d >= periodStart(ctx.period, perf.first, perf.last)));
  const label = ([k, name]) => `${name}${noDiv(k) ? "（不含股利）" : ""}`;
  const endOf = (k, i0) => rebase(series[k], i0).at(-1);

  const chips = el("div", { class: "chips", role: "group", "aria-label": "比較標的", style: { margin: "4px 0 0" } });
  const chipFor = new Map();
  for (const [k] of BENCH) {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": String(k === pick), "aria-disabled": series[k] ? null : "true" });
    if (!series[k]) b.title = "資料讀不到";
    b.addEventListener("click", () => {
      if (!series[k]) return;
      pick = k;
      for (const [kk, x] of chipFor) x.setAttribute("aria-pressed", String(kk === k));
      mount.redraw();
    });
    chipFor.set(k, b);
    chips.append(b);
  }
  const chipText = () => {
    const i0 = startIdx();
    for (const opt of BENCH) chipFor.get(opt[0]).textContent = series[opt[0]] ? `${label(opt)} ${pct(endOf(opt[0], i0))}` : `${opt[1]}：資料讀不到`;
  };

  // 為什麼輸（贏）大盤：摺疊，跟著期間切換重算（docs/INSIGHTS.md 4.2），固定用加權報酬指數
  const whyView = (at) => {
    if (!at) {
      why.replaceChildren();
      return;
    }
    const lose = at.diff < 0;
    const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
    const gap = at.value - at.same;
    why.replaceChildren(el("summary", {}, lose ? "為什麼輸大盤" : "為什麼贏大盤"),
      el("p", { class: "small" }, `這段期間${lose ? "落後" : "領先"}大盤（加權報酬指數）${Math.abs(at.diff).toFixed(1)} 個百分點（時間加權）。各檔的影響（個百分點）：`),
      el("ul", { class: "small" }, at.by.map((x) => el("li", {},
        `${x.code} ${NAMES[x.code] || ""}${x.market === "us" ? "（含匯率）" : ""}：`,
        el("strong", { class: tone(x.pp) }, pp(x.pp)))),
        Math.abs(at.other) >= 0.05 && el("li", {}, "其他（買進當天成交價與收盤價的差、手續費）：", el("strong", { class: tone(at.other) }, pp(at.other)))),
      el("p", { class: "small" }, `同樣的錢在同樣的日子改買加權報酬指數，現在約 ${twd(at.same)}；你的組合是 ${twd(at.value)}，${gap >= 0 ? "多" : "少"} ${twd(Math.abs(gap))}（這個差距也包含投入時點的影響）。`),
      el("p", { class: "tiny" }, "每一檔＝它每天占組合的比重 ×（它當天的報酬 − 大盤當天的報酬），整段期間加總；負數是把你拉離大盤、正數是幫你超前。加總等於上面的差距。美股的報酬含美元兌台幣的變化。"));
  };

  const draw = () => {
    const v = cssVar();
    const i0 = startIdx();
    chipText();
    const chart = timeChart(LW, box, { rightPriceScale: { borderColor: v("--axis"), minimumWidth: 56 } });
    const fmt = { type: "custom", formatter: (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`, minMove: 0.1 };
    const opts = { lineWidth: 2, priceLineVisible: false, priceFormat: fmt };
    const line = (values) => dates.slice(i0).flatMap((d, k) => (values[i0 + k] == null ? [] : [{ time: d, value: values[i0 + k] }]));
    const mine = rebase(mineIdx, i0);
    chart.addSeries(LW.LineSeries, { ...opts, color: v("--accent"), title: "我的組合" }).setData(line(mine));
    const name = BENCH.find(([k]) => k === pick)?.[1];
    if (pick) chart.addSeries(LW.LineSeries, { ...opts, color: v("--ma1"), title: name }).setData(line(rebase(series[pick], i0)));
    chart.timeScale().fitContent();
    const a = mine.at(-1), b = pick ? rebase(series[pick], i0).at(-1) : null;
    stats.replaceChildren(...[
      el("span", {}, el("i", { class: "sw", style: { background: v("--accent") } }), `我的組合（已投入部位）${pct(a)}`),
      el("span", {}, el("i", { class: "sw", style: { background: v("--ma1") } }), pick ? `${label(BENCH.find(([k]) => k === pick))} ${pct(b)}` : "比較標的：資料讀不到"),
      pick && el("span", {}, `差距 ${a - b >= 0 ? "+" : "−"}${Math.abs(a - b).toFixed(1)} 個百分點`),
      pick && lastDay[pick] < perf.last && el("span", {}, `${name} 資料只到 ${shortDate(lastDay[pick])}`),
      perf.xirr != null && el("span", {}, `XIRR（首筆起、年化）${pct(perf.xirr * 100)}`)].filter(Boolean));
    whyView(attribution(perf, dates[i0], trAt));
    return chart;
  };
  const mount = mountChart(box, ctx.alive, draw);
  ctx.onChange(() => mount.redraw());
  chipText();

  // R14：組合算到哪一天、美股收盤與匯率停在哪一天（不是正常才顯示）
  const asOf = perf.asOf || {};
  const perfStatus = statusLine([
    { kind: S.tw(perf.last), what: "組合算到", when: perf.last.replaceAll("-", "/") },
    asOf.us && { kind: S.us(asOf.us), what: "美股收盤", when: shortDate(asOf.us), note: S.us(asOf.us) === "stale" ? "之後的日子沿用這天的價格" : null },
    asOf.fx && { kind: S.fx(asOf.fx), what: "匯率", when: shortDate(asOf.fx) },
    trOk && { kind: S.tw(tr.at(-1).date), what: "加權報酬指數", when: shortDate(tr.at(-1).date) }], { closed: false });
  const noDivList = BENCH.filter(([k]) => series[k] && noDiv(k)).map(([k]) => k);
  return card("投資報酬率對比較標的", chips, perfStatus, box, stats, why,
    problems.length > 0 && notice("warn", `讀不到比較標的：${problems.join("；")}。`),
    !perf.divsKnown && notice("warn", "讀不到配息資料：台股 ETF 的現金股利這次沒有算進來，報酬可能少算。"),
    el("p", { class: "tiny" }, `範圍：已投入部位（帳本交易紀錄還原的持股），不含可用資金與其他現金。曲線是時間加權報酬：扣掉每次買進、賣出的影響，只看持股本身的漲跌與股利。`
      + `比較線可以選：加權報酬指數（含股利）、0050、009816、00981A；ETF 用收盤價加除息的現金股利逐日連乘（稅前），跟組合同一個算法。`
      + (noDivList.length ? `${noDivList.join("、")} 沒有配息資料，只用價格，所以選項上標「（不含股利）」；之後有配息資料會自動算進來。` : "")
      + `組合裡有美股，跟台股比較的差距也包含台美配置與匯率，不等於選股能力。算到 ${perf.last}。`),
    perfMethod(perf));
}

// 算法與假設（R08）：寫具體做法，不寫「符合某某標準」
export function perfMethod(perf) {
  const divLine = perf.divTotal > 0
    ? `這段期間計入 ${perf.dividends.map((x) => `${x.code} ${shortDate(x.exDate)} 除息 ${x.cash} 元 × ${shares(x.shares)} 股`).join("、")}，合計 ${twd(perf.divTotal)}。`
    : `你持有的期間還沒有遇到台股 ETF 除息（${Object.entries(perf.exInfo || {}).map(([c, x]) => (!x.count ? `${c} 沒有配息紀錄`
      : `${c} 最近一次除息 ${shortDate(x.last)}${x.last < x.firstBuy ? `，在你 ${shortDate(x.firstBuy)} 第一次買進之前` : ""}`)).join("；")}），所以目前的數字不受影響；之後除息會自動算進來。`;
  return el("details", { class: "more" }, el("summary", {}, "算法與假設"),
    el("ul", { class: "small" },
      el("li", {}, "每天＝一個台股交易日的收盤。單日報酬＝（收盤市值 − 當天買進金額 ＋ 當天賣出金額 ＋ 當天除息的現金股利）÷ 前一天收盤市值，逐日連乘就是時間加權報酬。"),
      el("li", {}, "買進、賣出都當作在當天收盤發生：買進當天成交價到收盤價的差與手續費算在那一天；第一筆買進那天只建立部位，從那天收盤起算。賣出拿回的錢與股利都算離開這個部位（回到可用資金），所以只投入、價格不動時報酬是 0。"),
      el("li", {}, "台股 ETF 股利：帳本「交易紀錄」只有買進、賣出，沒有記股利；這裡用 market-data 的配息資料（每單位現金）× 除息日前一天收盤時的持股，在除息日計入，稅前、未扣二代健保補充保費。", divLine),
      el("li", {}, "美股股利：market-data 的美股日線是 Yahoo 與 MoneyDJ 的收盤（只調整分割，不含股利），所以美股配息改看帳本「其他入帳」分頁——記了的配息（扣稅後實收的台幣）與手續費折抵算進報酬、損益與 XIRR，沒記的那幾天報酬會少算一點。"),
      el("li", {}, "估值時點：美股用不晚於當天日期的最後一個美國收盤（美國收盤在台北隔天清晨），乘當天（或之前最近一天）的美元兌台幣市場中間價；同一個日期的台股與美股收盤相差約 15 小時。帳本沒有台幣金額的美股買進，投入金額用買進當天的參考匯率換算。"),
      el("li", {}, "XIRR：照每筆投入、拿回、股利的日期與金額，加上最後的收盤市值，算出的年化報酬；投資未滿一年時，年化會放大短期的漲跌。"),
      el("li", {}, "這是照上面的假設在瀏覽器算的，不是任何績效標準的符合聲明，也不是投資建議。")));
}
