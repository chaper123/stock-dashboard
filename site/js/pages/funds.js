// 資金（docs/PIVOT.md 第 6 節）：小豬撲滿、20 年後、和巴菲特的差距、財富自由計算機。
// 都在瀏覽器計算，都只是試算，不是投資建議。
import { loadSettings, loadTrades, loadDividends, loadDaily, loadIndex, loadDca } from "../data.js";
import { dcaFor } from "../discipline.js";
import { loadPortfolio } from "../portfolio.js";
import { loadPerformance } from "../perf.js";
import { el, twd, pct, int, isNum, taipeiToday } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { FUNDS as F, NAMES } from "../config.js";

export async function render(root) {
  root.append(pageHeader("資金", "看得到的進度：撲滿、20 年後、和巴菲特比、財富自由要多少。這一頁都是試算，不是投資建議。"));
  slot(root, piggyCard);
  slot(root, futureCard);
  slot(root, buffettCard);
  slot(root, fireCard);
}

// ── 試算工具（年報酬換成等值月報酬，每月月底投入）──
const mRate = (r) => Math.pow(1 + r, 1 / 12) - 1;
export function fv(pv, pmt, r, months) {
  const m = mRate(r), g = Math.pow(1 + m, months);
  return pv * g + (m ? pmt * (g - 1) / m : pmt * months);
}
function monthsToReach(target, pv, pmt, r) {
  if (pv >= target) return 0;
  const m = mRate(r);
  let v = pv;
  for (let n = 1; n <= 1200; n++) {
    v = v * (1 + m) + pmt;
    if (v >= target) return n;
  }
  return null;
}
function pmtFor(target, pv, r, months) {
  const m = mRate(r), g = Math.pow(1 + m, months);
  const need = target - pv * g;
  return need <= 0 ? 0 : m ? need * m / (g - 1) : need / months;
}
const yearsText = (n) => (n == null ? "100 年以上" : n < 12 ? `${n} 個月` : `${(n / 12).toFixed(1)} 年`);
const wan = (v) => (v >= 1e4 ? `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)} 萬` : twd(v));

function store(k, v) {
  try {
    if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null");
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    return null;
  }
}
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// 每月投入金額：帳本「定投金額」這個月的金額（讀不到用 config 的 3,000）
const monthlyDeposit = async () => dcaFor(await loadDca().catch(() => null), taipeiToday().slice(0, 7));

async function totalAssets() {
  const [pf, st] = await Promise.all([loadPortfolio(), loadSettings().catch(() => null)]);
  return pf.totals.mvTwd + (st?.pool || 0);
}

// 滑桿＋數值
function range(label, { min, max, step, value, fmt }, onInput) {
  const out = el("output", {}, fmt(value));
  const input = el("input", { type: "range", min, max, step, value, "aria-label": label });
  input.addEventListener("input", () => {
    out.textContent = fmt(Number(input.value));
    onInput(Number(input.value));
  });
  return el("label", { class: "rng" }, el("span", {}, label), input, out);
}

// ── 小豬撲滿 ──
async function piggyCard() {
  const deposit = await monthlyDeposit();
  const [total, trades] = await Promise.all([totalAssets(), loadTrades().catch(() => [])]);
  const B = F.bucket;
  const full = Math.floor(total / B);
  const fill = (total - full * B) / B;
  // 這台裝置上次打開時的交易筆數與撲滿數（第一次打開不播動畫）
  const prev = store("piggy.seen");
  store("piggy.seen", { trades: trades.length, bucket: full });
  const newTrades = prev ? Math.max(0, trades.length - prev.trades) : 0;
  const crossed = prev ? full > prev.bucket : false;
  const motion = !reduceMotion();

  const pig = pigSvg(fill);
  const stage = el("div", { class: "pig-stage" }, pig);
  if (motion && newTrades) stage.append(...coins(Math.min(newTrades, 5)));
  if (motion && crossed) stage.append(fireworks());
  const eta = F.scenarios.map((r) => `${Math.round(r * 100)}% 約 ${yearsText(monthsToReach((full + 1) * B, total, deposit, r))}`);
  return card("小豬撲滿", stage,
    el("div", { class: "pig-text" },
      el("div", { class: "value" }, twd(total)),
      el("div", { class: "small" }, `第 ${full + 1} 隻撲滿：${twd(total - full * B)}／${int(B)}（${pct(fill * 100, 1, false)}）${full ? `・已經裝滿 ${full} 隻` : ""}`),
      newTrades > 0 && el("div", { class: "small up" }, `上次打開後有 ${newTrades} 筆新交易${motion ? "" : "（已關閉動畫）"}`),
      crossed && el("div", { class: "small up" }, `恭喜裝滿第 ${full} 隻！換下一隻。`)),
    el("p", { class: "tiny" }, `裝的是總資產（持倉市值＋可用資金），市場跌時撲滿也會變少。照每月 ${int(deposit)} 元裝滿這一隻：${eta.join("、")}。`));
}

