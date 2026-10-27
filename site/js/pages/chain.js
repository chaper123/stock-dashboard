// 決策鏈（PLAN D5）：偵察 → 新聞 → 情緒 → 圖表 → 風控 → 最終計畫，每站一張卡、點開看依據。
// 風控與最終計畫由 Phase 3 配置器（allocator）負責，上線前先留位置。新聞內容一律以純文字放進頁面。
import { loadArchive, latestRun, loadNews, loadFearGreed, loadVix } from "../data.js";
import {
  el, twd, price, pct, taipeiTime, shortDate, taipeiToday, badge, distText, extLink, LEVELS, isNum,
} from "../fmt.js";
import { slot, pageHeader, notice } from "../ui.js";
import { MARKET_LABEL } from "../config.js";

export async function render(root) {
  root.append(pageHeader("決策鏈", "六站接力：偵察 → 新聞 → 情緒 → 圖表 → 風控 → 最終計畫。點開每一站看依據。"));
  const chain = el("div", { class: "chain" });
  root.append(chain);
  const runs = loadArchive().then((a) => ({ tw: latestRun(a, "tw"), us: latestRun(a, "us") }));
  runs.catch(() => {}); // 失敗由各站自己顯示
  station(chain, "偵察", "engine", () => scout(runs));
  station(chain, "新聞", "新聞晨報", () => news(runs));
  station(chain, "情緒", "新聞晨報＋market-data", sentiment);
  station(chain, "圖表", "engine", () => chart(runs));
  pending(chain, "風控", "核准、縮減或拒絕，每個候選都附理由（單檔與市場上限、重疊群組與相關性、最低下單、block 事件、估值禁買、資金不足）。");
  pending(chain, "最終計畫", "整合前五站，輸出今天的分批價位與金額，以及一句話總結。");
}

function station(parent, name, owner, build) {
  const box = el("div", { class: "station" });
  parent.append(box);
  slot(box, async () => {
    const { concl, body } = await build();
    return el("section", { class: "card" },
      el("h2", {}, name, el("span", { class: "owner" }, owner)),
      el("div", { class: "concl" }, concl),
      body && el("details", { class: "more" }, el("summary", {}, "依據"), body));
  });
}

function pending(parent, name, what) {
  parent.append(el("div", { class: "station pending" }, el("section", { class: "card" },
    el("h2", {}, name, el("span", { class: "owner" }, "allocator（Phase 3）")),
    el("div", { class: "concl muted" }, "Phase 3 配置器上線後提供。"),
    el("p", { class: "tiny" }, what),
    el("p", { class: "tiny" }, "現在的規則參考金額見 ", el("a", { href: "#/plan" }, "今日計畫"), "（還沒有跨市場分配）。"))));
}

const buyTickers = (run) => (run ? run.json.tickers.filter((t) => t.role === "buy") : []);
const runLabel = (m, run) => (run ? `${MARKET_LABEL[m]}（資料日 ${shortDate(run.dataDate)}）` : `${MARKET_LABEL[m]}（沒有存檔）`);

async function scout(runsP) {
  const runs = await runsP;
  const parts = [];
  let n = 0;
  for (const m of ["tw", "us"]) {
    const inZone = buyTickers(runs[m]).filter((t) => LEVELS[t.level]?.inZone);
    n += inZone.length;
    parts.push(`${MARKET_LABEL[m]} ${inZone.length ? inZone.map((t) => `${t.code} ${t.status}`).join("、") : "沒有"}`);
  }
  const totals = ["tw", "us"].map((m) => `${MARKET_LABEL[m]} ${runs[m] ? twd(runs[m].json.total_twd) : "—"}`).join("、");
  const body = ["tw", "us"].map((m) => el("div", {},
    el("h3", {}, runLabel(m, runs[m])),
    el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
      el("thead", {}, el("tr", {}, ["代號", "狀態", "判定價", "距第一買區上緣", "規則參考"].map((h) => el("th", {}, h)))),
      el("tbody", {}, buyTickers(runs[m]).map((t) => el("tr", {},
        el("td", {}, t.code), el("td", {}, badge(t.level, t.status)), el("td", {}, price(t.price)),
        el("td", {}, distText(t.dist_to_z1_pct)), el("td", {}, twd(t.amount_twd)))))))));
  return {
    concl: [el("div", {}, `進買區 ${n} 檔：${parts.join("；")}。`), el("div", { class: "small muted" }, `規則參考合計：${totals}。`)],
    body,
  };
}

const FLAG_ZH = { none: "none", block: "block（暫停）", boost: "boost（加碼候選）" };

async function news(runsP) {
  const [nR, rR] = await Promise.allSettled([loadNews(), runsP]);
  const out = [];
  // 晨報最後採用的事件旗標（engine 的 event）
  if (rR.status === "fulfilled") {
    const flags = ["tw", "us"].flatMap((m) => buyTickers(rR.value[m]).filter((t) => t.event && t.event !== "none").map((t) => `${t.code} ${t.event}`));
    out.push(el("div", { class: "small" }, `晨報採用的事件旗標：${flags.length ? flags.join("、") : "全部 none"}`));
  }
  if (nR.status === "rejected") {
    return { concl: [...out, notice("err", `讀不到新聞分頁：${nR.reason.message}`)], body: null };
  }
  const { dataDate, generatedAt, rows } = nR.value;
  if (!rows.length) return { concl: [...out, el("div", { class: "muted" }, "新聞分頁還沒有資料。")], body: null };
  const events = groupEvents(rows.filter((r) => !["摘要", "情緒", "社群"].includes(r.category)));
  const flagged = events.filter((e) => e.flag !== "none");
  const tier1 = events.filter((e) => e.tier === 1);
  const stale = dataDate !== taipeiToday();
  const summary = rows.find((r) => r.category === "摘要");
  const concl = [
    el("div", { class: "row" },
      el("span", {}, `${events.length} 件事件；建議旗標 ${flagged.length ? flagged.map((e) => `${e.symbols.join("、")} ${FLAG_ZH[e.flag] || e.flag}`).join("；") : "全部 none"}；官方（Tier 1）${tier1.length} 件。`),
      stale && el("span", { class: "badge b-warn" }, `⚠ 資料日 ${shortDate(dataDate)}`)),
    ...out,
    el("div", { class: "tiny" }, `新聞晨報 ${taipeiTime(generatedAt)}（目前讀測試分頁；建議旗標只是建議，晨報依自己的規則決定）`),
  ];
  const body = el("div", {},
    summary && el("p", { class: "small muted" }, summary.fact),
    events.map(newsEvent));
  return { concl, body };
}

