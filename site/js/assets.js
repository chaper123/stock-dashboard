// 資產頁的計算（docs/ASSETS_PAGE.md）。純函式：不讀網路、不碰 DOM，tests/web/assets.html 直接呼叫。
// 輸入多半是 perf.js 的 loadPerformance()／computePerf() 的 days：每個台股交易日一筆
// { date, value 持倉市值, flow 當天投入（買進為正、賣出為負）, div 當天現金股利, invested 累計投入, index 時間加權指數, hv, px }。

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

// 每天的損益與報酬率。損益＝收盤市值 − 前一天收盤市值 − 當天投入 ＋ 當天現金股利；第一天沒有前一天，市值 − 投入（買進當天成交價到收盤價的差與手續費）。
// 報酬率＝時間加權指數的單日變化（index(d) ÷ index(d−1) − 1），第一天沒有
export function dailyPnl(days) {
  return days.map((d, i) => ({
    date: d.date,
    pnl: (i ? d.value - days[i - 1].value : d.value) - d.flow + d.div,
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
