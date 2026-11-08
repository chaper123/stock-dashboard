// 總覽：午間一站式（docs/PIVOT.md 第 3 節），由上到下：招呼與今日一句、我的資產、本月紀律、今天的重點、
// 台股盤中、隔夜美股與總經、行事曆、市場背景，最後是資料狀態。每一塊各自讀資料、各自失敗。
import {
  loadSettings, loadTrades, loadDca, loadMeta, loadFearGreed, loadNavHistory, loadIndex, loadDaily, loadCalendar, loadFx, loadHoldings, loadDividends,
} from "../data.js";
import { loadPortfolio, FX_KIND_LABEL } from "../portfolio.js";
import { marketCard } from "../market.js";
import { riskCard } from "../checkup.js";
import { loadFugle, getKey, fugleSettings, fugleUsable, quoteTime, FUGLE_NOTE } from "../fugle.js";
import { discipline, dcaFor, nextDepositDate, nextCheckDate } from "../discipline.js";
import { loadNewsView, sentimentParts, newsWhen, laterNsf } from "../news.js";
import { highlightsCard } from "./news.js";
import { cnnReading, gaugeBlock, pocketBlock } from "../gauge.js";
import {
  el, twd, pct, price, int, taipeiTime, shortDate, taipeiToday, daysBetween, tone, signed, isNum,
} from "../fmt.js";
import { slot, card, kv, notice } from "../ui.js";
import { DISCIPLINE as D, NAMES, TRACK } from "../config.js";
import { loadStatus, marketItem, statusLine, datasetKind, newsKind, worst, STATUS } from "../status.js";

export async function render(root) {
  slot(root, greetingCard);
  const grid = el("div", { class: "grid two" });
  root.append(grid);
  slot(grid, assetsCard);
  slot(grid, disciplineCard);
  slot(root, async () => {
    const [v, st] = await Promise.all([loadNewsView(), loadStatus()]);
    return highlightsCard(v, { link: true, later: await laterNsf(v).catch(() => null), st });
  });
  const grid2 = el("div", { class: "grid two" });
  root.append(grid2);
  slot(grid2, twCard);
  slot(grid2, usMacroCard);
  slot(grid2, calendarCard);
  slot(grid2, backgroundCard);
  slot(root, marketCard); // 市場狀態（docs/INSIGHTS.md 3.2）
  slot(root, riskCard); // 風險燈號（3.3）
  slot(root, healthCard);
}

const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// 台北時間的小時
function taipeiHour() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "numeric", hourCycle: "h23" }).format(new Date()));
}

async function greetingCard() {
  const h = taipeiHour();
  const hello = h >= 5 && h < 11 ? "早安" : h >= 11 && h < 18 ? "午安" : "晚安";
  const today = taipeiToday();
  const wd = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", weekday: "long" }).format(new Date());
  const v = await loadNewsView().catch(() => null);
  const line = v?.todayLine;
  const w = v && newsWhen(v);
  const old = w && !w.fresh; // R01：不是今天的晨報，標出是哪一天寫的
  return el("section", { class: "card greet" },
    el("div", { class: "greet-hello" }, `${hello}！`),
    el("div", { class: "small muted" }, `${today.replace(/-/g, "/")} ${wd}`),
    line ? el("p", { class: `greet-line${old ? " muted" : ""}` }, old ? `${w.name}：${line}` : line)
      : el("p", { class: "greet-line muted" }, "今日一句：新聞晨報 11:30 版上線後顯示。"),
    el("p", { class: "disclaimer-line" }, "內容是依自訂規則的提醒與資訊整理，不是投資建議。"));
}

