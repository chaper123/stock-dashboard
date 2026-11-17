// 資產（docs/ASSETS_PAGE.md）：現金與投入（原資金頁最上面那張卡）、資產變化（資產走勢、累計與每日損益、報酬率對比較標的、
// 個股表現、報酬日曆）。實際紀錄，不是試算；試算在「試算」頁。數字都在瀏覽器用帳本與 market-data 算。
import { loadSettings, loadTrades, loadDca } from "../data.js";
import { cashTable, nextDeposit, depositNote } from "../cash.js";
import { loadPerformance } from "../perf.js";
import { PERIODS, periodStart, daysFrom } from "../assets.js";
import { el, twd, int, isNum, taipeiToday } from "../fmt.js";
import { slot, card, pageHeader, kv, notice } from "../ui.js";
import { NAMES } from "../config.js";
import { trendCard, pnlCard, compareCard } from "./assets_charts.js";
import { stocksCard } from "./assets_tables.js";

export async function render(root, { alive }) {
  root.append(pageHeader("資產", "帳本裡現金的來去，以及實際的資產變化（走勢、損益）。這一頁是實際紀錄；試算（撲滿、20 年後、財富自由）在「試算」頁。"));
  slot(root, cashCard);
  root.append(el("h2", { class: "date-head" }, "資產變化"));
  // 一整塊資產變化共用一排期間選擇：換期間時，各卡登記的函式會被呼叫（重新設定資料與可見範圍）
  const subs = [];
  const ctx = { period: "all", alive, onChange: (fn) => subs.push(fn), set(k) { ctx.period = k; for (const f of subs) f(); } };
  slot(root, () => periodBar(ctx));
  slot(root, () => trendCard(ctx));
  slot(root, () => pnlCard(ctx));
  slot(root, () => compareCard(ctx));
  slot(root, () => stocksCard(ctx));
}

// 期間選擇：一週、一月、一季、年初至今、一年、全部（預設全部）。起點比第一筆買進早就從第一筆買進開始
async function periodBar(ctx) {
  const perf = await loadPerformance();
  const text = el("span", { class: "tiny" });
  const range = () => {
    const base = daysFrom(perf.days, periodStart(ctx.period, perf.first, perf.last))[0]?.date;
    text.textContent = base ? `期間：${base.replaceAll("-", "/")}～${perf.last.replaceAll("-", "/")}（從期間第一個交易日的收盤算起）` : "";
  };
  const chips = el("div", { class: "chips", role: "group", "aria-label": "資產變化的期間", style: { margin: "0 0 4px" } });
  for (const [k, label] of PERIODS) {
    const b = el("button", { class: "chip", type: "button", "aria-pressed": String(k === ctx.period) }, label);
    b.addEventListener("click", () => {
      for (const x of chips.children) x.setAttribute("aria-pressed", String(x === b));
      ctx.set(k);
      range();
    });
    chips.append(b);
  }
  range();
  return el("section", { class: "card" }, chips, text);
}

// ── 現金與投入（R18）──
// 期初＋入金−買進＋賣出＝期末，再跟帳本的可用資金對一次。數字都來自帳本「設定」與「交易紀錄」，算法在 cash.js
const NOT_IN_LEDGER = "帳本沒有這一列";
const slashDate = (d) => d.replaceAll("-", "/");
const cashVal = (v, none = NOT_IN_LEDGER) => (isNum(v) ? twd(v) : el("span", { class: "muted" }, none));
const UNREADABLE = "有幾筆讀不到金額"; // 買進、賣出合計：交易紀錄有列，但金額欄讀不到
const cashText = (v, none = NOT_IN_LEDGER) => (isNum(v) ? twd(v) : none);
// 差額不到 1 元時多寫小數，免得「差 NT$0」其實不是 0
const diffText = (v) => (Math.abs(v) >= 1 ? twd(Math.abs(v)) : `NT$${Math.abs(v).toFixed(2)}`);

// 逐筆明細（買進或賣出）：日期、標的、金額；讀不到金額的列照實寫
function legTable(rows, total) {
  const code = (r) => `${r.code} ${NAMES[r.code] || ""}`.trim();
  const keep = { style: { whiteSpace: "nowrap" } }; // 日期與金額不換行；標的名稱可以換行，手機上才看得到金額
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "日期"), el("th", {}, "標的"), el("th", { class: "r" }, "金額"))),
    el("tbody", {}, rows.map((r) => el("tr", {}, el("td", keep, r.date), el("td", {}, code(r)),
      el("td", { class: "r", ...keep }, isNum(r.amount) ? int(r.amount) : "讀不到金額")))),
    el("tfoot", {}, el("tr", {}, el("th", {}, "合計"), el("th", {}), el("th", { class: "r" }, isNum(total) ? int(total) : "—")))));
}

