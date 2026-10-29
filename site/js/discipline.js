// 本月紀律（docs/PIVOT.md 第 2 節）：從帳本交易紀錄算當月台股投入、核心：衛星比例與偏離、本月建議、
// 下次檢查日、連續投入月數。只管台股；美股不算進比例。都在瀏覽器計算，帳本「設定」分頁不用改。
import { DISCIPLINE as D } from "./config.js";

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

// positions：loadPortfolio().positions；trades：loadTrades()；today：台北 YYYY-MM-DD
export function discipline({ trades, positions, today }) {
  const month = today.slice(0, 7);
  const inv = monthlyInvested(trades);
  const cur = inv.get(month) || { total: 0, byCode: {} };
  const done = (m) => (inv.get(m)?.total || 0) >= D.investedMin;

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

  // 本月建議：偏離超過門檻時入金先補偏低的一檔（不賣出），否則照目標比例
  let plan;
  if (weights && Math.abs(weights.devPts) > D.bandPts) {
    plan = { mode: "rebalance", items: [[weights.devPts < 0 ? D.core : D.satellite, D.deposit]] };
  } else {
    plan = { mode: "target", items: [[D.core, D.deposit * D.target[D.core]], [D.satellite, D.deposit * D.target[D.satellite]]] };
  }

  const depositDate = `${month}-${pad(D.depositDay)}`;
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return {
    month, invested: cur.total, byCode: cur.byCode, done: cur.total >= D.investedMin, streak, weights, plan,
    depositArrived: today >= depositDate, depositDate, daysLeft: lastDay - Number(today.slice(8, 10)),
    nextCheck: nextCheckDate(today), nextDeposit: nextDepositDate(today),
  };
}
