// K 線買點圖：日 K、均線（美股 MA50／MA200、台股 MA20／MA60）、最新三個買區色帶、交易紀錄的成交標記。
// 一次顯示一檔，上方切換；Lightweight Charts 只在這頁才載入。
import { loadArchive, latestRun, loadDaily, loadTrades, loadIntraday, DataError } from "../data.js";
import { el, price, shares, shortDate, zoneText, badge, distText } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { MA, NAMES, MARKET_LABEL } from "../config.js";

const LW_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
const LW_SRI = "sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN";
const VISIBLE_BARS = 130; // 預設顯示約半年，均線用全部資料算

// 讀不到晨報存檔時的備用清單（沒有買區）
const FALLBACK = {
  us: ["VOO", "GOOGL", "NVDA", "TSLA", "SPCX", "AAPL", "IAUM", "ARKK", "ARKQ", "ARKX"],
  tw: ["009816", "00981A", "00411A"],
};

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
  root.append(pageHeader("K 線買點圖", "日 K＋均線，色帶是最新一次晨報的買區，箭頭是交易紀錄的成交。"));
  slot(root, () => view(arg, alive));
}

async function view(arg, alive) {
  let archive = null, archiveError = null;
  try {
    archive = await loadArchive();
  } catch (e) {
    archiveError = e;
  }
  const lists = {};
  for (const m of ["tw", "us"]) {
    const run = archive && latestRun(archive, m);
    lists[m] = run ? run.json.tickers.map((t) => ({ ...t, market: m, run })) : FALLBACK[m].map((code) => ({ code, market: m }));
  }
  const all = [...lists.tw, ...lists.us];
  const pick = all.find((t) => t.code === arg)
    || all.find((t) => ["z3", "z2", "z1", "starter"].includes(t.level) && t.role === "buy") || all[0];

  const chips = ["tw", "us"].map((m) => el("div", { class: "chip-row" },
    el("span", { class: "tiny" }, MARKET_LABEL[m]),
    el("div", { class: "chips" }, lists[m].map((t) => el("a", {
      class: "chip", href: `#/charts/${encodeURIComponent(t.code)}`, role: "button", "aria-pressed": String(t.code === pick.code),
    }, t.code)))));

  const box = el("div", { class: "chart-box", role: "img", "aria-label": `${pick.code} 日 K 線圖` });
  const ohlc = el("div", { class: "ohlc" });
  const legend = el("div", { class: "chart-legend" });
  const table = el("div");
  const head = el("div", { class: "spread" },
    el("div", { class: "row" }, el("strong", { class: "tk-code" }, pick.code), el("span", { class: "tk-name" }, NAMES[pick.code] || ""),
      pick.level && badge(pick.level, pick.status)),
    pick.run && el("span", { class: "tiny" }, `買區：${MARKET_LABEL[pick.market]}晨報 ${shortDate(pick.run.dataDate)}`));

  const section = card(null, head, ohlc, box, legend,
    pick.zones && el("div", { class: "small muted" }, `距第一買區上緣：${distText(pick.dist_to_z1_pct)}`),
    table);
  const warn = archiveError && notice("warn", `讀不到晨報存檔（${archiveError.message}），圖上沒有買區。`);

  // 資料與函式庫都到齊才畫；其中一項失敗就在圖的位置顯示原因
  const [LW, bars, tradesR, intraR] = await Promise.all([
    loadLW(), loadDaily(pick.market, pick.code),
    loadTrades().then((v) => ({ v }), (e) => ({ e })),
    pick.market === "tw" ? loadIntraday().catch(() => null) : null,
  ]);
  const trades = tradesR.v ? tradesR.v.filter((t) => t.code === pick.code) : [];
  const ctx = { LW, bars, pick, trades, intraday: intraR?.quotes?.[pick.code], box, ohlc, legend, table };
  // 等 slot 把元素放進頁面後再畫（不用 requestAnimationFrame：分頁在背景時不會觸發）
  setTimeout(() => {
    let chart = draw(ctx);
    const onTheme = () => {
      if (!alive() || !box.isConnected) {
        document.removeEventListener("themechange", onTheme);
        chart?.remove();
        return;
      }
      chart.remove();
      chart = draw(ctx);
    };
    document.addEventListener("themechange", onTheme);
  }, 0);
  return [warn, el("div", { class: "card" }, chips), section,
    tradesR.e && notice("warn", `讀不到交易紀錄（${tradesR.e.message}），圖上沒有成交標記。`)];
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

// 買區色帶：畫在 K 棒後面；自動縮放把買區也算進去，深度買區離現價遠也看得到
class ZoneBands {
  constructor(bands) {
    this.bands = bands;
    this.series = null;
  }
  attached({ series }) {
    this.series = series;
  }
  detached() {
    this.series = null;
  }
  updateAllViews() {}
  autoscaleInfo() {
    if (!this.bands.length) return null;
    return { priceRange: { minValue: Math.min(...this.bands.map((b) => b.lo)), maxValue: Math.max(...this.bands.map((b) => b.hi)) } };
  }
  paneViews() {
    const self = this;
    return [{
      zOrder: () => "bottom",
      renderer: () => ({
        draw() {},
        drawBackground(target) {
          if (!self.series) return;
          target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio }) => {
            for (const b of self.bands) {
              const y1 = self.series.priceToCoordinate(b.hi), y2 = self.series.priceToCoordinate(b.lo);
              if (y1 == null || y2 == null) continue;
              const top = Math.round(Math.min(y1, y2) * verticalPixelRatio);
              const h = Math.max(1, Math.round(Math.abs(y2 - y1) * verticalPixelRatio));
              context.fillStyle = b.fill;
              context.fillRect(0, top, bitmapSize.width, h);
            }
          });
        },
      }),
    }];
  }
}