// 我的資產（R07、R09、R14）：缺匯率、價格或可用資金時標「部分資產」，不把缺的當 0；
// 損益是證券損益折台幣（成本與市值用同一匯率，不含匯差）；資料時間標在卡片上
async function assetsCard() {
  const [pf, st, S] = await Promise.all([loadPortfolio(), loadSettings().catch((e) => e), loadStatus()]);
  const pool = st instanceof Error ? null : st.pool;
  const t = pf.totals;
  const total = t.mvTwd + (pool || 0);
  const today = taipeiToday();
  const missing = [...pf.missing, ...(pool == null ? ["可用資金（帳本讀不到）"] : [])];
  const partial = missing.length > 0;
  const ok = (m) => pf.positions.filter((p) => p.market === m && !p.error);
  const twAs = uniq(ok("tw").map((p) => p.asOf)), usAs = uniq(ok("us").map((p) => p.asOf));
  const when = [twAs.length && `台股 ${twAs.join("、")}`, usAs.length && `美股 ${usAs.join("、")}`,
    pf.fx && `匯率 ${price(pf.fx.rate)}（${shortDate(pf.fx.date)}，市場中間價）`].filter(Boolean).join("；");
  const hasUs = pf.positions.some((p) => p.market === "us");
  // R14：價格、匯率、可用資金不是正常時，就地標狀態與資料時間（休市用最近交易日收盤是正常的）
  const status = statusLine([marketItem(S, pf.positions, "tw", "台股"), marketItem(S, pf.positions, "us", "美股"),
    hasUs && (pf.fx ? { kind: S.fx(pf.fx.date), what: "匯率", when: shortDate(pf.fx.date) }
      : { kind: "fail", what: "匯率", note: "讀不到，美股沒有換算成台幣" }),
    pool == null && { kind: "fail", what: "可用資金", note: "帳本讀不到" }]);
  return card("我的資產",
    el("div", { class: "tile" },
      el("div", { class: "label" }, partial ? "部分資產：有資料讀不到，這不是完整總額" : "總資產（持倉市值＋可用資金）"),
      el("div", { class: `value${partial ? " muted" : ""}` }, twd(total))),
    partial && notice("warn", `讀不到：${missing.join("、")}。合計、漲跌與損益都只算讀得到的部分（原因見持倉頁）。`),
    status,
    kv(el("span", {}, "最近交易日漲跌", el("div", { class: "tiny" }, "各市場最近一個交易日對前一日，折台幣")),
      el("span", { class: tone(t.dayChgTwd) }, signed(t.dayChgTwd, twd))),
    kv(el("span", {}, "未實現損益", el("div", { class: "tiny" }, "證券損益折台幣，不含匯差")),
      el("span", { class: tone(t.pnlTwd) }, `${signed(t.pnlTwd, twd)}（${pct(t.pnlPct)}）`)),
    // R09：含匯差＝現在的台幣市值 − 歷史台幣成本；美股成本沒有實際台幣金額就標參考匯率
    hasUs && fxPnlRow(t.withFx),
    kv("持倉市值", `${twd(t.mvTwd)}（台股 ${twd(t.tw.mvTwd)}・美股 ${twd(t.us.mvTwd)}）`),
    kv("可用資金", pool == null ? "讀不到" : twd(pool)),
    kv("下次入金", st instanceof Error || !st.nextDeposit ? "—" : `${shortDate(st.nextDeposit)}（${daysBetween(today, st.nextDeposit)} 天後）`),
    el("p", { class: "tiny" }, `資料時間：${when || "—"}。`,
      "未實現損益的美股成本與市值用同一個匯率換算，所以不含匯差；含匯差的算法見持倉頁。持股與可用資金來自帳本（Google 試算表發布版，約 5 分鐘延遲）。"));
}

function fxPnlRow(w) {
  if (!w?.complete) {
    return kv(el("span", {}, "含匯差損益", el("div", { class: "tiny" }, "現在的台幣市值 − 當初的台幣成本")),
      el("span", { class: "muted" }, `缺 ${w?.lack?.map((x) => x.code).join("、") || "資料"} 的台幣成本`));
  }
  return kv(el("span", {}, `含匯差損益${w.kind === "actual" ? "" : "（參考）"}`,
    el("div", { class: "tiny" }, `現在的台幣市值 − 當初的台幣成本；${FX_KIND_LABEL[w.kind]}`)),
  el("span", {}, el("span", { class: tone(w.pnl) }, `${signed(w.pnl, twd)}（${pct(w.pnlPct)}）`),
    el("div", { class: "tiny" }, `其中匯率 ${signed(w.fxEffect, twd)}`)));
}

