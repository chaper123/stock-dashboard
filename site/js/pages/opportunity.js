// 機會頁（docs/INSIGHTS.md 5.2，第一版）：擇時分析，只當參考，跟每月 80／20 定投的核心規則分開。
// 現在在哪（加權指數這一段回落到過哪些級距）→ 歷史上跌到同樣級距之後 → 三種做法並列 → 加碼試算。
// 使用者 2026-11-11 決定：不設預備金、不照級距加碼；這頁不建議金額、不寫建議選哪一種，只描述已經發生的事。
import { loadIndex, loadDaily, loadSettings } from "../data.js";
import { loadPortfolio } from "../portfolio.js";
import { loadStatus, statusLine } from "../status.js";
import { nextDepositDate } from "../discipline.js";
import { DISCIPLINE as D, NAMES } from "../config.js";
import { el, price, twd, int, pct, tone, shortDate, dateVs, taipeiToday, isNum } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { TIERS, EXPAND_FROM, HORIZONS, tierCrossings, tierReport, baseline, currentEpisode } from "../opportunity.js";
import { whatIf } from "../opportunity.js";

const TARGET_TEXT = `${Math.round(D.target[D.core] * 100)}／${Math.round(D.target[D.satellite] * 100)}`;

export async function render(root) {
  root.append(pageHeader("機會", `擇時分析，只當參考。研究與 10/29 的回測都顯示，擇時長期很難贏紀律定投；每月 ${TARGET_TEXT} 定投的核心規則不受這頁影響。這頁不建議金額，也不寫該選哪一種做法。`));
  root.append(el("p", { class: "small" }, el("a", { href: "#/analysis" }, "← 回分析頁")));
  const base = loadBase();
  base.catch(() => {}); // 每個區塊各自顯示錯誤
  slot(root, async () => whereCard(await base));
  slot(root, async () => historyCard(await base));
  slot(root, async () => approachesCard(await base));
  slot(root, whatIfCard);
}

// 加權指數 2003 年起的收盤 → 現在這一段、每個級距的歷史、對照基準
async function loadBase() {
  const ix = await loadIndex("TAIEX");
  const cross = tierCrossings(ix);
  return {
    ix,
    ep: currentEpisode(ix),
    reports: new Map(TIERS.map((t) => [t, tierReport(ix, cross.get(t))])),
    base: HORIZONS.map(([label, n]) => ({ label, s: baseline(ix, n) })),
    years: (Date.parse(ix.at(-1).date) - Date.parse(ix[0].date)) / (365.25 * 864e5),
  };
}

// ETF 自己離高點多遠（高點從上市起算）；讀不到是 null
const etfEpisode = (code) => loadDaily("tw", code)
  .then((bars) => currentEpisode(bars.map((x) => ({ date: x.time, value: x.close }))), () => null);

const kv = (k, v, sub) => el("div", { class: "kv" }, el("span", { class: "k" }, k, sub && el("div", { class: "tiny" }, sub)), el("span", { class: "v" }, v));

// ── 現在在哪 ───────────────────────────────────────────
async function whereCard({ ep }) {
  const [S, core, sat] = await Promise.all([loadStatus().catch(() => null), etfEpisode(D.core), etfEpisode(D.satellite)]);
  const near = (d) => dateVs(d, ep.last.date);
  const hits = ep.hits.filter((h) => h.hit);
  const lead = ep.top === 0
    ? `加權指數離高點 ${pct(ep.dd)}（${shortDate(ep.last.date)} 收盤），這一段還沒有跌到 −${TIERS[0]}%，沒有觸發任何級距。`
    : `這一段從 ${near(ep.peak.date)} 的高點 ${price(ep.peak.value)} 回落，${hits.map((h, i) => `${near(h.hit.date)} ${i ? "" : "收盤第一次"}跌到 −${h.tier}%`).join("、")}；`
      + `最深 ${pct(ep.lowDd)}（${near(ep.low.date)}），現在 ${pct(ep.dd)}（${shortDate(ep.last.date)} 收盤）。`;

  const tags = el("div", { class: "row", style: { margin: "8px 0" } }, ep.hits.map((h) => el("span",
    { class: `tag ${h.hit ? (h.tier >= EXPAND_FROM ? "st-crit" : "st-warn") : ""}` },
    h.hit ? `−${h.tier}%　${near(h.hit.date)} 觸發${h.tier >= EXPAND_FROM ? "" : "（只提醒）"}` : `−${h.tier}%　沒到`)));

  const line = (label, e) => kv(label, el("strong", { class: e.dd < 0 ? "down" : "" }, pct(e.dd)),
    `${shortDate(e.last.date)} 收盤 ${price(e.last.value)}；高點 ${dateVs(e.peak.date, e.last.date)} ${price(e.peak.value)}；這一段最低 ${dateVs(e.low.date, e.last.date)}（${pct(e.lowDd)}）`);
  const missing = [[D.core, core], [D.satellite, sat]].filter(([, e]) => !e).map(([c]) => c);

  const kind = S ? S.tw(ep.last.date) : null;
  const status = kind && statusLine([{ kind, what: "加權指數", when: `${shortDate(ep.last.date)} 收盤`,
    note: kind === "stale" ? `應該已經有 ${shortDate(S.expect.tw)} 的收盤，先用舊的` : kind === "closed" ? "今天台股休市，用最近交易日的收盤" : null }]);

  return card("現在在哪", status,
    el("p", {}, el("strong", {}, lead)),
    tags,
    line("加權指數", ep),
    core && line(`${D.core} ${NAMES[D.core] || ""}`, core),
    sat && line(`${D.satellite} ${NAMES[D.satellite] || ""}`, sat),
    missing.length > 0 && el("p", { class: "tiny" }, `讀不到：${missing.join("、")}。`),
    el("p", { class: "tiny" }, `級距只看加權指數（2003 年起有資料）：從這一段的高點回落 ${TIERS.map((t) => `${t}%`).join("、")}，用收盤價，盤中不算；收盤創新高後才算下一段。`
      + `−${TIERS[0]}% 很常見，只當提醒；−${EXPAND_FROM}% 起才展開下面的三種做法。兩檔 ETF 上市時間短，只列現況，高點從上市起算。`));
}

