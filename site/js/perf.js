// 組合績效（docs/PIVOT.md 第 6 節）：用帳本交易紀錄還原每天持股，台股用日線收盤、美股用日線收盤 × 當天美元兌台幣，
// 算時間加權報酬（TWR，扣掉投入金額的影響）與資金加權報酬（XIRR）。都在瀏覽器計算。口徑寫在 computePerf 上面。
import { loadTrades, loadDaily, loadFx, loadDividends, DataError } from "./data.js";

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
  const trades = await loadTrades();
  const codes = (m) => [...new Set(trades.filter((t) => t.market === m && (t.side === "買進" || t.side === "賣出")).map((t) => t.code))];
  const tw = codes("tw"), us = codes("us");
  if (!tw.length && !us.length) throw new DataError("組合績效", "帳本沒有交易紀錄");
  const [fxRows, divs, ...bars] = await Promise.all([us.length ? loadFx() : Promise.resolve([]),
    // 配息資料讀不到時不擋整張圖，但要標出來（台股 ETF 的股利就沒算進去）
    tw.length ? loadDividends().catch(() => null) : Promise.resolve({ etfs: {} }),
    ...tw.map((c) => loadDaily("tw", c)), ...us.map((c) => loadDaily("us", c))]);
  return computePerf({ trades, bars: Object.fromEntries([...tw, ...us].map((c, i) => [c, bars[i]])), fxRows, divs });
}