async function disciplineCard() {
  const [trades, pf, v, dca, S] = await Promise.all([loadTrades(), loadPortfolio(), loadNewsView().catch(() => null), loadDca().catch(() => null), loadStatus()]);
  const today = taipeiToday();
  const d = discipline({ trades, positions: pf.positions, today, dca });
  const ratio = Math.min(1, d.invested / d.deposit);
  const status = !d.depositArrived && !d.invested
    ? el("span", { class: "muted" }, `本月 ${shortDate(d.depositDate)} 入金後開始`)
    : d.done ? el("span", { class: "badge b-ok" }, "✓ 本月已投入")
      : el("span", { class: "badge b-warn" }, `⚠ 還差 ${twd(d.investedMin - d.invested)} 到 9 成（月底前，剩 ${d.daysLeft} 天）`);
  const w = d.weights;
  const target = (code) => `${Math.round(D.target[code] * 100)}%`;
  const planText = d.plan.mode === "rebalance"
    ? `檢查月偏離超過 ${D.bandPts} 個百分點：本月入金先補 ${d.plan.items[0][0]}（${twd(d.plan.items[0][1])}）`
    : `本月建議：${d.plan.items.map(([c, a]) => `${c} ${twd(a)}`).join("、")}（照目標比例）`
      + (d.plan.overBand ? `；偏離已超過 ${D.bandPts} 個百分點，但不在檢查月，下次檢查再補` : "");
  const bought = Object.entries(d.byCode).sort((a, b) => b[1] - a[1]).map(([c, a]) => `${c} ${twd(a)}`).join("、");
  // R14：比例用的兩檔價格、定投金額不是正常時標出來
  const pair = pf.positions.filter((p) => p.code === D.core || p.code === D.satellite);
  const dataStatus = statusLine([marketItem(S, pair, "tw", "核心與衛星"),
    !dca && { kind: "fail", what: "帳本「定投金額」", note: `讀不到，先用計畫的 ${twd(D.deposit)}` }], { closed: false });
  return card(`本月紀律（${Number(d.month.slice(5))} 月）`,
    dataStatus,
    el("div", { class: "spread" }, el("span", {}, `已投入 ${twd(d.invested)}／本月定投 ${twd(d.deposit)}`), status),
    el("div", { class: "progress", role: "img", "aria-label": `已投入 ${Math.round(ratio * 100)}%` },
      el("span", { style: { width: `${ratio * 100}%` } })),
    d.extra > 0 && el("div", { class: "small" }, `其中定投 ${twd(d.dcaPart)}、自主加碼 ${twd(d.extra)}`),
    el("div", { class: "small muted" }, d.done
      ? `本月已買：${bought}；建議是 ${d.plan.items.map(([c, a]) => `${c} ${twd(a)}`).join("、")}`
      : planText),
    // R04：只留一個現在的答案（現在的價格即時算）；門檻用沒有四捨五入的數字判斷，顯示到小數兩位
    w ? [
      kv("核心：衛星（市值）", `${(w.core * 100).toFixed(1)}：${(w.sat * 100).toFixed(1)}（目標 ${target(D.core)}：${target(D.satellite)}）`),
      kv("偏離", el("span", { class: Math.abs(w.devPts) > D.bandPts ? "badge b-warn" : "" },
        `${w.devPts >= 0 ? "+" : "−"}${Math.abs(w.devPts).toFixed(2)} 個百分點（門檻 ±${D.bandPts}）`)),
      el("p", { class: "tiny" }, `比例用現在的價格算：${[D.core, D.satellite].map((c) => `${c} ${pf.positions.find((p) => p.code === c)?.asOf || ""}`).join("、")}。`),
    ] : kv("核心：衛星", "讀不到兩檔的市值"),
    kv("下次檢查", `${d.nextCheck.replace(/-/g, "/")}（${daysBetween(today, d.nextCheck)} 天後）`),
    kv("連續投入", `${d.streak} 個月`),
    // 晨報寫的紀律是它產生當時的價格算的，收成有時間的歷史快照，不跟上面的現在數字並列
    v?.disciplineRows?.length > 0 && el("details", { class: "more" },
      el("summary", {}, `新聞晨報當時的紀律快照（${taipeiTime(v.disciplineRows.reduce((m, r) => (r.generatedAt > m ? r.generatedAt : m), ""))}）`),
      v.disciplineRows.map((r) => el("div", { class: "small" }, r.fact)),
      el("p", { class: "tiny" }, "這是晨報產生當時的價格算的，比例和偏離會跟上面不同；現在的狀態以上面為準。")),
    el("p", { class: "tiny" }, `當月台股買進合計（含手續費）達 ${int(d.investedMin)} 元（定投金額 9 成）算已投入，超過定投金額的部分算自主加碼，不影響下個月的定投；檢查月（${D.checkMonths.join("、")} 月）偏離超過 ${D.bandPts} 個百分點時，當月入金整筆補偏低的一檔，其他月份照目標比例，不賣出。美股不算進比例。`));
}

