// 新聞整理：把新聞分頁（一件事件影響幾個標的就有幾列）合併成事件、依重要性排序、挑出「今天的重點」。
// 新聞頁與決策鏈共用。內容一律以純文字放進頁面（呼叫端用 el()），網址只接受 http/https。
import { loadNews, loadArchive, latestRun, loadHoldings, loadFearGreed, loadVix } from "./data.js";
import { LEVELS, isNum, shortDate } from "./fmt.js";

export const TIER_LABEL = { 1: "官方", 2: "主要媒體", 3: "第一手發言", 4: "其他" };
const NOT_CODES = new Set(["總經", "市場", "全部", ""]);
const CROWD = ["2330", "009816", "00981A", "00411A"];
const HIDE_IN_CARDS = new Set(["摘要", "重點", "情緒"]);

const splitCodes = (s) => (s || "").split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);

// 持有（帳本持倉）與在買區（最新晨報）的代號；讀不到就當成空的
async function loadContext() {
  const [h, a] = await Promise.allSettled([loadHoldings(), loadArchive()]);
  const held = new Set(h.status === "fulfilled" ? h.value.map((x) => x.code) : []);
  const zone = new Map();
  if (a.status === "fulfilled") {
    for (const m of ["tw", "us"]) {
      const run = latestRun(a.value, m);
      for (const t of run?.json.tickers || []) if (LEVELS[t.level]?.inZone && t.role === "buy") zone.set(t.code, t);
    }
  }
  const missing = [h.status === "rejected" && "帳本持倉", a.status === "rejected" && "晨報存檔"].filter(Boolean);
  return { held, zone, missing };
}

function groupEvents(rows, ctx) {
  const map = new Map();
  for (const r of rows) {
    const key = r.eventId || `${r.symbol}|${r.fact}`;
    if (!map.has(key)) map.set(key, { ...r, symbols: [], related: new Set(), flags: new Set(), tiers: [] });
    const e = map.get(key);
    for (const c of splitCodes(r.symbol)) if (!e.symbols.includes(c)) e.symbols.push(c);
    for (const c of splitCodes(r.related)) e.related.add(c);
    e.flags.add(r.flag || "none");
    if (isNum(r.tier)) e.tiers.push(r.tier);
  }
  return [...map.values()].map((e) => {
    const flag = [...e.flags].find((f) => f !== "none") || "none";
    const tier = e.tiers.length ? Math.min(...e.tiers) : null;
    const codes = e.symbols.filter((c) => !NOT_CODES.has(c));
    const relevant = codes.filter((c) => ctx.held.has(c) || ctx.zone.has(c));
    const related = [...e.related].filter((c) => !e.symbols.includes(c));
    const ev = { ...e, flag, tier, codes, relevant, related, mustWrite: /必寫/.test(e.reason || "") };
    ev.score = score(ev);
    return ev;
  }).sort((a, b) => b.score - a.score || (b.eventTime || "").localeCompare(a.eventTime || ""));
}

// 重要性：非 none 旗標 ＞ 影響持有或在買區 ＞ 必寫事項 ＞ 等級 ＞ 查證狀態
function score(e) {
  let s = 0;
  if (e.flag !== "none") s += 1000;
  if (e.relevant.length) s += 100 + 5 * Math.min(e.relevant.length, 3);
  if (e.mustWrite) s += 60;
  s += { 1: 40, 2: 30, 3: 20, 4: 0 }[e.tier] ?? 0;
  s += e.verify === "已查證" ? 15 : e.verify === "僅標題" ? 0 : -10;
  return s;
}