// ── 歷史上跌到這個級距之後 ─────────────────────────────
// 表格不折行（手機用左右滑），所以每格的說明拆成兩行短句
const tiny2 = (a, b) => [el("div", { class: "tiny" }, a), el("div", { class: "tiny" }, b)];
const statCell = (s) => (s
  ? el("td", { class: "r" }, el("strong", { class: tone(s.median) }, pct(s.median)), tiny2(`${s.n} 次裡 ${s.up} 次上漲`, `最差 ${pct(s.min)}`))
  : el("td", { class: "r" }, "—"));
const baseCell = (s) => (s
  ? el("td", { class: "r" }, el("strong", { class: tone(s.median) }, pct(s.median)), tiny2(`${Math.round((s.up / s.n) * 100)}% 的日子上漲`, `最差 ${pct(s.min)}`))
  : el("td", { class: "r" }, "—"));

function historyCard({ ix, ep, reports, base, years }) {
  const head = ["級距", "次數", ...HORIZONS.map(([l]) => `${l}後`), "觸發後還多跌"];
  const rows = TIERS.map((t) => {
    const r = reports.get(t), n = r.rows.length;
    return el("tr", {},
      el("td", {}, el("strong", {}, `−${t}%`), ep.top === t && el("div", {}, el("span", { class: "tag st-crit" }, "這一段到過"))),
      el("td", { class: "r" }, `${n} 次`, n > 0 && el("div", { class: "tiny" }, `平均約 ${(years / n).toFixed(1)} 年一次`)),
      r.stats.map((x) => statCell(x.s)),
      r.further
        ? el("td", { class: "r" }, el("strong", { class: "down" }, pct(r.further.median)), tiny2(`最多 ${pct(r.further.min)}`, `已回到高點的 ${r.further.n} 次`))
        : el("td", { class: "r" }, "—"));
  });
  rows.push(el("tr", {},
    el("td", {}, "任一交易日買進", el("div", { class: "tiny" }, "對照")),
    el("td", { class: "r" }, "—"),
    base.map((x) => baseCell(x.s)),
    el("td", { class: "r" }, "—")));

  const summary = el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
    el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
    el("tbody", {}, rows)));

  // 每一次的清單（新的在前）；這一段到過的最深級距預設打開
  const lists = TIERS.map((t) => {
    const r = reports.get(t);
    if (!r.rows.length) return null;
    const fwd = (v) => el("td", { class: `r ${v == null ? "" : tone(v)}` }, v == null ? "還沒滿" : pct(v));
    return el("details", { class: "more", open: ep.top === t },
      el("summary", {}, `−${t}% 的每一次（${r.rows.length} 次）`),
      el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
        el("thead", {}, el("tr", {}, ["觸發日", "當天離高點", ...HORIZONS.map(([l]) => `${l}後`), "之後還多跌", "回到高點"].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
        el("tbody", {}, [...r.rows].reverse().map((x) => el("tr", {},
          el("td", {}, x.date, x.peak.date === ep.peak.date && el("span", { class: "tag", style: { marginLeft: "6px" } }, "這一段")),
          el("td", { class: "r" }, pct(x.dd)),
          x.fwd.map(fwd),
          el("td", { class: "r" }, x.further.pct === 0 ? "沒有再跌" : pct(x.further.pct), !x.further.recovered && el("span", { class: "tiny" }, "（到目前）")),
          el("td", { class: "r" }, x.further.recovered || "尚未回到")))))));
  });

  return card("歷史上跌到這個級距之後",
    el("p", { class: "small" }, `加權指數 ${ix[0].date.slice(0, 4)} 年起，每一段回落第一次收盤跌到該級距的那天起算，之後的漲跌。粗體是中位數。`),
    summary, lists,
    el("p", { class: "tiny" }, `1、3、6、12 個月用 ${HORIZONS.map(([, n]) => n).join("、")} 個交易日；時間還沒到的那幾次不算進統計。「觸發後還多跌」是觸發那天之後、回到這一段高點之前的最低收盤，比觸發那天再低多少；統計只算已經回到高點的那幾段。`
      + `加權指數是價格指數，不含股利。資料從 ${ix[0].date.slice(0, 4)} 年起（之前的高點不算在內），樣本很少；只列已經發生的事，不代表之後會一樣。`));
}

