// 新聞：先看今天的重點與旗標，情緒一行，明細卡片依重要性排序（none 收起、Tier 4 另外收起）。
// 新聞內容一律以純文字放進頁面，原文網址只接受 http/https（extLink）。
import { loadNewsView, sentimentParts, firstSentence, TIER_LABEL } from "../news.js";
import { loadFearGreed } from "../data.js";
import { cnnReading, gaugeBlock, pocketBlock } from "../gauge.js";
import { el, taipeiTime, shortDate, taipeiToday, extLink, LEVELS } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";

export async function render(root) {
  root.append(pageHeader("新聞", "新聞晨報整理的事件：先看重點與旗標，明細依重要性排序。"));
  slot(root, view);
}

async function view() {
  const v = await loadNewsView();
  if (!v.rows.length) return notice("info", "新聞分頁還沒有資料。");
  const stale = v.dataDate !== taipeiToday();
  const main = v.events.filter((e) => e.tier !== 4);
  const minor = v.events.filter((e) => e.tier === 4);
  const [sentiment, fg] = await Promise.all([sentimentParts(v), loadFearGreed().catch(() => null)]);
  return [
    el("p", { class: "small muted row" }, `新聞晨報 ${taipeiTime(v.generatedAt)}・資料日 ${shortDate(v.dataDate)}・讀「${v.label}」分頁`,
      stale && el("span", { class: "badge b-warn" }, "⚠ 不是今天的")),
    v.ctx.missing.length > 0 && notice("warn", `讀不到${v.ctx.missing.join("、")}，「持有／在買區」的標示可能不完整。`),
    highlightsCard(v),
    el("section", { class: "card sent-grid" },
      el("div", { class: "fg-pair" },
        fg ? gaugeBlock("CNN 恐懼貪婪（美股）", `更新 ${taipeiTime(fg.time_utc)}`, cnnReading(fg), "沒有分數") : notice("err", "讀不到 CNN 恐懼貪婪"),
        pocketBlock(v.pocket)),
      el("div", { class: "sent-line" }, el("strong", {}, "情緒　"), sentiment.join("・"),
        el("div", { class: "tiny" }, "情緒只當參考，不單獨改變買區判定。"))),
    card(`明細（${main.length} 件，依重要性排序）`,
      el("p", { class: "tiny" }, "旗標不是 none 的會展開；其他點一下看全文、理由與原文。"),
      main.map((e) => evCard(e, v.ctx))),
    minor.length > 0 && el("details", { class: "card more" },
      el("summary", {}, `其他參考（Tier 4 分析、社群、二手整理，${minor.length} 則）`),
      minor.map((e) => evCard(e, v.ctx))),
    v.summaryRow && el("details", { class: "card more" }, el("summary", {}, "新聞晨報的輸入狀態"),
      el("p", { class: "small" }, v.summaryRow.fact)),
  ];
}

function highlightsCard(v) {
  const { by, items } = v.highlights;
  const list = items.length
    ? el("ol", { class: "hl-list" }, items.map((h) => el("li", { class: `hl ${h.flag !== "none" ? "flagged" : ""}` },
      el("div", { class: "ev-tags" }, codeChips(h.codes, v.ctx), h.flag !== "none" && flagBadge(h.flag)),
      el("div", { class: "hl-text" }, h.text),
      h.why && el("div", { class: "tiny" }, by === "routine" ? h.why : `為什麼列入：${h.why}`),
      h.eventId && el("button", { class: "linkish", type: "button", onclick: () => openEvent(h.eventId) }, "看明細"))))
    : el("p", { class: "muted" }, "今天沒有需要特別注意的事件。");
  const flags = v.flagged.length
    ? el("div", { class: "flag-alert", role: "alert" },
      el("strong", {}, `⚠ 有 ${v.flagged.length} 件建議旗標不是 none`),
      v.flagged.map((e) => el("div", {}, codeChips(e.codes, v.ctx), " ", flagBadge(e.flag), " ", firstSentence(e.fact, 50),
        e.reason && el("div", { class: "tiny" }, e.reason))))
    : el("p", { class: "flag-ok" }, "✓ 旗標全部正常（建議旗標都是 none）");
  return card("今天的重點", list, flags,
    by === "site" && el("p", { class: "tiny" }, "晨報還沒有「重點」列，先由網站依規則挑：非 none 旗標 → 持有或在買區、Tier 1～2 且已查證 → 必寫事項（保留一格）。"));
}

function openEvent(id) {
  const d = document.getElementById(`ev-${id}`);
  if (!d) return;
  const group = d.parentElement.closest("details");
  if (group) group.open = true;
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "start" });
}

function codeChips(codes, ctx) {
  return codes.map((c) => {
    const held = ctx.held.has(c);
    const z = ctx.zone.get(c);
    return el("span", { class: `code ${held || z ? "mine" : ""}` }, c,
      held && el("small", {}, "持有"), z && el("small", {}, LEVELS[z.level]?.label || z.status));
  });
}

const flagBadge = (f) => el("span", { class: `badge ${f === "block" ? "b-crit" : "b-ok"}` }, f === "block" ? "⛔ block" : `▲ ${f}`);

function verifyBadge(v) {
  if (v === "已查證") return el("span", { class: "tag" }, "已查證");
  if (v === "僅標題" || v === "無法查證") return el("span", { class: "badge b-warn" }, `⚠ ${v}`);
  return null;
}

const IMPACT = { 偏多: "up", 偏空: "down" };

function evCard(e, ctx) {
  const flagged = e.flag !== "none";
  return el("details", { class: `ev ${flagged ? "flagged" : ""}`, id: e.eventId ? `ev-${e.eventId}` : null, open: flagged },
    el("summary", {},
      el("div", { class: "ev-tags" },
        codeChips(e.codes.length ? e.codes : e.symbols, ctx),
        flagged && flagBadge(e.flag),
        verifyBadge(e.verify),
        e.tier && el("span", { class: "tag" }, `Tier ${e.tier} ${TIER_LABEL[e.tier] || ""}`)),
      el("div", { class: "ev-title" }, firstSentence(e.fact))),
    el("div", { class: "ev-body" },
      el("p", {}, e.fact),
      e.reason && el("p", { class: "small muted" }, `理由：${e.reason}`),
      el("div", { class: "ev-tags" },
        e.impact && el("span", { class: `tag ${IMPACT[e.impact] || ""}` }, e.impact),
        e.category && el("span", { class: "tag" }, e.category),
        e.eventTime && el("span", { class: "tag" }, e.eventTime),
        e.source && el("span", { class: "tag" }, e.source)),
      e.related.length > 0 && el("p", { class: "tiny" }, `其他相關：${e.related.join("、")}`),
      e.url && el("p", { class: "small" }, extLink(e.url, "原文 ↗"))));
}
