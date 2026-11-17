// 資產頁的表格類卡片：個股表現、報酬日曆。跟 assets_charts.js 一樣共用 ctx 的期間選擇（個股表現跟著期間；報酬日曆有自己的月份切換）。
import { loadHoldings, loadDaily, loadIndex } from "../data.js";
import { loadPerformance } from "../perf.js";
import { periodStart, periodLabel, daysFrom, performanceRows, dailyPnl, monthsBetween, calendarMonth } from "../assets.js";
import { el, pct, tone, shortDate, twd, int, signed, taipeiToday } from "../fmt.js";
import { card, notice } from "../ui.js";
import { NAMES } from "../config.js";

// ── 個股表現（ASSETS_PAGE 2.4）──
// 現在還持有的每一檔：期間報酬（跟著期間選擇）、近 1 日、近一週，依期間報酬由高到低；台股下面列加權指數、美股下面列 S&P 500 當對照。
// 全部是收盤價對收盤價的價格報酬（不含股利，跟對照的價格指數一致），美股用美元價格（不含匯率）
export async function stocksCard(ctx) {
  const [perf, holdings] = await Promise.all([loadPerformance(), loadHoldings()]);
  const [taiex, spx, ...loaded] = await Promise.all([loadIndex("TAIEX").catch((e) => e), loadDaily("macro", "SPX").catch((e) => e),
    ...holdings.map((h) => loadDaily(h.market, h.code).catch((e) => e))]);
  const asBars = (rows) => rows.map((r) => ({ time: r.date, close: r.value })); // loadIndex 的列是 { date, value }
  const bars = {};
  const problems = [];
  holdings.forEach((h, i) => {
    if (Array.isArray(loaded[i])) bars[h.code] = loaded[i];
    else problems.push(`${h.code} 的日線（${loaded[i].message}）`);
  });
  const indices = {};
  if (holdings.some((h) => h.market === "tw")) {
    if (Array.isArray(taiex)) indices.tw = { code: "TAIEX", name: "加權指數", bars: asBars(taiex) };
    else problems.push(`加權指數（${taiex.message}）`);
  }
  if (holdings.some((h) => h.market === "us")) {
    if (Array.isArray(spx)) indices.us = { code: "SPX", name: "S&P 500", bars: spx.map((b) => ({ time: b.time, close: b.close })) };
    else problems.push(`S&P 500（${spx.message}）`);
  }

  const table = el("div", { class: "table-wrap" });
  const note = el("p", { class: "tiny" });
  const render = () => {
    const start = periodStart(ctx.period, perf.first, perf.last);
    const base = daysFrom(perf.days, start)[0]?.date ?? start;
    const rows = performanceRows({ holdings, bars, indices, last: perf.last, start: base });
    const val = (x, muted) => el("td", { class: `r ${muted ? "" : tone(x)}` }, x == null ? "—" : pct(x, 2));
    table.replaceChildren(el("table", { class: "nowrap stock-perf" },
      el("thead", {}, el("tr", {}, el("th", {}, "名稱"), el("th", { class: "r" }, `${periodLabel(ctx.period)}報酬`), el("th", { class: "r" }, "近 1 日"), el("th", { class: "r" }, "近一週"))),
      el("tbody", {}, rows.map((r) => {
        const isIdx = r.kind === "index";
        return el("tr", { class: isIdx ? "idx-row" : "" },
          el("td", {}, isIdx ? `${r.name}（價格指數）` : el("span", {}, el("strong", {}, r.code), ` ${NAMES[r.code] || holdings.find((h) => h.code === r.code)?.name || ""}`)),
          val(r.period, isIdx), val(r.day, isIdx), val(r.week, isIdx));
      }))));
    note.textContent = `期間：${base.replaceAll("-", "/")}～${perf.last.replaceAll("-", "/")}（跟上面的期間選擇一樣）；`
      + `近一週是跟 7 天前（含）以前最近的收盤比。只列現在還持有的。最後一根收盤：${[...new Set(rows.filter((r) => r.endDate).map((r) => `${r.market === "us" ? "美股" : "台股"} ${shortDate(r.endDate)}`))].join("、")}。`;
  };
  ctx.onChange(render);
  render();
  return card("個股表現", table,
    problems.length > 0 && notice("warn", `讀不到：${problems.join("；")}，那幾列顯示「—」。`),
    note,
    el("p", { class: "tiny" }, "全部用收盤價對收盤價的價格報酬，不含股利（跟對照的加權指數、S&P 500 價格指數一致，所以含配息的 ETF 會比「投資報酬率對比較標的」那張卡低一點）；"
      + "美股用美元價格，不含匯率。這是每一檔自己的報酬，不是你的實際損益（不看你什麼時候買、買多少）。"));
}

