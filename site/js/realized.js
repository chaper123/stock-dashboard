// 已實現損益（docs/REALIZED_PNL.md）。純函式：不讀網路、不碰 DOM，tests/web/realized.html 直接呼叫。
// 平均成本法，全部換成台幣（跟 portfolio.js 的 twdCostBasis 同一種算法）：賣出照賣出前的平均成本扣掉，
// 股數歸 0 時成本也歸 0，下一筆買進重新開始一段持有。
import { shortDate, daysBetween } from "./fmt.js";

const EPS = 1e-9;
const noTwd = (dates, side) => `${dates.map(shortDate).join("、")} 的${side}沒有台幣金額，也查不到當天匯率`;

// trades：loadTrades() 的結果；refFx(date)：不晚於那天的美元兌台幣中間價（同 portfolio.js 的 fxOn），沒有是 null。
// 回傳 { rows（新到舊）, total, cost, proceeds, pct（%，cost 是 0 時 null）, est, ref, errors: [{ market, code, message }], open }
// rows 每筆：{ date, market, code, shares, since, days, proceeds, cost, pnl, pct, est, ref, closed }
// est＝這段持有裡有任何一筆買進、或這筆賣出本身用了股數×成交價估算（台股的 twd、settle 都空白）；ref＝用到參考匯率（美股）
// open：還沒賣掉的部分 { "市場:代號": { shares, cost } }（賣光與出錯的不列）
export function realizedPnl(trades, { refFx } = {}) {
  const groups = new Map();
  for (const t of trades || []) {
    if ((t.side !== "買進" && t.side !== "賣出") || !(t.shares > 0)) continue;
    const key = `${t.market}:${t.code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rows = [], errors = [], open = {};
  for (const [key, list] of groups) {
    // 同一天依帳本列號（沒有列號的保持原順序：sort 是穩定的）
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.row ?? 0) - (b.row ?? 0));
    const out = [];
    let shares = 0, cost = 0, since = null, estHold = false, refHold = false, error = null;
    const missBuy = [], missSell = [];
    for (const t of list) {
      const us = t.market === "us";
      // 這一筆換成台幣的金額與標記：買進是成本，賣出是拿回的錢
      let amount = null, est = false, ref = false;
      if (t.side === "買進") {
        if (!us) {
          amount = t.twd ?? t.settle ?? null;
          if (amount == null) {
            amount = t.shares * t.price + (t.fee ?? 0);
            est = true;
          }
        } else {
          const usd = t.settle ?? t.shares * t.price;
          if (t.twd != null) amount = t.twd;
          else if (t.fx) amount = usd * t.fx;
          else {
            const r = refFx ? refFx(t.date) : null;
            if (r) {
              amount = usd * r;
              ref = true;
            } else missBuy.push(t.date);
          }
        }
        if (shares < EPS) {
          since = t.date;
          estHold = false;
          refHold = false;
        }
        shares += t.shares;
        cost += amount ?? 0;
        estHold ||= est;
        refHold ||= ref;
        continue;
      }
      // 賣出
      if (!us) {
        amount = t.twd ?? t.settle ?? null;
        if (amount == null) {
          amount = t.shares * t.price - (t.fee ?? 0) - (t.tax ?? 0);
          est = true;
        }
      } else {
        const usd = t.settle ?? t.shares * t.price - (t.fee ?? 0) - (t.tax ?? 0);
        if (t.twd != null) amount = t.twd;
        else if (t.fx) amount = usd * t.fx;
        else {
          const r = refFx ? refFx(t.date) : null;
          if (r) {
            amount = usd * r;
            ref = true;
          } else missSell.push(t.date);
        }
      }
      if (t.shares > shares + EPS) {
        error = `${shortDate(t.date)} 賣出 ${t.shares} 股超過當時持有的 ${shares} 股`;
        break;
      }
      const sold = shares ? (cost * t.shares) / shares : 0;
      shares -= t.shares;
      cost -= sold;
      const closed = shares < EPS;
      const proceeds = amount ?? 0;
      out.push({
        date: t.date, market: t.market, code: t.code, shares: t.shares, since, days: daysBetween(since, t.date),
        proceeds, cost: sold, pnl: proceeds - sold, pct: sold > 0 ? ((proceeds - sold) / sold) * 100 : null,
        est: estHold || est, ref: refHold || ref, closed,
      });
      if (closed) {
        shares = 0;
        cost = 0;
        since = null;
        estHold = false;
        refHold = false;
      }
    }
    if (!error && missBuy.length) error = noTwd(missBuy, "買進");
    else if (!error && missSell.length) error = noTwd(missSell, "賣出");
    if (error) {
      errors.push({ market: list[0].market, code: list[0].code, message: error });
      continue; // 這一檔不算，其他檔照算
    }
    rows.push(...out);
    if (shares > EPS) open[key] = { shares, cost };
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.code.localeCompare(b.code));
  const total = rows.reduce((s, r) => s + r.pnl, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const proceeds = rows.reduce((s, r) => s + r.proceeds, 0);
  return {
    rows, total, cost, proceeds, pct: cost > 0 ? (total / cost) * 100 : null,
    est: rows.some((r) => r.est), ref: rows.some((r) => r.ref), errors, open,
  };
}
