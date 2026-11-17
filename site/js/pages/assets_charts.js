// 資產頁的時間序列圖（Lightweight Charts，可縮放平移）：資產走勢、累計損益與每日損益。
// 一整塊共用 ctx 的期間選擇（pages/assets.js）：換期間時各卡 ctx.onChange 的函式會被呼叫，重新設定資料與可見範圍。
import { loadSettings, loadTrades, loadHoldings, loadDaily, loadDca, loadFx } from "../data.js";
import { assetTrend } from "../cash.js";
import { loadPerformance } from "../perf.js";
import { periodStart, periodPnl, daysFrom, periodLabel } from "../assets.js";
import { el, twd, signed, tone, shortDate, isNum } from "../fmt.js";
import { card, notice } from "../ui.js";
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
    const [settings, trades, holdings, dca] = await Promise.all([loadSettings(), loadTrades(), loadHoldings(), loadDca().catch(() => null)]);
    const kinds = new Map();
    for (const h of holdings) kinds.set(`${h.market}:${h.code}`, h);
    for (const t of trades) if (t.side === "買進" || t.side === "賣出") kinds.set(`${t.market}:${t.code}`, t);
    const need = [...kinds.values()];
    const loaded = await Promise.all(need.map((x) => loadDaily(x.market, x.code).catch(() => null)));
    const bars = Object.fromEntries(need.map((x, i) => [x.code, loaded[i]]).filter(([, b]) => b));
    const fxRows = need.some((x) => x.market === "us") ? await loadFx().catch(() => null) : null;
    const unread = need.filter((x, i) => !loaded[i]).map((x) => `${x.code} 的日線`);
    return { a: assetTrend({ settings, trades, holdings, bars, fxRows, dca }), unread };
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
    el("p", { class: "tiny" }, "損益含手續費與匯率變動、含已領的台股 ETF 現金股利（稅前）。每日損益＝當天收盤市值 − 前一天收盤市值 − 當天投入（賣出算負的）＋ 當天股利；"
      + "累計損益從期間的第一天歸 0（選「全部」時第一天買進當天的損益也算），所以全部期間的累計損益＝持倉市值 − 累計投入 ＋ 已領股利。"
      + "上下兩張圖的時間軸一起縮放、平移。"));
}
