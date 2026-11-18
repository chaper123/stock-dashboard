// 資產頁「配息」卡（docs/AUTO_DIVIDENDS.md 第 3 節）：接下來的預計配息、最近自動或手動記進帳本的配息、Apps Script 自動記帳狀態。
// 估算只是提醒，實際入帳以錢包為準；Apps Script 每天自動記的列（來源「自動估算」）可以直接改帳本的台幣金額。
import { loadHoldings, loadDividends, loadUsDividends, loadFx, loadTrades, loadIncome } from "../data.js";
import { upcomingDividends, recentDividends, autoStatusLine, US_KEEP } from "../dividends.js";
import { writeConfig, callLedger } from "../ledger_write.js";
import { el, twd, shortDate, taipeiToday, isNum } from "../fmt.js";
import { card, notice } from "../ui.js";
import { NAMES, NO_DIVIDEND } from "../config.js";

const name = (code) => NAMES[code] || "";
const label = (code) => el("span", {}, el("strong", {}, code), name(code) ? ` ${name(code)}` : "");
const money = (n) => (n == null ? "金額未公布" : String(n));

// 一個標的一列：標的、說明（除息日、每單位、發放日）、估算金額
function upcomingRow(it) {
  const est = (v, extra = "") => (isNum(v) ? el("span", {}, `約 ${twd(v)}`, el("span", { class: "tag" }, "估算"), extra) : el("span", { class: "muted" }, "金額還沒公布"));
  let what;
  let amount;
  if (it.status === "next") {
    what = `${shortDate(it.exDate)} 除息，每單位 ${money(it.perUnit)}${it.perUnit == null ? "" : " 元"}・${it.payDate ? `${shortDate(it.payDate)} 發放` : "發放日還沒公布"}`;
    amount = est(it.estimate);
  } else if (it.status === "est") {
    const last = it.perUnit == null ? "上次金額未公布" : `上次每單位 ${it.perUnit} 元`;
    what = it.overdue ? `推估 ${shortDate(it.exDate)} 前後，還沒公告，${last}` : `約 ${shortDate(it.exDate)} 除息（推估，還沒公告），${last}`;
    amount = est(it.estimate);
  } else if (it.status === "paying") {
    what = `已在 ${shortDate(it.exDate)} 除息，每單位 ${money(it.perUnit)}${it.perUnit == null ? "" : " 元"}・${it.payDate ? `${shortDate(it.payDate)} 發放` : "發放日還沒公布"}`;
    amount = est(it.estimate);
  } else if (it.status === "usLast") {
    what = `上次除息 ${shortDate(it.exDate)}，每股 ${it.perShare == null ? "金額未公布" : `US$${it.perShare}`}（約每季一次）`;
    amount = isNum(it.estimate) ? el("span", {}, `下次約 ${twd(it.estimate)}`, el("span", { class: "tag" }, "估算"))
      : el("span", { class: "muted" }, it.rate == null ? "匯率讀不到，沒算" : "金額還沒公布");
  } else {
    what = "最近沒有除息";
    amount = null;
  }
  return el("div", { class: "kv" }, el("span", { class: "k" }, label(it.code), el("div", { class: "tiny" }, what)), el("span", { class: "v" }, amount));
}

function recentTable(rows) {
  const keep = { style: { whiteSpace: "nowrap" } };
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "入帳日"), el("th", {}, "標的"), el("th", { class: "r" }, "台幣金額"), el("th", {}, "來源"))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      el("td", keep, shortDate(r.date)), el("td", {}, label(r.code)),
      el("td", { class: "r", ...keep }, isNum(r.twd) ? twd(r.twd) : "讀不到金額"),
      el("td", {}, r.estimated ? el("span", { class: "tag" }, "估算") : (r.source || "手動記")))))));
}

export async function dividendCard() {
  const today = taipeiToday();
  const [holdings, tw, us, fxRows, trades, income] = await Promise.all([
    loadHoldings().catch(() => null), loadDividends().catch(() => null), loadUsDividends().catch(() => null),
    loadFx().catch(() => null), loadTrades().catch(() => null), loadIncome().catch(() => null)]);

  const up = holdings ? upcomingDividends({ holdings, tw, us, fxRows, trades, income: income ? income.rows : [], today, noDividend: NO_DIVIDEND }) : null;
  const recent = income && income.configured ? recentDividends(income.rows) : null;

  // 自動記帳狀態：有設定記帳連線才問 Apps Script（ping，不寫入）；不等它，先畫卡片，回來再補這一行
  const status = el("p", { class: "tiny" });
  status.hidden = true;
  if (writeConfig()) {
    callLedger("ping").then((o) => autoStatusLine(o.autoDividends), () => null).then((line) => {
      if (!line) return;
      status.hidden = false;
      status.className = "tiny";
      status.replaceChildren(line.text);
      if (line.error) status.replaceWith(notice("warn", el("strong", {}, "自動記配息有錯誤"), `：${line.error}。${line.text}。`));
    });
  }

  const missing = [];
  if (up && up.twMissing) missing.push("台股配息資料");
  if (up && up.usMissing) missing.push("美股配息資料");

  return card("配息",
    el("h3", {}, "接下來"),
    up === null ? notice("info", "讀不到持倉，沒辦法列出接下來的配息。")
      : up.items.length === 0 ? el("p", { class: "tiny" }, "目前沒有持有標的。")
        : up.items.map(upcomingRow),
    missing.length > 0 && el("p", { class: "tiny" }, `${missing.join("、")}讀不到，那幾檔先不列。`),
    up && up.skipped.length > 0 && el("p", { class: "tiny" }, `${up.skipped.join("、")} 不配息，不列。`),
    el("p", { class: "tiny" }, `台股用除息預告的每單位現金股利 × 持股，還沒公告的用過去的除息間隔推估日期、金額照上次；美股沒有未來的除息日，用上次的每股 × ${US_KEEP} × 最新匯率（扣 30% 預扣稅）。都是估算，實際入帳以錢包為準。`),
    el("h3", {}, "最近入帳"),
    income === null ? notice("info", "讀不到帳本的「其他入帳」分頁。")
      : recent === null ? el("p", { class: "tiny" }, "帳本的「其他入帳」分頁還沒接上。")
        : recent.length === 0 ? el("p", { class: "tiny" }, "還沒有配息紀錄。")
          : [recentTable(recent), recent.some((r) => r.estimated) && el("p", { class: "tiny" }, "標「估算」的是 Apps Script 每天自動記的；跟錢包實收不同可以改帳本的 G 欄（台幣金額），腳本不會蓋掉。")],
    status);
}