// 一句話：取到第一個句號、第一個分號；還是太長就切在 25 字以後的第一個逗號
export function firstSentence(text, max = 70) {
  let s = (text || "").split("。")[0].trim();
  const semi = s.indexOf("；");
  if (semi >= 15) s = s.slice(0, semi);
  if (s.length <= 45) return s;
  const comma = s.indexOf("，", 25);
  if (comma > 0 && comma <= max) return s.slice(0, comma);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function whyPicked(e, ctx) {
  const bits = [];
  if (e.flag !== "none") bits.push(`旗標 ${e.flag}`);
  if (e.relevant.some((c) => ctx.held.has(c))) bits.push("持有");
  if (e.relevant.some((c) => ctx.zone.has(c))) bits.push("在買區");
  if (e.mustWrite) bits.push("必寫事項");
  if (e.tier) bits.push(`Tier ${e.tier} ${TIER_LABEL[e.tier] || ""}`.trim());
  if (e.verify) bits.push(e.verify);
  return bits.join("・");
}

// 今天的重點：晨報有「重點」列就用；沒有就依網站規則挑最多 3 則
function pickHighlights(rows, events, ctx) {
  const own = rows.filter((r) => r.category === "重點");
  if (own.length) {
    const seen = new Map();
    for (const r of own) {
      const key = `${r.eventId}|${r.fact}`;
      if (!seen.has(key)) seen.set(key, { codes: [], text: r.fact, why: r.reason, eventId: r.eventId, flag: r.flag || "none" });
      for (const c of splitCodes(r.symbol)) if (!seen.get(key).codes.includes(c)) seen.get(key).codes.push(c);
    }
    return { by: "routine", items: [...seen.values()].slice(0, 3) };
  }
  const main = events.filter((e) => e.tier !== 4);
  const b1 = main.filter((e) => e.flag !== "none");
  const b2 = main.filter((e) => e.flag === "none" && e.relevant.length && e.tier && e.tier <= 2 && e.verify === "已查證")
    .sort((a, b) => a.tier - b.tier || b.relevant.length - a.relevant.length || (b.eventTime || "").localeCompare(a.eventTime || ""));
  const b3 = main.filter((e) => e.flag === "none" && e.mustWrite)
    .sort((a, b) => b.relevant.length - a.relevant.length || (a.market === "macro" ? -1 : 0) - (b.market === "macro" ? -1 : 0) || (a.tier ?? 9) - (b.tier ?? 9));
  const picked = [];
  const covered = new Set();
  const take = (e) => {
    if (picked.length >= 3 || picked.includes(e)) return;
    picked.push(e);
    e.relevant.forEach((c) => covered.add(c));
  };
  b1.forEach(take);
  // 留一格給必寫事項；持有／買區的先挑涵蓋不同代號的，剩下的格子最後再補
  const reserve = b3.some((e) => !picked.includes(e)) ? 1 : 0;
  for (const e of b2) {
    if (picked.length >= 3 - reserve) break;
    if (e.relevant.some((c) => !covered.has(c))) take(e);
  }
  b3.forEach(take);
  b2.forEach(take);
  return { by: "site", items: picked.map((e) => ({ codes: e.codes.length ? e.codes : ["總經"], text: firstSentence(e.fact), why: whyPicked(e, ctx), eventId: e.eventId, flag: e.flag })) };
}

export async function loadNewsView() {
  const [news, ctx] = await Promise.all([loadNews(), loadContext()]);
  const { rows } = news;
  const events = groupEvents(rows.filter((r) => !HIDE_IN_CARDS.has(r.category)), ctx);
  return {
    ...news,
    ctx,
    events,
    highlights: pickHighlights(rows, events, ctx),
    flagged: events.filter((e) => e.flag !== "none"),
    summaryRow: rows.find((r) => r.category === "摘要"),
    crowdRows: rows.filter((r) => r.category === "情緒" && CROWD.includes(r.symbol)),
  };
}

// 情緒一行：恐懼貪婪、台指 VIX（market-data），同學風向四檔（新聞分頁）
const FG_ZH = { "extreme fear": "極度恐懼", fear: "恐懼", neutral: "中性", greed: "貪婪", "extreme greed": "極度貪婪" };
function crowdShort(fact) {
  const m = /(\d+)\s*分「(.+?)」/.exec(fact || "");
  return m ? `${m[1]} ${m[2]}` : (fact || "未取得").replace(/（.*?）/g, "");
}
export async function sentimentParts(crowdRows) {
  const [fg, vix] = await Promise.allSettled([loadFearGreed(), loadVix()]);
  const parts = [];
  parts.push(fg.status === "fulfilled"
    ? `恐懼貪婪 ${isNum(fg.value.score) ? fg.value.score.toFixed(0) : "—"}（${FG_ZH[fg.value.rating] || fg.value.rating}）`
    : "恐懼貪婪讀不到");
  if (vix.status === "fulfilled") {
    const last = vix.value.at(-1);
    parts.push(`台指 VIX ${last.value.toFixed(2)}（${shortDate(last.date)}）`);
  } else parts.push("台指 VIX 讀不到");
  if (crowdRows) {
    const by = new Map(crowdRows.map((r) => [r.symbol, r]));
    parts.push(`同學風向 ${CROWD.map((c) => `${c} ${by.has(c) ? crowdShort(by.get(c).fact) : "未取得"}`).join("、")}`);
  }
  return parts;
}