// 台股盤中：有富果金鑰而且有今天的報價就用富果（使用者自己的瀏覽器查）；沒有就退回 market-data 前一交易日收盤
async function twCard() {
  const [S, f, v, navs, ix, ...bars] = await Promise.all([loadStatus(),
    loadFugle().then((x) => ({ x }), (e) => ({ e })), loadNewsView().catch(() => null), loadNavHistory().catch(() => null),
    loadIndex("TAIEX").catch(() => null), ...TRACK.tw.map((c) => loadDaily("tw", c).catch(() => null))]);
  // 富果今天的報價，或比 market-data 最後收盤新的那天（收盤後到隔天早上、週末）
  const fq = (sym, closes) => {
    const q = f.x?.quotes?.[sym];
    return fugleUsable(q, closes?.at(-1)?.date) ? q : null;
  };
  const used = [], closeDates = [];
  // 每一列：富果今天的報價，或前一交易日收盤（標日期）
  const line = (label, q, closes) => {
    let val = "—", chg = null, chgPct = null, when = "";
    if (q) {
      val = price(q.price);
      chg = q.change;
      chgPct = q.changePct;
      when = quoteTime(q);
      used.push(q);
    } else if (closes?.length >= 2) {
      const a = closes.at(-2), b = closes.at(-1);
      val = price(+b.value.toFixed(2));
      chg = b.value - a.value;
      chgPct = (chg / a.value) * 100;
      when = `${shortDate(b.date)} 收盤`;
      closeDates.push(b.date);
    }
    return el("div", { class: "kv" },
      el("span", { class: "k" }, label, el("div", { class: "tiny" }, when)),
      el("span", { class: "v" }, val, " ", isNum(chg) ? el("span", { class: tone(chg) }, `${signed(chg, (n) => price(+n.toFixed(2)))}（${pct(chgPct, 2)}）`) : ""));
  };
  const closesOf = (b) => b?.map((x) => ({ date: x.time, value: x.close }));
  const rows = [line("加權指數", fq("IX0001", ix), ix),
    ...TRACK.tw.map((c, i) => line(`${c} ${NAMES[c] || ""}`, fq(c, closesOf(bars[i])), closesOf(bars[i])))];

  // 為什麼沒有用富果
  let why = null, fugleFail = null;
  if (!getKey()) why = "沒有富果金鑰：顯示前一交易日收盤。";
  else if (f.e || (f.x && Object.keys(f.x.quotes).length === 0)) {
    fugleFail = Object.values(f.x?.errors || {})[0] || f.e?.message || "未知原因";
    why = "富果查詢失敗：顯示前一交易日收盤。";
  } else if (!used.length) why = "現在不是交易時間：顯示前一交易日收盤。";

  // 折溢價：淨值資料停止更新，最新日期落後最近兩個交易日就不顯示
  const ref = bars[0]?.at(-2)?.time;
  const latestNav = navs?.length ? navs.reduce((m, x) => (x.date > m ? x.date : m), "") : null;
  const navFresh = latestNav && ref && latestNav >= ref;
  const prem = navFresh ? TRACK.tw.map((c) => {
    const n = navs.filter((x) => x.code === c).at(-1);
    return n ? `${c} ${pct(n.premium, 2)}` : null;
  }).filter(Boolean).join("、") : null;

  // R14：收盤日期、富果、淨值的狀態（淨值是照計畫停用，不是故障）
  const minClose = closeDates.sort()[0];
  const navKind = datasetKind(S.meta, "tw/nav");
  const status = statusLine([
    minClose && { kind: S.tw(minClose), what: "台股收盤", when: [...new Set(closeDates)].map(shortDate).join("、"),
      note: S.tw(minClose) === "closed" ? "今天休市，用最近交易日的收盤" : S.tw(minClose) === "stale" ? `應該已經有 ${shortDate(S.expect.tw)} 的收盤，先用舊的` : null },
    fugleFail && { kind: "fail", what: "富果盤中報價", note: `${fugleFail}，改用前一交易日收盤` },
    !navFresh && { kind: navKind === "disabled" ? "disabled" : "stale", what: "ETF 淨值",
      when: latestNav ? `最後 ${shortDate(latestNav)}` : null,
      note: navKind === "disabled" ? "2026-11-03 起照計畫停用（找不到可公開使用的即時來源），所以不顯示折溢價" : "淨值沒有更新，不顯示折溢價" }]);
  const refreshBtn = el("button", { class: "btn small", type: "button" }, "↻ 更新");
  refreshBtn.addEventListener("click", () => document.dispatchEvent(new Event("refresh-request")));
  return card("台股盤中",
    el("div", { class: "spread" },
      el("span", { class: "small muted" }, used.length ? `${FUGLE_NOTE}` : why),
      getKey() && refreshBtn),
    status,
    rows,
    prem && el("p", { class: "tiny" }, `收盤折溢價（${shortDate(latestNav)}）：${prem}`),
    // 晨報的盤中摘要只在今天的晨報顯示；舊的盤中快照（例如週六看到週五的「今早盤中」）放在新聞頁
    v?.intradayRows?.length > 0 && newsWhen(v)?.fresh && el("div", { class: "small", style: { marginTop: "8px" } },
      el("strong", {}, `新聞晨報（${newsWhen(v).at}）：`), v.intradayRows.map((r) => el("div", {}, r.fact))),
    fugleSettings());
}

