// 資金（docs/PIVOT.md 第 6 節）：小豬撲滿、20 年後、和巴菲特的差距、財富自由計算機。
// 都在瀏覽器計算，都只是試算，不是投資建議。
import { loadSettings, loadTrades, loadDividends, loadDaily, loadIndex, loadDca } from "../data.js";
import { dcaFor } from "../discipline.js";
import { loadPortfolio } from "../portfolio.js";
import { loadPerformance } from "../perf.js";
import { el, twd, pct, int, isNum, taipeiToday, extLink } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { FUNDS as F, NAMES } from "../config.js";

// 官方說明（2026-11-07 確認網址有效）
const LINKS = {
  bengen: "https://www.financialplanningassociation.org/sites/default/files/2021-04/MAR04%20Determining%20Withdrawal%20Rates%20Using%20Historical%20Data.pdf",
  twseDividend: "https://www.twse.com.tw/zh/ETFortune/dividendList",
  nhi: "https://www.nhi.gov.tw/ch/cp-3283-34642-2589-1.html",
};

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

// 每月投入金額：帳本「定投金額」這個月的金額（讀不到用 config 的 3,000，known 是 false）
async function monthlyDeposit() {
  const dca = await loadDca().catch(() => null);
  return { amount: dcaFor(dca, taipeiToday().slice(0, 7)), known: !!dca };
}
const depositNote = (d) => (d.known ? "" : `（讀不到帳本的定投金額，先用計畫的 ${int(d.amount)} 元）`);

