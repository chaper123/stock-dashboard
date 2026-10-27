// 報告歷史：依日期與市場列出晨報全文。Markdown 用 marked 轉換，結果一律經 DOMPurify 過濾後才放進頁面。
import { loadArchive, oneLiner } from "../data.js";
import { el, taipeiTime, shortDate } from "../fmt.js";
import { slot, pageHeader, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";

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
  root.append(pageHeader("報告歷史", "兩個晨報每次執行的報告全文（排程寫進儀表板試算表的「報告存檔」）。"));
  const filter = ["us", "tw"].includes(arg) ? arg : "all";
  root.append(el("div", { class: "chips", role: "group", "aria-label": "市場" },
    [["all", "全部"], ["tw", "台股"], ["us", "美股"]].map(([k, label]) =>
      el("a", { class: "chip", href: `#/reports/${k === "all" ? "" : k}`, role: "button", "aria-pressed": String(k === filter) }, label))));
  slot(root, () => list(filter));
}

async function list(filter) {
  const rows = (await loadArchive()).filter((r) => r.report && (filter === "all" || r.market === filter)).reverse();
  if (!rows.length) return notice("info", "還沒有報告。");
  const out = [];
  let lastDay = null;
  rows.forEach((r, i) => {
    const day = r.generatedAt.slice(0, 10);
    if (day !== lastDay) {
      out.push(el("h2", { class: "date-head" }, `${day.replace(/-/g, "/")}`));
      lastDay = day;
    }
    const body = el("div", { class: "md" });
    const item = el("details", { class: "report-item" },
      el("summary", {},
        el("div", { class: "spread" },
          el("span", { class: "t" }, `${MARKET_LABEL[r.market] || r.market}晨報`),
          el("span", { class: "tiny" }, `產生 ${taipeiTime(r.generatedAt)}・資料日 ${shortDate(r.dataDate)}`)),
        el("div", { class: "p" }, oneLiner(r.report) || "（點開看全文）")),
      body);
    // 點開才轉換，第一篇預設打開
    const fill = () => {
      if (!body.childNodes.length) body.append(...[renderMarkdown(r.report)].flat());
    };
    item.addEventListener("toggle", () => item.open && fill());
    if (i === 0) {
      item.open = true;
      fill();
    }
    out.push(item);
  });
  return out;
}
