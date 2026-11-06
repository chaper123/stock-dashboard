// 展望（新聞頁 v4）：接下來已排定的事件，每件附一句「跟你的關係」。只列排定的事與規則算出來的日期，不預測漲跌。
// 日期來源：market-data 行事曆（FOMC、財報日、台股休市）、配息、景氣燈號預估公布日；
// 009816 定期審核日照指數規則推算（2、5、8、11 月第 7 個交易日為基準日，隔 5 個交易日收盤後生效），以臺灣指數公司公告為準。
import { loadCalendar, loadDividends, loadDca, loadHoldings, loadMeta } from "./data.js";
import { DISCIPLINE as D, TRACK } from "./config.js";
import { dcaFor, nextCheckDate, nextDepositDate, addMonth } from "./discipline.js";
import { twd, shortDate } from "./fmt.js";

const DAY = 864e5;
export const addDays = (iso, k) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const isTrading = (d, closed) => weekday(d) % 6 !== 0 && !closed.has(d);

function nthTradingDay(ym, n, closed) {
  let d = `${ym}-01`;
  for (let k = 0; ; d = addDays(d, 1)) if (isTrading(d, closed) && ++k === n) return d;
}
function addTradingDays(d, n, closed) {
  for (let k = 0; k < n;) {
    d = addDays(d, 1);
    if (isTrading(d, closed)) k += 1;
  }
  return d;
}

// 下一次 009816 定期審核（生效日還沒過的那一次）。休市資料沒涵蓋的年份標成預估
export function review009816(today, closed) {
  const years = new Set([...closed].map((d) => d.slice(0, 4)));
  for (let k = 0; k < 15; k++) {
    const ym = addMonth(today.slice(0, 7), k);
    if (![2, 5, 8, 11].includes(Number(ym.slice(5)))) continue;
    const base = nthTradingDay(ym, 7, closed);
    const effective = addTradingDays(base, 5, closed);
    if (effective >= today) return { base, effective, estimate: !years.has(ym.slice(0, 4)) };
  }
  return null;
}

const WD = "日一二三四五六";
export const dayLabel = (iso) => `${shortDate(iso)}（${WD[weekday(iso)]}）`;

// 回傳 { events: [{ date, when, title, note, estimate }], failed: [來源] }，依日期排
export async function outlookEvents(today, days = 75) {
  const [calR, divR, dcaR, holdR, metaR] = await Promise.allSettled([loadCalendar(), loadDividends(), loadDca(), loadHoldings(), loadMeta()]);
  const until = addDays(today, days);
  const events = [];
  const add = (date, e) => date >= today && date <= until && events.push({ date, when: dayLabel(date), ...e });

  if (calR.status === "fulfilled") {
    const cal = calR.value;
    const closed = new Set(cal.tw_market?.closed || []);
    const r = review009816(today, closed);
    if (r && r.base >= today) {
      add(r.base, { title: "009816 成分股定期審核（基準日）", estimate: r.estimate,
        note: `約 ${dayLabel(r.effective)} 收盤後換股。照指數規則換，你不用動作；換了哪幾檔會在「ETF 裡面在變什麼」列出。` });
    } else if (r) {
      add(r.effective, { title: "009816 新成分股生效", estimate: r.estimate, note: "今天收盤後換股，照指數規則換，你不用動作。" });
    }
    const f = (cal.fomc || []).find((x) => x.end >= today);
    if (f) {
      add(f.start < today ? today : f.start, { when: `${shortDate(f.start)}～${shortDate(f.end).split("/")[1]}`,
        title: `Fed 利率決策（FOMC）${f.sep ? "，含經濟預測" : ""}`,
        note: `台灣時間 ${dayLabel(addDays(f.end, 1))} 凌晨公布。影響美債利率與美股評價，也會牽動外資進出台股。` });
    }
    const held = new Set(holdR.status === "fulfilled" ? holdR.value.map((h) => h.code) : []);
    const us = [...new Set([...TRACK.us.filter((c) => held.has(c)), "NVDA"])];
    for (const c of us) {
      const e = cal.earnings?.symbols?.[c];
      for (const d of e?.dates || []) {
        add(d, { title: `${c} 財報`, estimate: e.is_estimate,
          note: c === "NVDA" ? "AI 供應鏈的風向球；你兩檔台股 ETF 都重壓半導體，財報後一兩天波動常比較大。" : "你持有這檔。" });
      }
    }
    const names = new Map((cal.tw_market?.entries || []).map((x) => [x.date, x.name]));
    for (const d of closed) add(d, { title: `台股休市${names.get(d) ? `（${names.get(d)}）` : ""}`, note: "這天不交易。" });
  }

  if (divR.status === "fulfilled") {
    const e = divR.value.etfs?.[D.satellite];
    if (e?.next?.ex_date) {
      add(e.next.ex_date, { title: `${D.satellite} 除息`, note: `每單位 ${e.next.cash} 元。` });
    } else if (e?.last?.ex_date) {
      // 季配：上次除息月份 + 3 個月的月中；金額在前一個月底收益評價後公告
      const ym = addMonth(e.last.ex_date.slice(0, 7), 3);
      add(`${ym}-15`, { when: `${Number(ym.slice(5))} 月中`, title: `${D.satellite} 除息`, estimate: true,
        note: `季配；上次 ${shortDate(e.last.ex_date)} 每單位 ${e.last.cash} 元。金額在前一個月底收益評價後公告。` });
    }
  }

  const bc = metaR.status === "fulfilled" ? metaR.value.datasets?.["longterm/tw_business_cycle"] : null;
  if (bc?.next_release_est) {
    add(bc.next_release_est, { title: "國發會公布景氣燈號", estimate: true,
      note: `看景氣是不是從${bc.last_light}燈降溫；上次 ${Number(bc.last.slice(5))} 月 ${bc.last_score} 分。` });
  }

  // 下一次入金（今天以後）；檢查月照規則補偏低的一檔，其他月份照 80／20
  const nd = nextDepositDate(addDays(today, 1));
  const amount = dcaFor(dcaR.status === "fulfilled" ? dcaR.value : null, nd.slice(0, 7));
  const checkMonth = D.checkMonths.includes(Number(nd.slice(5, 7)));
  add(nd, { title: `入金 ${twd(amount)}（${Number(nd.slice(5, 7))} 月定投）`,
    note: checkMonth ? `檢查月：比例偏離超過 ${D.bandPts} 個百分點時，整筆補偏低的一檔；沒有就照 80／20。`
      : `照 80／20：${D.core} ${twd(amount * D.target[D.core])}、${D.satellite} ${twd(amount * D.target[D.satellite])}。` });

  // 配置檢查不管多遠都列
  const ck = nextCheckDate(today);
  if (ck) events.push({ date: ck, when: dayLabel(ck), title: "配置檢查（009816：00981A）",
    note: `偏離超過 ${D.bandPts} 個百分點才用新資金補回，其他時候不調整。` });

  events.sort((a, b) => a.date.localeCompare(b.date));
  const failed = [calR, divR, metaR].filter((x) => x.status === "rejected").map((x) => x.reason?.source || x.reason?.message);
  return { events, failed };
}