// 同一事件影響幾個標的就有幾列：合併成一件
function groupEvents(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.eventId || `${r.symbol}-${r.fact}`;
    if (!map.has(key)) map.set(key, { ...r, symbols: [], flags: new Set() });
    const e = map.get(key);
    e.symbols.push(r.symbol);
    e.flags.add(r.flag);
  }
  return [...map.values()].map((e) => ({ ...e, flag: [...e.flags].find((f) => f !== "none") || "none" }))
    .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9));
}

function newsEvent(e) {
  return el("div", { class: "news-ev" },
    el("div", { class: "meta" },
      [e.symbols.join("、"), e.category, e.eventTime, e.source, e.tier ? `Tier ${e.tier}` : null, e.verify].filter(Boolean).join("・")),
    el("div", {}, e.fact),
    el("div", { class: "meta" },
      `影響 ${e.impact || "—"}・旗標 ${FLAG_ZH[e.flag] || e.flag}`, e.reason ? `・${e.reason}` : "",
      e.url ? ["・", extLink(e.url, "原文")] : null));
}

const FG_ZH = { "extreme fear": "極度恐懼", fear: "恐懼", neutral: "中性", greed: "貪婪", "extreme greed": "極度貪婪" };

async function sentiment() {
  const [fg, vix, nR] = await Promise.allSettled([loadFearGreed(), loadVix(), loadNews()]);
  const bits = [];
  if (fg.status === "fulfilled") bits.push(`恐懼貪婪 ${isNum(fg.value.score) ? fg.value.score.toFixed(0) : "—"}（${FG_ZH[fg.value.rating] || fg.value.rating}）`);
  else bits.push("恐懼貪婪讀不到");
  if (vix.status === "fulfilled") {
    const last = vix.value.at(-1);
    bits.push(`台指 VIX ${last.value.toFixed(2)}（${shortDate(last.date)}）`);
  } else bits.push("台指 VIX 讀不到");
  const social = nR.status === "fulfilled" ? nR.value.rows.filter((r) => ["情緒", "社群"].includes(r.category)) : [];
  const crowd = social.filter((r) => r.source.includes("同學風向"));
  if (crowd.length) bits.push(`同學風向 ${crowd.map((r) => `${r.symbol} ${crowdShort(r.fact)}`).join("、")}`);
  const body = social.length
    ? el("div", {}, social.map((r) => el("div", { class: "news-ev" },
      el("div", { class: "meta" }, [r.symbol, r.category, r.source, r.eventTime].filter(Boolean).join("・")),
      el("div", {}, r.fact),
      r.url && el("div", { class: "meta" }, extLink(r.url, "來源")))))
    : nR.status === "rejected" ? notice("err", `讀不到新聞分頁：${nR.reason.message}`) : null;
  return {
    concl: [el("div", {}, `${bits.join("・")}。`), el("div", { class: "tiny" }, "情緒只當參考層，不能單獨改變買區判定。")],
    body,
  };
}
// 「同學風向 46 分「中立」（更新 10/27 07:00）」→「46 中立」；樣本不足照原文
function crowdShort(fact) {
  const m = /(\d+)\s*分「(.+?)」/.exec(fact || "");
  return m ? `${m[1]} ${m[2]}` : (fact || "").replace(/（.*?）/g, "");
}

async function chart(runsP) {
  const runs = await runsP;
  const all = ["tw", "us"].flatMap((m) => buyTickers(runs[m]).map((t) => ({ ...t, market: m })));
  const trendKey = (s) => (s || "").replace(/\(.*\)|（.*）/g, "");
  const counts = {};
  for (const t of all) counts[trendKey(t.trend)] = (counts[trendKey(t.trend)] || 0) + 1;
  const weak = all.filter((t) => t.level === "weak");
  const body = el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
    el("thead", {}, el("tr", {}, ["代號", "趨勢", "RSI", "乖離", "距第一買區上緣", ""].map((h) => el("th", {}, h)))),
    el("tbody", {}, all.map((t) => el("tr", {},
      el("td", {}, t.code), el("td", {}, t.trend), el("td", {}, isNum(t.rsi) ? t.rsi.toFixed(0) : "—"),
      el("td", {}, pct(t.bias)), el("td", {}, distText(t.dist_to_z1_pct)),
      el("td", {}, el("a", { href: `#/charts/${encodeURIComponent(t.code)}` }, "K 線")))))));
  return {
    concl: [
      el("div", {}, `可買標的趨勢：${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join("、")}。`),
      el("div", { class: "small muted" }, weak.length ? `空頭排列不接刀：${weak.map((t) => t.code).join("、")}。` : "沒有觸發「空頭排列不接刀」。"),
    ],
    body,
  };
}
