// 資產頁的計算（docs/ASSETS_PAGE.md）。純函式：不讀網路、不碰 DOM，tests/web/assets.html 直接呼叫。
// 輸入多半是 perf.js 的 loadPerformance()／computePerf() 的 days：每個台股交易日一筆
// { date, value 持倉市值, flow 當天投入（買進為正、賣出為負）, div 當天台股 ETF 現金股利, other 當天其他入帳（美股配息、手續費折抵；沒有就是 0 或沒有這個欄位）,
//   invested 累計投入, index 時間加權指數, hv, px }。

// 共用的期間選擇（一整塊資產變化共用一排）
export const PERIODS = [["1w", "一週"], ["1m", "一月"], ["3m", "一季"], ["ytd", "年初至今"], ["1y", "一年"], ["all", "全部"]];
export const periodLabel = (key) => PERIODS.find(([k]) => k === key)?.[1] ?? key;

const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

// 期間起點（日期字串，不一定是交易日）：從 last（最後一個交易日）往前推。一月、一季、一年是日曆上的幾個月（月底不夠就取當月最後一天，
// 例如 3/31 往前一個月是 2/28），年初至今是 last 那一年的 1/1。起點比第一筆買進（first）早就從 first 開始
export function periodStart(key, first, last) {
  const [y, m, d] = last.split("-").map(Number);
  let s;
  if (key === "1w") s = iso(y, m - 1, d - 7);
  else if (key === "1m" || key === "3m") {
    const back = key === "1m" ? 1 : 3;
    const t = new Date(Date.UTC(y, m - 1 - back, 1));
    s = iso(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, daysIn(t.getUTCFullYear(), t.getUTCMonth())));
  } else if (key === "1y") s = iso(y - 1, m - 1, Math.min(d, daysIn(y - 1, m - 1)));
  else if (key === "ytd") s = iso(y, 0, 1);
  else return first;
  return s < first ? first : s;
}

// 每天的損益與報酬率。損益＝收盤市值 − 前一天收盤市值 − 當天投入 ＋ 當天現金股利 ＋ 當天其他入帳；第一天沒有前一天，市值 − 投入（買進當天成交價到收盤價的差與手續費）。
// 報酬率＝時間加權指數的單日變化（index(d) ÷ index(d−1) − 1），第一天沒有
export function dailyPnl(days) {
  return days.map((d, i) => ({
    date: d.date,
    pnl: (i ? d.value - days[i - 1].value : d.value) - d.flow + d.div + (d.other ?? 0),
    ret: i && days[i - 1].index > 0 ? d.index / days[i - 1].index - 1 : null,
  }));
}

// 期間內的日子（第一個 ≥ start 的交易日是期間的第一天）；整段都在 start 之前時回傳 []
export const daysFrom = (days, start) => days.filter((d) => d.date >= start);

// 累計損益與每日損益。期間的第一天累計從 0 開始，只累加它之後每一天的損益（它自己當天的損益算在期間之前）；
// 例外是期間的第一天就是整份資料的第一天（選「全部」）：那天以前部位是 0，第一天的損益也算進來，這樣全部期間的累計損益
// ＝ 最新持倉市值 − 累計投入 ＋ 已領股利。回傳 [{ date, pnl（當天損益，期間第一天是 null）, cum, ret }]；沒有資料時是 []
export function periodPnl(days, start) {
  const all = dailyPnl(days);
  const i0 = all.findIndex((x) => x.date >= start);
  if (i0 < 0) return [];
  const whole = i0 === 0;
  let cum = 0;
  return all.slice(i0).map((x, k) => {
    const counted = k > 0 || whole;
    if (counted) cum += x.pnl;
    return { date: x.date, pnl: counted ? x.pnl : null, cum, ret: x.ret };
  });
}

// ── 報酬率對比較標的（ASSETS_PAGE 2.3）──

// 已排序的 rows 裡，每個 dates 的日子取「不晚於那天的最後一筆」；那天之前沒有資料是 null。rows 是 [{ date|time, … }]，pick 取出數值
export function valuesAt(rows, dates, pick = (r) => r.value) {
  const out = [];
  let i = -1;
  for (const d of dates) {
    while (i + 1 < rows.length && (rows[i + 1].date ?? rows[i + 1].time) <= d) i++;
    out.push(i < 0 ? null : pick(rows[i]));
  }
  return out;
}

// 台股 ETF 含現金股利的報酬指數（比較線）：照 perf.js 對持股的算法——每天＝前一天指數 ×（當天收盤 ＋ 當天除息的現金股利）÷ 前一天收盤，
// 逐日連乘，第一天是 1。收盤取不晚於當天的最後一根（休市、缺日沿用前一天）；除息日落在（前一個日子, 今天］之間就算在今天（稅前）。
// bars：日線 [{ time, close }]；events：[{ date: 除息日, cash }]（可以是空的或 null＝只用價格）；dates：要算的日子（升冪）。
// 第一天以前沒有收盤就回傳 null（算不出來，不補）
export function etfIndex(bars, events, dates) {
  const close = valuesAt(bars || [], dates, (b) => b.close);
  if (!dates.length || !(close[0] > 0)) return null;
  const ev = (events || []).filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Number(e.cash) > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out = [1];
  let k = 0;
  while (k < ev.length && ev[k].date <= dates[0]) k++; // 第一天（含）以前的除息，不算在期間內
  for (let i = 1; i < dates.length; i++) {
    let div = 0;
    while (k < ev.length && ev[k].date <= dates[i]) div += Number(ev[k++].cash);
    out.push(out[i - 1] * ((close[i] + div) / close[i - 1]));
  }
  return out;
}

