// 資金（docs/PIVOT.md 第 6 節）：最上面是「現金與投入」（錢從哪來、花到哪、還剩多少，docs/R15_R18.md），
// 下面「長期試算」是小豬撲滿、20 年後、和巴菲特的差距、財富自由計算機。
// 都在瀏覽器計算，長期試算只是試算，不是投資建議。
import { loadSettings, loadTrades, loadDividends, loadDaily, loadIndex, loadDca } from "../data.js";
import { dcaFor } from "../discipline.js";
import { cashTable, nextDeposit } from "../cash.js";
import { monthlyReturns, describeBacktest, rollingWindows, blockSample, SAMPLE_PATHS } from "../backtest.js";
import { loadPortfolio } from "../portfolio.js";
import { loadPerformance } from "../perf.js";
import { el, twd, pct, int, isNum, taipeiToday, extLink, shortDate } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { FUNDS as F, NAMES } from "../config.js";

// 官方說明（2026-11-07 確認網址有效）
const LINKS = {
  bengen: "https://www.financialplanningassociation.org/sites/default/files/2021-04/MAR04%20Determining%20Withdrawal%20Rates%20Using%20Historical%20Data.pdf",
  twseDividend: "https://www.twse.com.tw/zh/ETFortune/dividendList",
  nhi: "https://www.nhi.gov.tw/ch/cp-3283-34642-2589-1.html",
};

export async function render(root) {
  root.append(pageHeader("資金", "看得到的進度：最上面是帳本裡現金的來去；「長期試算」以下（撲滿、20 年後、和巴菲特比、財富自由要多少）都是試算，不是預測，也不是投資建議。"));
  slot(root, cashCard);
  root.append(el("h2", { class: "date-head" }, "長期試算"));
  slot(root, piggyCard);
  slot(root, futureCard);
  slot(root, buffettCard);
  slot(root, fireCard);
}

// ── 現金與投入（R18）──
// 期初＋入金−買進＋賣出＝期末，再跟帳本的可用資金對一次。數字都來自帳本「設定」與「交易紀錄」，算法在 cash.js
const NOT_IN_LEDGER = "帳本沒有這一列";
const slashDate = (d) => d.replaceAll("-", "/");
const cashVal = (v, none = NOT_IN_LEDGER) => (isNum(v) ? twd(v) : el("span", { class: "muted" }, none));
const UNREADABLE = "有幾筆讀不到金額"; // 買進、賣出合計：交易紀錄有列，但金額欄讀不到
const cashText = (v, none = NOT_IN_LEDGER) => (isNum(v) ? twd(v) : none);
// 差額不到 1 元時多寫小數，免得「差 NT$0」其實不是 0
const diffText = (v) => (Math.abs(v) >= 1 ? twd(Math.abs(v)) : `NT$${Math.abs(v).toFixed(2)}`);

// 逐筆明細（買進或賣出）：日期、標的、金額；讀不到金額的列照實寫
function legTable(rows, total) {
  const code = (r) => `${r.code} ${NAMES[r.code] || ""}`.trim();
  const keep = { style: { whiteSpace: "nowrap" } }; // 日期與金額不換行；標的名稱可以換行，手機上才看得到金額
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "日期"), el("th", {}, "標的"), el("th", { class: "r" }, "金額"))),
    el("tbody", {}, rows.map((r) => el("tr", {}, el("td", keep, r.date), el("td", {}, code(r)),
      el("td", { class: "r", ...keep }, isNum(r.amount) ? int(r.amount) : "讀不到金額")))),
    el("tfoot", {}, el("tr", {}, el("th", {}, "合計"), el("th", {}), el("th", { class: "r" }, isNum(total) ? int(total) : "—")))));
}

