// K 線：日 K、均線（美股 MA50／MA200、台股 MA20／MA60）、交易紀錄的成交標記；副圖一次一種（成交量、MACD、DMI、乖離率、RSI，
// 預設收起），圖下有技術面白話描述。KDJ 2026-11-07 拿掉（使用者：太敏感）。
// 一次顯示一檔，上方切換；Lightweight Charts 只在這頁才載入。2026-10-30 轉型後拿掉買區色帶（PIVOT 第 7 節）。
import { loadDaily, loadTrades, loadIndex, DataError } from "../data.js";
import { fugleQuote, fugleUsable, fugleClosed, fugleBar, quoteTime, FUGLE_NOTE } from "../fugle.js";
import { loadPerformance, attribution } from "../perf.js";
import { el, price, shares, pct, twd, tone, shortDate } from "../fmt.js";
import { sma, rsi14, macd, dmi, bias, volAvg, fmtVol, describe } from "../ta.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { MA, NAMES, MARKET_LABEL, TRACK } from "../config.js";
import { loadStatus, statusLine } from "../status.js";

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
  root.append(pageHeader("K 線", "組合對大盤，以及各標的日 K＋均線（箭頭是交易紀錄的成交；副圖可以選成交量、MACD、DMI、乖離率、RSI）。"));
  slot(root, () => perfView(alive));
  slot(root, () => view(arg, alive));
}

// ── 組合對大盤（PIVOT 第 6 節）：時間加權報酬（扣掉投入的影響）對台股加權報酬指數，另列 XIRR ──
const PERIODS = [["all", "首筆買進起"], ["3m", "3 個月"], ["6m", "6 個月"], ["ytd", "今年"]];
let period = "all";

function periodStart(key, first, last) {
  const d = new Date(`${last}T00:00:00Z`);
  if (key === "3m") d.setUTCMonth(d.getUTCMonth() - 3);
  else if (key === "6m") d.setUTCMonth(d.getUTCMonth() - 6);
  else if (key === "ytd") d.setUTCMonth(0, 1);
  else return first;
  const s = d.toISOString().slice(0, 10);
  return s < first ? first : s;
}

