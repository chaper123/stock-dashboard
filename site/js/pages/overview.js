// 總覽：今天的一句話、資金池、總資產、台美比重、情緒、資料健康。
import {
  loadSettings, loadArchive, latestRun, oneLiner, loadMeta, loadFearGreed, loadFearGreedHistory, loadVix,
} from "../data.js";
import { loadPortfolio } from "../portfolio.js";
import {
  el, twd, pct, price, taipeiTime, shortDate, taipeiToday, daysBetween, tone, signed, badge, LEVELS, isNum,
} from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";
import { fearGreedGauge } from "../gauge.js";

export async function render(root) {
  root.append(pageHeader("總覽", `台北時間 ${taipeiToday()}`));
  slot(root, summaryCard);
  const kpis = el("div", { class: "kpis" });
  root.append(kpis);
  slot(kpis, poolTile);
  slot(kpis, assetsTile);
  slot(kpis, splitTile);
  const grid = el("div", { class: "grid two" });
  root.append(grid);
  slot(grid, sentimentCard);
  slot(grid, healthCard);
}

function autoLine(j) {
  const inZone = j.tickers.filter((t) => LEVELS[t.level]?.inZone);
  const names = inZone.map((t) => `${t.code} ${t.status}`).join("、");
  return `${names || "沒有標的在買區"}；規則參考合計 ${twd(j.total_twd)}。`;
}

async function summaryCard() {
  const archive = await loadArchive();
  const today = taipeiToday();
  const items = ["us", "tw"].map((m) => {
    const r = latestRun(archive, m);
    const head = el("strong", {}, `${MARKET_LABEL[m]}晨報`);
    if (!r) return el("div", { class: "sum-item" }, head, el("p", { class: "muted" }, "還沒有存檔。"));
    const j = r.json;
    const inZone = j.tickers.filter((t) => LEVELS[t.level]?.inZone);
    const stale = r.generatedAt.slice(0, 10) !== today;
    return el("div", { class: "sum-item" },
      el("div", { class: "spread" }, el("span", { class: "row" }, head, stale && el("span", { class: "badge b-warn" }, "⚠ 不是今天的")),
        el("span", { class: "tiny" }, `產生 ${taipeiTime(r.generatedAt)}・資料日 ${shortDate(r.dataDate)}`)),
      el("p", { class: "one-liner" }, oneLiner(r.report) || autoLine(j)),
      el("div", { class: "row small" },
        el("span", { class: "muted" }, `規則參考合計 ${twd(j.total_twd)}／本次上限 ${twd(j.cap_twd)}`),
        inZone.map((t) => el("span", {}, `${t.code} `, badge(t.level, t.status)))));
  });
  return card("今天的一句話", el("div", { class: "stack" }, items),
    el("p", { class: "small" }, el("a", { href: "#/plan" }, "看今日計畫 →"), "　", el("a", { href: "#/reports" }, "看報告全文 →")));
}

async function poolTile() {
  const s = await loadSettings();
  const today = taipeiToday();
  const ago = s.lastBuy ? daysBetween(s.lastBuy, today) : null;
  return el("section", { class: "card tile" },
    el("div", { class: "label" }, "資金池（可用資金）"),
    el("div", { class: "value" }, twd(s.pool)),
    el("div", { class: "sub" },
      el("div", {}, `每月入金 ${twd(s.monthly)}${s.nextDeposit ? `，下次 ${shortDate(s.nextDeposit)}` : ""}`),
      el("div", {}, s.lastBuy ? `最近一次買入 ${shortDate(s.lastBuy)}（${ago} 天前）` : "沒有買入紀錄"),
      el("div", { class: "tiny" }, "帳本理論值，不等於券商交割餘額")));
}

