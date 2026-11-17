// 本月紀律（docs/PIVOT.md 第 2 節）：從帳本交易紀錄算當月台股投入、核心：衛星比例與偏離、本月建議、
// 下次檢查日、連續投入月數，以及定投與自主加碼（當月買進含手續費超過定投金額的部分，2026-11-05 使用者決定）。
// 只管台股；美股不算進比例。都在瀏覽器計算。
// 檢查後繼續補足（docs/PIVOT.md 第 12 節，2026-11-17）：非檢查月 M，找最近一個在 M 之前的檢查月 C；C 的計畫日前一天收盤的偏離超過
// 門檻、C 到 M 前一個月每個月月底的偏離都超過門檻而且偏低的是同一檔、現在的偏離也超過門檻而且偏低的還是那一檔，入金整筆補那一檔
// （plan.continued、plan.since）；第一個算數的檢查月是 D.firstCheck（2027-04），比它早的檢查月一律當成沒觸發；中途哪個月月底回到 ±5 內或換成另一檔偏低就停，等下次檢查月。過去某天的股數 ＝ 現在的股數減掉
// 那天之後的買進、加回賣出；缺收盤或股數就不猜，照目標比例並在 warnings 警告。算法和 engine/discipline.py 相同
import { DISCIPLINE as D } from "./config.js";

// 某個月的定投金額（帳本「定投金額」分頁）：生效月份不晚於這個月的最後一列；比第一列早用第一列；讀不到用 config
export function dcaFor(dca, ym) {
  if (!dca?.length) return D.deposit;
  let a = dca[0].amount;
  for (const r of dca) if (r.ym <= ym) a = r.amount;
  return a;
}
// 已投入門檻：定投金額的 9 成（3,000 → 2,700，與 engine/discipline.py 相同）
export const minFor = (amount) => Math.round((amount * D.investedMin) / D.deposit);

const pad = (n) => String(n).padStart(2, "0");
export const addMonth = (m, k) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
// 台幣金額欄空白（基準日前的列）就用股數 × 成交價
const tradeTwd = (t) => t.twd ?? (t.shares != null && t.price != null ? t.shares * t.price : 0);

// 每個月台股買進合計：Map("YYYY-MM" → { total, byCode })
export function monthlyInvested(trades) {
  const by = new Map();
  for (const t of trades) {
    if (t.market !== "tw" || t.side !== "買進") continue;
    const m = t.date.slice(0, 7);
    const e = by.get(m) || { total: 0, byCode: {} };
    const v = tradeTwd(t);
    e.total += v;
    e.byCode[t.code] = (e.byCode[t.code] || 0) + v;
    by.set(m, e);
  }
  return by;
}

export function nextCheckDate(today) {
  const y = Number(today.slice(0, 4));
  return [y, y + 1].flatMap((yy) => D.checkMonths.map((m) => `${yy}-${pad(m)}-${pad(D.checkDay)}`)).sort().find((d) => d >= today);
}

export function nextDepositDate(today) {
  const thisMonth = `${today.slice(0, 7)}-${pad(D.depositDay)}`;
  return thisMonth >= today ? thisMonth : `${addMonth(today.slice(0, 7), 1)}-${pad(D.depositDay)}`;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
// 計畫日：6 日；遇週末順延到下一個平日（跟 engine/discipline.py 的 plan_day 一樣）
export function planDay(ym) {
  let t = dayMs(`${ym}-${pad(D.depositDay)}`);
  while ([0, 6].includes(new Date(t).getUTCDay())) t += 86400000;
  return isoDay(t);
}
// 月底：那個月最後一個平日（休市日沒有收盤，取不晚於它的最後收盤，結果跟 Python 用行事曆找最後交易日一樣）
const monthEnd = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  let t = Date.UTC(y, m, 0);
  while ([0, 6].includes(new Date(t).getUTCDay())) t -= 86400000;
  return isoDay(t);
};
// 最近一個在 ym 之前的檢查月
export function lastCheckBefore(ym) {
  const [y, m] = ym.split("-").map(Number);
  const c = [y - 1, y].flatMap((yy) => D.checkMonths.map((mm) => [yy, mm])).filter(([yy, mm]) => yy < y || (yy === y && mm < m)).pop();
  return `${c[0]}-${pad(c[1])}`;
}
// d 當天收盤後的股數：現在的股數減掉 d 之後的買進、加回賣出（只看台股）。讀不到股數回傳 null
export function sharesOn(code, d, now, trades) {
  let n = now ?? 0;
  for (const t of trades) {
    if (t.market !== "tw" || t.code !== code || t.date <= d || (t.side !== "買進" && t.side !== "賣出")) continue;
    if (t.shares == null) return null;
    n += t.side === "買進" ? -t.shares : t.shares;
  }
  return n;
}
// 不晚於 d 的最後一個收盤；沒有回傳 null
export function closeOn(bars, d) {
  let last = null;
  for (const b of bars || []) {
    if (b.time > d) break;
    last = b.close;
  }
  return last;
}
// d 當天收盤的偏離（百分點，沒四捨五入）；缺收盤、缺股數、股數為負、市值為 0 回傳 null
function deviationOn(d, ctx) {
  const vals = [];
  for (const code of [D.core, D.satellite]) {
    const n = sharesOn(code, d, ctx.shares[code], ctx.trades), c = closeOn(ctx.bars[code], d);
    if (n == null || n < 0 || c == null) return null;
    vals.push(n * c);
  }
  const total = vals[0] + vals[1];
  return total > 0 ? (vals[0] / total - D.target[D.core]) * 100 : null;
}
const underOf = (dev) => (dev > 0 ? D.satellite : D.core);
// 非檢查月 ym 要不要繼續補：回傳 { since, devAtCheck }、null（不補）；缺資料時回傳 { missing: true }
function continuedSince(ym, under, ctx) {
  const c = lastCheckBefore(ym);
  if (c < D.firstCheck) return null; // 轉型前的檢查月不算觸發，不用算也不警告
  const devC = deviationOn(isoDay(dayMs(planDay(c)) - 86400000), ctx); // 當月入金之前
  if (devC == null) return { missing: true };
  if (Math.abs(devC) <= D.bandPts || underOf(devC) !== under) return null;
  for (let m = c; m !== ym; m = addMonth(m, 1)) {
    const dev = deviationOn(monthEnd(m), ctx);
    if (dev == null) return { missing: true };
    if (Math.abs(dev) <= D.bandPts || underOf(dev) !== under) return null;
  }
  return { since: c, devAtCheck: devC };
}

