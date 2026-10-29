// K 線：日 K、均線（美股 MA50／MA200、台股 MA20／MA60）、交易紀錄的成交標記，RSI14／KDJ 副圖（預設收起）。
// 一次顯示一檔，上方切換；Lightweight Charts 只在這頁才載入。2026-10-30 轉型後拿掉買區色帶（PIVOT 第 7 節）。
import { loadDaily, loadTrades, loadIntraday, DataError } from "../data.js";
import { el, price, shares } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { MA, NAMES, MARKET_LABEL, TRACK } from "../config.js";

const LW_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
const LW_SRI = "sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN";
const VISIBLE_BARS = 130; // 預設顯示約半年，均線用全部資料算

let lwPromise = null;
function loadLW() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  lwPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LW_URL;
    s.integrity = LW_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => {
      lwPromise = null;
      s.remove();
      reject(new DataError("K 線圖函式庫", "載入失敗（可能離線或 CDN 被擋）"));
    };
    document.head.append(s);
  });
  return lwPromise;
}

export async function render(root, { arg, alive }) {
  root.append(pageHeader("K 線", "日 K＋均線，箭頭是交易紀錄的成交；RSI14／KDJ 副圖可以打開。"));
  slot(root, () => view(arg, alive));
}

async function view(arg, alive) {
  const lists = { tw: TRACK.tw.map((code) => ({ code, market: "tw" })), us: TRACK.us.map((code) => ({ code, market: "us" })) };
  const all = [...lists.tw, ...lists.us];
  const pick = all.find((t) => t.code === arg) || all[0];

  const chips = ["tw", "us"].map((m) => el("div", { class: "chip-row" },
    el("span", { class: "tiny" }, MARKET_LABEL[m]),
    el("div", { class: "chips" }, lists[m].map((t) => el("a", {
      class: "chip", href: `#/charts/${encodeURIComponent(t.code)}`, role: "button", "aria-pressed": String(t.code === pick.code),
    }, t.code)))));

  const box = el("div", { class: "chart-box", role: "img", "aria-label": `${pick.code} 日 K 線圖` });
  const ohlc = el("div", { class: "ohlc" });
  const legend = el("div", { class: "chart-legend" });
  const table = el("div");
  const head = el("div", { class: "row" }, el("strong", { class: "tk-code" }, pick.code), el("span", { class: "tk-name" }, NAMES[pick.code] || ""));

  // 副圖開關（預設收起，記在這個瀏覽器）
  let showInd = store(IND_KEY) === "on";
  const toggle = el("button", { class: "chip", type: "button", "aria-pressed": String(showInd) }, "RSI／KDJ 副圖");
  box.classList.toggle("with-ind", showInd);
  const note = el("p", { class: "tiny" },
    "RSI14（日收盤，Wilder 平滑）與 KDJ(9,3,3) 只是參考，不是配置紀律的一部分。");
  const section = card(null, head, el("div", { class: "row", style: { marginTop: "6px" } }, toggle), ohlc, box, legend, note, table);

  // 資料與函式庫都到齊才畫；其中一項失敗就在圖的位置顯示原因
  const [LW, bars, tradesR, intraR] = await Promise.all([
    loadLW(), loadDaily(pick.market, pick.code),
    loadTrades().then((v) => ({ v }), (e) => ({ e })),
    pick.market === "tw" ? loadIntraday().catch(() => null) : null,
  ]);
  const trades = tradesR.v ? tradesR.v.filter((t) => t.code === pick.code) : [];
  const ctx = { LW, bars, pick, trades, intraday: intraR?.quotes?.[pick.code], box, ohlc, legend, table,
    rsi: rsi14(bars), kdj: kdj(bars), showInd };
  // 等 slot 把元素放進頁面後再畫（不用 requestAnimationFrame：分頁在背景時不會觸發）
  setTimeout(() => {
    let chart = draw(ctx);
    const redraw = () => {
      chart?.remove();
      chart = draw(ctx);
    };
    const onTheme = () => {
      if (!alive() || !box.isConnected) {
        document.removeEventListener("themechange", onTheme);
        chart?.remove();
        return;
      }
      redraw();
    };
    document.addEventListener("themechange", onTheme);
    toggle.addEventListener("click", () => {
      showInd = ctx.showInd = !ctx.showInd;
      store(IND_KEY, showInd ? "on" : "off");
      toggle.setAttribute("aria-pressed", String(showInd));
      box.classList.toggle("with-ind", showInd);
      redraw();
    });
  }, 0);
  return [el("div", { class: "card" }, chips), section,
    tradesR.e && notice("warn", `讀不到交易紀錄（${tradesR.e.message}），圖上沒有成交標記。`)];
}