// 換算成「期間起點（第 i0 個）＝ 0%」的累積報酬（%）；起點或某天沒有值就是 null
export function rebase(values, i0 = 0) {
  const base = values?.[i0];
  return (values || []).map((v) => (v == null || !(base > 0) ? null : (v / base - 1) * 100));
}

// ── 個股表現（ASSETS_PAGE 2.4）──

// 「YYYY-MM-DD」往前（後）推 n 天
export function shiftDays(d, n) {
  const [y, m, day] = d.split("-").map(Number);
  return iso(y, m - 1, day + n);
}

// bars（升冪）裡最後一根 ≤ d 的位置，沒有是 -1
function barIdx(bars, d) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= d) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// 收盤價對收盤價的價格報酬（%，不含股利、美股是美元價格不含匯率）。最後一根取不晚於 last 的收盤；
// day＝跟前一根比（近 1 日）、week＝跟 last 往前 7 天（含）以前最近的一根比（近一週）、period＝跟 start（期間起點）以前最近的一根比。
// 資料不夠早（沒有那根）是 null。bars：[{ time, close }]
export function priceReturns(bars, last, start) {
  const i = barIdx(bars || [], last);
  if (i < 0) return { endDate: null, close: null, day: null, week: null, period: null };
  const end = bars[i].close;
  const ret = (j) => (j >= 0 && bars[j].close > 0 ? (end / bars[j].close - 1) * 100 : null);
  return { endDate: bars[i].time, close: end, day: ret(i - 1), week: ret(barIdx(bars, shiftDays(last, -7))), period: ret(barIdx(bars, start)) };
}

// 個股表現的列：台股持股（期間報酬由高到低，讀不到的排最後）後面接一列加權指數、美股持股後面接一列 S&P 500，作為對照。
// holdings：[{ market, code }]（現在還持有的）；bars：{ 代號: [{ time, close }] }；indices：{ tw?: { code, name, bars }, us?: {…} }
// 回傳 [{ kind: "stock"|"index", market, code, name?, day, week, period, missing }]
export function performanceRows({ holdings, bars, indices = {}, last, start }) {
  const out = [];
  const byPeriod = (a, b) => (a.period == null) - (b.period == null) || (b.period ?? 0) - (a.period ?? 0);
  for (const market of ["tw", "us"]) {
    const rows = holdings.filter((h) => h.market === market).map((h) => ({
      kind: "stock", market, code: h.code, missing: !bars[h.code]?.length, ...priceReturns(bars[h.code], last, start),
    })).sort(byPeriod);
    if (!rows.length) continue;
    out.push(...rows);
    const ix = indices[market];
    if (ix) out.push({ kind: "index", market, code: ix.code, name: ix.name, missing: !ix.bars?.length, ...priceReturns(ix.bars, last, start) });
  }
  return out;
}

// ── 報酬日曆（ASSETS_PAGE 2.5）──

// 兩個月份（YYYY-MM）之間（含）的每個月，升冪
export function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split("-").map(Number);
  const [y2, m2] = b.split("-").map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// 單日報酬連乘：只乘有值的日子，一天都沒有是 null（報酬率，不是百分比）
const chain = (rets) => {
  const live = rets.filter((r) => r != null);
  return live.length ? live.reduce((p, r) => p * (1 + r), 1) - 1 : null;
};

// 一個月的日曆：週一到週五五欄的一列一週。daily 是 dailyPnl(perf.days) 的結果（[{ date, pnl, ret }]）。
// 回傳 { ym, weeks: [{ cells, pnl, ret }], pnl, ret }：cells 五格，不是這個月的日子是 null，這個月但沒有資料（休市、還沒到、還沒開始）是
// { date, day, trading: false }，有資料的是 { date, day, trading: true, pnl, ret }。
// 週損益＝那一列有資料的日子的損益相加，週報酬率＝那些日子的單日報酬連乘減 1（跨月的週，這個月只算這個月的日子，兩個月加起來是整週）；
// 整月損益＝每日損益相加、整月報酬率＝每日報酬連乘減 1。整列都不是這個月的週（月初週末那一列）不列。沒有資料的週與月，pnl、ret 是 null
export function calendarMonth(daily, ym) {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const [y, m] = ym.split("-").map(Number);
  const DAY = 86400000;
  const first = Date.UTC(y, m - 1, 1), end = Date.UTC(y, m, 0); // 當月第一天、最後一天
  const back = (new Date(first).getUTCDay() + 6) % 7;            // 往前退到那一週的週一
  const weeks = [];
  for (let monday = first - back * DAY; monday <= end; monday += 7 * DAY) {
    const cells = [];
    for (let k = 0; k < 5; k++) {
      const t = monday + k * DAY;
      if (t < first || t > end) {
        cells.push(null);
        continue;
      }
      const date = new Date(t).toISOString().slice(0, 10);
      const d = byDate.get(date);
      cells.push(d ? { date, day: new Date(t).getUTCDate(), trading: true, pnl: d.pnl, ret: d.ret } : { date, day: new Date(t).getUTCDate(), trading: false });
    }
    if (cells.every((c) => c == null)) continue;
    const live = cells.filter((c) => c?.trading);
    weeks.push({ cells, pnl: live.length ? live.reduce((a, c) => a + c.pnl, 0) : null, ret: chain(live.map((c) => c.ret)) });
  }
  const live = weeks.flatMap((w) => w.cells).filter((c) => c?.trading);
  return { ym, weeks, pnl: live.length ? live.reduce((a, c) => a + c.pnl, 0) : null, ret: chain(live.map((c) => c.ret)) };
}
