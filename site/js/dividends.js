// 資產頁「配息」卡的純函式（docs/AUTO_DIVIDENDS.md 第 3 節）：接下來的預計配息、最近入帳、Apps Script 自動記帳狀態。
// 不碰畫面也不連網；資料由 pages/assets_dividends.js 讀好傳進來。金額都是估算，實際入帳以錢包為準。
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const DAY = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(ymd) + n * DAY).toISOString().slice(0, 10);
const gap = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export const US_KEEP = 0.7;        // 美股配息扣 30% 預扣稅，實收 7 成（跟 Apps Script 一致）
export const WINDOW_DAYS = 60;     // 「接下來」只列 60 天內除息的
export const US_STALE_DAYS = 400;  // 美股上次除息超過這麼久，當成沒在配息
export const PAYING_NO_DATE_DAYS = 45; // 已除息但發放日未公布：除息後 45 天內還算「待發放」
export const RECENT_N = 5;

// 除息日前（不含除息日當天）的持股＝買進減賣出；trades 是 loadTrades() 的結果（沖銷的一對已拿掉）
export function sharesBefore(trades, market, code, exDate) {
  let n = 0;
  for (const t of trades || []) {
    if (t.market !== market || String(t.code).toUpperCase() !== String(code).toUpperCase() || !(t.date < exDate) || !isNum(t.shares)) continue;
    if (t.side === "買進") n += t.shares;
    else if (t.side === "賣出") n -= t.shares;
  }
  return Math.round(n * 1e6) / 1e6;
}

// 美股估算：股數 × 每股 × 0.7 × 匯率，四捨五入到元；沒有匯率或沒有金額回傳 null
export function usEstimate(shares, perShare, rate) {
  if (!isNum(shares) || !isNum(perShare) || !isNum(rate)) return null;
  return Math.round(shares * perShare * US_KEEP * rate);
}

// 接下來的預計配息：每檔現在持有的標的。
//   holdings：loadHoldings()；tw：loadDividends()（null＝讀不到）；us：美股配息檔 data/dividends/us.json（null＝讀不到或還沒有）；
//   fxRows：loadFx()（null＝讀不到）；trades：loadTrades()（算已除息、待發放那筆的股數；沒給就用現在的股數）；
//   income：loadIncome().rows（已經記進去的配息不再列為待發放）；today：台北今天 YYYY-MM-DD
// 回傳 { items, twMissing, usMissing }。items 每項：
//   { status: "next", market: "tw", code, exDate, payDate, perUnit, shares, estimate }  60 天內要除息（台股 next；金額沒公布 estimate 是 null）
//   { status: "paying", market: "tw", ... }                                            已除息、還沒發放（或發放日沒公布）
//   { status: "usLast", market: "us", code, exDate, perShare, shares, rate, estimate }  美股沒有未來的除息日：上次除息，約每季一次
//   { status: "none", market, code }                                                   最近沒有除息
export function upcomingDividends({ holdings, tw, us, fxRows, trades, income = [], today, days = WINDOW_DAYS }) {
  const items = [];
  const list = holdings || [];
  const recorded = new Set(income.filter((r) => r.kind === "配息" && r.exDate).map((r) => `${String(r.code).toUpperCase()}|${r.exDate}`));
  const rate = fxRows && fxRows.length ? fxRows[fxRows.length - 1].value : null;
  const twHeld = list.filter((h) => h.market === "tw");
  const usHeld = list.filter((h) => h.market === "us");
  const end = addDays(today, days);

  for (const h of twHeld) {
    if (!tw) break;
    const etf = tw.etfs && tw.etfs[h.code];
    const before = items.length;
    const nx = etf && etf.next;
    if (nx && YMD.test(nx.ex_date || "") && nx.ex_date >= today && nx.ex_date <= end) {
      const perUnit = num(nx.cash);
      items.push({ status: "next", market: "tw", code: h.code, exDate: nx.ex_date, payDate: YMD.test(nx.pay_date || "") ? nx.pay_date : "",
        perUnit, shares: h.shares, estimate: perUnit == null ? null : Math.round(h.shares * perUnit) });
    }
    const last = etf && etf.last;
    if (last && YMD.test(last.ex_date || "") && last.ex_date < today && !recorded.has(`${h.code.toUpperCase()}|${last.ex_date}`)) {
      const hasPay = YMD.test(last.pay_date || "");
      const pending = hasPay ? last.pay_date >= today : gap(last.ex_date, today) <= PAYING_NO_DATE_DAYS;
      const shares = trades ? sharesBefore(trades, "tw", h.code, last.ex_date) : h.shares;
      const perUnit = num(last.cash);
      if (pending && shares > 0) {
        items.push({ status: "paying", market: "tw", code: h.code, exDate: last.ex_date, payDate: hasPay ? last.pay_date : "",
          perUnit, shares, estimate: perUnit == null ? null : Math.round(shares * perUnit) });
      }
    }
    if (items.length === before) items.push({ status: "none", market: "tw", code: h.code });
  }

  for (const h of usHeld) {
    if (!us) break;
    const sym = us.symbols && us.symbols[h.code];
    const ev = (sym && sym.events) || [];
    const last = ev.length ? ev[ev.length - 1] : null;
    if (last && YMD.test(last.ex_date || "") && gap(last.ex_date, today) <= US_STALE_DAYS) {
      const perShare = num(last.cash);
      items.push({ status: "usLast", market: "us", code: h.code, exDate: last.ex_date, perShare, shares: h.shares, rate,
        estimate: usEstimate(h.shares, perShare, rate) });
    } else {
      items.push({ status: "none", market: "us", code: h.code });
    }
  }

  // 要除息的在前（依除息日），然後是美股上次除息，沒有的放最後
  const rank = { paying: 0, next: 1, usLast: 2, none: 3 };
  items.sort((a, b) => rank[a.status] - rank[b.status] || (a.exDate || "").localeCompare(b.exDate || "") || a.code.localeCompare(b.code));
  return { items, twMissing: !tw && twHeld.length > 0, usMissing: !us && usHeld.length > 0 };
}

// 最近入帳：「其他入帳」類型是配息的最近 n 列（入帳日由新到舊，同一天看試算表列號）。
// estimated：來源是「自動估算」＝Apps Script 估的，不是照錢包記的
export function recentDividends(rows, n = RECENT_N) {
  return (rows || []).filter((r) => r.kind === "配息")
    .sort((a, b) => b.date.localeCompare(a.date) || (b.row || 0) - (a.row || 0))
    .slice(0, n)
    .map((r) => ({ date: r.date, code: r.code, market: r.market, twd: r.twd, source: r.source, exDate: r.exDate, inPool: r.inPool,
      estimated: r.source === "自動估算" }));
}

// Apps Script ping 回的 autoDividends：{ lastRun: "2026-11-18 09:12:03", added, error }；
// undefined＝舊版 Apps Script（沒有這個欄位）或沒設定記帳連線，卡片不顯示這行；null＝裝好了但還沒跑過
export function autoStatusLine(s) {
  if (s === undefined) return null;
  if (s === null) return { kind: "never", text: "自動記帳：還沒跑過（Apps Script 裝好觸發器後每天跑一次）", error: "" };
  const m = /^\d{4}-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s.lastRun || "");
  const when = m ? `${m[1]}/${m[2]} ${m[3]}:${m[4]}` : "時間不明";
  const error = String(s.error || "");
  return { kind: error ? "error" : "ok", text: `上次自動檢查：${when}${error ? "" : s.added > 0 ? `，新增 ${s.added} 筆` : "，沒有新增"}`, error };
}