// ── 三種做法並列 ───────────────────────────────────────
async function approachesCard({ ep, reports }) {
  const [core, sat, settings] = await Promise.all([etfEpisode(D.core), etfEpisode(D.satellite), loadSettings().catch(() => null)]);
  const T = Math.max(ep.top, EXPAND_FROM);        // 還沒到 −20% 時，用 −20% 的歷史當例子
  const rep = reports.get(T);
  const s1 = rep.stats[0].s, s12 = rep.stats.at(-1).s, fu = rep.further;
  const reachedNow = ep.top >= EXPAND_FROM;
  const hitDate = ep.hits.find((h) => h.tier === T)?.hit?.date;
  const hist12 = s12 ? `歷史上跌到 −${T}% 之後 12 個月，${s12.n} 次裡 ${s12.up} 次上漲，中位數 ${pct(s12.median)}、最差 ${pct(s12.min)}` : `歷史上還沒有跌到 −${T}% 滿 12 個月的例子`;

  const block = (title, sub, rows) => el("div", {},
    el("h3", {}, title, el("span", { class: "tiny", style: { marginLeft: "6px", fontWeight: 400 } }, sub)),
    el("table", { class: "kvt" }, el("tbody", {}, rows.filter(Boolean).map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v))))));

  const conservative = block("保守", "照規則不動", [
    ["做法", `每月 ${D.depositDay} 日照 ${TARGET_TEXT} 定投，不另外加碼。下次入金 ${shortDate(nextDepositDate(taipeiToday()))}。`],
    ["根據", "定投在跌的月份，同樣的錢會買到比較多股。10/29 的回測裡，等回檔或等止跌才買的規則，報酬和定期定額差不多或更差（docs/BACKTEST.md）。"],
    ["好處", "不用判斷時點，也不用另外準備錢。"],
    ["代價", `如果之後反彈，沒有多買。${hist12}。`],
  ]);

  const neutral = block("中性", `另外拿一筆錢照 ${TARGET_TEXT} 加碼`, [
    ["做法", `金額自己決定（這頁不設預備金、不建議金額），照 ${TARGET_TEXT} 買；記帳時會歸在「自主加碼」。下面可以試算。`],
    ["根據", (reachedNow && hitDate ? `這一段 ${dateVs(hitDate, ep.last.date)} 收盤跌到 −${T}%，現在離高點 ${pct(ep.dd)}。` : `這一段還沒跌到 −${T}%，以下用 −${T}% 的歷史當例子。`)
      + (s1 ? `歷史上之後 1 個月 ${s1.n} 次裡 ${s1.up} 次上漲（中位數 ${pct(s1.median)}）；` : "") + `${hist12}。`],
    ["好處", "比例照規則，不用改任何設定。"],
    ["代價", (fu ? `觸發後通常還會再跌：已經回到高點的 ${fu.n} 次裡，中位數再跌 ${Math.abs(fu.median).toFixed(1)}%、最多再跌 ${Math.abs(fu.min).toFixed(1)}%。` : "")
      + `錢要從別的地方來${settings && isNum(settings.pool) ? `：帳本可用資金目前 ${twd(settings.pool)}` : ""}。`],
  ]);

  const gap = core && sat ? sat.lowDd - core.lowDd : null;
  const aggressive = block("積極", "加碼並調整衛星比例或加入新標的", [
    ["做法", `加碼之外，調整核心與衛星的比例，或加入新的標的。這是因應少見情況的做法，可以不照 ${TARGET_TEXT}。`],
    ["根據", core && sat
      ? `這一段最深：${D.satellite} ${pct(sat.lowDd)}、${D.core} ${pct(core.lowDd)}、加權 ${pct(ep.lowDd)}。衛星比核心${gap < 0 ? "多跌" : "少跌"} ${Math.abs(gap).toFixed(1)} 個百分點。`
      : "讀不到兩檔 ETF 的日線，先不列。"],
    ["還沒做", "新標的的候選篩選（分散型、進攻型並列，每一檔寫理由與代價）排在第二版。"],
    ["要想清楚", "新標的如果和現有兩檔連動高，等於加碼同一個風險；改比例等於改核心規則，要另外決定。"],
  ]);

  const body = [
    el("div", { class: "grid three" }, conservative, neutral, aggressive),
    el("p", { class: "tiny" }, "三種做法只列做法、根據、好處、代價，不寫建議選哪一種；決定之後照常到記帳頁記錄。歷史數字來自上面的表，樣本很少。"),
  ];
  if (reachedNow) return card("三種做法（並列）", body);
  return card("三種做法（並列）",
    notice("info", ep.top === 0 ? `目前沒有觸發級距（離高點 ${pct(ep.dd)}）。` : `這一段只到 −${TIERS[0]}%：很常見，這裡只提醒，不展開。`),
    el("details", { class: "more" }, el("summary", {}, `先看三種做法（用 −${T}% 的歷史當例子）`), body));
}

