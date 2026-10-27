// 持倉：每檔股數、成本、現價、市值、未實現損益與報酬率，以及交易紀錄。
import { loadTrades } from "../data.js";
import { loadPortfolio } from "../portfolio.js";
import { el, twd, usd, price, pct, shares, shortDate, signed, tone, int } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";

export async function render(root) {
  root.append(pageHeader("持倉", "股數與成本來自共用帳本「持倉」分頁（券商確認）。"));
  slot(root, positionsView);
  slot(root, tradesCard);
}

const money = (market, v) => (market === "us" ? usd(v) : twd(v));

async function positionsView() {
  const pf = await loadPortfolio();
  const t = pf.totals;
  const summary = card("合計（台幣）",
    el("div", { class: "grid three" },
      kv("持倉市值", el("strong", {}, twd(t.mvTwd))),
      kv("成本", twd(t.costTwd)),
      kv("未實現損益", el("span", { class: tone(t.pnlTwd) }, `${signed(t.pnlTwd, twd)}（${pct(t.pnlPct)}）`))),
    pf.warnings.map((w) => notice("warn", w)),
    el("p", { class: "tiny" },
      "損益未扣賣出手續費與稅。",
      pf.fx ? `美股以 ${price(pf.fx.rate)}（${shortDate(pf.fx.date)} 美元兌台幣中間價）換算，成本也用同一匯率換算，所以台幣損益不含匯差。` : ""));
  const cards = ["tw", "us"].map((m) => {
    const list = pf.positions.filter((p) => p.market === m);
    if (!list.length) return null;
    const mt = t[m];
    return card(null,
      el("div", { class: "spread" }, el("h2", { style: { margin: 0 } }, MARKET_LABEL[m]),
        el("span", { class: "small" }, `市值 ${money(m, mt.mv)}・`, el("span", { class: tone(mt.pnl) }, `${signed(mt.pnl, (v) => money(m, v))}（${pct(mt.pnlPct)}）`))),
      list.map((p) => position(p)));
  });
  return [summary, ...cards];
}

function position(p) {
  const m = p.market;
  const cell = (k, v) => el("div", {}, el("span", { class: "k" }, k), el("span", { class: "v" }, v));
  return el("div", { class: "pos" },
    el("div", { class: "spread" },
      el("div", {}, el("strong", {}, p.code), el("span", { class: "tk-name" }, `　${p.name || ""}`)),
      p.error ? el("span", { class: "small down" }, p.error)
        : el("strong", { class: tone(p.pnl) }, `${signed(p.pnl, (v) => money(m, v))}（${pct(p.pnlPct)}）`)),
    el("div", { class: "pos-grid" },
      cell("股數", shares(p.shares)),
      cell("平均成本", price(p.avg)),
      cell(`現價（${p.at ? (p.at.startsWith("今天") ? p.at : shortDate(p.at)) : "—"}）`, price(p.price)),
      cell("總成本", money(m, p.cost)),
      cell("市值", money(m, p.mv)),
      m === "us" && cell("市值（台幣）", twd(p.mvTwd)),
      cell("確認日", shortDate(p.confirmed))),
    p.note && el("div", { class: "tiny" }, `價格來源：${p.note}`));
}

async function tradesCard() {
  const trades = (await loadTrades()).slice().sort((a, b) => b.date.localeCompare(a.date));
  const row = (t) => el("tr", {},
    el("td", {}, t.date), el("td", {}, MARKET_LABEL[t.market]), el("td", {}, t.code), el("td", {}, t.side),
    el("td", { class: "r" }, shares(t.shares)), el("td", { class: "r" }, price(t.price)),
    el("td", { class: "r" }, t.twd != null ? int(t.twd) : "—"), el("td", {}, t.inPool ? "是" : "否"));
  const table = (list) => el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
    el("thead", {}, el("tr", {}, ["日期", "市場", "代號", "買賣", "股數", "成交價", "台幣", "計入資金池"]
      .map((h, i) => el("th", { class: i >= 4 && i <= 6 ? "r" : "" }, h)))),
    el("tbody", {}, list.map(row))));
  return card("交易紀錄",
    table(trades.slice(0, 8)),
    trades.length > 8 && el("details", { class: "more" }, el("summary", {}, `顯示較早的 ${trades.length - 8} 筆`), table(trades.slice(8))),
    el("p", { class: "tiny" }, "「計入資金池」為「否」的是基準日（10/06）以前的買入，不影響可用資金。"));
}
