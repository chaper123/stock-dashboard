// 報告歷史：依日期與市場列出晨報全文。Markdown 用 marked 轉換，結果一律經 DOMPurify 過濾後才放進頁面。
// 兩個買點晨報已在 2026-11-03 正式停用，這裡只當歷史紀錄保留查詢（舊報告內容不改寫）。
import { loadArchive, oneLiner } from "../data.js";
import { el, taipeiTime, shortDate } from "../fmt.js";
import { slot, pageHeader, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";

// 停用紀錄（docs/PROGRESS.md「下一步」第 8、10 項、docs/PIVOT.md 第 1、7 節）：
// - 2026-10-29 回測：買區規則與每月定期定額幾乎一樣（台股每年 −0.02、SPY +0.02 個百分點），加 KD 止跌確認更差
// - 2026-10-30 使用者決定轉型：每月定投、台股 009816 80%／00981A 20%，4、10 月檢查；買點晨報的額度移給新聞晨報
// - 2026-11-03 09:20、10:17 兩次執行一開始就被帳號的 7 天用量上限拒絕（claude.ai 排程執行紀錄），沒有報告
// - 2026-11-03 17:38～17:41 新聞晨報 v3 切換正式排程時，美股 v2.1、台股 v2.1 兩個排程用 API 停用
const RETIRED = { date: "2026-11-03" };
// 晨報版本：存檔從 v2 開始（v1 沒有寫存檔）；2026-10-29 起是 v2.1（改讀新聞分頁，買區規則不變）
const routineVer = (r) => (r.generatedAt.slice(0, 10) >= "2026-10-29" ? "v2.1" : "v2");
const ruleVer = (r) => /engine-(v[\d.]+)/.exec(r.engine || "")?.[1] || "版本不明";
const strategyText = (r) => `買區監測規則 ${ruleVer(r)}・晨報 ${routineVer(r)}`;

let hooked = false;
function purifier() {
  const P = window.DOMPurify;
  if (!P?.sanitize) return null;
  if (!hooked) {
    // 連結一律開新分頁，且不帶來源
    P.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A" && node.getAttribute("href")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return P;
}

// 回傳已過濾的 DocumentFragment；函式庫沒載入時退回純文字
export function renderMarkdown(md) {
  const P = purifier();
  const M = window.marked;
  if (!P || !M?.parse) {
    return [notice("warn", "Markdown／過濾函式庫沒有載入（可能離線），以純文字顯示。"), el("pre", { class: "md-plain" }, md)];
  }
  const html = M.parse(md, { gfm: true, breaks: true, async: false });
  // 報告沒有圖片；外部圖片會在打開時連到別的網站，所以連同表單元素一起擋掉
  const frag = P.sanitize(html, {
    USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["img", "picture", "video", "audio", "source", "style", "form", "input", "button", "textarea", "select"],
  });
  for (const t of frag.querySelectorAll("table")) {
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    t.replaceWith(wrap);
    wrap.append(t);
    // 報告常在表格下一行直接寫說明（沒有空行），GFM 會把它當成只有第一格的列；搬回表格後面當段落
    const rows = [...t.querySelectorAll("tbody tr")];
    const notes = [];
    while (rows.length > 1) {
      const cells = [...rows.at(-1).cells];
      if (cells.length < 2 || cells.slice(1).some((c) => c.textContent.trim())) break;
      notes.unshift(rows.pop());
    }
    let anchor = wrap;
    for (const r of notes) {
      const p = document.createElement("p");
      p.append(...r.cells[0].childNodes);
      r.remove();
      anchor.after(p);
      anchor = p;
    }
  }
  return frag;
}

export async function render(root, { arg }) {
  root.append(pageHeader("報告歷史", "轉型前兩個買點晨報（美股、台股）的報告全文，保留查詢用。這兩種報告已經停止產生，內容不代表現行計畫。"));
  slot(root, status);
  const filter = ["us", "tw"].includes(arg) ? arg : "all";
  root.append(el("div", { class: "chips", role: "group", "aria-label": "市場" },
    [["all", "全部"], ["tw", "台股"], ["us", "美股"]].map(([k, label]) =>
      el("a", { class: "chip", href: `#/reports/${k === "all" ? "" : k}`, role: "button", "aria-pressed": String(k === filter) }, label))));
  slot(root, () => list(filter));
}

// 置頂說明：這類報告還有沒有在產生、最後一份是哪天、為什麼停止。停用的事實寫死；最後一份從存檔算
async function status() {
  const rows = await loadArchive().then((a) => a.filter((r) => r.report), () => null);
  const lastOf = (m) => rows?.filter((r) => r.market === m).at(-1);
  const lastText = (m) => {
    const r = lastOf(m);
    return r ? `${MARKET_LABEL[m]} ${taipeiTime(r.generatedAt, true)}（資料日 ${shortDate(r.dataDate)}）` : `${MARKET_LABEL[m]} 沒有`;
  };
  const after = rows?.filter((r) => r.generatedAt.slice(0, 10) > RETIRED.date) || [];
  return notice("warn",
    el("strong", {}, "這兩種晨報已經停止產生"),
    el("p", {}, "美股晨報、台股晨報（買點監測）在 2026-11-03 下午正式停用。這是計畫改變，不是排程故障，之後不會再有新的報告。"),
    el("ul", { class: "notes" },
      el("li", {}, "最後一份：", rows ? `${lastText("us")}、${lastText("tw")}。` : "這次讀不到存檔，無法顯示日期（停用日期不受影響）。"),
      el("li", {}, "為什麼停：2026-10-29 用 2008 年起的歷史資料回測，原本「等股價跌到買區才買」的規則，結果跟每月固定投入幾乎一樣（每年只差約 0.02 個百分點），加上止跌確認的版本反而更差。所以 10/30 改成現行計畫：每月定期投入，台股 009816 佔 80%、00981A 佔 20%，每年 4 月、10 月檢查比例；原本這兩個晨報用的額度改給新聞晨報。"),
      el("li", {}, "11/03 為什麼沒有報告：那天早上兩個排程還沒停用，但帳號當週的用量額度已經用完，兩次執行一開始就被拒絕，所以沒有產生；同一天下午正式停用。"),
      el("li", {}, "現在每天還在產生的：新聞晨報（平日 08:40 晨間、11:30 午間），內容在",
        el("a", { href: "#/news" }, "新聞"), "頁和", el("a", { href: "#/overview" }, "總覽"), "；這個月該投入多少，看總覽的「本月紀律」。"),
      el("li", {}, "下面的舊報告是舊策略的歷史紀錄：裡面的第一買區、第二買區、深度買區和「規則參考金額」是當時的規則算的，不是今天要做的事。")),
    after.length > 0 && el("p", {}, el("strong", {}, `注意：停用日之後還有 ${after.length} 份新報告`),
      `（最新 ${taipeiTime(after.at(-1).generatedAt, true)}），跟停用紀錄不一致，可能有排程被重新啟用。`));
}

async function list(filter) {
  const rows = (await loadArchive()).filter((r) => r.report && (filter === "all" || r.market === filter)).reverse();
  if (!rows.length) return notice("info", "沒有報告。");
  const out = [];
  let lastDay = null;
  for (const r of rows) {
    const day = r.generatedAt.slice(0, 10);
    if (day !== lastDay) {
      out.push(el("h2", { class: "date-head" }, `${day.replace(/-/g, "/")}`));
      lastDay = day;
    }
    const body = el("div", { class: "md" });
    const line = oneLiner(r.report);
    const item = el("details", { class: "report-item" },
      el("summary", {},
        el("div", { class: "spread" },
          el("span", { class: "t" }, `${MARKET_LABEL[r.market] || r.market}晨報`),
          el("span", { class: "tiny" }, `產生 ${taipeiTime(r.generatedAt)}・資料日 ${shortDate(r.dataDate)}`)),
        el("div", {}, el("span", { class: "badge b-warn" }, "舊策略的歷史紀錄，不代表現行計畫"), " ",
          el("span", { class: "tag" }, strategyText(r))),
        el("div", { class: "p" }, line ? `當時的一句話：${line}` : "（點開看全文）")),
      body);
    // 一律收合，點開才轉換；全文上面再提醒一次
    const fill = () => {
      if (body.childNodes.length) return;
      body.append(notice("warn", `這是 2026-10-30 轉型前的舊策略報告（${strategyText(r)}）。裡面的買區、狀態與金額是當時的規則算的，不代表現行計畫，也不是今天要做的事。`),
        ...[renderMarkdown(r.report)].flat());
    };
    item.addEventListener("toggle", () => item.open && fill());
    out.push(item);
  }
  return out;
}
