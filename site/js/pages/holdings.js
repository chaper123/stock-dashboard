// 持倉：每檔股數、成本、現價、市值、未實現損益與報酬率，以及交易紀錄。
import { loadTrades } from "../data.js";
import { loadPortfolio, FX_KIND_LABEL } from "../portfolio.js";
import { el, twd, usd, price, pct, shares, shortDate, signed, tone, int } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";
import { loadStatus, marketItem, statusLine } from "../status.js";

export async function render(root) {
  root.append(pageHeader("持倉", "股數與成本來自共用帳本「持倉」分頁（券商確認）。"));
  slot(root, positionsView);
  slot(root, tradesCard);
}

const money = (market, v) => (market === "us" ? usd(v) : twd(v));

async function positionsView() {
  const [pf, S] = await Promise.all([loadPortfolio(), loadStatus()]);
  const t = pf.totals;
  const hasUs = pf.positions.some((p) => p.market === "us");
  // R14：價格與匯率不是正常時，在合計旁邊標狀態與資料時間
  const status = statusLine([marketItem(S, pf.positions, "tw", "台股"), marketItem(S, pf.positions, "us", "美股"),
    hasUs && (pf.fx ? { kind: S.fx(pf.fx.date), what: "匯率", when: shortDate(pf.fx.date) } : { kind: "fail", what: "匯率", note: "讀不到，美股沒有換算成台幣" })]);
  const summary = card("合計（台幣）",
    el("div", { class: "grid three" },
      kv("持倉市值", el("strong", {}, twd(t.mvTwd))),
      kv(hasUs ? el("span", {}, "成本", el("div", { class: "tiny" }, "美股用現在的匯率換算")) : "成本", twd(t.costTwd)),
      kv(el("span", {}, "未實現損益", el("div", { class: "tiny" }, "證券損益折台幣，不含匯差")),
        el("span", { class: tone(t.pnlTwd) }, `${signed(t.pnlTwd, twd)}（${pct(t.pnlPct)}）`)),
      hasUs && kv(el("span", {}, `含匯差損益${t.withFx.complete && t.withFx.kind !== "actual" ? "（參考）" : ""}`,
        el("div", { class: "tiny" }, "現在的台幣市值 − 當初的台幣成本")),
      t.withFx.complete ? el("span", {}, el("span", { class: tone(t.withFx.pnl) }, `${signed(t.withFx.pnl, twd)}（${pct(t.withFx.pnlPct)}）`),
        el("div", { class: "tiny" }, `其中匯率 ${signed(t.withFx.fxEffect, twd)}`))
        : el("span", { class: "muted" }, `缺 ${t.withFx.lack.map((x) => x.code).join("、")} 的台幣成本`))),
    !pf.complete && notice("warn", `合計只算讀得到的部分，缺：${pf.missing.join("、")}。`),
    status,
    pf.warnings.map((w) => notice("warn", w)),
    hasUs && fxNote(pf),
    el("p", { class: "tiny" },
      "損益未扣賣出手續費與稅。",
      pf.fx ? `未實現損益的美股市值與成本都用 ${price(pf.fx.rate)}（${shortDate(pf.fx.date)} 美元兌台幣中間價）換算，所以不含匯差。` : ""));
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
      m === "us" && cell(p.fxBasis?.kind === "actual" ? "台幣成本（實際）" : "台幣成本（參考匯率）", p.costTwdHist != null ? twd(p.costTwdHist) : "—"),
      m === "us" && cell("含匯差損益", p.pnlTwdFx != null
        ? el("span", {}, el("span", { class: tone(p.pnlTwdFx) }, signed(p.pnlTwdFx, twd)), el("span", { class: "tiny" }, `（匯率 ${signed(p.fxEffect, twd)}）`)) : "—"),
      cell("確認日", shortDate(p.confirmed))),
    p.note && el("div", { class: "tiny" }, `價格來源：${p.note}`));
}

// 含匯差的口徑（R09）：分清實際台幣成本與參考匯率換算的成本；缺資料就說缺，不補造
function fxNote(pf) {
  const us = pf.positions.filter((p) => p.market === "us" && !p.error);
  const ref = us.filter((p) => p.fxBasis && !p.fxBasis.error && p.fxBasis.kind !== "actual");
  const bad = us.filter((p) => p.fxBasis?.error);
  const w = pf.totals.withFx;
  return el("div", {},
    ref.length > 0 && notice("info", el("strong", {}, "實際台幣成本尚缺"),
      `：帳本 ${ref.map((p) => `${p.code}（${p.fxBasis.refDates.map(shortDate).join("、")} 買進）`).join("、")} 沒有台幣金額與成交匯率，`
      + "含匯差先用買進當天的美元兌台幣市場中間價換算，是參考值，不是你實際換匯花的台幣（銀行或券商的匯率還有價差）。帳本補上台幣金額後會改用實際成本。"),
    bad.map((p) => notice("warn", `${p.code} 的含匯差算不出來：${p.fxBasis.error}。`)),
    el("p", { class: "tiny" }, "兩種損益：「未實現損益」是美元損益換成台幣（成本與市值用同一個現在的匯率），不含匯差；",
      "「含匯差損益」是現在的台幣市值 − 剩餘持股當初的台幣成本，美元漲跌與匯率變化都在裡面，「其中匯率」是兩者的差。",
      "部分賣出用平均成本法：賣出照當時的平均台幣成本扣掉，剩下的持股沿用原本的平均成本。",
      w.complete && w.kind === "actual" ? `${FX_KIND_LABEL.actual}。` : ""));
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