async function cashCard() {
  const [settings, trades, dca] = await Promise.all([loadSettings(), loadTrades(), loadDca().catch(() => null)]);
  const c = cashTable({ settings, trades });
  const next = nextDeposit(taipeiToday(), dca);

  // 入金的說明：累計剛好等於「月數 × 每月入金」才寫成乘法，定投金額中途改過就不硬湊
  const inNote = c.depositMonths == null ? `已入金月數：${NOT_IN_LEDGER}`
    : c.depositsByMonths ? `已入金 ${int(c.depositMonths)} 個月 × 每月 ${twd(c.monthly)}`
      : `已入金 ${int(c.depositMonths)} 個月，各月金額照「定投金額」分頁加總`;

  const leg = (label, rows, total, hint) => rows.length > 0 && [
    kv(`${label}（${rows.length} 筆）`, cashVal(total, UNREADABLE)),
    el("details", { class: "more" }, el("summary", {}, `看逐筆（${rows.length} 筆）`), legTable(rows, total), hint)];

  // 對帳：差額不是 0 就標出來；其中一邊讀不到就說沒辦法對，不當成對得起來
  const dir = (d) => (d > 0 ? "多" : "少");
  const poolCheck = c.poolDiff == null
    ? notice("info", c.closing == null ? "期末算不出來，所以沒辦法跟帳本的可用資金對帳。" : `可用資金：${NOT_IN_LEDGER}，沒辦法對帳。`)
    : c.poolDiff === 0 ? kv("可用資金對帳", "對得起來")
      : notice("warn", el("strong", {}, `對不上，差 ${diffText(c.poolDiff)}`),
        `：算出來的期末比帳本的可用資金${dir(c.poolDiff)}。交易紀錄、入金或基準日資金其中有一邊跟帳本不同，請到帳本核對；網站只讀不改帳本。`);
  const buysCheck = c.buysDiff == null
    ? notice("info", c.buys == null ? "買進合計算不出來，所以沒辦法跟帳本的「基準日後買入合計」對。" : `「基準日後買入合計」：${NOT_IN_LEDGER}，沒辦法對。`)
    : c.buysDiff === 0 ? [kv("買進合計對帳", "對得起來"), el("div", { class: "tiny" }, `對的是帳本「基準日後買入合計」${twd(c.ledgerBuys)}`)]
      : notice("warn", el("strong", {}, `買進合計對不上，差 ${diffText(c.buysDiff)}`),
        `：交易紀錄加起來 ${twd(c.buys)}，帳本「基準日後買入合計」是 ${twd(c.ledgerBuys)}。`);
  // 賣出合計也對一次；兩邊都沒有賣出（交易紀錄沒有賣出、帳本是 0 或沒有這一列）時不多顯示任何東西
  const sellsCheck = c.sellRows.length === 0 && !c.ledgerSells ? null
    : c.sellsDiff == null
      ? notice("info", c.sells == null ? "賣出合計算不出來，所以沒辦法跟帳本的「基準日後賣出回收」對。" : `「基準日後賣出回收」：${NOT_IN_LEDGER}，沒辦法對。`)
      : c.sellsDiff === 0 ? [kv("賣出合計對帳", "對得起來"), el("div", { class: "tiny" }, `對的是帳本「基準日後賣出回收」${twd(c.ledgerSells)}`)]
        : notice("warn", el("strong", {}, `賣出合計對不上，差 ${diffText(c.sellsDiff)}`),
          `：交易紀錄加起來 ${twd(c.sells)}，帳本「基準日後賣出回收」是 ${twd(c.ledgerSells)}。`);

  return card("現金與投入",
    kv("基準日", c.basis ? slashDate(c.basis) : cashVal(null)),
    kv("期初（基準日手上還沒投入的錢）", cashVal(c.opening, "算不出來（缺項見下一行）")),
    el("div", { class: "tiny" }, `基準日未投入資金 ${cashText(c.basisFund)} ＋ 記帳前錢包零頭 ${cashText(c.pocket)}`),
    kv("入金（推算）", cashVal(c.deposits)),
    el("div", { class: "tiny" }, `${inNote}；照「定投金額」分頁推算，不是逐筆確認。`),
    leg("買進", c.buyRows, c.buys, el("p", { class: "tiny" }, "只列「計入資金池」的買進；網站沖銷的一對（原列與沖銷列）已拿掉。金額含手續費。")),
    c.buyRows.length === 0 && kv("買進", cashVal(c.buys, UNREADABLE)),
    leg("賣出", c.sellRows, c.sells),
    kv("算出來的期末", cashVal(c.closing, "先不算")),
    el("div", { class: "tiny" }, `期初 ${cashText(c.opening, "算不出來")} ＋ 入金 ${cashText(c.deposits)} − 買進 ${cashText(c.buys, UNREADABLE)} ＋ 賣出 ${cashText(c.sells, UNREADABLE)}`),
    c.closing == null && notice("warn", el("strong", {}, "期末先不算"),
      `：缺 ${c.missing.join("、")}。讀不到的項目不補 0，帳本補上後會自動算出來。`),
    kv("帳本的可用資金", cashVal(c.ledgerPool)),
    poolCheck,
    buysCheck,
    sellsCheck,
    kv("下一次入金", `${slashDate(next.date)}・${twd(next.amount)}${depositNote(next)}`),
    el("ul", { class: "notes" },
      el("li", { class: "tiny" }, "入金是照「定投金額」分頁逐月推算，不是逐筆確認錢真的入帳。"),
      el("li", { class: "tiny" }, "股利與費用帳本沒有流水；手續費已含在交割金額裡。"),
      el("li", { class: "tiny" }, "券商帳戶的實際餘額不在帳本裡；帳本的可用資金是理論值，不等於券商的交割餘額。")));
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
// 年數只寫到整數（R11：不用 18.3 年這種精細數字營造確定感）
const yearsText = (n) => (n == null ? "100 年以上" : n < 12 ? `${n} 個月` : `${Math.round(n / 12)} 年`);
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

// ── N 年後（歷史回測推算，docs/FUNDS_BACKTEST.md）──
// 把加權報酬指數歷史上的月報酬，套在現在的總資產與每月定投上：一是歷史上真的發生過（每個月都當起點的滾動區間），
// 二是區塊抽樣（隨機接出 2,000 條路徑，取第 10、50、90 百分位）。算法在 backtest.js，這裡只負責畫面
const ymText = (ym) => ym.replace("-", "/");
const PCT_ROWS = [["p10", "偏差的情況（第 10 百分位）", "s1"], ["p50", "中間（中位數）", "s2"], ["p90", "偏好的情況（第 90 百分位）", "s3"]];

async function futureCard() {
  const tot = await totalAssets();
  // 起始本金不完整就不算：拿部分資產算出來的 20 年後看起來完整，其實偏低或偏高
  if (!tot.complete) return card("20 年後", partialNotice(tot, "20 年後的試算要從完整的總資產開始，所以先不算"));
  const pv = tot.value;
  const [dep, series] = await Promise.all([monthlyDeposit(), loadIndex("TAIEX_TR")]);
  const rets = monthlyReturns(series);
  const bt = describeBacktest(series);
  if (!bt || !rets.length) return card("20 年後", notice("warn", "加權報酬指數的歷史資料不夠，這張卡先不算。"));
  const state = { pmt: dep.amount, years: 20 };
  const outBox = el("div");
  let heading = null;
  const draw = () => {
    const n = state.years * 12;
    if (heading) heading.textContent = `${state.years} 年後`;
    const s = blockSample(rets, n, pv, state.pmt);
    const rows = PCT_ROWS.map(([k, label, cls]) => ({ label, cls, v: s.final[k], line: [pv, ...s.yearly.map((y) => y[k])] }));
    const roll = rollingWindows(rets, n, pv, state.pmt);
    outBox.replaceChildren(...[
      el("div", { class: "scen" }, rows.map((x) => el("div", { class: `scen-item ${x.cls}` },
        el("div", { class: "tiny" }, x.label), el("div", { class: "scen-v" }, wan(x.v)),
        el("div", { class: "tiny" }, `約投入本金的 ${(x.v / s.principal).toFixed(1)} 倍`)))),
      // 年數超過歷史長度時，滾動區間湊不出來，抽樣推估也只是把歷史重新排列延伸出來的
      state.years > bt.years && el("p", { class: "tiny" }, `超過歷史長度（約 ${bt.years.toFixed(1)} 年）的年數只有抽樣推估，是把歷史重新排列延伸出來的，參考價值更低。`),
      el("p", { class: "small" }, `投入本金合計 ${twd(s.principal)}（現在的總資產 ${twd(pv)} ＋ 每月 ${twd(state.pmt)} × ${n} 個月）；`
        + `期末低於投入本金的機率 ${pct(s.below * 100, 1, false)}（${int(s.paths)} 條路徑裡有 ${int(Math.round(s.below * s.paths))} 條）。`),
      futureChart(state, rows),
      el("h3", {}, "歷史上真的發生過"),
      roll.count === 0
        ? el("p", { class: "small" }, `歷史資料只有約 ${bt.years.toFixed(1)} 年，湊不出 ${state.years} 年的連續區間。`)
        : el("p", { class: "small" }, `每個月都當一次起點、各投 ${state.years} 年，共 ${roll.count} 個起點：`
          + `最差 ${wan(roll.worst.value)}（${ymText(roll.worst.start)} 開始）、中位數 ${wan(roll.median)}、最好 ${wan(roll.best.value)}（${ymText(roll.best.start)} 開始）。`),
      roll.count > 0 && roll.small && notice("warn", el("strong", {}, "樣本太少"),
        `：只有 ${roll.count} 個起點，而且彼此高度重疊（相鄰起點的 ${state.years} 年幾乎是同一段歷史），只能當參考。`)].filter(Boolean));
  };
  draw();
  const c = card("20 年後",
    el("p", {}, "用加權報酬指數的歷史回測推算，不是預測。"),
    range("每月投入", { min: 0, max: 30000, step: 500, value: state.pmt, fmt: (v) => twd(v) }, (v) => { state.pmt = v; draw(); }),
    range("年數", { min: 5, max: 30, step: 1, value: state.years, fmt: (v) => `${v} 年` }, (v) => { state.years = v; draw(); }),
    outBox,
    el("p", {}, `從目前總資產 ${twd(pv)} 開始、每月月底投入。實際報酬每年不同，有的年份會虧損，結果不保證。`),
    el("ul", { class: "notes" },
      el("li", { class: "tiny" }, `回測期間 ${ymText(bt.from)}～${ymText(bt.to)}（${bt.months} 個月）：這段期間加權報酬指數年化 ${pct(bt.annualized * 100, 1, false)}、`
        + `最大回落 ${pct(bt.maxDrawdown * 100, 1, false)}${bt.drawdown ? `（${ymText(bt.drawdown.peak)} 高點到 ${ymText(bt.drawdown.trough)}）` : ""}。月報酬取每個月最後一個交易日的收盤。`),
      el("li", { class: "tiny" }, "用加權報酬指數（含股利）代表整個組合：009816、00981A 上市太短沒有足夠的歷史，美股部位也用同一條近似。"),
      el("li", { class: "tiny" }, "指數不含 ETF 的費用與稅（管理費、證交稅、股利所得稅等），實際報酬會比指數低一些。"),
      el("li", { class: "tiny" }, "沒有扣通膨：金額是名目的，未來的錢購買力比較低。"),
      el("li", { class: "tiny" }, `這段期間台股表現很好（指數年化 ${pct(bt.annualized * 100, 1, false)}），用它推算偏樂觀。過去不代表未來。`),
      el("li", { class: "tiny" }, `「偏差、中間、偏好」是抽樣推估：從這段月報酬隨機接出 ${state.years} 年的路徑（每次連續取 12 個月、超過結尾就接回開頭），共 ${SAMPLE_PATHS.toLocaleString("en-US")} 條，`
        + "取期末值的第 10、50、90 百分位；亂數種子固定，同樣的輸入每次結果相同。"),
      el("li", { class: "tiny" }, `每月投入預設是這個月的定投金額${depositNote(dep)}。不用你未滿一年的實際報酬推估。`)));
  heading = c.querySelector("h2");
  return c;
}

// 圖：三個百分位逐年的值（rows[i].line 是第 0 年到第 N 年）
function futureChart(state, rows) {
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
    const pts = x.line.map((v, y) => `${X(y).toFixed(1)},${Y(v).toFixed(1)}`);
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

// ── 財富自由試算（改進報告 R11）──
// 兩種問題分開算：「以歷史配息率估算的稅前現金流」（高股息 ETF 近 12 個月配息 ÷ 最新收盤，股價跌時這個比率會變高、
// 配息也會變）與「退休可持續提領」（4% 法則的提領率）。通膨是使用者可調的假設（預設年 2%），金額可以用今天的購買力
// 或未來的名目金額表示；年數與每月要投用 4%／7%／10% 三種年報酬寫成區間，不給精細到小數的年數。
export const FIRE_INFL = 0.02;
export const FIRE_RULES = [[0.04, "4%", "Bengen：退休 30 年"], [0.035, "3.5%", "退休更久或更保守（情境假設）"], [0.03, "3%", "很保守（情境假設）"]];
export const FIRE_CUTS = [[0, "配息維持近 12 個月的水準"], [0.2, "配息減少 2 成"], [0.4, "配息減少 4 成"]];

// 高股息 ETF 的加權配息率：沒有配息率的不默默排除，回傳 missing 讓畫面標「不是完整組合」
export function weightedYield(etfs, weights) {
  const used = etfs.filter((x) => isNum(x.yield) && x.yield > 0 && (weights[x.code] ?? 0) > 0);
  const missing = etfs.filter((x) => !(isNum(x.yield) && x.yield > 0)).map((x) => x.code);
  const sw = used.reduce((s, x) => s + weights[x.code], 0);
  return { yield: sw ? used.reduce((s, x) => s + (weights[x.code] / sw) * x.yield, 0) : null, used: used.map((x) => x.code), missing };
}

// 需要的本金（名目）：每月想領（今天的錢）照通膨漲到 months 個月後，再除以年提領率／配息率
export const needAt = (monthly, rate, infl, months) => (monthly * 12 * Math.pow(1 + infl, months / 12)) / rate;

// 幾個月後存到（目標跟著通膨變大）；每月月底投入固定金額。100 年內到不了回傳 null
export function monthsToNeed(monthly, rate, infl, pv, pmt, r) {
  const m = mRate(r);
  let v = pv;
  for (let n = 0; n <= 1200; n++) {
    if (n) v = v * (1 + m) + pmt;
    if (v >= needAt(monthly, rate, infl, n)) return n;
  }
  return null;
}

// 多情境寫成區間：年數取整數（下限無條件捨去、上限無條件進位），到不了寫「100 年以上」
export function yearsRange(list) {
  const ys = list.filter((n) => n != null).map((n) => n / 12);
  if (!ys.length) return "100 年以上";
  if (ys.length === list.length && Math.max(...ys) === 0) return "已達到";
  const lo = Math.floor(Math.min(...ys)), hi = Math.ceil(Math.max(...ys));
  const top = ys.length < list.length ? "100 年以上" : `${hi} 年`;
  return lo === hi && ys.length === list.length ? `約 ${lo} 年` : `約 ${lo} 年～${top}`;
}
const moneyRange = (xs) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return wan(lo) === wan(hi) ? wan(lo) : `${wan(lo)}～${wan(hi)}`;
};

async function fireCard() {
  const tot = await totalAssets();
  // 起始本金不完整時，「需要本金」照算（跟目前資產無關），「多久存到」「每月要投」停算
  const pv = tot.complete ? tot.value : null;
  const dep = await monthlyDeposit();
  const div = await loadDividends().catch(() => null);
  // 高股息 ETF 近 12 個月實際配息 ÷ 最新收盤
  const etfs = await Promise.all(F.fire.etfs.map(async (c) => {
    const e = div?.etfs?.[c];
    const bars = await loadDaily("tw", c).catch(() => null);
    const close = bars?.at(-1)?.close;
    return { code: c, ttm: e?.ttm_cash, n: e?.ttm_count, close, date: bars?.at(-1)?.time, yield: e?.ttm_cash && close ? e.ttm_cash / close : null };
  }));
  const state = { monthly: F.fire.monthly, infl: FIRE_INFL, real: true, pmt: dep.amount, years: 20, w: Object.fromEntries(etfs.map((x) => [x.code, 1])) };
  const R = F.scenarios;
  const outBox = el("div");

  // 每個情境一塊（手機上不用左右捲表格）：需要本金、多久存到、N 年存到每月要投
  const cell = (k, v) => el("div", {}, el("span", { class: "k" }, k), el("span", { class: "v" }, v));
  const row = (label, sub, rate) => {
    const title = el("div", {}, el("strong", {}, label), sub && el("span", { class: "tiny" }, `　${sub}`));
    if (!isNum(rate) || rate <= 0) return el("div", { class: "pos" }, title, el("div", { class: "small muted" }, "資料準備中"));
    const n = state.years * 12;
    const need = needAt(state.monthly, rate, state.real ? 0 : state.infl, state.real ? 0 : n);
    const stop = "缺資料，先不算";
    return el("div", { class: "pos" }, title, el("div", { class: "pos-grid" },
      cell(state.real ? "需要本金（今天的購買力）" : `需要本金（${state.years} 年後名目）`, wan(need)),
      cell("多久存到", pv == null ? stop : yearsRange(R.map((r) => monthsToNeed(state.monthly, rate, state.infl, pv, state.pmt, r)))),
      cell(`${state.years} 年存到，每月要投`, pv == null ? stop : moneyRange(R.map((r) => pmtFor(needAt(state.monthly, rate, state.infl, n), pv, r, n))))));
  };
  const unit = () => (state.real ? "本金是今天的購買力（實質）" : `本金是 ${state.years} 年後的名目金額（照年通膨 ${(state.infl * 100).toFixed(1)}% 換算）`);

  const draw = () => {
    const wy = weightedYield(etfs, state.w);
    const later = Math.pow(1 + state.infl, state.years);
    // replaceChildren 會把 false 與陣列變成文字：先攤平、濾掉條件式的 false
    outBox.replaceChildren(...[
      el("p", { class: "small" }, `通膨是假設、不是預測：年 ${(state.infl * 100).toFixed(1)}% 的話，今天每月 ${twd(state.monthly)} 的購買力，`
        + `${state.years} 年後每月要 ${twd(state.monthly * later)}（名目）。`),
      el("h3", {}, "退休可持續提領（4% 法則）"),
      FIRE_RULES.map(([r, label, sub]) => row(`提領率 ${label}`, sub, r)),
      el("p", { class: "tiny" }, `口徑：每月想領的是稅前金額；${unit()}；每月要投是名目的固定金額。提領率是退休第一年領起始資產的比例，之後每年照通膨調整領的金額。`
        + `「多久存到」「每月要投」用年報酬 ${R.map((r) => `${Math.round(r * 100)}%`).join("、")} 三種情境寫成區間，目標金額每年照通膨變大。`),
      el("h3", {}, "以歷史配息率估算的稅前現金流（高股息 ETF）"),
      wy.missing.length > 0 && notice("warn", `${wy.missing.join("、")} 沒有近 12 個月的配息率，`
        + (wy.used.length ? `下面只用 ${wy.used.join("、")} 算，不是三檔的完整組合。` : "先不算。")),
      FIRE_CUTS.map(([cut, label]) => row(label, isNum(wy.yield) ? `配息率 ${pct(wy.yield * (1 - cut) * 100, 2, false)}` : null, isNum(wy.yield) ? wy.yield * (1 - cut) : null)),
      el("p", { class: "tiny" }, `口徑：配息率是稅前、名目（近 12 個月配息 ÷ 最新收盤）；${unit()}；每月要投是名目的固定金額。`
        + "用今天的購買力表示時，等於假設配息會跟著通膨增加；配息金額如果不變，"
        + `${state.years} 年後的購買力只剩約 ${Math.round((1 / later) * 100)}%。股價下跌時，用現價當分母的配息率會變高，看起來需要的本金變少，這不代表比較安全。`)].flat().filter(Boolean));
  };
  draw();
  const set = (k) => (v) => {
    state[k] = v;
    draw();
  };
  const modes = el("div", { class: "chips", role: "group", "aria-label": "本金的表示方式" },
    [[true, "今天的購買力"], [false, "未來的名目金額"]].map(([v, label]) => {
      const b = el("button", { class: "chip", type: "button", "aria-pressed": String(v === state.real) }, label);
      b.addEventListener("click", () => {
        state.real = v;
        for (const x of modes.children) x.setAttribute("aria-pressed", String(x === b));
        draw();
      });
      return b;
    }));
  const okEtfs = etfs.filter((x) => isNum(x.yield));
  return card("財富自由試算",
    range("每月想領（今天的錢，稅前）", { min: 30000, max: 300000, step: 10000, value: state.monthly, fmt: (v) => twd(v) }, set("monthly")),
    range("每月投入", { min: 0, max: 30000, step: 500, value: state.pmt, fmt: (v) => twd(v) }, set("pmt")),
    range("幾年存到", { min: 5, max: 40, step: 1, value: state.years, fmt: (v) => `${v} 年` }, set("years")),
    range("年通膨（假設）", { min: 0, max: 5, step: 0.5, value: state.infl * 100, fmt: (v) => `${v.toFixed(1)}%` }, (v) => set("infl")(v / 100)),
    el("div", { class: "row" }, el("span", { class: "small" }, "本金用："), modes),
    !tot.complete && partialNotice(tot, "「需要本金」照算，「多久存到」和「每月要投」要從完整的總資產開始，所以先不算"),
    outBox,
    el("h3", {}, "高股息 ETF 近 12 個月配息（比例可調）"),
    okEtfs.length ? okEtfs.map((x) => range(`${x.code} ${NAMES[x.code] || ""}：配息率 ${pct(x.yield * 100, 2, false)}（${x.n} 次 ${x.ttm} 元／${shortDate(x.date)} 收盤 ${x.close}）`,
      { min: 0, max: 100, step: 10, value: 100, fmt: (v) => `比重 ${v}` }, (v) => { state.w[x.code] = v / 100; draw(); }))
      : notice("info", "高股息 ETF 配息資料準備中。"),
    el("ul", { class: "notes" },
      el("li", {}, "這兩種算法回答的是不同問題：配息率是過去一年的現金配息 ÷ 現在的股價，不保證會維持，也不等於能長期維持購買力的提領率；兩者不能直接比誰需要的本金少。"),
      el("li", {}, "配息的數字都是稅前。ETF 的收益分配可能來自股利、利息、資本利得或收益平準金等不同組成，要繳多少所得稅和二代健保補充保費，要看每次配息的實際組成和你自己的條件（例如單次金額、投保身分），這裡不精算。"),
      el("li", {}, "配息不是多出來的錢：除息當天股價會扣掉配息金額。"),
      el("li", {}, "4% 法則（Bengen 1994）：退休第一年提領起始資產的 4%，之後每年照通膨調整這個金額（不是每年重新領當時餘額的 4%）。這是用美國股債歷史資料、30 年退休期做的研究，不保證未來，也不是提領建議；3.5%、3% 是退休更久或更保守時的情境假設。"),
      el("li", {}, pv == null ? "這是試算，不是投資建議。"
        : `從目前總資產 ${twd(pv)} 開始試算；每月投入預設是這個月的定投金額${depositNote(dep)}，可用滑桿改。這是試算，不是投資建議。`)),
    el("p", { class: "tiny" }, "官方說明（2026-11-07 查核網址）：",
      extLink(LINKS.twseDividend, "證交所 ETF 配息清單"), "（每檔的收益分配標準與歷次配息）、",
      extLink(LINKS.nhi, "健保署補充保險費計算公式"), "（股利、利息所得的門檻、上限與例外）、",
      extLink(LINKS.bengen, "Bengen 原始研究（重刊）"), "。"));
}