const MACRO = [["macro/SPX", "S&P 500"], ["macro/IXIC", "Nasdaq"], ["macro/SOX", "費城半導體"], ["macro/VIX", "VIX"],
  ["macro/TNX", "美 10 年債殖利率"], ["macro/DXY", "美元指數"], ["macro/GOLD", "黃金"], ["macro/WTI", "WTI 原油"], ["macro/TSM", "台積電 ADR"]];

async function usMacroCard() {
  const [meta, fx, holdings] = await Promise.all([loadMeta(), loadFx().catch(() => null), loadHoldings().catch(() => [])]);
  const ds = meta.datasets || {};
  const held = new Set(holdings.map((h) => h.code));
  const line = (name, d, isYield) => {
    if (!d || !isNum(d.last_close)) return el("tr", {}, el("td", {}, name), el("td", { class: "r" }, "—"), el("td", { class: "r" }, "—"));
    const chg = isNum(d.prev_close) ? (isYield ? d.last_close - d.prev_close : (d.last_close / d.prev_close - 1) * 100) : null;
    return el("tr", {}, el("td", {}, name),
      el("td", { class: "r" }, isYield ? `${d.last_close.toFixed(2)}%` : price(+d.last_close.toFixed(2))),
      el("td", { class: `r ${tone(chg)}` }, chg == null ? "—" : isYield ? signed(chg, (n) => n.toFixed(2)) : pct(chg, 2)));
  };
  const fxRow = fx && fx.length >= 2 ? (() => {
    const a = fx.at(-2).value, b = fx.at(-1).value;
    return el("tr", {}, el("td", {}, "美元兌台幣"), el("td", { class: "r" }, b.toFixed(3)), el("td", { class: `r ${tone(b - a)}` }, signed(b - a, (n) => n.toFixed(3))));
  })() : null;
  const last = ds["macro/SPX"]?.last;
  return card("隔夜美股與總經",
    el("div", { class: "small muted" }, last ? `美國 ${shortDate(last)} 收盤` : ""),
    el("div", { class: "table-wrap" }, el("table", {},
      el("tbody", {}, MACRO.map(([k, name]) => line(name, ds[k], k === "macro/TNX")), fxRow))),
    el("h3", {}, "美股持股與追蹤"),
    el("div", { class: "table-wrap" }, el("table", {},
      el("tbody", {}, TRACK.us.map((c) => line(`${c}${held.has(c) ? "（持有）" : ""}`, ds[`us/${c}`]))))),
    el("p", { class: "tiny" }, "殖利率的漲跌是百分點差；其他是漲跌幅。"));
}