async function cashCard() {
  const [settings, trades, dca] = await Promise.all([loadSettings(), loadTrades(), loadDca().catch(() => null)]);
  const c = cashTable({ settings, trades });
  const next = nextDeposit(taipeiToday(), dca);

  // 入金的說明：累計剛好等於「月數 × 每月入金」才寫成乘法，定投金額中途改過就不硬湊
  const inNote = c.depositMonths == null ? `已入金月數：${NOT_IN_LEDGER}`
    : c.depositsByMonths ? `已入金 ${int(c.depositMonths)} 個月 × 每月 ${twd(c.monthly)}`
      : `已入金 ${int(c.depositMonths)} 個月，各月金額照「定投金額」分頁加總`;

  const leg = (label, rows, total, hint) => rows.length > 0 && [
    kv(`${label}（${rows.length} 筆）`, cashVal(total, UNREADABLE)),
    el("details", { class: "more" }, el("summary", {}, `看逐筆（${rows.length} 筆）`), legTable(rows, total), hint)];

  // 對帳：差額不是 0 就標出來；其中一邊讀不到就說沒辦法對，不當成對得起來
  const dir = (d) => (d > 0 ? "多" : "少");
  const poolCheck = c.poolDiff == null
    ? notice("info", c.closing == null ? "期末算不出來，所以沒辦法跟帳本的可用資金對帳。" : `可用資金：${NOT_IN_LEDGER}，沒辦法對帳。`)
    : c.poolDiff === 0 ? kv("可用資金對帳", "對得起來")
      : notice("warn", el("strong", {}, `對不上，差 ${diffText(c.poolDiff)}`),
        `：算出來的期末比帳本的可用資金${dir(c.poolDiff)}。交易紀錄、入金或基準日資金其中有一邊跟帳本不同，請到帳本核對；網站只讀不改帳本。`);
  const buysCheck = c.buysDiff == null
    ? notice("info", c.buys == null ? "買進合計算不出來，所以沒辦法跟帳本的「基準日後買入合計」對。" : `「基準日後買入合計」：${NOT_IN_LEDGER}，沒辦法對。`)
    : c.buysDiff === 0 ? [kv("買進合計對帳", "對得起來"), el("div", { class: "tiny" }, `對的是帳本「基準日後買入合計」${twd(c.ledgerBuys)}`)]
      : notice("warn", el("strong", {}, `買進合計對不上，差 ${diffText(c.buysDiff)}`),
        `：交易紀錄加起來 ${twd(c.buys)}，帳本「基準日後買入合計」是 ${twd(c.ledgerBuys)}。`);
  // 賣出合計也對一次；兩邊都沒有賣出（交易紀錄沒有賣出、帳本是 0 或沒有這一列）時不多顯示任何東西
  const sellsCheck = c.sellRows.length === 0 && !c.ledgerSells ? null
    : c.sellsDiff == null
      ? notice("info", c.sells == null ? "賣出合計算不出來，所以沒辦法跟帳本的「基準日後賣出回收」對。" : `「基準日後賣出回收」：${NOT_IN_LEDGER}，沒辦法對。`)
      : c.sellsDiff === 0 ? [kv("賣出合計對帳", "對得起來"), el("div", { class: "tiny" }, `對的是帳本「基準日後賣出回收」${twd(c.ledgerSells)}`)]
        : notice("warn", el("strong", {}, `賣出合計對不上，差 ${diffText(c.sellsDiff)}`),
          `：交易紀錄加起來 ${twd(c.sells)}，帳本「基準日後賣出回收」是 ${twd(c.ledgerSells)}。`);

  return card("現金與投入",
    kv("基準日", c.basis ? slashDate(c.basis) : cashVal(null)),
    kv("期初（基準日手上還沒投入的錢）", cashVal(c.opening, "算不出來（缺項見下一行）")),
    el("div", { class: "tiny" }, `基準日未投入資金 ${cashText(c.basisFund)} ＋ 記帳前錢包零頭 ${cashText(c.pocket)}`),
    kv("入金（推算）", cashVal(c.deposits)),
    el("div", { class: "tiny" }, `${inNote}；照「定投金額」分頁推算，不是逐筆確認。`),
    leg("買進", c.buyRows, c.buys, el("p", { class: "tiny" }, "只列「計入資金池」的買進；網站沖銷的一對（原列與沖銷列）已拿掉。金額含手續費。")),
    c.buyRows.length === 0 && kv("買進", cashVal(c.buys, UNREADABLE)),
    leg("賣出", c.sellRows, c.sells),
    kv("算出來的期末", cashVal(c.closing, "先不算")),
    el("div", { class: "tiny" }, `期初 ${cashText(c.opening, "算不出來")} ＋ 入金 ${cashText(c.deposits)} − 買進 ${cashText(c.buys, UNREADABLE)} ＋ 賣出 ${cashText(c.sells, UNREADABLE)}`),
    c.closing == null && notice("warn", el("strong", {}, "期末先不算"),
      `：缺 ${c.missing.join("、")}。讀不到的項目不補 0，帳本補上後會自動算出來。`),
    kv("帳本的可用資金", cashVal(c.ledgerPool)),
    poolCheck,
    buysCheck,
    sellsCheck,
    kv("下一次入金", `${slashDate(next.date)}・${twd(next.amount)}${depositNote(next)}`),
    el("ul", { class: "notes" },
      el("li", { class: "tiny" }, "入金是照「定投金額」分頁逐月推算，不是逐筆確認錢真的入帳。"),
      el("li", { class: "tiny" }, "股利與費用帳本沒有流水；手續費已含在交割金額裡。"),
      el("li", { class: "tiny" }, "券商帳戶的實際餘額不在帳本裡；帳本的可用資金是理論值，不等於券商的交割餘額。")));
}