// 總資產＝持倉市值＋可用資金。缺匯率、某檔價格或可用資金時 complete 是 false、missing 列出缺什麼，
// value 只加讀得到的部分（部分資產）；只有帳本寫的是 0 才算 0。
// 判斷用 loadPortfolio() 既有的 warnings 與每檔的台幣市值（portfolio.js 之後會另外回傳 complete、missing）
async function totalAssets() {
  const [pf, st] = await Promise.all([loadPortfolio(), loadSettings().then((v) => ({ v }), (e) => ({ e }))]);
  const missing = [];
  const noFx = pf.positions.filter((p) => !p.error && p.market === "us" && !isNum(p.mvTwd));
  if (noFx.length) missing.push(`美元兌台幣匯率（${noFx.map((p) => p.code).join("、")} 沒算進來）`);
  for (const p of pf.positions) {
    if (p.error) missing.push(`${p.code} 的價格`);
    else if (!isNum(p.mvTwd) && !noFx.includes(p)) missing.push(`${p.code} 的市值`);
  }
  if (pf.warnings?.length && !missing.length) missing.push(...pf.warnings);
  const pool = st.v?.pool;
  if (!isNum(pool)) missing.push(st.e ? "可用資金（帳本「設定」讀不到）" : "可用資金（帳本「設定」沒有數字）");
  return { value: pf.totals.mvTwd + (isNum(pool) ? pool : 0), complete: !missing.length, missing };
}
const missingText = (t) => t.missing.join("；");
// 缺資料時的說明：主值標「部分資產」並列出缺什麼，衍生試算停算
const partialNotice = (t, stopped, list = true) => notice("warn",
  list && el("strong", {}, "部分資產"), list && `，缺：${missingText(t)}。`,
  `缺的部分沒有算進來，這不是完整的總資產；${stopped}。重新整理再試一次，資料齊了就會照常計算。`);

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
  const dep = await monthlyDeposit();
  const [tot, trades] = await Promise.all([totalAssets(), loadTrades().catch(() => [])]);
  const total = tot.value;
  const B = F.bucket;
  const full = Math.max(0, Math.floor(total / B));
  const fill = Math.min(1, Math.max(0, (total - full * B) / B));
  // 這台裝置上次打開時的交易筆數與撲滿數（第一次打開不播動畫）。
  // 資料不完整時不更新撲滿數，免得補齊後被誤判成「剛裝滿一隻」
  const prev = store("piggy.seen");
  store("piggy.seen", { trades: trades.length, bucket: tot.complete ? full : prev?.bucket ?? null });
  const newTrades = prev ? Math.max(0, trades.length - prev.trades) : 0;
  const crossed = tot.complete && prev?.bucket != null && full > prev.bucket;
  const motion = !reduceMotion();

  const pig = pigSvg(fill);
  const stage = el("div", { class: "pig-stage" }, pig);
  if (motion && newTrades) stage.append(...coins(Math.min(newTrades, 5)));
  if (motion && crossed) stage.append(fireworks());
  const eta = F.scenarios.map((r) => `${Math.round(r * 100)}% 約 ${yearsText(monthsToReach((full + 1) * B, total, dep.amount, r))}`);
  const trade = newTrades > 0 && el("div", { class: "small up" }, `上次打開後有 ${newTrades} 筆新交易${motion ? "" : "（已關閉動畫）"}`);
  if (!tot.complete) {
    return card("小豬撲滿", stage,
      el("div", { class: "pig-text" },
        el("div", { class: "value" }, twd(total)),
        el("div", {}, el("span", { class: "badge b-warn" }, "部分資產"), ` 缺：${missingText(tot)}`),
        trade),
      partialNotice(tot, "撲滿進度和裝滿要多久先不算", false));
  }
  return card("小豬撲滿", stage,
    el("div", { class: "pig-text" },
      el("div", { class: "value" }, twd(total)),
      el("div", { class: "small" }, `第 ${full + 1} 隻撲滿：${twd(total - full * B)}／${int(B)}（${pct(fill * 100, 1, false)}）${full ? `・已經裝滿 ${full} 隻` : ""}`),
      trade,
      crossed && el("div", { class: "small up" }, `恭喜裝滿第 ${full} 隻！換下一隻。`)),
    el("p", {}, "裝的是總資產（持倉市值＋可用資金），市場跌時撲滿也會變少。"),
    el("p", { class: "small muted" }, `照每月 ${int(dep.amount)} 元${depositNote(dep)}裝滿這一隻，用固定年報酬試算：${eta.join("、")}。`));
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
  const tot = await totalAssets();
  // 起始本金不完整就不算：拿部分資產算出來的 20 年後看起來完整，其實偏低或偏高
  if (!tot.complete) return card("20 年後", partialNotice(tot, "20 年後的試算要從完整的總資產開始，所以先不算"));
  const pv = tot.value;
  const dep = await monthlyDeposit();
  const state = { pmt: dep.amount, years: 20, custom: 0.07 };
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
    el("p", {}, `從目前總資產 ${twd(pv)} 開始、每月月底投入，用固定年報酬試算；實際報酬每年不同，有的年份會虧損，結果不保證。`),
    el("p", { class: "tiny" }, `每月投入預設是這個月的定投金額${depositNote(dep)}。不用你未滿一年的實際報酬推估。`));
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
      ? [kv(`你的累積報酬（已投入部位、${months} 個月，扣掉入金影響）`, el("strong", { class: perf.twr >= 0 ? "up" : "down" }, pct(perf.twr * 100))),
        kv("同期台股加權報酬指數（含股利）", bench == null ? "資料準備中" : pct(bench * 100)),
        el("p", {}, "投資未滿一年，只比累積報酬；滿一年後改比年化報酬。")]
      : [kv("你的年化報酬（已投入部位，扣掉入金影響）", el("strong", {}, pct(annual(perf.twr) * 100))),
        kv("同期台股加權報酬指數（含股利，年化）", bench == null ? "資料準備中" : pct(annual(bench) * 100))],
    kv(`波克夏 ${B.period} 年化`, pct(B.brk * 100, 1, false)),
    kv(`S&P 500 ${B.period} 年化`, pct(B.spx * 100, 1, false)),
    perf.xirr != null && kv("照每筆錢投入時間與金額算的年化報酬（XIRR）", pct(perf.xirr * 100)),
    el("h3", {}, "如果每筆錢都有巴菲特的報酬"),
    kv("你的持倉現值（台股收盤、美股換台幣，不含可用資金）", twd(perf.value)),
    perf.divTotal > 0 && kv("加上已領的台股 ETF 股利（稅前）", twd(perf.value + perf.divTotal)),
    kv(`每筆都照波克夏 ${pct(B.brk * 100, 1, false)}`, twd(brkV)),
    kv(`每筆都照 S&P 500 ${pct(B.spx * 100, 1, false)}`, twd(spxV)),
    el("p", {}, "巴菲特的數字是 60 年的平均，短期拿來比只是好玩，不代表你該期待這個報酬。"),
    el("p", { class: "tiny" }, `你的報酬只算已投入的持股（不含可用資金）：時間加權報酬，台股 ETF 含現金股利、美股只有價格（股利沒算進來）；組合有美股，跟台股大盤的差距也包含台美配置與匯率。`
      + `算法與假設見 K 線頁「組合對大盤」。出處：${B.source}（${B.period} 每股市值年化與 S&P 500 含股利年化）。投入金額 ${twd(perf.invested)}，算到 ${perf.last}。`));
}