async function assetsTile() {
  const [pf, st] = await Promise.all([loadPortfolio(), loadSettings().catch((e) => e)]);
  const pool = st instanceof Error ? null : st.pool;
  const t = pf.totals;
  const total = t.mvTwd + (pool || 0);
  return el("section", { class: "card tile" },
    el("div", { class: "label" }, "總資產（持倉市值＋可用資金）"),
    el("div", { class: "value" }, twd(total)),
    el("div", { class: "sub" },
      el("div", {}, `持倉 ${twd(t.mvTwd)}・未實現 `, el("span", { class: tone(t.pnlTwd) }, `${signed(t.pnlTwd, twd)}（${pct(t.pnlPct)}）`)),
      el("div", {}, pool == null ? "可用資金讀不到，沒有算進去" : `可用資金 ${twd(pool)}`),
      pf.fx && el("div", { class: "tiny" }, `美股以 ${price(pf.fx.rate)}（${shortDate(pf.fx.date)} 美元兌台幣中間價）換算`)),
    pf.warnings.map((w) => notice("warn", w)));
}

async function splitTile() {
  const pf = await loadPortfolio();
  const { tw, us, mvTwd } = pf.totals;
  if (!mvTwd) return el("section", { class: "card tile" }, el("div", { class: "label" }, "台美比重"), el("p", {}, "沒有可計算的持倉。"));
  const twP = (tw.mvTwd / mvTwd) * 100, usP = (us.mvTwd / mvTwd) * 100;
  return el("section", { class: "card tile" },
    el("div", { class: "label" }, "台美比重（持倉市值）"),
    el("div", { class: "value" }, `${Math.round(twP)} : ${Math.round(usP)}`),
    el("div", { class: "split", role: "img", "aria-label": `台股 ${pct(twP, 1, false)}，美股 ${pct(usP, 1, false)}` },
      el("span", { class: "s-tw", style: { width: `${twP}%` } }), el("span", { class: "s-us", style: { width: `${usP}%` } })),
    el("div", { class: "legend" },
      el("span", {}, el("i", { style: { background: "var(--accent)" } }), `台股 ${twd(tw.mvTwd)}（${pct(twP, 1, false)}）`),
      el("span", {}, el("i", { style: { background: "var(--ma1)" } }), `美股 ${twd(us.mvTwd)}（${pct(usP, 1, false)}）`)));
}