// 組合績效的計算（不碰網路，tests/web/perf.html 直接呼叫）。口徑（改進報告 R08）：
// - 範圍是「已投入部位」：帳本交易紀錄還原的持股，不含可用資金與其他現金。買進是投入這個部位的錢、賣出與現金股利是離開的錢
// - 每天＝一個台股交易日的收盤：台股用當天收盤；美股用不晚於這個日期的最後一個美國收盤 × 當天（或之前最近）的美元兌台幣
// - 單日報酬＝（收盤市值 − 當天買進 ＋ 當天賣出 ＋ 當天除息的現金股利）÷ 前一天收盤市值；逐日連乘就是時間加權報酬
//   （流入、流出都算在當天收盤，所以買進當天成交價到收盤價的差與手續費算在那一天）。首筆交易那天只建立部位，從那天收盤起算
// - 台股 ETF 現金股利：market-data 的配息資料（每單位現金），除息日前一天收盤時的持股才領得到，除息日計入、稅前；
//   帳本「交易紀錄」只有買進／賣出，沒有記股利。美股日線是價格（不含股利），美股的股利沒有算進來
// trades：loadTrades()；bars：{ 代號: 日線 }；fxRows：loadFx()；divs：loadDividends()（null＝讀不到）
export function computePerf({ trades, bars, fxRows = [], divs = { etfs: {} } }) {
  const list = trades.filter((t) => (t.side === "買進" || t.side === "賣出") && t.shares > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) throw new DataError("組合績效", "帳本沒有交易紀錄");
  const codes = (m) => [...new Set(list.filter((t) => t.market === m).map((t) => t.code))];
  const tw = codes("tw"), us = codes("us");
  const fx = series(fxRows, (r) => r.value);
  const px = {};
  for (const c of [...tw, ...us]) px[c] = series(bars[c] || [], (b) => b.close);
  // 除息：{ 代號: [{ ex_date, cash }]（舊到新） }
  const ex = Object.fromEntries(tw.map((c) => [c, (divs?.etfs?.[c]?.events || [])
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.ex_date || "") && Number(e.cash) > 0)
    .map((e) => ({ date: e.ex_date, cash: Number(e.cash) })).sort((a, b) => a.date.localeCompare(b.date))]));

  // 每天的格子：台股交易日（任何一檔台股有 K 棒的日子），從第一筆交易起；沒有台股就用美股的日子
  const first = list[0].date;
  const gridSrc = tw.length ? tw : us;
  const grid = [...new Set(gridSrc.flatMap((c) => px[c].dates))].filter((d) => d >= first).sort();
  if (!grid.length) throw new DataError("組合績效", "日線還沒有交易日之後的資料");

  // 交易的台幣金額：台股用台幣金額（基準日前空白就用股數 × 成交價）；美股帳本有台幣金額就用，沒有用交割金額（美元）× 當天匯率
  const costTwd = (t) => {
    if (t.twd != null) return t.twd;
    const local = t.settle ?? t.shares * t.price;
    return t.market === "us" ? local * (fx.at(t.date) ?? NaN) : local;
  };

  const shares = {}, lastPrice = {}, exAt = {};
  const days = [], dividends = [];
  let ti = 0, prevV = null, prevD = null, index = 1, invested = 0;
  for (const d of grid) {
    // 現金股利：除息日在（前一個格子, 今天］之間，持股是今天的交易之前（除息日前一天收盤）的股數
    let div = 0;
    const dv = {};
    for (const c of tw) {
      const evs = ex[c];
      exAt[c] ??= 0;
      while (exAt[c] < evs.length && evs[exAt[c]].date <= d) {
        const e = evs[exAt[c]++];
        const n = shares[c] || 0;
        if (prevD == null || e.date <= prevD || n <= 0) continue;
        div += n * e.cash;
        dv[c] = (dv[c] || 0) + e.cash;
        dividends.push({ date: d, exDate: e.date, code: c, shares: n, cash: e.cash, amount: n * e.cash });
      }
    }
    let flow = 0;
    while (ti < list.length && list[ti].date <= d) {
      const t = list[ti++];
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
      const p = px[c]?.at(d) ?? lastPrice[c];
      const q = p * (isUs ? fx.at(d) ?? NaN : 1);
      pxd[c] = q;
      hv[c] = n * q;
      value += n * q;
    }
    if (prevV != null && prevV > 0) index *= (value - flow + div) / prevV;
    days.push({ date: d, value, flow, div, invested, index, hv, px: pxd, dv });
    prevV = value;
    prevD = d;
  }

  const last = days.at(-1);
  // XIRR：投入為負、賣出與股利為正，最後加上收盤市值
  const cfs = days.filter((x) => x.flow || x.div).map((x) => ({ date: x.date, amount: -x.flow + x.div }));
  cfs.push({ date: last.date, amount: last.value });
  return {
    days, first: days[0].date, last: last.date, value: last.value, invested: last.invested,
    twr: last.index - 1, xirr: xirr(cfs),
    flows: days.filter((x) => x.flow).map((x) => ({ date: x.date, amount: x.flow })),
    dividends, divTotal: dividends.reduce((a, x) => a + x.amount, 0), divsKnown: divs != null,
    // 每檔台股的配息概況（畫面說明用）：配息次數、最近一次除息日、第一次買進日
    exInfo: Object.fromEntries(tw.map((c) => [c, { count: ex[c].length, last: ex[c].at(-1)?.date || null, firstBuy: list.find((t) => t.code === c)?.date }])),
    years: (Date.parse(last.date) - Date.parse(days[0].date)) / (365 * 86400000),
    markets: Object.fromEntries([...tw.map((c) => [c, "tw"]), ...us.map((c) => [c, "us"])]),
    // 資料時間（R14）：美股最舊的最後收盤、匯率最後一天；之後的日子沿用這些值
    asOf: { us: us.length ? us.map((c) => px[c].dates.at(-1)).sort()[0] : null, fx: us.length ? fx.dates.at(-1) : null },
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
      // 除息日把每單位現金股利加回（跟組合的單日報酬同一個口徑）
      by[c] = (by[c] || 0) + k * (v / p.value) * ((q1 + (d.dv?.[c] || 0)) / q0 - 1 - rb);
    }
  }
  const diff = dN.index / d0.index - BN / B0;
  const sum = Object.values(by).reduce((a, x) => a + x, 0);
  let same = d0.value * (BN / B0);
  for (const d of days.slice(1)) {
    // 投入照同一天的大盤買；領走的現金股利也從大盤那邊領走同樣金額，兩邊才比得起來
    const b = d.flow || d.div ? benchAt(d.date) : null;
    if (b) same += (d.flow - (d.div || 0)) * (BN / b);
  }
  return {
    diff: diff * 100, other: (diff - sum) * 100, value: dN.value, same,
    by: Object.entries(by).map(([code, x]) => ({ code, pp: x * 100, market: perf.markets[code] })).sort((a, b) => a.pp - b.pp),
  };
}