const IND_KEY = "charts.indicators";
function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    return null;
  }
}

// RSI14：和 engine/monitor.py、monitor_us.py 的 indicators() 相同——
// d = close.diff()；漲幅、跌幅各用 ewm(alpha=1/14, adjust=False, min_periods=14)；RSI = 100 − 100/(1+au/ad)。
// adjust=False 的遞迴從第一個有效值（第一筆 diff）開始，第 14 個 diff 起才有值。回傳 Map(日期 → RSI)
export function rsi14(bars) {
  const out = new Map();
  const a = 1 / 14;
  let au = null, ad = null;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (au === null) {
      au = g;
      ad = l;
    } else {
      au = (1 - a) * au + a * g;
      ad = (1 - a) * ad + a * l;
    }
    if (i >= 14) {
      const v = ad === 0 ? (au === 0 ? null : 100) : 100 - 100 / (1 + au / ad);
      if (v != null) out.set(bars[i].time, v);
    }
  }
  return out;
}

// KDJ(9,3,3)，台灣券商慣用：RSV＝(收−9日最低)÷(9日最高−9日最低)×100（分母為 0 沿用前一個 RSV）；
// K＝2/3 前K＋1/3 RSV、D＝2/3 前D＋1/3 K，起始 K＝D＝50；J＝3K−2D。回傳 Map(日期 → {k, d, j})
export function kdj(bars, n = 9) {
  const out = new Map();
  let k = 50, d = 50, rsv = 50;
  for (let i = n - 1; i < bars.length; i++) {
    const win = bars.slice(i - n + 1, i + 1);
    const hi = Math.max(...win.map((b) => b.high)), lo = Math.min(...win.map((b) => b.low));
    if (hi > lo) rsv = ((bars[i].close - lo) / (hi - lo)) * 100;
    k = (2 / 3) * k + rsv / 3;
    d = (2 / 3) * d + k / 3;
    out.set(bars[i].time, { k, d, j: 3 * k - 2 * d });
  }
  return out;
}


function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: +(sum / n).toFixed(4) });
  }
  return out;
}

function draw({ LW, bars, pick, trades, intraday, box, ohlc, legend, table, rsi, kdj: kd, showInd }) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const [n1, n2] = MA[pick.market];
  const chart = LW.createChart(box, {
    autoSize: true,
    layout: { background: { type: LW.ColorType.Solid, color: v("--surface") }, textColor: v("--ink-2"), fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { visible: false }, horzLines: { color: v("--line") } },
    rightPriceScale: { borderColor: v("--axis") },
    timeScale: { borderColor: v("--axis"), rightOffset: 4 },
    crosshair: { mode: LW.CrosshairMode.Normal },
    localization: { locale: "zh-TW", dateFormat: "yyyy/MM/dd" },
  });
  const up = v("--candle-up"), down = v("--candle-down");
  const candles = chart.addSeries(LW.CandlestickSeries, {
    upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
  });
  candles.setData(bars);
  const lineOpts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const ma1 = sma(bars, n1), ma2 = sma(bars, n2);
  chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--ma1") }).setData(ma1);
  if (ma2.length) chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--ma2") }).setData(ma2);

  if (intraday?.is_today && Number.isFinite(intraday.price)) {
    candles.createPriceLine({ price: intraday.price, color: v("--ink-2"), lineWidth: 1, lineStyle: LW.LineStyle.Dotted,
      axisLabelVisible: true, title: `盤中 ${(intraday.time || "").slice(11, 16)}` });
  }

  // 成交標記：只標在有 K 棒的日子
  const days = new Set(bars.map((b) => b.time));
  const marks = trades.filter((t) => days.has(t.date)).sort((a, b) => a.date.localeCompare(b.date)).map((t) => {
    const buy = t.side !== "賣出";
    return { time: t.date, position: buy ? "belowBar" : "aboveBar", shape: buy ? "arrowUp" : "arrowDown",
      color: v("--marker"), text: `${buy ? "買" : "賣"} ${shares(t.shares)}` };
  });
  if (marks.length) LW.createSeriesMarkers(candles, marks);

  if (showInd) drawIndicators(LW, chart, v, rsi, kd);

  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 3 });

  // 游標所在那天的開高低收與均線；離開圖時顯示最後一天
  const maAt = (list, time) => list.find((x) => x.time === time)?.value;
  const show = (bar) => {
    const chg = bar.prev ? ((bar.close - bar.prev) / bar.prev) * 100 : null;
    ohlc.replaceChildren(el("span", {}, `${bar.time.replace(/-/g, "/")}　開 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 `,
      el("strong", { class: chg == null ? "" : chg >= 0 ? "up" : "down" }, price(bar.close)),
      chg == null ? "" : `（${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%）`),
      el("span", { class: "ind-read" }, indText(rsi.get(bar.time), kd.get(bar.time))));
  };
  const withPrev = (i) => ({ ...bars[i], prev: bars[i - 1]?.close });
  show(withPrev(bars.length - 1));
  const index = new Map(bars.map((b, i) => [b.time, i]));
  chart.subscribeCrosshairMove((p) => {
    const i = p.time ? index.get(p.time) : undefined;
    show(withPrev(i ?? bars.length - 1));
  });

  const last = bars.at(-1);
  const fmtMa = (list) => {
    const x = maAt(list, last.time);
    return x == null ? "資料不足" : price(+x.toFixed(2));
  };
  legend.replaceChildren(...[
    el("span", {}, el("i", { class: "sw", style: { background: v("--ma1") } }), `MA${n1} ${fmtMa(ma1)}`),
    el("span", {}, el("i", { class: "sw", style: { background: v("--ma2") } }), `MA${n2} ${fmtMa(ma2)}`),
    marks.length ? el("span", {}, el("span", { style: { color: v("--marker") } }, "▲ "), `成交 ${marks.length} 筆`) : null,
  ].filter(Boolean));

  // 數據表（最近 20 個交易日），給不方便看圖的情況
  const rows = bars.slice(-20).reverse();
  table.replaceChildren(el("details", { class: "more" }, el("summary", {}, "數據表（最近 20 個交易日）"),
    el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
      el("thead", {}, el("tr", {}, ["日期", "開", "高", "低", "收", `MA${n1}`, `MA${n2}`, "RSI14", "K", "D", "J"]
        .map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
      el("tbody", {}, rows.map((b) => {
        const kk = kd.get(b.time);
        return el("tr", {}, el("td", {}, b.time),
          [b.open, b.high, b.low, b.close, maAt(ma1, b.time), maAt(ma2, b.time)].map((x) =>
            el("td", { class: "r" }, x == null ? "—" : price(+x.toFixed(2)))),
          [rsi.get(b.time), kk?.k, kk?.d, kk?.j].map((x) => el("td", { class: "r" }, x == null ? "—" : x.toFixed(1))));
      }))))));
  return chart;
}

