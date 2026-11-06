// 組合績效（docs/PIVOT.md 第 6 節）：用帳本交易紀錄還原每天持股，台股用日線收盤、美股用日線收盤 × 當天美元兌台幣，
// 算時間加權報酬（TWR，扣掉投入金額的影響）與資金加權報酬（XIRR）。都在瀏覽器計算。
import { loadTrades, loadDaily, loadFx, DataError } from "./data.js";

// 已排序的日期陣列裡，最後一個 ≤ d 的位置
function lastIdx(dates, d) {
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function series(rows, pick) {
  const dates = rows.map((r) => r.time ?? r.date);
  const vals = rows.map(pick);
  return { dates, at: (d) => {
    const i = lastIdx(dates, d);
    return i < 0 ? null : vals[i];
  } };
}

// XIRR：cfs＝[{ date, amount }]，投入為負、最後市值為正；找不到解回傳 null
export function xirr(cfs) {
  if (cfs.length < 2) return null;
  const t0 = Date.parse(cfs[0].date);
  const npv = (r) => cfs.reduce((s, c) => s + c.amount / Math.pow(1 + r, (Date.parse(c.date) - t0) / (365 * 86400000)), 0);
  let lo = -0.99, hi = 10, flo = npv(lo);
  if (flo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-8) return mid;
    if (flo * fm < 0) hi = mid;
    else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

let memo = null;
export function loadPerformance() {
  memo ??= build().catch((e) => {
    memo = null;
    throw e;
  });
  return memo;
}

async function build() {
  const trades = (await loadTrades()).filter((t) => (t.side === "買進" || t.side === "賣出") && t.shares > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!trades.length) throw new DataError("組合績效", "帳本沒有交易紀錄");
  const codes = (m) => [...new Set(trades.filter((t) => t.market === m).map((t) => t.code))];
  const tw = codes("tw"), us = codes("us");
  const [fxRows, ...bars] = await Promise.all([us.length ? loadFx() : Promise.resolve([]),
    ...tw.map((c) => loadDaily("tw", c)), ...us.map((c) => loadDaily("us", c))]);
  const fx = series(fxRows, (r) => r.value);
  const px = {};
  [...tw, ...us].forEach((c, i) => {
    px[c] = series(bars[i], (b) => b.close);
  });

  // 每天的格子：台股交易日（任何一檔台股有 K 棒的日子），從第一筆交易起；沒有台股就用美股的日子
  const first = trades[0].date;
  const gridSrc = tw.length ? tw : us;
  const grid = [...new Set(gridSrc.flatMap((c) => px[c].dates))].filter((d) => d >= first).sort();
  if (!grid.length) throw new DataError("組合績效", "日線還沒有交易日之後的資料");

  // 交易的台幣成本：台股用台幣金額（基準日前空白就用股數 × 成交價）；美股用交割金額（美元）× 當天匯率
  const costTwd = (t) => {
    if (t.twd != null) return t.twd;
    const local = t.settle ?? t.shares * t.price;
    return t.market === "us" ? local * (fx.at(t.date) ?? NaN) : local;
  };
  const priceAt = (t, d) => {
    const p = px[t]?.at(d);
    return p ?? null;
  };

  const shares = {}, lastPrice = {};
  const days = [];
  let ti = 0, prevV = null, index = 1, invested = 0;
  for (const d of grid) {
    let flow = 0;
    while (ti < trades.length && trades[ti].date <= d) {
      const t = trades[ti++];
      const sign = t.side === "賣出" ? -1 : 1;
      shares[t.code] = (shares[t.code] || 0) + sign * t.shares;
      lastPrice[t.code] ??= t.price;
      flow += sign * costTwd(t);
    }
    invested += flow;
    let value = 0;
    const hv = {}, pxd = {}; // 每檔的台幣市值與台幣價格（給 attribution 拆解用）
    for (const [c, n] of Object.entries(shares)) {
      if (!n) continue;
      const isUs = us.includes(c);
      const p = priceAt(c, d) ?? lastPrice[c];
      const q = p * (isUs ? fx.at(d) ?? NaN : 1);
      pxd[c] = q;
      hv[c] = n * q;
      value += n * q;
    }
    // TWR：當天報酬＝(收盤市值 − 當天投入) ÷ 前一天收盤市值
    if (prevV != null && prevV > 0) index *= (value - flow) / prevV;
    days.push({ date: d, value, flow, invested, index, hv, px: pxd });
    prevV = value;
  }

  const last = days.at(-1);
  const cfs = days.filter((x) => x.flow).map((x) => ({ date: x.date, amount: -x.flow }));
  cfs.push({ date: last.date, amount: last.value });
  return {
    days, first: days[0].date, last: last.date, value: last.value, invested: last.invested,
    twr: last.index - 1, xirr: xirr(cfs),
    flows: days.filter((x) => x.flow).map((x) => ({ date: x.date, amount: x.flow })),
    years: (Date.parse(last.date) - Date.parse(days[0].date)) / (365 * 86400000),
    markets: Object.fromEntries([...tw.map((c) => [c, "tw"]), ...us.map((c) => [c, "us"])]),
  };
}

// 為什麼輸（贏）大盤（docs/INSIGHTS.md 4.2）：把「組合 − 大盤」的累積報酬差拆到每一檔。
// 每檔每天＝前一天權重 ×（該檔當天報酬 − 大盤當天報酬），再乘「之前的組合成長 × 之後的大盤成長」，
// 這樣整段加總剛好等於累積報酬差；剩下的（買進當天成交價與收盤價的差、手續費）列成「其他」。
// 另算「同樣的錢在同樣的日子改投大盤」現在值多少（包含投入時點的影響）。benchAt(date) 回傳大盤當天（或之前最近）的值
export function attribution(perf, start, benchAt) {
  const days = perf.days.filter((x) => x.date >= start);
  if (days.length < 2) return null;
  const d0 = days[0], dN = days.at(-1);
  const B0 = benchAt(d0.date), BN = benchAt(dN.date);
  if (!B0 || !BN) return null;
  const by = {};
  for (let i = 1; i < days.length; i++) {
    const p = days[i - 1], d = days[i];
    const bp = benchAt(p.date), bd = benchAt(d.date);
    if (!(p.value > 0) || !bp || !bd) continue;
    const rb = bd / bp - 1;
    const k = (p.index / d0.index) * (BN / bd);
    for (const [c, v] of Object.entries(p.hv)) {
      const q0 = p.px[c], q1 = d.px[c];
      if (!(v > 0) || !q0 || !q1) continue;
      by[c] = (by[c] || 0) + k * (v / p.value) * (q1 / q0 - 1 - rb);
    }
  }
  const diff = dN.index / d0.index - BN / B0;
  const sum = Object.values(by).reduce((a, x) => a + x, 0);
  let same = d0.value * (BN / B0);
  for (const d of days.slice(1)) {
    const b = d.flow ? benchAt(d.date) : null;
    if (b) same += d.flow * (BN / b);
  }
  return {
    diff: diff * 100, other: (diff - sum) * 100, value: dN.value, same,
    by: Object.entries(by).map(([code, x]) => ({ code, pp: x * 100, market: perf.markets[code] })).sort((a, b) => a.pp - b.pp),
  };
}