async function calendarCard() {
  const [cal, div, dca] = await Promise.all([loadCalendar(), loadDividends().catch(() => null), loadDca().catch(() => null)]);
  const today = taipeiToday();
  const until = new Date(Date.parse(today) + 60 * 86400000).toISOString().slice(0, 10);
  const ev = [];
  const add = (date, text) => date >= today && date <= until && ev.push([date, text]);
  for (const c of TRACK.us) {
    const e = cal.earnings?.symbols?.[c];
    for (const d of e?.dates || []) add(d, `${c} 財報${e.is_estimate ? "（預估）" : ""}`);
  }
  for (const f of cal.fomc || []) if (f.end >= today) add(f.start < today ? today : f.start, `FOMC 會議 ${shortDate(f.start)}～${shortDate(f.end)}${f.sep ? "（含經濟預測）" : ""}`);
  const names = new Map((cal.tw_market?.entries || []).map((x) => [x.date, x.name]));
  for (const d of cal.tw_market?.closed || []) add(d, `台股休市（${names.get(d) || "休市"}）`);
  for (const c of TRACK.tw) {
    const n = div?.etfs?.[c]?.next;
    if (n?.ex_date) add(n.ex_date, `${c} 除息${isNum(n.cash) ? `（每單位 ${n.cash} 元）` : ""}`);
  }
  const nd = nextDepositDate(today);
  add(nd, `入金 ${twd(dcaFor(dca, nd.slice(0, 7)))}`);
  add(nextCheckDate(today), "配置檢查（核心：衛星）");
  ev.sort((a, b) => a[0].localeCompare(b[0]));
  return card("行事曆（60 天內）",
    ev.length ? el("ul", { class: "health" }, ev.slice(0, 10).map(([d, t]) =>
      el("li", {}, el("span", {}, t), el("span", { class: "muted nums" }, `${shortDate(d)}（${daysBetween(today, d)} 天後）`))))
      : el("p", { class: "muted" }, "60 天內沒有排定的事件。"),
    el("p", { class: "tiny" }, `CPI：${cal.cpi?.status === "未取得" ? "日期未取得" : "見行事曆"}。`,
      div ? TRACK.tw.map((c) => {
        const l = div.etfs?.[c]?.last;
        return l ? `${c} 上次除息 ${shortDate(l.ex_date)} 每單位 ${l.cash} 元。` : `${c} 還沒有配息紀錄。`;
      }).join("") : "除息資料讀不到。"));
}

const LIGHT = { 紅: ["#d03b3b", "熱絡"], 黃紅: ["#ec835a", "轉向"], 綠: ["#0ca30c", "穩定"], 黃藍: ["#5598e7", "轉向"], 藍: ["#2a78d6", "低迷"] };

async function backgroundCard() {
  const [meta, fg, v] = await Promise.all([loadMeta().catch(() => null), loadFearGreed().catch(() => null), loadNewsView().catch(() => null)]);
  const ds = meta?.datasets || {};
  const bc = ds["longterm/tw_business_cycle"], bf = ds["longterm/buffett_indicator"];
  const parts = (await sentimentParts(v)).filter((p) => !p.startsWith("恐懼貪婪") && !p.startsWith("口袋"));
  const light = bc && LIGHT[bc.last_light];
  return card("市場背景（參考）",
    bc && isNum(bc.last_score) ? kv("景氣燈號",
      el("span", {}, light && el("i", { class: "fg-dot", style: { background: light[0] } }),
        `${Number(bc.last.slice(5))} 月 ${bc.last_score} 分 ${bc.last_light}燈${light ? `（${light[1]}）` : ""}`),
      el("div", { class: "tiny" }, bc.next_release_est ? `下次公布約 ${shortDate(bc.next_release_est)}` : ""))
      : kv("景氣燈號", "資料準備中"),
    bf && isNum(bf.last_ratio_pct) ? kv("巴菲特指標（美國）",
      `${bf.last_ratio_pct.toFixed(0)}%（趨勢 ${bf.last_trend_pct.toFixed(0)}%，${bf.last_dev_sigma >= 0 ? "高" : "低"}於趨勢 ${Math.abs(bf.last_dev_sigma).toFixed(1)} 個標準差）`,
      el("div", { class: "tiny" }, `${bf.last}，股市總市值／GDP`))
      : kv("巴菲特指標", "資料準備中"),
    el("div", { class: "fg-pair", style: { marginTop: "10px" } },
      fg ? gaugeBlock("CNN 恐懼貪婪（美股）", `更新 ${taipeiTime(fg.time_utc)}`, cnnReading(fg), "沒有分數") : notice("err", "讀不到 CNN 恐懼貪婪"),
      pocketBlock(v?.pocket, v ? null : "讀不到新聞分頁")),
    el("p", { class: "small" }, parts.join("・")),
    el("p", { class: "tiny" }, "這些只是背景參考，不改變每月投入與配置紀律。"));
}