function sparkline(values, label) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(2)},${(34 - ((v - min) / span) * 32).toFixed(2)}`).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 36");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const title = document.createElementNS(svg.namespaceURI, "title");
  title.textContent = label;
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", d);
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(title, path);
  return svg;
}

async function sentimentCard() {
  const [fg, hist, vix] = await Promise.allSettled([loadFearGreed(), loadFearGreedHistory(), loadVix()]);
  const parts = [];
  if (fg.status === "fulfilled") {
    const f = fg.value;
    const h = hist.status === "fulfilled" ? hist.value.slice(-60) : [];
    parts.push(el("div", {},
      el("div", { class: "spread" }, el("strong", {}, "CNN 恐懼貪婪（美股）"), el("span", { class: "tiny" }, `更新 ${taipeiTime(f.time_utc)}`)),
      isNum(f.score) ? fearGreedGauge(f) : el("p", { class: "muted" }, "沒有分數"),
      el("div", { class: "small muted", style: { textAlign: "center" } }, `一週前 ${fmt1(f.previous_1_week)}・一個月前 ${fmt1(f.previous_1_month)}・一年前 ${fmt1(f.previous_1_year)}`),
      h.length > 1 && sparkline(h.map((x) => x.value), `恐懼貪婪近 ${h.length} 個交易日：${shortDate(h[0].date)} ${fmt1(h[0].value)} → ${shortDate(h.at(-1).date)} ${fmt1(h.at(-1).value)}`)));
  } else parts.push(notice("err", `讀不到 CNN 恐懼貪婪：${fg.reason.message}`));
  if (vix.status === "fulfilled") {
    const v = vix.value, last = v.at(-1), prev = v.at(-2);
    const s = v.slice(-60);
    parts.push(el("div", { class: "vix" },
      el("div", { class: "spread" }, el("strong", {}, "台指 VIX"), el("span", { class: "tiny" }, `${shortDate(last.date)} 收盤`)),
      el("div", { class: "row" }, el("span", { class: "tile" }, el("span", { class: "value" }, last.value.toFixed(2))),
        prev && el("span", { class: "small muted" }, `前一日 ${prev.value.toFixed(2)}（${signed(last.value - prev.value, (x) => x.toFixed(2))}）`)),
      sparkline(s.map((x) => x.value), `台指 VIX 近 ${s.length} 個交易日：${shortDate(s[0].date)} ${s[0].value} → ${shortDate(last.date)} ${last.value}`)));
  } else parts.push(notice("err", `讀不到台指 VIX：${vix.reason.message}`));
  return card("市場情緒", el("div", { class: "stack" }, parts),
    el("p", { class: "tiny" }, "情緒只當參考，不單獨改變買區判定。"));
}
const fmt1 = (v) => (isNum(v) ? v.toFixed(1) : "—");

const ST_LABEL = { ok: "正常", stale: "沿用舊檔", fail: "從未成功" };

async function healthCard() {
  const [metaR, archR, setR] = await Promise.allSettled([loadMeta(), loadArchive(), loadSettings()]);
  const items = [];
  const li = (st, name, val) => el("li", {}, el("span", { class: `st-${st}` }, name), el("span", { class: "muted nums" }, val));
  if (metaR.status === "fulfilled") {
    const meta = metaR.value, ds = meta.datasets || {};
    const counts = { ok: 0, stale: 0, fail: 0 };
    for (const d of Object.values(ds)) counts[d.status] = (counts[d.status] || 0) + 1;
    const worst = counts.fail ? "fail" : counts.stale ? "stale" : "ok";
    items.push(li(worst, "行情資料（market-data）", `${meta.generated_at_taipei} 產生・正常 ${counts.ok}／沿用 ${counts.stale}／失敗 ${counts.fail}`));
    const lastOf = (prefix) => Object.entries(ds).filter(([k]) => k.startsWith(prefix)).map(([, d]) => d.last).filter(Boolean).sort().at(-1);
    const stOf = (prefix) => {
      const s = Object.entries(ds).filter(([k]) => k.startsWith(prefix)).map(([, d]) => d.status);
      return s.includes("fail") ? "fail" : s.includes("stale") ? "stale" : "ok";
    };
    for (const [name, prefix] of [["美股日線", "us/"], ["台股日線", "tw/0"], ["美元兌台幣", "fx/usdtwd_mid"], ["恐懼貪婪", "sentiment/cnn"],
      ["台指 VIX", "sentiment/taifex"], ["新聞標題", "news/headlines"]]) {
      const last = lastOf(prefix);
      items.push(li(stOf(prefix), name, last ? `最後 ${last}` : "—"));
    }
    const bad = Object.entries(ds).filter(([, d]) => d.status !== "ok");
    const conflict = Object.entries(ds).filter(([, d]) => d.cross_check_ok === false);
    if (bad.length) items.push(li("stale", "不是正常的資料集", bad.map(([k, d]) => `${k}（${ST_LABEL[d.status] || d.status}）`).join("、")));
    if (conflict.length) items.push(li("stale", "雙來源核對不一致", conflict.map(([k]) => k).join("、")));
  } else items.push(li("fail", "行情資料（market-data）", metaR.reason.message));
  if (archR.status === "fulfilled") {
    for (const m of ["us", "tw"]) {
      const r = latestRun(archR.value, m);
      const today = r && r.generatedAt.slice(0, 10) === taipeiToday();
      items.push(li(r ? (today ? "ok" : "stale") : "fail", `${MARKET_LABEL[m]}晨報`, r ? `產生 ${taipeiTime(r.generatedAt)}・${r.engine.split("@")[0]}` : "沒有存檔"));
    }
  } else items.push(li("fail", "晨報存檔", archR.reason.message));
  items.push(setR.status === "fulfilled" ? li("ok", "共用帳本", "讀取成功") : li("fail", "共用帳本", setR.reason.message));
  return card("資料健康", el("ul", { class: "health" }, items),
    el("p", { class: "tiny" }, "● 正常　▲ 沿用舊檔或不是今天　✕ 失敗。台股休市日沒有晨報。"));
}
