// 首頁「市場狀態」卡（docs/INSIGHTS.md 3.2）：加權指數與兩檔 ETF 離高點多遠、修正／熊市門檻、
// 加權指數 2003 年起每一段跌 20% 以上的歷史、外資與融資最近 5 個交易日、晨報的總經總結。
// 數字都在瀏覽器從 market-data 算（加上使用者自己的富果報價），只描述已發生的事，不預測。
import { loadIndex, loadDaily, loadMarketInsti, loadMargin } from "./data.js";
import { fugleQuote, fugleUsable, fugleClosed } from "./fugle.js";
import { loadNewsView } from "./news.js";
import { el, price, shortDate, dateVs, taipeiTime } from "./fmt.js";
import { card } from "./ui.js";
import { TRACK, NAMES } from "./config.js";

const CORRECTION = 10, BEAR = 20; // 常見定義：從高點跌 10% 叫修正、20% 叫熊市（門檻待使用者確認）

// 一個序列 [{date, value}]（由舊到新）目前離歷史高點多遠
export function fromPeak(series) {
  let peak = series[0];
  for (const x of series) if (x.value >= peak.value) peak = x;
  const last = series.at(-1);
  const dd = (last.value / peak.value - 1) * 100;
  return { peak, last, dd, state: dd <= -BEAR ? "bear" : dd <= -CORRECTION ? "corr" : "ok" };
}

