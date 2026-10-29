// 總覽：午間一站式（docs/PIVOT.md 第 3 節），由上到下：招呼與今日一句、我的資產、本月紀律、今天的重點、
// 台股盤中、隔夜美股與總經、行事曆、市場背景，最後是資料狀態。每一塊各自讀資料、各自失敗。
import {
  loadSettings, loadTrades, loadMeta, loadFearGreed, loadVix, loadIntraday, loadNavRaw, loadCalendar, loadFx, loadHoldings,
} from "../data.js";
import { loadPortfolio } from "../portfolio.js";
import { discipline, nextDepositDate, nextCheckDate } from "../discipline.js";
import { loadNewsView, sentimentParts } from "../news.js";
import { highlightsCard } from "./news.js";
import { cnnReading, gaugeBlock, pocketBlock } from "../gauge.js";
import {
  el, twd, pct, price, int, taipeiTime, shortDate, taipeiToday, daysBetween, tone, signed, isNum,
} from "../fmt.js";
import { slot, card, kv, notice } from "../ui.js";
import { DISCIPLINE as D, NAMES, TRACK } from "../config.js";

export async function render(root) {
  slot(root, greetingCard);
  const grid = el("div", { class: "grid two" });
  root.append(grid);
  slot(grid, assetsCard);
  slot(grid, disciplineCard);
  slot(root, async () => highlightsCard(await loadNewsView(), { link: true }));
  const grid2 = el("div", { class: "grid two" });
  root.append(grid2);
  slot(grid2, twCard);
  slot(grid2, usMacroCard);
  slot(grid2, calendarCard);
  slot(grid2, backgroundCard);
  slot(root, healthCard);
}

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
  return el("section", { class: "card greet" },
    el("div", { class: "greet-hello" }, `${hello}！`),
    el("div", { class: "small muted" }, `${today.replace(/-/g, "/")} ${wd}`),
    line ? el("p", { class: "greet-line" }, line)
      : el("p", { class: "greet-line muted" }, "今日一句：新聞晨報 11:30 版上線後顯示。"),
    el("p", { class: "disclaimer-line" }, "內容是依自訂規則的提醒與資訊整理，不是投資建議。"));
}

async function assetsCard() {
  const [pf, st] = await Promise.all([loadPortfolio(), loadSettings().catch((e) => e)]);
  const pool = st instanceof Error ? null : st.pool;
  const t = pf.totals;
  const total = t.mvTwd + (pool || 0);
  const today = taipeiToday();
  return card("我的資產",
    el("div", { class: "tile" },
      el("div", { class: "label" }, "總資產（持倉市值＋可用資金）"),
      el("div", { class: "value" }, twd(total))),
    kv("今天漲跌", el("span", { class: tone(t.dayChgTwd) }, signed(t.dayChgTwd, twd))),
    kv("未實現損益", el("span", { class: tone(t.pnlTwd) }, `${signed(t.pnlTwd, twd)}（${pct(t.pnlPct)}）`)),
    kv("持倉市值", `${twd(t.mvTwd)}（台股 ${twd(t.tw.mvTwd)}・美股 ${twd(t.us.mvTwd)}）`),
    kv("可用資金", pool == null ? "讀不到" : twd(pool)),
    kv("下次入金", st instanceof Error || !st.nextDeposit ? "—" : `${shortDate(st.nextDeposit)}（${daysBetween(today, st.nextDeposit)} 天後）`),
    el("p", { class: "tiny" }, "今天漲跌：台股是現價對昨收，美股是最後一個交易日對前一日。",
      pf.fx ? ` 美股以 ${price(pf.fx.rate)}（${shortDate(pf.fx.date)}）換台幣。` : ""),
    pf.warnings.map((w) => notice("warn", w)));
}

async function disciplineCard() {
  const [trades, pf] = await Promise.all([loadTrades(), loadPortfolio()]);
  const today = taipeiToday();
  const d = discipline({ trades, positions: pf.positions, today });
  const ratio = Math.min(1, d.invested / D.deposit);
  const status = !d.depositArrived && !d.invested
    ? el("span", { class: "muted" }, `本月 ${shortDate(d.depositDate)} 入金後開始`)
    : d.done ? el("span", { class: "badge b-ok" }, "✓ 本月已投入")
      : el("span", { class: "badge b-warn" }, `⚠ 還差 ${twd(D.investedMin - d.invested)} 到 9 成（月底前，剩 ${d.daysLeft} 天）`);
  const w = d.weights;
  const target = (code) => `${Math.round(D.target[code] * 100)}%`;
  return card(`本月紀律（${Number(d.month.slice(5))} 月）`,
    el("div", { class: "spread" }, el("span", {}, `已投入 ${twd(d.invested)}／應投入 ${twd(D.deposit)}`), status),
    el("div", { class: "progress", role: "img", "aria-label": `已投入 ${Math.round(ratio * 100)}%` },
      el("span", { style: { width: `${ratio * 100}%` } })),
    el("div", { class: "small muted" }, d.plan.mode === "rebalance"
      ? `偏離超過 ${D.bandPts} 個百分點：本月入金先補 ${d.plan.items[0][0]}（${twd(d.plan.items[0][1])}）`
      : `本月建議：${d.plan.items.map(([c, a]) => `${c} ${twd(a)}`).join("、")}（照目標比例）`),
    w ? [
      kv("核心：衛星（市值）", `${Math.round(w.core * 100)}：${Math.round(w.sat * 100)}（目標 ${target(D.core)}：${target(D.satellite)}）`),
      kv("偏離", el("span", { class: Math.abs(w.devPts) > D.bandPts ? "badge b-warn" : "" },
        `${w.devPts >= 0 ? "+" : "−"}${Math.abs(w.devPts).toFixed(1)} 個百分點（門檻 ±${D.bandPts}）`)),
    ] : kv("核心：衛星", "讀不到兩檔的市值"),
    kv("下次檢查", `${d.nextCheck.replace(/-/g, "/")}（${daysBetween(today, d.nextCheck)} 天後）`),
    kv("連續投入", `${d.streak} 個月`),
    el("p", { class: "tiny" }, `當月台股買進合計達 ${int(D.investedMin)} 元算已投入；檢查日偏離超過 ${D.bandPts} 個百分點時，之後的入金先補偏低的一檔，不賣出。美股不算進比例。`));
}

