// 今日計畫：各市場最新一次晨報的判定（狀態、規則參考金額、買區、距第一買區上緣）。
import { loadArchive, latestRun } from "../data.js";
import { el, twd, usd, price, pct, taipeiTime, shortDate, badge, distText, zoneText, LEVELS, isNum } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { MARKET_LABEL, NAMES } from "../config.js";

export async function render(root) {
  root.append(pageHeader("今日計畫", "各市場最新一次晨報的判定；金額是規則參考，Phase 3 配置器上線前還沒有跨市場分配。"));
  for (const m of ["tw", "us"]) slot(root, () => marketCard(m));
}

async function marketCard(market) {
  const r = latestRun(await loadArchive(), market);
  if (!r) return card(`${MARKET_LABEL[market]}`, notice("info", "還沒有晨報存檔。"));
  const j = r.json;
  const main = j.tickers.filter((t) => t.role === "buy");
  const side = j.tickers.filter((t) => t.role !== "buy");
  return card(null,
    el("div", { class: "spread" },
      el("h2", { style: { margin: 0 } }, `${MARKET_LABEL[market]}・資料日 ${shortDate(j.data_date)}`),
      el("span", { class: "tiny" }, `產生 ${taipeiTime(r.generatedAt)}・${j.engine?.ref || ""}`)),
    el("div", { class: "grid three", style: { margin: "10px 0" } },
      kv("可用資金", twd(j.pool_twd)),
      kv(`本次上限（${market === "us" ? "40" : "60"}%）`, twd(j.cap_twd)),
      kv("規則參考合計", el("strong", {}, twd(j.total_twd)))),
    market === "us" ? usNotes(j) : twNotes(j),
    el("div", { class: "tickers" }, main.map((t) => tickerCard(market, t))),
    side.length > 0 && el("details", { class: "more" },
      el("summary", {}, `觀察與市場指標（${side.length} 檔，不給金額）`),
      el("div", { class: "tickers" }, side.map((t) => tickerCard(market, t)))));
}

function usNotes(j) {
  const out = [];
  if (j.fx) {
    out.push(el("div", { class: "small muted" },
      `匯率濾網：台銀即期賣出 ${price(j.fx.rate)}（${shortDate(j.fx.date)}），半年均值 ${price(j.fx.mean)}，偏離 ${pct(j.fx.dev_pct, 2)}`));
  }
  if (j.min_order?.twd) {
    out.push(el("div", { class: "small muted" }, `最低下單 ${j.min_order.usd} 美元，含 3% 圈存約 ${twd(j.min_order.twd)}`));
  }
  if (j.gauge?.tag) {
    out.push(el("div", { class: "small muted" }, `IAUM 市場指標：${j.gauge.tag}（IAUM 20 日 ${pct(j.gauge.iaum_chg20, 2)}、VOO 20 日 ${pct(j.gauge.voo_chg20, 2)}）`));
  }
  return out;
}

function twNotes(j) {
  const idle = j.idle_reminder;
  return idle ? el("div", { class: "small muted" }, `距最近一次買入 ${idle.days} 天${idle.alert ? "（空手提醒）" : ""}`) : null;
}

function gateText(market, t) {
  if (market === "us") {
    if (!t.valuation || t.valuation === "—") return null;
    const v = Object.entries(t.val_now || {}).filter(([, x]) => x != null).map(([k, x]) => `${{ pe: "本益比", fwd_pe: "Forward PE", peg: "PEG" }[k] || k} ${x}`);
    return `估值 ${t.valuation}${v.length ? `（${v.join("、")}）` : ""}`;
  }
  return t.premium == null ? "溢價未取得" : `溢價 ${t.premium}%`;
}

function tickerCard(market, t) {
  const lv = LEVELS[t.level] || {};
  const zones = [];
  if (market === "tw") zones.push(["starter", "起始倉區", t.held ? null : t.zones.starter, t.held ? "已持有" : null]);
  zones.push(["z1", "第一買區", t.zones.z1], ["z2", "第二買區", t.zones.z2], ["z3", "深度買區", t.zones.z3]);
  const usedIntraday = market === "tw" && isNum(t.intraday) && t.price === t.intraday;
  const amount = t.role === "buy"
    ? el("div", { class: "tk-amt" },
      el("div", { class: `a ${t.amount_twd ? "" : "muted"}` }, twd(t.amount_twd)),
      market === "us" && t.amount_usd > 0 && el("div", { class: "tiny" }, `可下單約 ${usd(t.amount_usd)}`),
      el("div", { class: "tiny" }, "規則參考金額"))
    : null;
  return el("article", { class: `tk ${lv.inZone ? "in-zone" : ""}` },
    el("div", { class: "tk-head" },
      el("div", {},
        el("div", { class: "row" }, el("span", { class: "tk-code" }, t.code), badge(t.level, t.status)),
        el("div", { class: "tk-name" }, NAMES[t.code] || "")),
      amount),
    el("div", { class: "small", style: { marginTop: "6px" } },
      `判定價 ${price(t.price)}${usedIntraday ? "（盤中）" : ""}`,
      el("span", { class: "muted" }, `・收盤 ${price(t.close)}（${shortDate(t.date)}）`)),
    el("div", { class: "small" }, "距第一買區上緣：", el("strong", {}, distText(t.dist_to_z1_pct))),
    el("div", { class: `zones ${zones.length === 4 ? "four" : ""}` },
      zones.map(([k, label, z, alt]) => el("div", { class: `zone z-${k} ${t.level === k ? "on" : ""}` },
        el("b", {}, label), el("span", {}, alt || zoneText(z))))),
    t.why?.length > 0 && el("ul", { class: "why" }, t.why.map((w) => el("li", {}, w))),
    t.issues?.length > 0 && el("ul", { class: "why" }, t.issues.map((w) => el("li", {}, `資料檢查：${typeof w === "string" ? w : JSON.stringify(w)}`))),
    el("div", { class: "tiny", style: { marginTop: "6px" } },
      [`趨勢 ${t.trend}`, isNum(t.rsi) ? `RSI ${t.rsi.toFixed(0)}` : null, isNum(t.bias) ? `乖離 ${pct(t.bias)}` : null, gateText(market, t),
        t.event && t.event !== "none" ? `事件旗標 ${t.event}` : null].filter(Boolean).join("・")));
}