function pigSvg(fill) {
  const NS = "http://www.w3.org/2000/svg";
  const n = (tag, a) => {
    const x = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) x.setAttribute(k, v);
    return x;
  };
  const svg = n("svg", { viewBox: "0 0 220 160", class: "pig", role: "img", "aria-label": `撲滿裝了 ${Math.round(fill * 100)}%` });
  const id = `pigclip${Math.random().toString(36).slice(2, 8)}`;
  const clip = n("clipPath", { id });
  clip.append(n("ellipse", { cx: 105, cy: 88, rx: 72, ry: 52 }));
  const defs = n("defs", {});
  defs.append(clip);
  const top = 36, h = 104; // 身體上下緣
  svg.append(defs,
    n("rect", { x: 55, y: 125, width: 14, height: 22, rx: 4, class: "pig-leg" }), n("rect", { x: 140, y: 125, width: 14, height: 22, rx: 4, class: "pig-leg" }),
    n("path", { d: "M34 82 q-14 -6 -10 -18 q4 -8 12 0", class: "pig-tail" }),
    n("ellipse", { cx: 105, cy: 88, rx: 72, ry: 52, class: "pig-body" }),
    n("rect", { x: 30, y: top + h * (1 - fill), width: 150, height: h * fill + 2, class: "pig-fill", "clip-path": `url(#${id})` }),
    n("ellipse", { cx: 105, cy: 88, rx: 72, ry: 52, class: "pig-outline" }),
    n("path", { d: "M128 44 l12 -22 l10 26 z", class: "pig-body pig-outline" }),
    n("ellipse", { cx: 180, cy: 92, rx: 16, ry: 13, class: "pig-body pig-outline" }),
    n("circle", { cx: 175, cy: 91, r: 2.5, class: "pig-dark" }), n("circle", { cx: 185, cy: 91, r: 2.5, class: "pig-dark" }),
    n("circle", { cx: 150, cy: 70, r: 4, class: "pig-dark" }),
    n("rect", { x: 88, y: 37, width: 34, height: 6, rx: 3, class: "pig-dark" }));
  return svg;
}

function coins(k) {
  return Array.from({ length: k }, (_, i) => el("span", { class: "coin", style: { animationDelay: `${i * 0.35}s`, left: `${44 + (i % 3) * 3}%` } }, "$"));
}
function fireworks() {
  const box = el("div", { class: "fw", "aria-hidden": "true" });
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    box.append(el("i", { style: { "--dx": `${Math.cos(a) * 90}px`, "--dy": `${Math.sin(a) * 70}px`, animationDelay: `${(i % 4) * 0.08}s` } }));
  }
  return box;
}

// ── 20 年後 ──
async function futureCard() {
  const pv = await totalAssets();
  const state = { pmt: await monthlyDeposit(), years: 20, custom: 0.07 };
  const outBox = el("div");
  const draw = () => {
    const n = state.years * 12;
    const rows = [...F.scenarios.map((r, i) => ({ r, label: `${Math.round(r * 100)}%`, cls: `s${i + 1}` })),
      { r: state.custom, label: `自訂 ${(state.custom * 100).toFixed(1)}%`, cls: "s0" }];
    for (const x of rows) x.v = fv(pv, state.pmt, x.r, n);
    outBox.replaceChildren(
      el("div", { class: "scen" }, rows.map((x) => el("div", { class: `scen-item ${x.cls}` },
        el("div", { class: "tiny" }, `年報酬 ${x.label}`), el("div", { class: "scen-v" }, wan(x.v))))),
      futureChart(pv, state, rows));
  };
  draw();
  return card("20 年後",
    range("每月投入", { min: 0, max: 30000, step: 500, value: state.pmt, fmt: (v) => twd(v) }, (v) => { state.pmt = v; draw(); }),
    range("年數", { min: 5, max: 40, step: 1, value: state.years, fmt: (v) => `${v} 年` }, (v) => { state.years = v; draw(); }),
    range("自訂年報酬", { min: 0, max: 15, step: 0.5, value: 7, fmt: (v) => `${v.toFixed(1)}%` }, (v) => { state.custom = v / 100; draw(); }),
    outBox,
    el("p", { class: "tiny" }, `從目前總資產 ${twd(pv)} 開始、每月月底投入，用固定年報酬試算；實際報酬每年不同。不用未滿一年的實際報酬推估。`));
}

