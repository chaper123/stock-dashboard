// 新聞：今天的重點（含旗標）→ 依標的篩選 → 分區（持股相關、產業與供應鏈、總經與政策、地緣、市場話題、情緒）。
// 每則一行，點開看事實、來源等級、查證狀態與原文（PIVOT 第 4 節）。
// 新聞內容一律以純文字放進頁面，原文網址只接受 http/https（extLink）。
import { loadNewsView, sentimentParts, firstSentence, TIER_LABEL, SECTIONS, sectionOf } from "../news.js";
import { loadFearGreed } from "../data.js";
import { cnnReading, gaugeBlock, pocketBlock } from "../gauge.js";
import { el, taipeiTime, shortDate, taipeiToday, extLink } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { DROPPED } from "../config.js";

export async function render(root, { arg }) {
  root.append(pageHeader("新聞", "新聞晨報整理的事件：先看重點，再依分區或標的看；每則點開看事實、來源與原文。"));
  slot(root, () => view(arg));
}

async function view(arg) {
  const v = await loadNewsView();
  if (!v.rows.length) return notice("info", "新聞分頁還沒有資料。");
  const stale = v.dataDate !== taipeiToday();
  const [sentiment, fg] = await Promise.all([sentimentParts(v), loadFearGreed().catch(() => null)]);

  // 標的篩選：持有的排前面
  const all = [...new Set(v.events.flatMap((e) => e.codes))].filter((c) => !DROPPED.has(c));
  const codes = [...all.filter((c) => v.ctx.held.has(c)), ...all.filter((c) => !v.ctx.held.has(c)).sort()];
  const filter = codes.includes(arg) ? arg : null;
  const list = filter ? v.events.filter((e) => e.codes.includes(filter) || e.related.includes(filter)) : v.events;

  const sections = SECTIONS.map((name) => {
    const inSec = list.filter((e) => sectionOf(e) === name);
    // 晨報為每個沒消息的標的寫一列「無重大消息」，併成一行
    const quiet = inSec.filter((e) => /^無重大消息/.test(e.fact || ""));
    const items = inSec.filter((e) => !quiet.includes(e));
    const empty = name === "市場話題" ? "還沒有話題（新聞晨報 v3 與話題統計上線後顯示）。" : "沒有。";
    return card(`${name}（${items.length}）`,
      items.length ? items.map((e) => evLine(e, v.ctx)) : el("p", { class: "small muted" }, empty),
      quiet.length > 0 && el("p", { class: "tiny" }, `無重大消息：${quiet.flatMap((e) => e.codes.length ? e.codes : e.symbols).join("、")}`));
  });

  return [
    el("p", { class: "small muted row" }, `新聞晨報 ${taipeiTime(v.generatedAt)}・資料日 ${shortDate(v.dataDate)}・讀「${v.label}」分頁`,
      stale && el("span", { class: "badge b-warn" }, "⚠ 不是今天的")),
    v.ctx.missing.length > 0 && notice("warn", `讀不到${v.ctx.missing.join("、")}，「持有」的標示可能不完整。`),
    highlightsCard(v),
    el("div", { class: "card" },
      el("div", { class: "tiny", style: { marginBottom: "6px" } }, "依標的篩選"),
      el("div", { class: "chips", style: { margin: 0 } }, [["", "全部"], ...codes.map((c) => [c, c])].map(([c, label]) =>
        el("a", { class: "chip", href: `#/news/${c}`, role: "button", "aria-pressed": String((filter || "") === c) }, label)))),
    ...sections,
    card("情緒",
      el("div", { class: "sent-grid" },
        el("div", { class: "fg-pair" },
          fg ? gaugeBlock("CNN 恐懼貪婪（美股）", `更新 ${taipeiTime(fg.time_utc)}`, cnnReading(fg), "沒有分數") : notice("err", "讀不到 CNN 恐懼貪婪"),
          pocketBlock(v.pocket)),
        el("div", { class: "sent-line" }, sentiment.join("・"),
          el("div", { class: "tiny" }, "情緒只當參考。")))),
    v.summaryRow && el("details", { class: "card more" }, el("summary", {}, "新聞晨報的輸入狀態"),
      el("p", { class: "small" }, v.summaryRow.fact)),
  ];
}

