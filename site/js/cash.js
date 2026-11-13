// 資金頁「現金與投入」的計算（docs/R15_R18.md「R18 資金頁先講現金」）。
// 純函式：不讀網路、不碰 DOM。輸入是 loadSettings() 的結果與 loadTrades() 的結果（loadTrades 已經拿掉網站沖銷的一對）。
// 讀不到的項目不補 0：那一項回傳 null、列在 missing，期末也不算。
import { isNum } from "./fmt.js";
import { dcaFor, nextDepositDate } from "./discipline.js";

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

// settings：loadSettings()；trades：loadTrades()（沖銷的一對已拿掉）
// 期末＝期初＋入金−買進＋賣出，期初＝基準日未投入資金＋記帳前錢包零頭
export function cashTable({ settings, trades }) {
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

  const closing = [opening, deposits, buy.total, sell.total].every(isNum)
    ? round2(opening + deposits - buy.total + sell.total) : null;
  const ledgerPool = isNum(s.pool) ? s.pool : null;
  const ledgerBuys = isNum(s.buysSince) ? s.buysSince : null;
  // 差額＝算出來的 − 帳本的；其中一邊沒有就不比（null），不是 0
  const poolDiff = closing != null && ledgerPool != null ? round2(closing - ledgerPool) : null;
  const buysDiff = buy.total != null && ledgerBuys != null ? round2(buy.total - ledgerBuys) : null;
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
    closing, ledgerPool, poolDiff, ledgerBuys, buysDiff,
    missing,
  };
}

// 下一次入金日與金額：日期照每月 6 日入帳的規則（discipline.js），金額用「定投金額」分頁裡該月的設定；
// 讀不到定投金額分頁（dca 是 null）時用 config 的計畫金額，known 是 false，畫面要註明
export function nextDeposit(today, dca) {
  const date = nextDepositDate(today);
  return { date, amount: dcaFor(dca, date.slice(0, 7)), known: !!dca?.length };
}