// ── 財富自由計算機 ──
async function fireCard() {
  const tot = await totalAssets();
  // 起始本金不完整時，「需要本金」照算（跟目前資產無關），「照目前速度」「每月要投」停算
  const pv = tot.complete ? tot.value : null;
  const dep = await monthlyDeposit();
  const div = await loadDividends().catch(() => null);
  // 高股息 ETF 近 12 個月實際配息 ÷ 最新收盤
  const etfs = await Promise.all(F.fire.etfs.map(async (c) => {
    const e = div?.etfs?.[c];
    const bars = await loadDaily("tw", c).catch(() => null);
    const close = bars?.at(-1)?.close;
    return { code: c, ttm: e?.ttm_cash, n: e?.ttm_count, close, yield: e?.ttm_cash && close ? e.ttm_cash / close : null };
  }));
  const ok = etfs.filter((x) => isNum(x.yield));
  const state = { monthly: F.fire.monthly, ret: 0.07, pmt: dep.amount, years: 20, w: Object.fromEntries(ok.map((x) => [x.code, 1])) };
  const outBox = el("div");
  const weighted = () => {
    const sw = ok.reduce((s, x) => s + state.w[x.code], 0);
    return sw ? ok.reduce((s, x) => s + (state.w[x.code] / sw) * x.yield, 0) : null;
  };
  const row = (name, rate, pre = "") => {
    if (!isNum(rate) || rate <= 0) return el("tr", {}, el("td", {}, name), el("td", { class: "r", colspan: 3 }, "資料準備中"));
    const need = (state.monthly * 12) / rate;
    const stop = el("td", { class: "r muted" }, "缺資料，先不算");
    return el("tr", {}, el("td", {}, `${name}（${pre}${pct(rate * 100, 2, false)}）`), el("td", { class: "r" }, wan(need)),
      pv == null ? stop : el("td", { class: "r" }, yearsText(monthsToReach(need, pv, state.pmt, state.ret))),
      pv == null ? stop.cloneNode(true) : el("td", { class: "r" }, twd(pmtFor(need, pv, state.ret, state.years * 12))));
  };
  const draw = () => outBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["方法", "需要本金", "照目前速度", `${state.years} 年達成每月要投`].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
    el("tbody", {}, row("高股息配息", weighted(), "稅前 "), row("4% 法則", F.fire.rule)))));
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
    !tot.complete && partialNotice(tot, "「需要本金」照算，「照目前速度」和「每月要投」要從完整的總資產開始，所以先不算"),
    outBox,
    el("ul", { class: "notes" },
      el("li", {}, "配息的數字都是稅前。ETF 的收益分配可能來自股利、利息、資本利得或收益平準金等不同組成，要繳多少所得稅和二代健保補充保費，要看每次配息的實際組成和你自己的條件（例如單次金額、投保身分），這裡不精算。"),
      el("li", {}, "配息不是多出來的錢：除息當天股價會扣掉配息金額。"),
      el("li", {}, "配息每年會變，近 12 個月的殖利率不代表以後。"),
      el("li", {}, "4% 法則（Bengen 1994）：退休第一年提領起始資產的 4%，之後每年照通膨調整這個金額（不是每年重新領當時餘額的 4%）。這是用美國股債歷史資料做的研究，不保證未來，也不是提領建議。"),
      el("li", {}, pv == null ? "這是試算，不是投資建議。"
        : `從目前總資產 ${twd(pv)} 開始試算；每月投入預設是這個月的定投金額${depositNote(dep)}，可用滑桿改。這是試算，不是投資建議。`)),
    el("p", { class: "tiny" }, "官方說明（2026-11-07 查核網址）：",
      extLink(LINKS.twseDividend, "證交所 ETF 配息清單"), "（每檔的收益分配標準與歷次配息）、",
      extLink(LINKS.nhi, "健保署補充保險費計算公式"), "（股利、利息所得的門檻、上限與例外）、",
      extLink(LINKS.bengen, "Bengen 原始研究（重刊）"), "。"));
}
