// 資產頁「現金與投入」的計算（docs/R15_R18.md「R18 先講現金」；2026-11-17 資金頁改名，這張卡搬到資產頁）。
// 純函式：不讀網路、不碰 DOM。輸入是 loadSettings()、loadTrades() 的結果（loadTrades 已經拿掉網站沖銷的一對），
// 與 loadIncome() 的結果（帳本「其他入帳」：配息與手續費折抵，docs/OTHER_INCOME.md）。
// 讀不到的項目不補 0：那一項回傳 null、列在 missing，期末也不算。
import { isNum, int } from "./fmt.js";
import { dcaFor, nextDepositDate, addMonth } from "./discipline.js";
import { DISCIPLINE as D } from "./config.js";

// 金額都是數字相加；小數只留 2 位，免得 0.1 + 0.2 這類誤差冒出來。加 0 是把 -0 變成 0
const round2 = (v) => Math.round(v * 100) / 100 + 0;

// 一筆成交進出資金的金額（台幣）。優先用「台幣金額」：帳本設定的「基準日後買入合計」也是加這一欄；
// 台股沒有台幣金額時用交割金額（台股的交割金額就是台幣）。美股的交割金額是美元，不能直接加，沒有台幣金額就讀不到
export function tradeCash(t) {
  if (isNum(t.twd)) return t.twd;
  if (t.market === "tw" && isNum(t.settle)) return t.settle;
  return null;
}