async function twCard() {
  const [intra, nav] = await Promise.all([loadIntraday(), loadNavRaw().catch(() => null)]);
  const q = intra.quotes || {};
  const ix = q.TAIEX;
  const row = (label, x, extra) => el("div", { class: "kv" },
    el("span", { class: "k" }, label),
    el("span", { class: "v" }, x && isNum(x.price) ? [price(x.price), " ",
      el("span", { class: tone(x.change) }, `${signed(x.change, (n) => price(+n.toFixed(2)))}（${pct(x.change_pct, 2)}）`)] : "—", extra));
  const prem = (code) => {
    const it = nav?.items?.[code];
    const g = it ? Number(it.g) : NaN;
    return Number.isFinite(g) ? el("div", { class: "tiny" }, `盤中預估折溢價 ${pct(g, 2)}`) : null;
  };
  const when = ix?.time ? taipeiTime(ix.time.replace(" ", "T") + "+08:00") : intra.fetched_at_taipei;
  return card("台股盤中",
    el("div", { class: "small muted" }, `${intra.session || ""}・證交所快照 ${when || "—"}`, ix && !ix.is_today && el("span", { class: "badge b-warn" }, " 不是今天的")),
    row("加權指數", ix),
    TRACK.tw.map((c) => row(`${c} ${NAMES[c] || ""}`, q[c], prem(c))),
    el("p", { class: "tiny" }, "快照目前約 10:05 更新；12:00 快照上線後改成午間資料。"));
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
  const cal = await loadCalendar();
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
  add(nextDepositDate(today), `入金 ${twd(D.deposit)}`);
  add(nextCheckDate(today), "配置檢查（核心：衛星）");
  ev.sort((a, b) => a[0].localeCompare(b[0]));
  return card("行事曆（60 天內）",
    ev.length ? el("ul", { class: "health" }, ev.slice(0, 10).map(([d, t]) =>
      el("li", {}, el("span", {}, t), el("span", { class: "muted nums" }, `${shortDate(d)}（${daysBetween(today, d)} 天後）`))))
      : el("p", { class: "muted" }, "60 天內沒有排定的事件。"),
    el("p", { class: "tiny" }, `CPI：${cal.cpi?.status === "未取得" ? "日期未取得" : "見行事曆"}。除息與收益分配：資料準備中。`));
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

const ST_LABEL = { ok: "正常", stale: "沿用舊檔", fail: "從未成功" };

async function healthCard() {
  const [metaR, newsR, setR] = await Promise.allSettled([loadMeta(), loadNewsView(), loadSettings()]);
  const items = [];
  const li = (st, name, val) => el("li", {}, el("span", { class: `st-${st}` }, name), el("span", { class: "muted nums" }, val));
  if (metaR.status === "fulfilled") {
    const meta = metaR.value, ds = meta.datasets || {};
    const counts = { ok: 0, stale: 0, fail: 0 };
    for (const d of Object.values(ds)) counts[d.status] = (counts[d.status] || 0) + 1;
    const worst = counts.fail ? "fail" : counts.stale ? "stale" : "ok";
    items.push(li(worst, "行情資料", `${meta.generated_at_taipei}・正常 ${counts.ok}／沿用 ${counts.stale}／失敗 ${counts.fail}`));
    const bad = Object.entries(ds).filter(([, d]) => d.status !== "ok");
    if (bad.length) items.push(li("stale", "不是正常的資料集", bad.map(([k, d]) => `${k}（${ST_LABEL[d.status] || d.status}）`).join("、")));
  } else items.push(li("fail", "行情資料", metaR.reason.message));
  if (newsR.status === "fulfilled" && newsR.value.generatedAt) {
    const n = newsR.value;
    items.push(li(n.dataDate === taipeiToday() ? "ok" : "stale", "新聞晨報", `${taipeiTime(n.generatedAt)}（${n.label}）`));
  } else items.push(li("fail", "新聞晨報", newsR.reason?.message || "沒有資料"));
  items.push(setR.status === "fulfilled" ? li("ok", "共用帳本", "讀取成功") : li("fail", "共用帳本", setR.reason.message));
  return el("details", { class: "card more" }, el("summary", {}, "資料狀態"), el("ul", { class: "health" }, items),
    el("p", { class: "tiny" }, "● 正常　▲ 沿用舊檔或不是今天　✕ 失敗"));
}