// 今天的重點與旗標（總覽也用）
export function highlightsCard(v, { title = "今天的重點", link = false } = {}) {
  const { by, items } = v.highlights;
  const list = items.length
    ? el("ol", { class: "hl-list" }, items.map((h) => el("li", { class: `hl ${h.flag !== "none" ? "flagged" : ""}` },
      el("div", { class: "ev-tags" }, codeChips(h.codes, v.ctx), h.flag !== "none" && flagBadge(h.flag)),
      el("div", { class: "hl-text" }, h.text),
      h.why && el("div", { class: "tiny" }, by === "routine" ? h.why : `為什麼列入：${h.why}`),
      !link && h.eventId && el("button", { class: "linkish", type: "button", onclick: () => openEvent(h.eventId) }, "看明細"))))
    : el("p", { class: "muted" }, "今天沒有需要特別注意的事件。");
  const flags = v.flagged.length
    ? el("div", { class: "flag-alert", role: "alert" },
      el("strong", {}, `⚠ 有 ${v.flagged.length} 件建議旗標不是 none`),
      v.flagged.map((e) => el("div", {}, codeChips(e.codes, v.ctx), " ", flagBadge(e.flag), " ", firstSentence(e.fact, 50),
        e.reason && el("div", { class: "tiny" }, e.reason))))
    : el("p", { class: "flag-ok" }, "✓ 旗標全部正常（建議旗標都是 none）");
  return card(title, list, flags,
    by === "site" && el("p", { class: "tiny" }, "晨報還沒有「重點」列，先由網站依規則挑：非 none 旗標 → 持有標的、Tier 1～2 且已查證 → 必寫事項（保留一格）。"),
    link && el("p", { class: "small" }, el("a", { href: "#/news" }, `看全部新聞（${v.events.length} 件）→`)));
}

function openEvent(id) {
  const d = document.getElementById(`ev-${id}`);
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "center" });
}

function codeChips(codes, ctx) {
  return codes.map((c) => el("span", { class: `code ${ctx.held.has(c) ? "mine" : ""}` }, c, ctx.held.has(c) && el("small", {}, "持有")));
}

const flagBadge = (f) => el("span", { class: `badge ${f === "block" ? "b-crit" : "b-ok"}` }, f === "block" ? "⛔ block" : `▲ ${f}`);

function verifyBadge(v) {
  if (v === "已查證") return el("span", { class: "tag" }, "已查證");
  if (v === "僅標題" || v === "無法查證") return el("span", { class: "badge b-warn" }, `⚠ ${v}`);
  return null;
}

const IMPACT = { 偏多: "up", 偏空: "down" };

// 一則一行：代號＋一句話（＋旗標、未查證警示）；點開看事實、標籤、理由、原文
function evLine(e, ctx) {
  const flagged = e.flag !== "none";
  const weak = e.verify === "僅標題" || e.verify === "無法查證";
  const codes = e.codes.length ? e.codes : e.symbols;
  return el("details", { class: `ev1 ${flagged ? "flagged" : ""} ${e.tier === 4 ? "minor" : ""}`, id: e.eventId ? `ev-${e.eventId}` : null, open: flagged },
    el("summary", {},
      // 一行只放一個代號（持有的用底色標），其他用 +N，標題才有空間
      el("span", { class: "codes" }, codes[0] && el("span", { class: `code ${ctx.held.has(codes[0]) ? "mine" : ""}` }, codes[0]),
        codes.length > 1 && el("small", { class: "muted" }, `+${codes.length - 1}`)),
      el("span", { class: "t" }, firstSentence(e.fact)),
      flagged && flagBadge(e.flag),
      weak && el("span", { class: "warn-mark", title: e.verify, "aria-label": e.verify }, "⚠")),
    el("div", { class: "body" },
      codes.length > 1 && el("div", { class: "ev-tags" }, codeChips(codes, ctx)),
      el("p", {}, e.fact),
      el("div", { class: "ev-tags" },
        e.tier && el("span", { class: "tag" }, `Tier ${e.tier} ${TIER_LABEL[e.tier] || ""}`),
        verifyBadge(e.verify),
        e.impact && el("span", { class: `tag ${IMPACT[e.impact] || ""}` }, e.impact),
        e.category && el("span", { class: "tag" }, e.category),
        e.eventTime && el("span", { class: "tag" }, e.eventTime),
        e.source && el("span", { class: "tag" }, e.source)),
      e.reason && el("p", { class: "small muted" }, `理由：${e.reason}`),
      e.related.length > 0 && el("p", { class: "tiny" }, `其他相關：${e.related.join("、")}`),
      e.url && el("p", { class: "small" }, extLink(e.url, "原文 ↗"))));
}
