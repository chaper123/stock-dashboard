// 持倉 × 最新價。台股有今天的富果報價（使用者自己的金鑰）就用它，否則用 market-data 最後收盤；
// 美股用最後收盤，以美元兌台幣中間價換算。
// 「今天漲跌」：台股＝現價對昨收；美股＝最後一個交易日對前一日（台北早上看到的是美國前一晚）。
import { loadHoldings, loadDaily, loadFx, loadTrades } from "./data.js";
import { fugleQuote, fugleUsable, quoteTime, FUGLE_NOTE } from "./fugle.js";
import { taipeiToday, shortDate } from "./fmt.js";

async function twQuote(code) {
  const [qR, barsR] = await Promise.allSettled([fugleQuote(code), loadDaily("tw", code)]);
  const q = qR.status === "fulfilled" ? qR.value : null;
  const bars = barsR.status === "fulfilled" ? barsR.value : null;
  // 富果今天的報價，或比 market-data 最後收盤新的那天（收盤後到隔天早上、週末）；market-data 讀不到時有富果就用
  if (q && (bars ? fugleUsable(q, bars.at(-1)?.time) : true)) {
    return { price: q.price, prev: q.prev, at: q.date === taipeiToday() ? quoteTime(q) : q.date, priceDate: q.date, note: FUGLE_NOTE,
      asOf: q.date === taipeiToday() ? `富果 ${quoteTime(q)}` : `${shortDate(q.date)} 收盤（富果）` };
  }
  if (!bars) throw barsR.reason;
  const b = bars.at(-1);
  return { price: b.close, prev: bars.at(-2)?.close, at: b.time, priceDate: b.time, note: "收盤", asOf: `${shortDate(b.time)} 收盤` };
}

async function usQuote(code) {
  const bars = await loadDaily("us", code);
  const b = bars.at(-1);
  return { price: b.close, prev: bars.at(-2)?.close, at: b.time, priceDate: b.time, note: "收盤", asOf: `${shortDate(b.time)} 收盤（美國）` };
}

// 美股剩餘部位的台幣成本（改進報告 R09），平均成本法（跟帳本 Apps Script 的持倉成本同一種算法）：
// 買進的台幣成本：帳本有「台幣金額」→ 實際；有成交「匯率」→ 交割金額 × 匯率（實際）；都沒有 → 交割金額 × 買進當天的
// 參考匯率（市場中間價，refFx(date)），標成參考、不能叫實際成本；連參考匯率都沒有就不算（不補造成本）。
// 賣出照賣出前的平均成本，同比例扣掉實際與參考兩部分。回傳 { shares, cost, actual, ref, kind, refDates } 或 { error }
export function twdCostBasis(trades, refFx) {
  const list = trades.filter((t) => (t.side === "買進" || t.side === "賣出") && t.shares > 0).sort((a, b) => a.date.localeCompare(b.date));
  let shares = 0, actual = 0, ref = 0;
  const refDates = [], missing = [];
  for (const t of list) {
    if (t.side === "賣出") {
      if (t.shares > shares + 1e-9) return { error: `${t.date} 賣出 ${t.shares} 股超過當時持有的 ${shares} 股` };
      const keep = shares ? 1 - t.shares / shares : 0;
      actual *= keep;
      ref *= keep;
      shares -= t.shares;
      continue;
    }
    const usd = t.settle ?? t.shares * t.price;
    shares += t.shares;
    if (t.twd != null) actual += t.twd;
    else if (t.fx) actual += usd * t.fx;
    else {
      const r = refFx(t.date);
      if (!r) missing.push(t.date);
      else {
        ref += usd * r;
        refDates.push(t.date);
      }
    }
  }
  if (missing.length) return { error: `${missing.join("、")} 的買進沒有台幣金額，也查不到當天匯率`, shares };
  return { shares, cost: actual + ref, actual, ref, refDates, kind: ref < 1e-9 ? "actual" : actual < 1e-9 ? "ref" : "mixed" };
}

// 已排序的匯率列裡，不晚於 d 的最後一個值
function fxOn(rows, d) {
  let v = null;
  for (const r of rows) {
    if (r.date > d) break;
    v = r.value;
  }
  return v;
}