// ── 加碼試算（中性：照目標比例）──────────────────────────
async function whatIfCard() {
  const title = `加碼試算（照 ${TARGET_TEXT}）`;
  const pf = await loadPortfolio();
  const pos = (code) => pf.positions.find((p) => p.code === code && !p.error);
  const core = pos(D.core), sat = pos(D.satellite);
  if (!core || !sat || !isNum(core.mvTwd) || !isNum(sat.mvTwd)) {
    return card(title, notice("warn", `讀不到 ${D.core}、${D.satellite} 的持倉或價格，先不能試算。`));
  }
  const total = core.mvTwd + sat.mvTwd;
  const ratio = (c) => `${c.toFixed(1)}：${(100 - c).toFixed(1)}`;
  const pts = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
  const asOf = (p) => p.asOf || shortDate(p.priceDate);

  const out = el("div", { "aria-live": "polite" });
  const input = el("input", { type: "number", inputmode: "numeric", min: 1, step: 1, placeholder: "輸入金額", "aria-describedby": "whatif-note" });
  const update = () => {
    if (input.value === "") {
      out.replaceChildren(el("p", { class: "tiny" }, "輸入金額後，這裡會算兩檔各買多少、買完的比例。"));
      return;
    }
    const amount = Number(input.value);
    if (!(amount > 0) || amount > 1e9) {
      out.replaceChildren(notice("warn", "金額要大於 0。"));
      return;
    }
    const w = whatIf({ coreMv: core.mvTwd, satMv: sat.mvTwd, amount, target: D.target[D.core], corePrice: core.price, satPrice: sat.price });
    out.replaceChildren(
      kv(`${D.core} ${NAMES[D.core] || ""}`, twd(w.addCore), `約 ${int(w.sharesCore)} 股（照 ${asOf(core)} ${price(core.price)} 元估）`),
      kv(`${D.satellite} ${NAMES[D.satellite] || ""}`, twd(w.addSat), `約 ${int(w.sharesSat)} 股（照 ${asOf(sat)} ${price(sat.price)} 元估）`),
      kv(`買完的比例（${D.core}：${D.satellite}）`, ratio(w.after.core),
        `現在 ${ratio(w.before.core)}，目標 ${TARGET_TEXT.replace("／", "：")}；偏離 ${pts(w.before.dev)} → ${pts(w.after.dev)} 個百分點`),
      kv("台股部位變大", pct(w.growth), `現在兩檔合計 ${twd(total)}，買完 ${twd(total + amount)}`));
  };
  input.addEventListener("input", update);
  update();

  return card(title,
    el("label", { class: "field", style: { maxWidth: "260px" } }, el("span", {}, "另外投入的金額（台幣）"), input),
    out,
    el("p", { class: "tiny", id: "whatif-note" }, `只是算術：把你輸入的金額照 ${TARGET_TEXT} 分，不是建議金額，也不會寫進帳本。股數用上面標的價格估（零股、無條件捨去），實際成交價與手續費會不同。`
      + `偏離超過 ±${D.bandPts} 個百分點時，規則是在 4、10 月檢查用新資金補偏低的一檔；這裡一律照 ${TARGET_TEXT} 分。`));
}