// 「計入資金池＝是」的買進或賣出：逐筆明細（日期由舊到新，同一天維持帳本順序）與合計。
// 任何一筆讀不到金額，合計就是 null（不把那一筆當 0）
function legs(trades, side) {
  const rows = trades
    .filter((t) => t.inPool && t.side === side)
    .map((t) => ({ date: t.date, market: t.market, code: t.code, shares: t.shares, amount: tradeCash(t) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const unreadable = rows.filter((r) => !isNum(r.amount)).length;
  return { rows, unreadable, total: unreadable ? null : round2(rows.reduce((s, r) => s + r.amount, 0)) };
}

// 「計入資金池＝是」的其他入帳（配息、手續費折抵）：逐筆明細（日期由舊到新）與合計，金額用台幣金額欄（實際進錢包的）。
// income 的三種狀況要分清楚：
// - 沒給或 { configured: false }：分頁還沒接上，當成 0（known:true、configured:false）
// - null：分頁接上了但讀不到，合計是 null、不補 0（known:false）
// - { configured: true, rows }：正常；任何一列台幣金額讀不到，合計也是 null
function incomeLegs(income) {
  if (income === null) return { configured: true, known: false, rows: [], unreadable: 0, total: null };
  if (!income || income.configured === false) return { configured: false, known: true, rows: [], unreadable: 0, total: 0 };
  const rows = (income.rows || [])
    .filter((x) => x.inPool)
    .map((x) => ({ date: x.date, market: x.market, code: x.code, kind: x.kind, note: x.note, amount: isNum(x.twd) ? x.twd : null }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const unreadable = rows.filter((r) => !isNum(r.amount)).length;
  return { configured: true, known: true, rows, unreadable, total: unreadable ? null : round2(rows.reduce((s, r) => s + r.amount, 0)) };
}

// settings：loadSettings()；trades：loadTrades()（沖銷的一對已拿掉）；income：loadIncome()（讀不到傳 null；沒有就當還沒設定）
// 期末＝期初＋入金−買進＋賣出＋其他入帳，期初＝基準日未投入資金＋記帳前錢包零頭
export function cashTable({ settings, trades, income }) {
  const s = settings || {};
  const missing = [];
  const num = (v, label) => {
    if (isNum(v)) return v;
    missing.push(label);
    return null;
  };

  const basisFund = num(s.basisFund, "基準日未投入資金");
  const pocket = num(s.pocket, "記帳前錢包零頭");
  const opening = basisFund != null && pocket != null ? round2(basisFund + pocket) : null;
  const deposits = num(s.depositTotal, "累計入金");

  const buy = legs(trades || [], "買進");
  const sell = legs(trades || [], "賣出");
  if (buy.unreadable) missing.push(`買進（${buy.unreadable} 筆讀不到金額）`);
  if (sell.unreadable) missing.push(`賣出（${sell.unreadable} 筆讀不到金額）`);

  const inc = incomeLegs(income);
  if (!inc.known) missing.push("其他入帳");
  else if (inc.unreadable) missing.push(`其他入帳（${inc.unreadable} 筆讀不到金額）`);

  const closing = [opening, deposits, buy.total, sell.total, inc.total].every(isNum)
    ? round2(opening + deposits - buy.total + sell.total + inc.total) : null;
  const ledgerPool = isNum(s.pool) ? s.pool : null;
  const ledgerBuys = isNum(s.buysSince) ? s.buysSince : null;
  const ledgerSells = isNum(s.sellsSince) ? s.sellsSince : null;
  // 差額＝算出來的 − 帳本的；其中一邊沒有就不比（null），不是 0
  const poolDiff = closing != null && ledgerPool != null ? round2(closing - ledgerPool) : null;
  const buysDiff = buy.total != null && ledgerBuys != null ? round2(buy.total - ledgerBuys) : null;
  const sellsDiff = sell.total != null && ledgerSells != null ? round2(sell.total - ledgerSells) : null;
  const ledgerIncome = isNum(s.incomeSince) ? s.incomeSince : null;
  const incomeDiff = inc.configured && inc.total != null && ledgerIncome != null ? round2(inc.total - ledgerIncome) : null;
  // 累計入金是不是等於「已入金月數 × 每月入金」（定投金額中途改過就不會相等，畫面不能硬寫成乘法）
  const byMonths = isNum(s.depositMonths) && isNum(s.monthly) ? round2(s.depositMonths * s.monthly) : null;

  return {
    basis: s.basis || null,
    basisFund, pocket, opening,
    depositMonths: isNum(s.depositMonths) ? s.depositMonths : null,
    monthly: isNum(s.monthly) ? s.monthly : null,
    deposits,
    depositsByMonths: byMonths != null && deposits != null ? byMonths === deposits : null,
    buys: buy.total, buyRows: buy.rows,
    sells: sell.total, sellRows: sell.rows,
    income: inc.total, incomeRows: inc.rows, incomeConfigured: inc.configured, ledgerIncome, incomeDiff,
    closing, ledgerPool, poolDiff, ledgerBuys, buysDiff, ledgerSells, sellsDiff,
    missing,
  };
}

// 下一次入金日與金額：日期照每月 6 日入帳的規則（discipline.js），金額用「定投金額」分頁裡該月的設定；
// 讀不到定投金額分頁（dca 是 null）時用 config 的計畫金額，known 是 false，畫面要註明
export function nextDeposit(today, dca) {
  const date = nextDepositDate(today);
  return { date, amount: dcaFor(dca, date.slice(0, 7)), known: !!dca?.length };
}

// ── 總資產走勢（docs/ASSET_TREND.md）──
// 基準日到最新台股交易日，每個交易日的「持倉市值 ＋ 可用資金」，加一條對照線（基準日的總資產 ＋ 到那天為止已入帳的入金）。
// 純函式。股數從現在的持倉往回推（減掉那天之後的買進、加回賣出）；入金是基準日之後每個月一筆，日子取
// 那個月 6 日和那個月第一筆「計入資金池」買進的日子比較早的（6 日前就先買的月份，照 6 日入金會有一天負的可用資金），金額跟著「定投金額」；
// 沒有收盤的日子用之前最近的一筆。任何一檔缺價或匯率，整張圖不畫（回傳 ok:false 與缺什麼），不用 0 補；
// 可用資金排不出來（入金合計跟帳本不同、買賣讀不到金額、缺期初）時只畫持倉市值，hasCash:false 並寫明原因。
// 資料落後時（交易、入金的日期比最後一個交易日還晚）當成發生在最後一個交易日，最後一天才等於帳本現在的持倉與可用資金。
// 手續費與匯率變動都在裡面；可用資金含「其他入帳」分頁計入資金池的配息與手續費折抵。
function lastAtOrBefore(dates, d) {
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
const priceAt = (rows, dateOf, valueOf, d) => {
  const i = lastAtOrBefore(rows.map(dateOf), d);
  return i < 0 ? null : valueOf(rows[i]);
};

// settings：loadSettings()；trades：loadTrades()；holdings：loadHoldings()；bars：{ 代號: loadDaily 的日線 }；
// fxRows：loadFx()（沒有美股可以不給）；dca：loadDca()（null＝讀不到，用 config 的計畫金額）；
// income：loadIncome()（null＝讀不到，可用資金排不出來；沒給＝還沒設定，當 0）。其他入帳在入帳日加進可用資金，入帳日不是交易日就算在下一個交易日
export function assetTrend({ settings, trades, holdings, bars = {}, fxRows = null, dca = null, income }) {
  const s = settings || {};
  const fail = (missing) => ({ ok: false, missing });
  if (!s.basis) return fail(["基準日（帳本「設定」沒有這一列）"]);
  const list = (trades || []).filter((t) => (t.side === "買進" || t.side === "賣出") && t.shares > 0);
  const key = (market, code) => `${market}:${code}`;
  const cur = {}, meta = {};
  for (const h of holdings || []) {
    cur[key(h.market, h.code)] = h.shares ?? 0;
    meta[key(h.market, h.code)] = h;
  }
  for (const t of list) meta[key(t.market, t.code)] ??= { market: t.market, code: t.code };
  const keys = Object.keys(meta);
  const twCodes = keys.filter((k) => meta[k].market === "tw").map((k) => meta[k].code);
  const gridSrc = twCodes.length ? twCodes : keys.map((k) => meta[k].code);
  const grid = [...new Set(gridSrc.flatMap((c) => (bars[c] || []).map((b) => b.time)))].filter((d) => d >= s.basis).sort();
  if (!grid.length) return fail([`${s.basis} 之後的台股日線`]);
  const n = grid.length;
  const idxOf = (date) => {
    const i = grid.findIndex((g) => g >= date);
    return i < 0 ? n - 1 : i;
  };

  // 每個交易日的股數變動（買進 +、賣出 −）→ 從現在往回推
  const delta = Object.fromEntries(keys.map((k) => [k, new Array(n).fill(0)]));
  for (const t of list) delta[key(t.market, t.code)][idxOf(t.date)] += (t.side === "買進" ? 1 : -1) * t.shares;
  const shares = Object.fromEntries(keys.map((k) => {
    const out = new Array(n);
    let after = 0;
    for (let i = n - 1; i >= 0; i--) {
      out[i] = (cur[k] ?? 0) - after;
      after += delta[k][i];
    }
    return [k, out];
  }));

  // 可用資金：期初 ＋ 入金 − 買進 ＋ 賣出 ＋ 其他入帳（只算「計入資金池」的列）
  const cash = cashTable({ settings: s, trades, income });
  const reasons = [];
  if (cash.opening == null) reasons.push(`缺${[cash.basisFund == null && "基準日未投入資金", cash.pocket == null && "記帳前錢包零頭"].filter(Boolean).join("、")}`);
  if (cash.buys == null || cash.sells == null) reasons.push("有買進或賣出讀不到金額");
  if (cash.income == null) reasons.push("其他入帳讀不到或有讀不到金額的列");
  const deposits = [];
  if (!isNum(s.depositMonths)) reasons.push("缺已入金月數");
  else {
    for (let i = 1; i <= s.depositMonths; i++) {
      const ym = addMonth(s.basis.slice(0, 7), i);
      const sixth = `${ym}-${String(D.depositDay).padStart(2, "0")}`;
      const firstBuy = (trades || []).filter((t) => t.inPool && t.side === "買進" && t.date.startsWith(ym)).map((t) => t.date).sort()[0];
      deposits.push({ date: firstBuy && firstBuy < sixth ? firstBuy : sixth, amount: dcaFor(dca, ym) });
    }
    const sum = round2(deposits.reduce((a, x) => a + x.amount, 0));
    if (!isNum(s.depositTotal)) reasons.push("缺累計入金");
    else if (sum !== s.depositTotal) reasons.push(`入金照每月 6 日與「定投金額」排出來合計 ${sum}，跟帳本的累計入金 ${s.depositTotal} 不相等`);
  }
  const hasCash = reasons.length === 0;
  const flow = new Array(n).fill(0), depFlow = new Array(n).fill(0);
  if (hasCash) {
    for (const r of cash.buyRows) flow[idxOf(r.date)] -= r.amount;
    for (const r of cash.sellRows) flow[idxOf(r.date)] += r.amount;
    for (const r of cash.incomeRows) flow[idxOf(r.date)] += r.amount;
    for (const d of deposits) {
      flow[idxOf(d.date)] += d.amount;
      depFlow[idxOf(d.date)] += d.amount;
    }
  }

  const days = [], missing = new Set();
  let cashNow = hasCash ? cash.opening : null, line = null;
  for (let i = 0; i < n; i++) {
    const d = grid[i];
    let hold = 0;
    for (const k of keys) {
      const { market, code } = meta[k];
      const sh = shares[k][i];
      if (Math.abs(sh) < 1e-9) continue;
      if (sh < 0) return fail([`${code} 的交易紀錄跟持倉對不起來（${d} 往回推的股數是負的）`]);
      const p = priceAt(bars[code] || [], (b) => b.time, (b) => b.close, d);
      if (p == null) {
        missing.add(`${code} 的收盤價（${d} 以前沒有資料）`);
        continue;
      }
      let rate = 1;
      if (market === "us") {
        rate = priceAt(fxRows || [], (r) => r.date, (r) => r.value, d);
        if (rate == null) {
          missing.add(`美元兌台幣匯率（${d} 以前沒有資料）`);
          continue;
        }
      }
      hold += sh * p * rate;
    }
    if (hasCash) {
      cashNow += flow[i];
      line = i === 0 ? null : line + depFlow[i];
    }
    const total = hold + (hasCash ? cashNow : 0);
    if (hasCash && i === 0) line = total;
    days.push({ date: d, hold, cash: hasCash ? cashNow : null, total, line: hasCash ? line : null });
  }
  if (missing.size) return fail([...missing]);
  const first = days[0], last = days.at(-1);
  return {
    ok: true, hasCash, cashReason: hasCash ? null : reasons.join("；"),
    days, first, last, deposits,
    depositsAfter: hasCash ? round2(last.line - first.total) : null, // 基準日之後入帳的入金合計
    pnl: hasCash ? last.total - last.line : null,                    // 基準日以來的投資損益（含匯率變動與其他入帳的配息、折抵）
    closing: cash.closing,
  };
}

// 讀不到帳本的定投金額、改用計畫金額時，接在金額後面的提醒（試算頁與資產頁共用）
export const depositNote = (d) => (d.known ? "" : `（讀不到帳本的定投金額，先用計畫的 ${int(d.amount)} 元）`);