// complete／missing（改進報告 R07）：有持倉卻缺匯率或價格時，合計只是部分資產，呼叫端要標示、衍生結果不能當完整的用
export async function loadPortfolio() {
  const holdings = await loadHoldings();
  const warnings = [];
  const hasUs = holdings.some((h) => h.market === "us");
  const hasTw = holdings.some((h) => h.market === "tw");
  const [fxR, trR] = await Promise.allSettled([hasUs ? loadFx() : Promise.resolve(null), hasUs ? loadTrades() : Promise.resolve([])]);
  const fxRow = fxR.status === "fulfilled" && fxR.value ? fxR.value.at(-1) : null;
  const fx = fxRow ? { rate: fxRow.value, date: fxRow.date } : null;
  if (hasUs && !fx) warnings.push(`讀不到匯率（${fxR.reason?.message || "未知原因"}），美股沒有換算成台幣`);

  const positions = await Promise.all(holdings.map(async (h) => {
    const p = { ...h };
    try {
      Object.assign(p, h.market === "tw" ? await twQuote(h.code) : await usQuote(h.code));
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
    p.dayChg = Number.isFinite(p.prev) ? (p.price - p.prev) * p.shares : null;
    p.dayChgTwd = rate && p.dayChg != null ? p.dayChg * rate : null;
    // R09 含匯差：台股的台幣損益本來就含（沒有匯率）；美股＝現在的台幣市值 − 剩餘部位的歷史台幣成本
    if (h.market === "tw") Object.assign(p, { fxBasis: { kind: "actual" }, costTwdHist: p.costTwd, pnlTwdFx: p.pnlTwd });
    else if (trR.status === "rejected") p.fxBasis = { error: `讀不到交易紀錄（${trR.reason?.message || "未知原因"}）` };
    else {
      const b = twdCostBasis(trR.value.filter((t) => t.market === "us" && t.code === h.code), (d) => fxOn(fxR.value || [], d));
      p.fxBasis = !b.error && Math.abs(b.shares - h.shares) > 1e-6
        ? { error: `交易紀錄合計 ${b.shares} 股，跟持倉 ${h.shares} 股對不起來` } : b;
      if (!p.fxBasis.error && p.mvTwd != null) {
        p.costTwdHist = b.cost;
        p.pnlTwdFx = p.mvTwd - b.cost;
        p.fxEffect = p.pnlTwd != null ? p.pnlTwdFx - p.pnlTwd : null; // 匯率造成的部分
      }
    }
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
      dayChgTwd: sum(list, "dayChgTwd"),
    };
    totals[m].pnlPct = totals[m].cost ? (totals[m].pnl / totals[m].cost) * 100 : null;
  }
  totals.mvTwd = totals.tw.mvTwd + totals.us.mvTwd;
  totals.costTwd = totals.tw.costTwd + totals.us.costTwd;
  totals.pnlTwd = totals.tw.pnlTwd + totals.us.pnlTwd;
  totals.dayChgTwd = totals.tw.dayChgTwd + totals.us.dayChgTwd;
  totals.pnlPct = totals.costTwd ? (totals.pnlTwd / totals.costTwd) * 100 : null;
  // 含匯差（R09）：每一檔都有歷史台幣成本才給合計；美股成本有用參考匯率的就標參考
  const ok = positions.filter((p) => !p.error);
  const lack = ok.filter((p) => p.pnlTwdFx == null);
  const us = ok.filter((p) => p.market === "us" && p.pnlTwdFx != null);
  totals.withFx = lack.length ? { complete: false, lack: lack.map((p) => ({ code: p.code, why: p.fxBasis?.error || "沒有台幣市值" })) } : {
    complete: true, pnl: sum(ok, "pnlTwdFx"), cost: sum(ok, "costTwdHist"), fxEffect: sum(us, "fxEffect"),
    kind: us.some((p) => p.fxBasis.kind !== "actual") ? (us.every((p) => p.fxBasis.kind === "ref") ? "ref" : "mixed") : "actual",
  };
  if (totals.withFx.complete) totals.withFx.pnlPct = totals.withFx.cost ? (totals.withFx.pnl / totals.withFx.cost) * 100 : null;
  const missing = [
    ...(hasUs && !fx ? ["美元兌台幣匯率（美股沒算進台幣合計）"] : []),
    ...positions.filter((p) => p.error).map((p) => `${p.code} 價格`),
  ];
  return { positions, fx, totals, warnings, missing, complete: missing.length === 0, today: taipeiToday() };
}

// 含匯差的口徑說明（總覽與持倉共用）
export const FX_KIND_LABEL = {
  actual: "美股成本用帳本的實際台幣金額",
  ref: "美股成本用買進當天的參考匯率換算（帳本沒有實際台幣金額）",
  mixed: "部分美股成本用買進當天的參考匯率換算（那幾筆帳本沒有實際台幣金額）",
};