function futureChart(pv, state, rows) {
  const NS = "http://www.w3.org/2000/svg";
  const W = 320, H = 150, L = 6, R = 64, T = 8, Bm = 18;
  const max = Math.max(...rows.map((x) => x.v));
  const X = (y) => L + (y / state.years) * (W - L - R);
  const Y = (v) => T + (1 - v / max) * (H - T - Bm);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "fchart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", rows.map((x) => `${x.label} ${wan(x.v)}`).join("、"));
  const add = (tag, a, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };
  add("line", { x1: L, x2: W - R, y1: H - Bm, y2: H - Bm, class: "fc-axis" });
  for (const x of rows) {
    const pts = [];
    for (let y = 0; y <= state.years; y++) pts.push(`${X(y).toFixed(1)},${Y(fv(pv, state.pmt, x.r, y * 12)).toFixed(1)}`);
    const line = add("polyline", { points: pts.join(" "), class: `fc-line ${x.cls}` });
    line.append(Object.assign(document.createElementNS(NS, "title"), { textContent: `${x.label}：${wan(x.v)}` }));
    add("text", { x: W - R + 4, y: Y(x.v) + 4, class: "fc-label" }, wan(x.v));
  }
  add("text", { x: L, y: H - 4, class: "fc-label" }, "今天");
  add("text", { x: W - R, y: H - 4, class: "fc-label", "text-anchor": "end" }, `${state.years} 年`);
  return svg;
}

// ── 和巴菲特的差距 ──
async function buffettCard() {
  const perf = await loadPerformance();
  const tr = await loadIndex("TAIEX_TR").catch(() => null);
  const B = F.buffett;
  const months = Math.round(perf.years * 12);
  // 同期加權報酬指數（第一筆投入到最後一個交易日）
  let bench = null;
  if (tr) {
    const at = (d) => [...tr].reverse().find((x) => x.date <= d)?.value;
    const a = at(perf.first), b = at(perf.last);
    if (a && b) bench = b / a - 1;
  }
  const ifRate = (r) => perf.flows.reduce((s, f) => s + f.amount * Math.pow(1 + r, (Date.parse(perf.last) - Date.parse(f.date)) / (365 * 86400000)), 0);
  const brkV = ifRate(B.brk), spxV = ifRate(B.spx);
  const under1 = perf.years < 1;
  const annual = (x) => Math.pow(1 + x, 1 / perf.years) - 1;
  return card("和巴菲特的差距",
    under1
      ? [kv(`你的累積報酬（${months} 個月，時間加權）`, el("strong", { class: perf.twr >= 0 ? "up" : "down" }, pct(perf.twr * 100))),
        kv("同期台股加權報酬指數", bench == null ? "資料準備中" : pct(bench * 100)),
        el("p", { class: "tiny" }, "投資未滿一年，只比累積報酬；滿一年後改比年化報酬。")]
      : [kv("你的年化報酬（時間加權）", el("strong", {}, pct(annual(perf.twr) * 100))),
        kv("同期台股加權報酬指數（年化）", bench == null ? "資料準備中" : pct(annual(bench) * 100))],
    kv(`波克夏 ${B.period} 年化`, pct(B.brk * 100, 1, false)),
    kv(`S&P 500 ${B.period} 年化`, pct(B.spx * 100, 1, false)),
    perf.xirr != null && kv("資金加權報酬 XIRR（年化）", pct(perf.xirr * 100)),
    el("h3", {}, "如果每筆錢都有巴菲特的報酬"),
    kv("你的持倉現值（台股收盤、美股換台幣）", twd(perf.value)),
    kv(`每筆都照波克夏 ${pct(B.brk * 100, 1, false)}`, twd(brkV)),
    kv(`每筆都照 S&P 500 ${pct(B.spx * 100, 1, false)}`, twd(spxV)),
    el("p", { class: "tiny" }, `出處：${B.source}（${B.period} 每股市值年化與 S&P 500 含股利年化）。巴菲特的數字是 60 年平均，短期比較只是好玩。投入金額 ${twd(perf.invested)}，算到 ${perf.last}。`));
}