// ── 報酬日曆（ASSETS_PAGE 2.5）──
// 一個月一頁：週一到週五五欄加「週損益」；每格寫日期、當天損益與當天報酬率（時間加權指數的單日變化），賺的淡紅底、賠的淡綠底。
// 休市或還沒到的日子只留淡淡的日期。有自己的月份切換（從第一筆買進的月份到這個月），不跟上面的期間選擇
const WEEKDAYS = ["一", "二", "三", "四", "五"];

export async function calendarCard() {
  const perf = await loadPerformance();
  const daily = dailyPnl(perf.days);
  const months = monthsBetween(perf.first.slice(0, 7), [perf.last.slice(0, 7), taipeiToday().slice(0, 7)].sort().at(-1));
  let at = months.length - 1; // 預設這個月
  const title = el("strong", { class: "cal-title" });
  const sum = el("div", { class: "cal-sum" });
  const grid = el("div", { class: "cal", role: "table", "aria-label": "報酬日曆" });
  const prev = el("button", { class: "btn small", type: "button", "aria-label": "上一個月" }, "‹");
  const next = el("button", { class: "btn small", type: "button", "aria-label": "下一個月" }, "›");
  const money = (x) => (x == null ? "—" : signed(x, int));
  const rate = (r) => (r == null ? "" : pct(r * 100, 2));
  const kind = (x) => (x > 0 ? "gain" : x < 0 ? "loss" : "");

  const render = () => {
    const ym = months[at];
    const m = calendarMonth(daily, ym);
    title.textContent = `${ym.replace("-", "/")} 報酬`;
    prev.disabled = at === 0;
    next.disabled = at === months.length - 1;
    sum.replaceChildren(m.pnl == null ? "這個月還沒有資料" : el("span", {}, "整月損益 ", el("strong", { class: tone(m.pnl) }, signed(m.pnl, twd)),
      "　整月報酬率 ", m.ret == null ? "—" : el("strong", { class: tone(m.ret) }, pct(m.ret * 100, 2))));
    grid.replaceChildren(
      ...WEEKDAYS.map((w) => el("div", { class: "cal-h", role: "columnheader" }, w)), el("div", { class: "cal-h", role: "columnheader" }, "週損益"),
      ...m.weeks.flatMap((w) => [
        ...w.cells.map((c) => {
          if (!c) return el("div", { class: "cal-c none", role: "cell" });
          if (!c.trading) return el("div", { class: "cal-c off", role: "cell", title: `${shortDate(c.date)} 休市或沒有資料` }, el("span", { class: "cal-d" }, String(c.day)));
          return el("div", { class: `cal-c ${kind(c.pnl)}`, role: "cell", "aria-label": `${shortDate(c.date)} 損益 ${money(c.pnl)}${c.ret == null ? "" : `，報酬率 ${rate(c.ret)}`}` },
            el("span", { class: "cal-d" }, String(c.day)),
            el("span", { class: `cal-p ${tone(c.pnl)}` }, money(c.pnl)),
            c.ret != null && el("span", { class: `cal-r ${tone(c.ret)}` }, rate(c.ret)));
        }),
        w.pnl == null ? el("div", { class: "cal-c none", role: "cell" })
          : el("div", { class: `cal-c cal-w ${kind(w.pnl)}`, role: "cell" },
            el("span", { class: `cal-p ${tone(w.pnl)}` }, money(w.pnl)),
            w.ret != null && el("span", { class: `cal-r ${tone(w.ret)}` }, rate(w.ret))),
      ]));
  };
  prev.addEventListener("click", () => {
    at = Math.max(0, at - 1);
    render();
  });
  next.addEventListener("click", () => {
    at = Math.min(months.length - 1, at + 1);
    render();
  });
  render();
  return card("報酬日曆", el("div", { class: "cal-nav" }, prev, title, next), sum, grid,
    el("p", { class: "tiny" }, "每格是當天的損益（含手續費與匯率變動、台股 ETF 現金股利、美股配息與手續費折抵）與報酬率（時間加權指數的單日變化，扣掉當天買進、賣出的影響）；"
      + "週損益是那一列有資料的日子相加，週報酬率與整月報酬率是每日報酬連乘；跨月的週，每個月只算那個月的日子。"
      + "休市或還沒到的日子只留淡色的日期。第一筆買進那天只有損益、沒有報酬率。這張卡的月份自己切換，不跟上面的期間選擇。"));
}
