// 資料狀態的共用分類（改進報告 R14）：用到資料的卡片在資料不是正常時，就地標出狀態與資料時間，不只在首頁底部。
// 六種：
//   正常       資料日期是這個時間應該有的最新一天
//   休市正常   今天（或最近一天）休市，用最近交易日的收盤，這是正常的，不是異常
//   沿用       拿到的是舊的：新的應該已經有了（上游沒更新、或抓取失敗沿用上次的檔）
//   缺失       應該有的檔案或欄位沒有（例如 meta 沒有這項、帳本沒填）
//   失敗       讀取或查詢失敗
//   刻意停用   照計畫不再更新（原因與替代用 market-data meta 記的）
// 「↻ 更新」只是重新讀檔，不會讓上游產生新資料；資料時間一律用資料本身的日期，不用讀取的時間。
import { loadCalendar, loadMeta } from "./data.js";
import { el, shortDate } from "./fmt.js";

export const STATUS = {
  ok: { label: "正常", cls: "st-ok", rank: 0 },
  closed: { label: "休市正常", cls: "st-ok", rank: 1 },
  disabled: { label: "刻意停用", cls: "st-off", rank: 2 },
  stale: { label: "沿用", cls: "st-stale", rank: 3 },
  missing: { label: "缺失", cls: "st-stale", rank: 4 },
  fail: { label: "失敗", cls: "st-fail", rank: 5 },
};
export const worst = (kinds) => kinds.filter(Boolean).reduce((w, k) => (STATUS[k].rank > STATUS[w].rank ? k : w), "ok");

// market-data 台北 06:15 抓前一個交易日的收盤（台股日線、美股日線、匯率）；過了這個小時還沒有才算沿用
export const READY_HOUR = 9;

// 美股休市日（NYSE 全天休市；半天交易照常算交易日）。每年底補下一年；清單沒有的年份只把週末當休市，
// 所以碰到美國假日可能多標一天「沿用」
const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekend = (d) => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());

// 台股這一天有沒有開盤：週末與行事曆的休市日沒有（週末看到週五收盤是正常的）
export function twOpen(day, cal) {
  return !weekend(day) && !(cal?.tw_market?.closed || []).includes(day);
}
export const usOpen = (day) => !weekend(day) && !US_HOLIDAYS.has(day);

// 不晚於 day 的最近一個交易日
function lastOpen(day, isOpen) {
  let d = day;
  for (let i = 0; i < 40 && !isOpen(d); i++) d = addDays(d, -1);
  return d;
}

const taipeiDate = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(now);
function taipeiHour(now) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "numeric", hourCycle: "h23" }).format(now));
}

// 這個時間「應該已經有」的最新資料日：
//   tw／us：前一個交易日的收盤（台北早上 READY_HOUR 點以前，再往前一個交易日）
//   news：新聞晨報（平日 08:40 起），READY_HOUR 點以前是前一個交易日
// closedTw／closedUs：最新一個應有的交易日不是「昨天」（週末、假日），用更早的收盤是休市正常
export function expectedDates(cal, now = new Date()) {
  const today = taipeiDate(now), hour = taipeiHour(now);
  const base = hour >= READY_HOUR ? today : addDays(today, -1);
  const tw = lastOpen(addDays(base, -1), (d) => twOpen(d, cal));
  const us = lastOpen(addDays(base, -1), usOpen);
  return {
    today, hour, tw, us,
    news: lastOpen(base, (d) => twOpen(d, cal)),
    twOpenToday: twOpen(today, cal),
    closedUs: us !== addDays(base, -1),
  };
}

// 依日期判斷：沒有日期是缺失，比應有的舊是沿用，否則正常（或休市正常）
export function byDate(last, expected, closed = false) {
  if (!last) return "missing";
  if (expected && last.slice(0, 10) < expected) return "stale";
  return closed ? "closed" : "ok";
}

// meta.json 的一個資料集 → 狀態
export function datasetKind(meta, key, expected, closed = false) {
  const d = meta?.datasets?.[key];
  if (!d) return "missing";
  if (d.status === "disabled") return "disabled";
  if (d.status === "fail") return "fail";
  if (d.status === "stale") return "stale";
  return expected ? byDate(d.last, expected, closed) : "ok";
}

// 共用的判斷環境：行事曆、meta（data.js 同一次瀏覽只讀一次，各卡片重複呼叫不會重抓）
export async function loadStatus(now = new Date()) {
  const [cal, meta] = await Promise.all([loadCalendar().catch(() => null), loadMeta().catch(() => null)]);
  const ex = expectedDates(cal, now);
  return {
    ...ex, expect: ex, cal, meta,
    // 台股收盤（market-data 或富果）的日期
    tw: (date) => byDate(date, ex.tw, !ex.twOpenToday),
    // 美股收盤的日期（美國日期）
    us: (date) => byDate(date, ex.us, ex.closedUs),
    // 匯率（台灣的營業日；休市不另外標，台股那一項已經寫了）
    fx: (date) => byDate(date, ex.tw),
    dataset: (key, market) => datasetKind(meta, key, market === "us" ? ex.us : market === "tw" ? ex.tw : null,
      market === "us" ? ex.closedUs : market === "tw" ? !ex.twOpenToday : false),
  };
}

// 一檔持倉的價格狀態（portfolio.js 的 position：priceDate、asOf、error）
export function priceKind(st, p) {
  if (p.error) return "fail";
  return p.market === "us" ? st.us(p.priceDate) : st.tw(p.priceDate);
}

// 同一個市場的持倉合成一項：最差的狀態、所有的資料時間
export function marketItem(st, positions, market, label) {
  const list = positions.filter((p) => p.market === market);
  if (!list.length) return null;
  const kind = worst(list.map((p) => priceKind(st, p)));
  const bad = list.filter((p) => p.error).map((p) => p.code);
  const times = [...new Set(list.filter((p) => !p.error).map((p) => p.asOf))];
  return {
    kind, what: `${label}價格`,
    when: [times.join("、"), bad.length && `${bad.join("、")} 讀不到`].filter(Boolean).join("；"),
    note: kind === "stale" ? `應該已經有 ${shortDate(market === "us" ? st.expect.us : st.expect.tw)} 的收盤，先用舊的`
      : kind === "closed" ? (market === "tw" ? "今天台股休市，用最近交易日的收盤" : "美股週末或假日休市，用最近交易日的收盤")
        : null,
  };
}

// 新聞晨報的狀態（news.js 的 newsView）
export function newsKind(st, v) {
  if (!v?.dataDate) return "missing";
  return byDate(v.dataDate, st.expect.news, !st.twOpenToday);
}

// 卡片裡的狀態列：全部正常時不顯示；休市正常用正常的顏色。item：{ kind, what, when, note }
export function statusLine(items, { closed = true } = {}) {
  const list = items.filter((x) => x && x.kind !== "ok" && (closed || x.kind !== "closed"));
  if (!list.length) return null;
  return el("ul", { class: "st-line" }, list.map((x) => el("li", {},
    el("span", { class: STATUS[x.kind].cls }, STATUS[x.kind].label), "：", x.what,
    x.when ? `（${x.when}）` : "", x.note ? `。${x.note}` : "")));
}