// ── 財富自由計算機 ──
async function fireCard() {
  const pv = await totalAssets();
  const div = await loadDividends().catch(() => null);
  // 高股息 ETF 近 12 個月實際配息 ÷ 最新收盤
  const etfs = await Promise.all(F.fire.etfs.map(async (c) => {
    const e = div?.etfs?.[c];
    const bars = await loadDaily("tw", c).catch(() => null);
    const close = bars?.at(-1)?.close;
    return { code: c, ttm: e?.ttm_cash, n: e?.ttm_count, close, yield: e?.ttm_cash && close ? e.ttm_cash / close : null };
  }));
  const ok = etfs.filter((x) => isNum(x.yield));
  const state = { monthly: F.fire.monthly, ret: 0.07, pmt: await monthlyDeposit(), years: 20, w: Object.fromEntries(ok.map((x) => [x.code, 1])) };
  const outBox = el("div");
  const weighted = () => {
    const sw = ok.reduce((s, x) => s + state.w[x.code], 0);
    return sw ? ok.reduce((s, x) => s + (state.w[x.code] / sw) * x.yield, 0) : null;
  };
  const row = (name, rate) => {
    if (!isNum(rate) || rate <= 0) return el("tr", {}, el("td", {}, name), el("td", { class: "r", colspan: 3 }, "資料準備中"));
    const need = (state.monthly * 12) / rate;
    return el("tr", {}, el("td", {}, `${name}（${pct(rate * 100, 2, false)}）`), el("td", { class: "r" }, wan(need)),
      el("td", { class: "r" }, yearsText(monthsToReach(need, pv, state.pmt, state.ret))),
      el("td", { class: "r" }, twd(pmtFor(need, pv, state.ret, state.years * 12))));
  };
  const draw = () => outBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["方法", "需要本金", "照目前速度", `${state.years} 年達成每月要投`].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
    el("tbody", {}, row("高股息配息", weighted()), row("4% 法則", F.fire.rule)))));
  draw();
  const set = (k) => (v) => {
    state[k] = v;
    draw();
  };
  return card("財富自由計算機",
    range("每月想領", { min: 30000, max: 300000, step: 10000, value: state.monthly, fmt: (v) => twd(v) }, set("monthly")),
    range("存錢期間年報酬", { min: 0, max: 12, step: 0.5, value: 7, fmt: (v) => `${v.toFixed(1)}%` }, (v) => set("ret")(v / 100)),
    range("每月投入", { min: 0, max: 30000, step: 500, value: state.pmt, fmt: (v) => twd(v) }, set("pmt")),
    range("幾年達成", { min: 5, max: 40, step: 1, value: state.years, fmt: (v) => `${v} 年` }, set("years")),
    el("h3", {}, "高股息 ETF 近 12 個月配息（比例可調）"),
    ok.length ? ok.map((x) => range(`${x.code} ${NAMES[x.code] || ""}：殖利率 ${pct(x.yield * 100, 2, false)}（${x.n} 次 ${x.ttm} 元／收盤 ${x.close}）`,
      { min: 0, max: 100, step: 10, value: 100, fmt: (v) => `比重 ${v}` }, (v) => { state.w[x.code] = v; draw(); }))
      : notice("info", "高股息 ETF 配息資料準備中。"),
    outBox,
    el("ul", { class: "tiny notes" },
      el("li", {}, "配息不是多出來的錢：除息當天股價會扣掉配息金額。"),
      el("li", {}, "配息每年會變，近 12 個月的殖利率不代表以後。"),
      el("li", {}, `股利要併入綜合所得；單筆股利 ${int(F.nhiThreshold)} 元以上要扣二代健保補充保費 ${(F.nhiRate * 100).toFixed(2)}%。`),
      el("li", {}, "4% 法則（Bengen 1994）：每年提領本金 4%，依美國歷史資料 30 年大致不會用完；不保證。"),
      el("li", {}, `從目前總資產 ${twd(pv)} 開始試算。這是試算，不是投資建議。`)));
}