const fmt1 = (x) => (x == null ? "—" : x.toFixed(1));
function indText(r, k) {
  return `RSI14 ${fmt1(r)}　K ${fmt1(k?.k)}　D ${fmt1(k?.d)}　J ${fmt1(k?.j)}`;
}

// 副圖：RSI14（至少 0～100，70／30 參考線）與 KDJ（80／20 參考線）
function drawIndicators(LW, chart, v, rsi, kd) {
  const lineOpts = { lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: true,
    priceFormat: { type: "price", precision: 1, minMove: 0.1 } };
  const atLeast = (lo, hi) => (orig) => {
    const r = orig();
    return { priceRange: { minValue: Math.min(lo, r?.priceRange?.minValue ?? lo), maxValue: Math.max(hi, r?.priceRange?.maxValue ?? hi) } };
  };
  const ref = (s, price, title, color, style) => s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style,
    axisLabelVisible: false, title });

  const rsiS = chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--accent"), title: "RSI14",
    autoscaleInfoProvider: atLeast(0, 100) }, 1);
  rsiS.setData([...rsi].map(([time, value]) => ({ time, value })));
  const refColor = v("--muted");
  ref(rsiS, 30, "30", refColor, LW.LineStyle.Solid);
  ref(rsiS, 70, "70", refColor, LW.LineStyle.Solid);

  const data = [...kd];
  const kS = chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--ma1"), title: "K", autoscaleInfoProvider: atLeast(0, 100) }, 2);
  kS.setData(data.map(([time, x]) => ({ time, value: x.k })));
  chart.addSeries(LW.LineSeries, { ...lineOpts, color: v("--ma2"), title: "D" }, 2).setData(data.map(([time, x]) => ({ time, value: x.d })));
  chart.addSeries(LW.LineSeries, { ...lineOpts, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, color: v("--ink-2"), title: "J" }, 2)
    .setData(data.map(([time, x]) => ({ time, value: x.j })));
  ref(kS, 80, "80", refColor, LW.LineStyle.Solid);
  ref(kS, 20, "20", refColor, LW.LineStyle.Solid);
  // 副圖上下留白小一點，RSI 軸才會接近 0～100
  for (const s of [rsiS, kS]) s.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.06 } });

  // 主圖：RSI：KDJ＝3：1：1（用比例，畫面縮放時跟著調整）
  chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
}