// 每天收盤後更新的行情檔：用日期判斷沿用（台股、美股各照自己的交易日）；其他照 meta 記的狀態
const dailyMarket = (k) => (/^(us|macro)\//.test(k) && !/^macro\/(DXY|GOLD|WTI|KOSPI)$/.test(k) ? "us"
  : /^(tw\/(?!quotes|nav)|tw_watch\/|index\/|fx\/usdtwd_mid)/.test(k) ? "tw" : null);

// 資料狀態（R14）：正常、休市正常、沿用、缺失、失敗、刻意停用分開（分類在 status.js，各卡片也就地標示）；
// 「↻ 更新」只是重讀檔案，資料時間以各檔為準
async function healthCard() {
  const [metaR, newsR, setR, S] = await Promise.allSettled([loadMeta(), loadNewsView(), loadSettings(), loadStatus()]).then((rs) => [...rs.slice(0, 3), rs[3].value]);
  const items = [];
  const li = (kind, name, val) => el("li", {}, el("span", { class: STATUS[kind].cls }, name), el("span", { class: "muted nums" }, val));
  if (metaR.status === "fulfilled") {
    const meta = metaR.value, ds = meta.datasets || {};
    const kinds = Object.fromEntries(Object.keys(ds).map((k) => [k, S.dataset(k, dailyMarket(k))]));
    const count = (kind) => Object.values(kinds).filter((x) => x === kind).length;
    const order = ["ok", "closed", "stale", "missing", "fail", "disabled"];
    items.push(li(worst(Object.values(kinds).filter((x) => x !== "disabled")), "行情資料",
      `${meta.generated_at_taipei} 抓取・${order.filter((k) => count(k)).map((k) => `${STATUS[k].label} ${count(k)}`).join("／")}`));
    const bad = Object.entries(kinds).filter(([, x]) => ["stale", "missing", "fail"].includes(x));
    if (bad.length) items.push(li(worst(bad.map(([, x]) => x)), "沿用、缺失或失敗",
      bad.map(([k, x]) => `${k}（${STATUS[x].label}${ds[k]?.last ? `，停在 ${shortDate(ds[k].last)}` : ""}）`).join("、")));
    if (count("closed")) items.push(li("closed", "休市正常", `${count("closed")} 項停在最近交易日（${[!S.twOpenToday && `台股 ${shortDate(S.expect.tw)}`, S.closedUs && `美股 ${shortDate(S.expect.us)}`].filter(Boolean).join("、")}），這是正常的`));
    const off = Object.entries(ds).filter(([k]) => kinds[k] === "disabled");
    // 照計畫停用的跟沿用、失敗分開，原因與替代用 market-data meta 記的
    if (off.length) items.push(el("li", {}, el("details", { class: "more" }, el("summary", { class: "st-off" }, `刻意停用 ${off.length} 項（不影響其他資料）`),
      el("ul", { class: "small" }, off.map(([k, d]) => el("li", {}, `${k}：${d.reason || "停用"}`))))));
  } else items.push(li("fail", "行情資料", metaR.reason.message));
  if (newsR.status === "fulfilled" && newsR.value.generatedAt) {
    const n = newsR.value, w = newsWhen(n), kind = newsKind(S, n);
    items.push(li(kind, "新聞晨報", `${w.name} ${w.at} 產生（${n.label}）`
      + (kind === "closed" ? "・晨報只在平日產生，今天休市是正常的" : kind === "stale" ? "・不是最新的" : "")));
  } else items.push(li(newsR.status === "fulfilled" ? "missing" : "fail", "新聞晨報", newsR.reason?.message || "沒有資料"));
  items.push(setR.status === "fulfilled" ? li("ok", "共用帳本", "讀取成功（Google 試算表發布版，約 5 分鐘延遲）") : li("fail", "共用帳本", setR.reason.message));
  return el("details", { class: "card more" }, el("summary", {}, "資料狀態"), el("ul", { class: "health" }, items),
    el("p", { class: "tiny" }, "● 正常、休市正常（休市日用最近交易日收盤）　▲ 沿用舊資料或缺失　✕ 失敗　◌ 刻意停用（照計畫不再更新）。",
      `「應該已經有」的日期：台股 ${shortDate(S.expect.tw)}、美股 ${shortDate(S.expect.us)} 收盤（台北早上 9 點後算前一個交易日）。「↻ 更新」只是重新讀取檔案，不會讓上游產生新資料。`));
}