async function perfView(alive) {
  const [LW, perf, tr, S] = await Promise.all([loadLW(), loadPerformance(), loadIndex("TAIEX_TR").catch((e) => e), loadStatus()]);
  const box = el("div", { class: "perf-box", role: "img", "aria-label": "組合與加權報酬指數的累積報酬折線圖" });
  const stats = el("div", { class: "chart-legend" });
  const chips = el("div", { class: "chips", style: { margin: "4px 0 0" } });
  const trOk = Array.isArray(tr);
  const trAt = (d) => {
    if (!trOk) return null;
    let v = null;
    for (const x of tr) {
      if (x.date > d) break;
      v = x.value;
    }
    return v;
  };
  let chart = null;
  const draw = () => {
    chart?.remove();
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const start = periodStart(period, perf.first, perf.last);
    const days = perf.days.filter((x) => x.date >= start);
    const base = days[0], trBase = trAt(base.date);
    const mine = days.map((x) => ({ time: x.date, value: (x.index / base.index - 1) * 100 }));
    const bench = trBase ? days.map((x) => ({ time: x.date, value: (trAt(x.date) / trBase - 1) * 100 })) : [];
    chart = LW.createChart(box, {
      autoSize: true,
      layout: { background: { type: LW.ColorType.Solid, color: v("--surface") }, textColor: v("--ink-2"), fontSize: 11,
        fontFamily: getComputedStyle(document.body).fontFamily },
      grid: { vertLines: { visible: false }, horzLines: { color: v("--line") } },
      rightPriceScale: { borderColor: v("--axis") },
      timeScale: { borderColor: v("--axis") },
      localization: { locale: "zh-TW", dateFormat: "yyyy/MM/dd" },
    });
    const fmt = { type: "custom", formatter: (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`, minMove: 0.1 };
    const opts = { lineWidth: 2, priceLineVisible: false, priceFormat: fmt };
    chart.addSeries(LW.LineSeries, { ...opts, color: v("--accent"), title: "我的組合" }).setData(mine);
    if (bench.length) chart.addSeries(LW.LineSeries, { ...opts, color: v("--ma1"), title: "加權報酬指數" }).setData(bench);
    chart.timeScale().fitContent();
    const a = mine.at(-1).value, b = bench.at(-1)?.value;
    stats.replaceChildren(
      el("span", {}, el("i", { class: "sw", style: { background: v("--accent") } }), `我的組合 ${pct(a)}`),
      el("span", {}, el("i", { class: "sw", style: { background: v("--ma1") } }), bench.length ? `加權報酬指數 ${pct(b)}` : "加權報酬指數：資料準備中"),
      bench.length ? el("span", {}, `差距 ${a - b >= 0 ? "+" : "−"}${Math.abs(a - b).toFixed(1)} 個百分點`) : null,
      perf.xirr != null ? el("span", {}, `XIRR（首筆起、年化）${pct(perf.xirr * 100)}`) : null);
    whyView(attribution(perf, start, trAt));
  };
  // 為什麼輸（贏）大盤：摺疊，跟著期間切換重算（docs/INSIGHTS.md 4.2）
  const why = el("details", { class: "more" });
  const whyView = (at) => {
    if (!at) {
      why.replaceChildren();
      return;
    }
    const lose = at.diff < 0;
    const pp = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
    const gap = at.value - at.same;
    why.replaceChildren(el("summary", {}, lose ? "為什麼輸大盤" : "為什麼贏大盤"),
      el("p", { class: "small" }, `這段期間${lose ? "落後" : "領先"}大盤 ${Math.abs(at.diff).toFixed(1)} 個百分點（時間加權）。各檔的影響（個百分點）：`),
      el("ul", { class: "small" }, at.by.map((x) => el("li", {},
        `${x.code} ${NAMES[x.code] || ""}${x.market === "us" ? "（含匯率）" : ""}：`,
        el("strong", { class: tone(x.pp) }, pp(x.pp)))),
        Math.abs(at.other) >= 0.05 && el("li", {}, "其他（買進當天成交價與收盤價的差、手續費）：", el("strong", { class: tone(at.other) }, pp(at.other)))),
      el("p", { class: "small" }, `同樣的錢在同樣的日子改買加權報酬指數，現在約 ${twd(at.same)}；你的組合是 ${twd(at.value)}，${gap >= 0 ? "多" : "少"} ${twd(Math.abs(gap))}（這個差距也包含投入時點的影響）。`),
      el("p", { class: "tiny" }, "每一檔＝它每天占組合的比重 ×（它當天的報酬 − 大盤當天的報酬），整段期間加總；負數是把你拉離大盤、正數是幫你超前。加總等於上面的差距。美股的報酬含美元兌台幣的變化。"));
  };
  for (const [k, label] of PERIODS) {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": String(k === period) }, label);
    b.addEventListener("click", () => {
      period = k;
      for (const x of chips.children) x.setAttribute("aria-pressed", String(x === b));
      draw();
    });
    chips.append(b);
  }
  setTimeout(() => {
    draw();
    const onTheme = () => {
      if (!alive() || !box.isConnected) {
        document.removeEventListener("themechange", onTheme);
        chart?.remove();
        return;
      }
      draw();
    };
    document.addEventListener("themechange", onTheme);
  }, 0);
  // R14：組合算到哪一天、美股收盤與匯率停在哪一天（不是正常才顯示）
  const asOf = perf.asOf || {};
  const perfStatus = statusLine([
    { kind: S.tw(perf.last), what: "組合算到", when: perf.last.replaceAll("-", "/") },
    asOf.us && { kind: S.us(asOf.us), what: "美股收盤", when: shortDate(asOf.us), note: S.us(asOf.us) === "stale" ? "之後的日子沿用這天的價格" : null },
    asOf.fx && { kind: S.fx(asOf.fx), what: "匯率", when: shortDate(asOf.fx) },
    trOk && { kind: S.tw(tr.at(-1).date), what: "加權報酬指數", when: shortDate(tr.at(-1).date) }], { closed: false });
  return card("組合對大盤", chips, perfStatus, box, stats, why,
    !trOk && notice("warn", `讀不到加權報酬指數（${tr.message}）`),
    el("p", { class: "tiny" }, `曲線是時間加權報酬（扣掉每次投入的影響，GIPS 的比較方式）：台股用日線收盤、美股用日線收盤 × 當天美元兌台幣；大盤是含股利的台股加權報酬指數。XIRR 是資金加權報酬（考慮投入時點）。算到 ${perf.last}。`));
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

  // 副圖：一次一種（預設收起，選擇記在這個瀏覽器）
  let ind = indPref();
  const indBtns = IND.map(([k, label]) => el("button", { class: "chip", type: "button", "aria-pressed": String(k === ind), "data-k": k }, label));
  box.classList.toggle("with-ind", ind !== "off");
  const taBox = el("div", { class: "ta-read" });
  const note = el("p", { class: "tiny" },
    "技術指標只描述現況，不預測；10/29 回測顯示用技術指標挑買點不比定期定額好，不是配置紀律的一部分。");
  const fugleNote = el("p", { class: "tiny", hidden: true });
  const section = card(null, head,
    el("div", { class: "row ind-row" }, el("span", { class: "tiny" }, "副圖"), el("div", { class: "chips" }, indBtns)),
    ohlc, box, legend, fugleNote, taBox, note, table);

  // 資料與函式庫都到齊才畫；其中一項失敗就在圖的位置顯示原因
  const [LW, daily, tradesR, fq, S] = await Promise.all([
    loadLW(), loadDaily(pick.market, pick.code),
    loadTrades().then((v) => ({ v }), (e) => ({ e })),
    pick.market === "tw" ? fugleQuote(pick.code) : null,
    loadStatus(),
  ]);
  // 富果比 market-data 新的那天：收盤了就補一根 K 棒（market-data 隔天早上更新後換成正式資料），盤中只畫虛線
  const lastDate = daily.at(-1)?.time;
  const fresh = fugleUsable(fq, lastDate) ? fq : null;
  const extra = fresh && fresh.date > lastDate && fugleClosed(fresh) ? fugleBar(fresh) : null;
  const bars = extra ? [...daily, extra] : daily;
  const intraday = fresh && !extra ? fresh : null;
  if (extra) {
    fugleNote.textContent = `${extra.time.slice(5).replace("-", "/")} 這根來自富果（${FUGLE_NOTE}）；market-data 隔天早上更新後換成正式資料。`;
    fugleNote.hidden = false;
  }
  // R14：最後一根 K 棒的日期不是正常時標在圖上方（休市用最近交易日是正常的）
  const lastBar = bars.at(-1).time;
  const kind = pick.market === "us" ? S.us(lastBar) : S.tw(lastBar);
  const exp = pick.market === "us" ? S.expect.us : S.expect.tw;
  const st = statusLine([{ kind, what: "日線", when: `最後一根 ${shortDate(lastBar)}${extra ? "（富果）" : ""}`,
    note: kind === "stale" ? `應該已經有 ${shortDate(exp)} 的收盤，market-data 還沒更新` : kind === "closed" ? (pick.market === "us" ? "美股週末或假日休市" : "今天台股休市") : null }]);
  if (st) head.after(st);
  const mas = MA[pick.market];
  const lines = describe(bars, pick.market, mas);
  if (lines.length) {
    taBox.replaceChildren(el("strong", {}, `技術面（${bars.at(-1).time.slice(5).replace("-", "/")}）`),
      el("dl", { class: "hl-why" }, lines.map(({ k, t }) => el("div", {}, el("dt", {}, k), el("dd", {}, t)))));
  }
  const trades = tradesR.v ? tradesR.v.filter((t) => t.code === pick.code) : [];
  const ctx = { LW, bars, pick, trades, intraday, box, ohlc, legend, table, ind, calc: indicators(bars, mas) };
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
    for (const b of indBtns) {
      b.addEventListener("click", () => {
        ind = ctx.ind = b.dataset.k;
        store(IND_KEY, ind);
        for (const x of indBtns) x.setAttribute("aria-pressed", String(x === b));
        box.classList.toggle("with-ind", ind !== "off");
        redraw();
      });
    }
  }, 0);
  return [el("div", { class: "card" }, chips), section,
    tradesR.e && notice("warn", `讀不到交易紀錄（${tradesR.e.message}），圖上沒有成交標記。`)];
}

const IND_KEY = "charts.indicators";
const IND = [["off", "關"], ["vol", "成交量"], ["macd", "MACD"], ["dmi", "DMI"], ["bias", "乖離率"], ["rsi", "RSI"]];
function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    return null;
  }
}
// 舊版存的是 on／off（RSI＋KDJ 副圖）：on 改成 RSI
function indPref() {
  const v = store(IND_KEY);
  if (v === "on") return "rsi";
  return IND.some(([k]) => k === v) ? v : "off";
}

function indicators(bars, [n1, n2]) {
  return { rsi: rsi14(bars), macd: macd(bars), dmi: dmi(bars), bias1: bias(bars, n1), bias2: bias(bars, n2), vavg: volAvg(bars, 20) };
}

function draw({ LW, bars, pick, trades, intraday, box, ohlc, legend, table, ind, calc }) {
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

  if (intraday && Number.isFinite(intraday.price)) {
    candles.createPriceLine({ price: intraday.price, color: v("--ink-2"), lineWidth: 1, lineStyle: LW.LineStyle.Dotted,
      axisLabelVisible: true, title: `富果 ${quoteTime(intraday).replace("今天", "").trim()}` });
  }

  // 成交標記：只標在有 K 棒的日子
  const days = new Set(bars.map((b) => b.time));
  const marks = trades.filter((t) => days.has(t.date)).sort((a, b) => a.date.localeCompare(b.date)).map((t) => {
    const buy = t.side !== "賣出";
    return { time: t.date, position: buy ? "belowBar" : "aboveBar", shape: buy ? "arrowUp" : "arrowDown",
      color: v("--marker"), text: `${buy ? "買" : "賣"} ${shares(t.shares)}` };
  });
  if (marks.length) LW.createSeriesMarkers(candles, marks);

  if (ind !== "off") drawSub(LW, chart, v, ind, bars, calc, [n1, n2], pick.market);

  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - VISIBLE_BARS), to: bars.length + 3 });

  // 游標所在那天的開高低收、成交量與選的副圖讀數；離開圖時顯示最後一天
  const maAt = (list, time) => list.find((x) => x.time === time)?.value;
  const show = (bar) => {
    const chg = bar.prev ? ((bar.close - bar.prev) / bar.prev) * 100 : null;
    ohlc.replaceChildren(el("span", {}, `${bar.time.replace(/-/g, "/")}　開 ${price(bar.open)}　高 ${price(bar.high)}　低 ${price(bar.low)}　收 `,
      el("strong", { class: chg == null ? "" : chg >= 0 ? "up" : "down" }, price(bar.close)),
      chg == null ? "" : `（${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}%）`,
      `　量 ${fmtVol(bar.volume, pick.market)}`),
      el("span", { class: "ind-read" }, readText(ind, calc, bar, [n1, n2], pick.market)));
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
  const f1 = (x) => (x == null ? "—" : x.toFixed(1));
  table.replaceChildren(el("details", { class: "more" }, el("summary", {}, "數據表（最近 20 個交易日）"),
    el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
      el("thead", {}, el("tr", {}, ["日期", "開", "高", "低", "收", "量", `MA${n1}`, `MA${n2}`, `乖離 MA${n1}`, "RSI14"]
        .map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
      el("tbody", {}, rows.map((b) => el("tr", {}, el("td", {}, b.time),
        [b.open, b.high, b.low, b.close].map((x) => el("td", { class: "r" }, price(x))),
        el("td", { class: "r" }, fmtVol(b.volume, pick.market)),
        [maAt(ma1, b.time), maAt(ma2, b.time)].map((x) => el("td", { class: "r" }, x == null ? "—" : price(+x.toFixed(2)))),
        el("td", { class: "r" }, calc.bias1.has(b.time) ? `${f1(calc.bias1.get(b.time))}%` : "—"),
        el("td", { class: "r" }, f1(calc.rsi.get(b.time))))))))));
  return chart;
}

// 游標那天的副圖讀數
function readText(ind, calc, bar, [n1, n2], market) {
  const f = (x, d = 1) => (x == null ? "—" : x.toFixed(d).replace("-", "−"));
  const t = bar.time;
  if (ind === "vol") return `20 日均量 ${fmtVol(calc.vavg.get(t), market)}`;
  if (ind === "macd") {
    const m = calc.macd.get(t), d = bar.close < 50 ? 3 : 2;
    return m ? `DIF ${f(m.dif, d)}　DEA ${f(m.dea, d)}　柱 ${f(m.hist, d)}` : "MACD 資料不足";
  }
  if (ind === "dmi") {
    const m = calc.dmi.get(t);
    return m ? `+DI ${f(m.pdi)}　−DI ${f(m.mdi)}　ADX ${f(m.adx)}` : "DMI 資料不足";
  }
  if (ind === "bias") return `乖離 MA${n1} ${f(calc.bias1.get(t))}%　MA${n2} ${f(calc.bias2.get(t))}%`;
  if (ind === "rsi") return `RSI14 ${f(calc.rsi.get(t))}`;
  return "";
}

// 副圖（主圖：副圖＝3：1）：成交量＋20 日均量、MACD、DMI（ADX 25 參考線）、乖離率（0 軸）、RSI14（30／70）
function drawSub(LW, chart, v, ind, bars, calc, [n1, n2], market) {
  const up = v("--candle-up"), down = v("--candle-down"), refColor = v("--muted");
  const p1 = { type: "price", precision: 1, minMove: 0.1 };
  const lineOpts = { lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: true, priceFormat: p1 };
  const atLeast = (lo, hi) => (orig) => {
    const r = orig();
    return { priceRange: { minValue: Math.min(lo, r?.priceRange?.minValue ?? lo), maxValue: Math.max(hi, r?.priceRange?.maxValue ?? hi) } };
  };
  const ref = (s, at, title) => s.createPriceLine({ price: at, color: refColor, lineWidth: 1, lineStyle: LW.LineStyle.Solid,
    axisLabelVisible: false, title });
  const line = (data, color, title, extra = {}) => {
    const s = chart.addSeries(LW.LineSeries, { ...lineOpts, color, title, ...extra }, 1);
    s.setData(data);
    return s;
  };
  const of = (m, get) => [...m].map(([time, x]) => ({ time, value: get(x) })).filter((x) => x.value != null);
  let main;
  if (ind === "vol") {
    const unit = market === "tw" ? 1000 : 1;
    const volFmt = { type: "volume" };
    main = chart.addSeries(LW.HistogramSeries, { priceFormat: volFmt, priceLineVisible: false, lastValueVisible: false }, 1);
    main.setData(bars.filter((b) => b.volume > 0).map((b) => ({ time: b.time, value: b.volume / unit, color: b.close >= b.open ? up : down })));
    line(of(calc.vavg, (x) => x / unit), v("--accent"), "20 日均量", { priceFormat: volFmt, lastValueVisible: false });
  } else if (ind === "macd") {
    const small = bars.at(-1).close < 50;
    const pf = { type: "price", precision: small ? 3 : 2, minMove: small ? 0.001 : 0.01 };
    main = chart.addSeries(LW.HistogramSeries, { priceFormat: pf, priceLineVisible: false, lastValueVisible: false }, 1);
    main.setData(of(calc.macd, (x) => x.hist).map((x) => ({ ...x, color: x.value >= 0 ? up : down })));
    line(of(calc.macd, (x) => x.dif), v("--ma1"), "DIF", { priceFormat: pf });
    line(of(calc.macd, (x) => x.dea), v("--ma2"), "DEA", { priceFormat: pf });
    ref(main, 0, "");
  } else if (ind === "dmi") {
    main = line(of(calc.dmi, (x) => x.adx), v("--accent"), "ADX", { autoscaleInfoProvider: atLeast(0, 50) });
    line(of(calc.dmi, (x) => x.pdi), up, "+DI");
    line(of(calc.dmi, (x) => x.mdi), down, "−DI");
    ref(main, 25, "25");
  } else if (ind === "bias") {
    main = line(of(calc.bias1, (x) => x), v("--ma1"), `MA${n1}`);
    line(of(calc.bias2, (x) => x), v("--ma2"), `MA${n2}`);
    ref(main, 0, "");
  } else {
    main = line(of(calc.rsi, (x) => x), v("--accent"), "RSI14", { autoscaleInfoProvider: atLeast(0, 100) });
    ref(main, 30, "30");
    ref(main, 70, "70");
  }
  main.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.06 } });
  chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 3 : 1));
}