// positions：loadPortfolio().positions；trades：loadTrades()；today：台北 YYYY-MM-DD；dca：loadDca()（可以是 null）
// bars：{ 代號: [{ time, close }] }，核心與衛星的日線（loadDaily）；不給就不判斷「檢查後繼續補足」（只要連續月數的呼叫方可以不給）
export function discipline({ trades, positions, today, dca = null, bars = null }) {
  const month = today.slice(0, 7);
  const inv = monthlyInvested(trades);
  const cur = inv.get(month) || { total: 0, byCode: {} };
  const deposit = dcaFor(dca, month);
  const investedMin = minFor(deposit);
  const done = (m) => (inv.get(m)?.total || 0) >= minFor(dcaFor(dca, m));

  // 連續投入月數：從 D.start 起；當月還沒投入時算到上個月為止
  let streak = 0;
  for (let m = done(month) ? month : addMonth(month, -1); m >= D.start && done(m); m = addMonth(m, -1)) streak++;

  // 核心：衛星比例（市值）
  const mv = (code) => positions.find((p) => p.code === code && !p.error)?.mvTwd ?? null;
  const core = mv(D.core), sat = mv(D.satellite);
  let weights = null;
  if (core != null && sat != null && core + sat > 0) {
    const wc = core / (core + sat);
    weights = { core: wc, sat: 1 - wc, devPts: (wc - D.target[D.core]) * 100, coreMv: core, satMv: sat };
  }

  // 本月建議（與 engine/discipline.py 相同）：檢查月偏離超過門檻時入金整筆補偏低的一檔（不賣出）；
  // 非檢查月符合「檢查後繼續補足」（見檔頭）也整筆補；其他情況照目標比例，
  // 不在檢查月、沒在補足中但已超過門檻時記下 overBand，等下次檢查
  const over = weights && Math.abs(weights.devPts) > D.bandPts;
  const isCheck = D.checkMonths.includes(Number(month.slice(5)));
  const under = weights ? (weights.devPts < 0 ? D.core : D.satellite) : null;
  const warnings = [];
  let cont = null;
  if (bars && over && !isCheck) {
    const shares = Object.fromEntries([D.core, D.satellite].map((c) => [c, positions.find((p) => p.code === c)?.shares ?? 0]));
    cont = continuedSince(month, under, { shares, trades, bars });
    if (cont?.missing) {
      warnings.push("算不出之前的偏離，照 80／20");
      cont = null;
    }
  }
  let plan;
  if (over && isCheck) {
    plan = { mode: "rebalance", continued: false, since: null, items: [[under, deposit]] };
  } else if (cont) {
    plan = { mode: "rebalance", continued: true, since: cont.since, devAtCheck: cont.devAtCheck, items: [[under, deposit]] };
  } else {
    plan = { mode: "target", continued: false, since: null, overBand: !!over,
      items: [[D.core, deposit * D.target[D.core]], [D.satellite, deposit * D.target[D.satellite]]] };
  }

  const depositDate = `${month}-${pad(D.depositDay)}`;
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return {
    month, invested: cur.total, byCode: cur.byCode, done: cur.total >= investedMin, streak, weights, plan,
    warnings, deposit, investedMin, dcaPart: Math.min(cur.total, deposit), extra: Math.max(0, cur.total - deposit),
    depositArrived: today >= depositDate, depositDate, daysLeft: lastDay - Number(today.slice(8, 10)),
    nextCheck: nextCheckDate(today), nextDeposit: nextDepositDate(today),
  };
}
