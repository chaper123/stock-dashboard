// 持倉 × 最新價。台股有今天的盤中快照就用盤中價，否則用最後收盤；美股用最後收盤，以美元兌台幣中間價換算。
import { loadHoldings, loadDaily, loadIntraday, loadFx } from "./data.js";
import { taipeiToday } from "./fmt.js";

async function twQuote(code, intraday) {
  const q = intraday?.quotes?.[code];
  if (q && q.is_today && Number.isFinite(q.price)) {
    const hm = (q.time || "").slice(11, 16);
    const mid = q.price_field === "bid_ask_mid" ? "，買賣中間價" : "";
    return { price: q.price, at: `今天 ${hm}`, note: `證交所盤中快照${mid}` };
  }
  const bars = await loadDaily("tw", code);
  const b = bars.at(-1);
  return { price: b.close, at: b.time, note: "收盤" };
}

async function usQuote(code) {
  const bars = await loadDaily("us", code);
  const b = bars.at(-1);
  return { price: b.close, at: b.time, note: "收盤" };
}

export async function loadPortfolio() {
  const holdings = await loadHoldings();
  const warnings = [];
  const hasUs = holdings.some((h) => h.market === "us");
  const hasTw = holdings.some((h) => h.market === "tw");
  const [fxR, intraR] = await Promise.allSettled([
    hasUs ? loadFx() : Promise.resolve(null),
    hasTw ? loadIntraday() : Promise.resolve(null),
  ]);
  const fxRow = fxR.status === "fulfilled" && fxR.value ? fxR.value.at(-1) : null;
  const fx = fxRow ? { rate: fxRow.value, date: fxRow.date } : null;
  if (hasUs && !fx) warnings.push(`讀不到匯率（${fxR.reason?.message || "未知原因"}），美股沒有換算成台幣`);
  const intraday = intraR.status === "fulfilled" ? intraR.value : null;
  if (hasTw && !intraday) warnings.push("讀不到台股盤中快照，台股用最後收盤價");

  const positions = await Promise.all(holdings.map(async (h) => {
    const p = { ...h };
    try {
      Object.assign(p, h.market === "tw" ? await twQuote(h.code, intraday) : await usQuote(h.code));
    } catch (e) {
      p.error = `讀不到價格（${e.message}）`;
      warnings.push(`${h.code} ${p.error}`);
      return p;
    }
    p.mv = p.shares * p.price;
    p.pnl = h.cost != null ? p.mv - h.cost : null;
    p.pnlPct = h.cost ? (p.pnl / h.cost) * 100 : null;
    const rate = h.market === "us" ? fx?.rate : 1;
    p.mvTwd = rate ? p.mv * rate : null;
    p.costTwd = rate && h.cost != null ? h.cost * rate : null;
    p.pnlTwd = rate && p.pnl != null ? p.pnl * rate : null;
    return p;
  }));

  const sum = (list, k) => list.reduce((s, p) => s + (Number.isFinite(p[k]) ? p[k] : 0), 0);
  const by = (m) => positions.filter((p) => p.market === m && !p.error);
  const totals = {};
  for (const m of ["tw", "us"]) {
    const list = by(m);
    totals[m] = {
      count: list.length,
      mv: sum(list, "mv"), cost: sum(list, "cost"), pnl: sum(list, "pnl"),
      mvTwd: sum(list, "mvTwd"), costTwd: sum(list, "costTwd"), pnlTwd: sum(list, "pnlTwd"),
    };
    totals[m].pnlPct = totals[m].cost ? (totals[m].pnl / totals[m].cost) * 100 : null;
  }
  totals.mvTwd = totals.tw.mvTwd + totals.us.mvTwd;
  totals.costTwd = totals.tw.costTwd + totals.us.costTwd;
  totals.pnlTwd = totals.tw.pnlTwd + totals.us.pnlTwd;
  totals.pnlPct = totals.costTwd ? (totals.pnlTwd / totals.costTwd) * 100 : null;
  return { positions, fx, totals, warnings, today: taipeiToday() };
}