// 每一段從高點跌超過 th% 的期間：高點、最低點、最深跌幅、回到高點的日子（還沒回到是 null）
export function drawdowns(series, th = BEAR) {
  const out = [];
  let peak = series[0], cur = null;
  for (const x of series) {
    if (x.value >= peak.value) {
      if (cur) {
        cur.recovered = x;
        out.push(cur);
        cur = null;
      }
      peak = x;
      continue;
    }
    const dd = (x.value / peak.value - 1) * 100;
    if (!cur && dd <= -th) cur = { peak, trough: x, dd, recovered: null };
    if (cur && dd < cur.dd) {
      cur.trough = x;
      cur.dd = dd;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const span = (a, b) => {
  const d = Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  if (d < 45) return `${d} 天`;
  const m = d / 30.44;
  return m < 24 ? `約 ${Math.round(m)} 個月` : `約 ${(m / 12).toFixed(1)} 年`;
};
const yi = (v) => `${Math.abs(v / 1e8).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 億`;
const STATE = { ok: ["", "正常"], corr: ["st-warn", "修正"], bear: ["st-crit", "熊市"] };

// market-data 的日線，加上比它新的富果收盤（或盤中）報價
async function withFugle(series, symbol) {
  const q = await fugleQuote(symbol).catch(() => null);
  const last = series.at(-1)?.date;
  if (!fugleUsable(q, last) || q.date <= last) return { series, note: null };
  return { series: [...series, { date: q.date, value: q.price }], note: fugleClosed(q) ? "收盤（富果）" : "盤中（富果）" };
}

export async function marketCard() {
  const [ixR, krR, instR, marR, newsR, ...etfR] = await Promise.allSettled([
    loadIndex("TAIEX"), loadDaily("macro", "KOSPI"), loadMarketInsti(), loadMargin(), loadNewsView(),
    ...TRACK.tw.map((c) => loadDaily("tw", c))]);
  const rows = [];
  const failed = [];
  let ix = null;
  if (ixR.status === "fulfilled") {
    ix = await withFugle(ixR.value, "IX0001");
    rows.push(["加權指數", ix]);
  } else failed.push("加權指數");
  if (krR.status === "fulfilled") rows.push(["韓國綜合指數", { series: krR.value.map((b) => ({ date: b.time, value: b.close })), note: null }]);
  else failed.push("韓國綜合指數");
  for (const [i, c] of TRACK.tw.entries()) {
    const r = etfR[i];
    if (r.status !== "fulfilled") {
      failed.push(c);
      continue;
    }
    rows.push([`${c} ${NAMES[c] || ""}`, await withFugle(r.value.map((b) => ({ date: b.time, value: b.close })), c)]);
  }

  const lines = rows.map(([label, { series, note }]) => {
    const s = fromPeak(series);
    const [cls, text] = STATE[s.state];
    return el("div", { class: "kv" },
      el("span", { class: "k" }, label,
        el("div", { class: "tiny" }, `${shortDate(s.last.date)} ${note || "收盤"} ${price(+s.last.value.toFixed(2))}；高點 ${dateVs(s.peak.date, s.last.date)} ${price(+s.peak.value.toFixed(2))}`)),
      el("span", { class: "v" }, el("strong", { class: s.dd < 0 ? "down" : "" }, `${s.dd < 0 ? "−" : ""}${Math.abs(s.dd).toFixed(1)}%`),
        el("div", {}, el("span", { class: `tag ${cls}` }, text))));
  });

  // 外資與融資：最近 5 個交易日
  const flow = [];
  if (instR.status === "fulfilled") {
    const last5 = instR.value.slice(-5);
    const sum = last5.reduce((a, x) => a + x.foreign, 0);
    flow.push(el("div", {}, `外資最近 5 個交易日${sum < 0 ? "賣超" : "買超"} `, el("strong", {}, yi(sum)),
      `（到 ${shortDate(last5.at(-1).date)}，單日 ${last5.map((x) => `${x.foreign < 0 ? "−" : "+"}${yi(x.foreign)}`).join("、")}）`));
  } else failed.push("三大法人");
  if (marR.status === "fulfilled" && marR.value.length >= 6) {
    const m = marR.value, a = m.at(-6), b = m.at(-1);
    const d = b.amount - a.amount;
    flow.push(el("div", {}, `融資餘額最近 5 個交易日${d < 0 ? "減少" : "增加"} `, el("strong", {}, yi(d)),
      `（${shortDate(b.date)} 餘額 ${yi(b.amount)}，集中市場）`));
  } else if (marR.status !== "fulfilled") failed.push("融資");

  // 晨報的總經總結（原因）
  const v = newsR.status === "fulfilled" ? newsR.value : null;
  const sum = v?.macroSummary;

  // 歷史：加權指數 2003 年起跌 20% 以上的每一段
  let history = null;
  if (ix) {
    const eps = drawdowns(ix.series).reverse();
    history = el("details", { class: "more" },
      el("summary", {}, `加權指數歷史上跌 ${BEAR}% 以上的 ${eps.length} 次（2003 年起）`),
      el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
        el("thead", {}, el("tr", {}, ["高點", "最深", "跌到最低花了", "從最低回到高點花了"].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
        el("tbody", {}, eps.map((e) => el("tr", {},
          el("td", {}, e.peak.date),
          el("td", { class: "r" }, `−${Math.abs(e.dd).toFixed(1)}%（${e.trough.date}）`),
          el("td", { class: "r" }, span(e.peak.date, e.trough.date)),
          el("td", { class: "r" }, e.recovered ? span(e.trough.date, e.recovered.date) : "尚未回到")))))),
      el("p", { class: "tiny" }, "加權指數是價格指數（不含股利），回到高點的時間會比含息的報酬指數長。只列已經發生的事，不代表這次會一樣。"));
  }

  return card("市場狀態",
    lines,
    flow.length > 0 && el("div", { class: "small", style: { marginTop: "8px" } }, flow),
    sum && el("div", { class: "ai" }, el("b", {}, "原因（新聞晨報）"), sum.fact,
      el("p", { class: "tiny" }, `新聞晨報 ${taipeiTime(v.generatedAt)}・AI 依數字與新聞整理，只描述現況，不是預測。`)),
    history,
    el("p", { class: "small" }, el("a", { href: "#/opportunity" }, "跌到級距之後的歷史與三種做法 → 機會頁（擇時，只當參考）")),
    failed.length > 0 && el("p", { class: "tiny" }, `讀不到：${failed.join("、")}。`),
    el("p", { class: "tiny" }, `「修正」「熊市」是常見定義（從歷史高點跌 ${CORRECTION}%、${BEAR}%），只描述現況；ETF 的高點從上市起算，韓國綜合指數只有近 2 年資料。外資是集中市場外資及陸資買賣超，融資是集中市場融資金額。`));
}
