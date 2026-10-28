// 決策鏈（PLAN D5）：偵察 → 新聞 → 情緒 → 圖表 → 風控 → 最終計畫，每站一張卡、點開看依據。
// 風控與最終計畫由 Phase 3 配置器（allocator）負責，上線前先留位置。新聞內容一律以純文字放進頁面。
import { loadArchive, latestRun } from "../data.js";
import { loadNewsView, sentimentParts } from "../news.js";
import {
  el, twd, price, pct, taipeiTime, shortDate, taipeiToday, badge, distText, LEVELS, isNum,
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

// 新聞站：今天的重點與旗標（明細在新聞頁）
async function news(runsP) {
  const [vR, rR] = await Promise.allSettled([loadNewsView(), runsP]);
  const adopted = rR.status === "fulfilled"
    ? ["tw", "us"].flatMap((m) => buyTickers(rR.value[m]).filter((t) => t.event && t.event !== "none").map((t) => `${t.code} ${t.event}`))
    : null;
  const adoptedLine = adopted && el("div", { class: "small muted" }, `晨報採用的事件旗標：${adopted.length ? adopted.join("、") : "全部 none"}`);
  if (vR.status === "rejected") return { concl: [notice("err", `讀不到新聞分頁：${vR.reason.message}`), adoptedLine], body: null };
  const v = vR.value;
  if (!v.rows.length) return { concl: [el("div", { class: "muted" }, "新聞分頁還沒有資料。"), adoptedLine], body: null };
  const stale = v.dataDate !== taipeiToday();
  return {
    concl: [
      el("ol", { class: "chain-hl" }, v.highlights.items.map((h) => el("li", {},
        el("strong", {}, h.codes.join("、")), "　", h.text))),
      el("div", { class: "small" }, v.flagged.length
        ? `⚠ 建議旗標：${v.flagged.map((e) => `${e.codes.join("、")} ${e.flag}`).join("；")}`
        : "✓ 旗標全部正常"),
      adoptedLine,
      el("div", { class: "row small" }, el("a", { href: "#/news" }, `看新聞明細（${v.events.length} 件）→`),
        stale && el("span", { class: "badge b-warn" }, `⚠ 資料日 ${shortDate(v.dataDate)}`),
        el("span", { class: "tiny" }, `新聞晨報 ${taipeiTime(v.generatedAt)}（${v.label}）`)),
    ],
    body: null,
  };
}

async function sentiment() {
  const v = await loadNewsView().catch(() => null);
  const parts = await sentimentParts(v);
  return {
    concl: [el("div", {}, `${parts.join("・")}。`), el("div", { class: "tiny" }, "情緒只當參考層，不能單獨改變買區判定。")],
    body: null,
  };
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