const ZONES = [["starter", "起始倉區"], ["z1", "第一買區"], ["z2", "第二買區"], ["z3", "深度買區"]];
const ZONE_ALPHA = { starter: 0.08, z1: 0.12, z2: 0.26, z3: 0.42 };

function draw({ LW, bars, pick, trades, intraday, box, ohlc, legend, table }) {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const band = v("--band");
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

  // 買區：色帶＋上緣虛線（台股已持有時不畫起始倉區）
  const zones = ZONES.filter(([k]) => pick.zones?.[k] && !(k === "starter" && pick.held));
  candles.attachPrimitive(new ZoneBands(zones.map(([k]) => ({
    lo: pick.zones[k][0], hi: pick.zones[k][1], fill: `rgba(${band}, ${ZONE_ALPHA[k]})`,
  }))));
  for (const [k, label] of zones) {
    candles.createPriceLine({ price: pick.zones[k][1], color: `rgba(${band}, .9)`, lineWidth: 1,
      lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false, title: label });
  }
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

  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 3 });

  // 游標所在那天的開高低收與均線；離開圖時顯示最後一天
  const maAt = (list, time) => list.find((x) => x.time === time)?.value;
  const show = (bar) => {
    const chg = bar.prev ? ((bar.close - bar.prev) / bar.prev) * 100 : null;
    ohlc.replaceChildren(el("span", {}, `${bar.time.replace(/-/g, "/")}　開 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 `,
      el("strong", { class: chg == null ? "" : chg >= 0 ? "up" : "down" }, price(bar.close)),
      chg == null ? "" : `（${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%）`));
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
    ...zones.map(([k, label]) => el("span", {}, el("i", { class: "bx", style: { background: `rgba(${band}, ${ZONE_ALPHA[k] + 0.2})` } }),
      `${label} ${zoneText(pick.zones[k])}`)),
    marks.length ? el("span", {}, el("span", { style: { color: v("--marker") } }, "▲ "), `成交 ${marks.length} 筆`) : null,
  ].filter(Boolean));

  // 數據表（最近 20 個交易日），給不方便看圖的情況
  const rows = bars.slice(-20).reverse();
  table.replaceChildren(el("details", { class: "more" }, el("summary", {}, "數據表（最近 20 個交易日）"),
    el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
      el("thead", {}, el("tr", {}, ["日期", "開", "高", "低", "收", `MA${n1}`, `MA${n2}`].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
      el("tbody", {}, rows.map((b) => el("tr", {}, el("td", {}, b.time),
        [b.open, b.high, b.low, b.close, maAt(ma1, b.time), maAt(ma2, b.time)].map((x) =>
          el("td", { class: "r" }, x == null ? "—" : price(+x.toFixed(2)))))))))));
  return chart;
}
