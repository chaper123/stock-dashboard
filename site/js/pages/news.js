// 新聞（v4，docs/PROGRESS.md 第 12 項）：跳轉列 → 今天跟你有關的（新聞晨報）→ 展望 → 總經 → 持股新聞（不經 AI）＋多家媒體都在報
// → 新聞晨報整理的事件、話題、情緒。每一塊各自讀資料、各自失敗。
// 新聞內容一律以純文字放進頁面，連結只接受 http/https（el 的 href 會檢查）。
import { loadNewsView, sentimentParts, firstSentence, TIER_LABEL, SECTIONS, sectionOf } from "../news.js";
import { loadFearGreed, loadTopics, loadHeadlines, loadNsf, loadIndex, loadCalendar } from "../data.js";
import { cnnReading, gaugeBlock, pocketBlock } from "../gauge.js";
import { el, taipeiTime, shortDate, taipeiToday, extLink, daysBetween, int, pct, twd, tone } from "../fmt.js";
import { slot, card, pageHeader, notice } from "../ui.js";
import { DROPPED } from "../config.js";
import { TABS, holdTags, sortItems, hotList, nsfNews, nsfStatus, ago, timeOf } from "../headlines.js";
import { macroTiles } from "../macro.js";
import { outlookEvents, review009816, dayLabel } from "../outlook.js";
import { loadPortfolio } from "../portfolio.js";
import { loadFund, hasPrivate, privateSettings, PRIVATE_NOTE } from "../private.js";
import { MOVE_PCT, weekStart, fundMoves, sinceFirst, lastSetChange, top10Rows, fundSummary, lookThrough } from "../inside.js";

const PARTS = [["brief", "今天的重點"], ["nsf", "國安基金"], ["outlook", "展望"], ["macro", "總經"], ["inside", "ETF 裡面在變什麼"], ["feed", "持股新聞"], ["more", "晨報事件與情緒"]];

export async function render(root, { arg }) {
  root.append(pageHeader("新聞", "先看跟你有關的重點，再看接下來的事、總經，最後是持股的即時新聞。"));
  // 網站用 #/… 換頁，跳轉不能用錨點連結，改成按鈕捲動。國安基金那一塊只在大跌或有消息時出現，按鈕跟著出現
  const buttons = Object.fromEntries(PARTS.map(([id, label]) => [id,
    el("button", { type: "button", hidden: id === "nsf", onclick: () => document.getElementById(id)?.scrollIntoView({ block: "start" }) }, label)]));
  root.append(el("nav", { class: "jump", "aria-label": "跳到" }, Object.values(buttons)));
  const part = (id) => {
    const box = el("div", { id, class: "jump-target" });
    root.append(box);
    return box;
  };
  slot(part("brief"), briefView);
  slot(part("nsf"), async () => {
    const node = await nsfView();
    buttons.nsf.hidden = !node;
    return node;
  });
  slot(part("outlook"), outlookView);
  slot(part("macro"), macroView);
  slot(part("inside"), insideView);
  slot(part("feed"), () => feedView(arg));
  slot(part("more"), moreView);
}

// ── 今天跟你有關的（新聞晨報的重點列；晨報 v4 之後改成「對你／為什麼／要做什麼」）
async function briefView() {
  const v = await loadNewsView();
  if (!v.rows.length) return notice("info", "新聞晨報還沒有資料。");
  const stale = v.dataDate !== taipeiToday();
  return [
    v.ctx.missing.length > 0 && notice("warn", `讀不到${v.ctx.missing.join("、")}，「持有」的標示可能不完整。`),
    highlightsCard(v, { title: "今天跟你有關的" }),
    el("p", { class: "tiny row" }, `新聞晨報 ${taipeiTime(v.generatedAt)}・資料日 ${shortDate(v.dataDate)}`,
      stale && el("span", { class: "badge b-warn" }, "⚠ 不是今天的")),
  ];
}

// ── 大跌時：國安基金與政府動向。只列官方公告與主要媒體的報導，不猜會不會進場
const NSF_LAW = "https://law-out.mof.gov.tw/LawContent.aspx?id=GL008772";
const NSF_LIST = "https://www.mof.gov.tw/multiplehtml/383";
const ext = (href, text) => el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
// 同一家媒體最多列 n 則（同一家常一題多發，避免擠掉其他來源）
const perSource = (items, n) => { const c = {}; return items.filter((x) => (c[x.source] = (c[x.source] || 0) + 1) <= n); };

// 國安基金狀態 → 圖示、一個字的答案、一句話
const NSF_VIEW = {
  active: { icon: "✓", word: "會", line: () => "國安基金已決定進場護盤" },
  considering: { icon: "?", word: "未定", line: () => "有進場的消息，但還沒正式決定" },
  stopped: { icon: "✕", word: "沒有", line: (s) => `國安基金目前沒有在護盤（${shortDate(s.date)} 已停止）` },
  none: { icon: "✕", word: "沒有", line: () => "財政部沒有進場公告" },
  unknown: { icon: "—", word: "讀不到", line: () => "讀不到財政部的國安基金公告，請稍後再看" },
};

async function nsfView() {
  const today = taipeiToday();
  const now = Date.now();
  const [ixR, nsfR, hR] = await Promise.allSettled([loadIndex("TAIEX"), loadNsf(), loadHeadlines()]);
  const ix = ixR.status === "fulfilled" ? ixR.value : null;
  let m = null;
  if (ix?.length >= 6) {
    const last = ix.at(-1);
    const high = Math.max(...ix.slice(-250).map((x) => x.value));
    m = { last, chg: (last.value / ix.at(-2).value - 1) * 100, week: (last.value / ix.at(-6).value - 1) * 100, dd: (last.value / high - 1) * 100 };
  }
  const official = nsfR.status === "fulfilled" ? nsfR.value.items || [] : [];
  const fresh = (d) => daysBetween(d, today) <= 14;
  const media = hR.status === "fulfilled" ? nsfNews(sortItems(hR.value.items || [])).filter((x) => now - timeOf(x) < 72 * 3600e3) : [];
  const st = nsfStatus(nsfR.status === "fulfilled" ? official : null, media, today, now);
  // 出現條件：進場中或有消息、大跌、兩週內有官方公告，或兩天內有兩則以上主要媒體報導
  const drop = m && (m.chg <= -3 || m.dd <= -10);
  if (!["active", "considering"].includes(st.state) && !drop && !official.some((x) => fresh(x.date))
    && media.filter((x) => now - timeOf(x) < 48 * 3600e3).length < 2) return null;

  const v = NSF_VIEW[st.state];
  return card("國安基金會不會護盤？",
    el("div", { class: `nsf-status ${st.state}` },
      el("span", { class: "nsf-icon", "aria-hidden": "true" }, v.icon),
      el("div", {},
        el("div", { class: "nsf-word" }, v.word, el("span", {}, v.line(st))),
        st.title && el("p", { class: "tiny" }, `依據：${st.by} ${shortDate(st.date)}`, ext(st.link, `〈${st.title}〉`),
          st.media ? "（財政部還沒公告）" : ""))),
    el("details", { class: "nsf-more" },
      el("summary", {}, "看依據：大盤、官方公告、媒體報導、法規"),
      m && el("p", { class: "small" },
        `加權指數 ${shortDate(m.last.date)} 收 ${int(m.last.value)} 點：當天 ${pct(m.chg, 2)}、近 5 個交易日 ${pct(m.week, 1)}、比 52 週高點 ${pct(m.dd, 1)}。`,
        el("span", { class: "tiny" }, "（收盤數字隔天早上更新）")),
      el("h3", {}, "官方公告（財政部・國安基金新聞稿）"),
      official.length ? el("ul", { class: "nsf-list" }, official.slice(0, 3).map((x) => el("li", {},
        el("span", { class: "mini hold" }, "官方"), " ", ext(x.link, x.title),
        el("span", { class: "k" }, `${x.date}${fresh(x.date) ? "・兩週內" : ""}`))))
        : el("p", { class: "muted small" }, nsfR.status === "rejected" ? "讀不到財政部的國安基金新聞稿。" : "沒有公告。"),
      el("p", { class: "tiny" }, ext(NSF_LIST, "財政部「國家金融安定基金訊息」全部公告 ↗")),
      el("h3", {}, "主要媒體怎麼報（最近 72 小時）"),
      media.length ? el("ul", { class: "nsf-list" }, perSource(media, 2).slice(0, 6).map((x) => el("li", {},
        el("span", { class: "mini" }, x.tier === 1 ? "官方" : "主要媒體"), " ", ext(x.url || x.link, x.title),
        el("span", { class: "k" }, `${x.source}・${ago(timeOf(x), now)}`))))
        : el("p", { class: "muted small" }, "最近 72 小時沒有主要媒體的相關報導。"),
      el("div", { class: "ai" }, el("b", {}, "國安基金什麼時候會進場（法規）"),
        "依《國家金融安定基金設置及管理條例》第 8 條：國內外重大事件、國際資金大幅移動，顯著影響民眾信心，致市場有失序或損及國家安定之虞時，",
        "由管理委員會（主任委員是行政院副院長）決議動用；可運用總額 5,000 億元（第 4 條）。股市下跌本身不一定會進場，要看委員會的決議與財政部公告。"),
      el("div", { class: "ai" }, el("b", {}, "對你"),
        "國安基金進不進場，都不改變你的計畫：每月 6 日照 80／20 投入，4 月與 10 月檢查比例。這裡只整理官方公告與主要媒體的報導，不預測漲跌。"),
      el("p", { class: "tiny" }, "怎麼判斷：「會」要財政部公告啟動或繼續執行，或兩家以上主要媒體報導已決議進場；只有「不排除」、臨時會或一家報導時算「未定」；",
        "財政部公告停止或沒有公告算「沒有」。出處：財政部國安基金新聞稿（政府資料開放授權條款－第 1 版）、", ext(NSF_LAW, "國家金融安定基金設置及管理條例"),
        "。媒體只列官方與主要媒體（Tier 1～2）標題提到國安基金、護盤、救市、限空、公股行庫的。")));
}

// ── 你的 ETF 裡面在變什麼（私人 repo 的每日持股，要 GitHub token；本機 ?dev 讀 dev-data/private）
const FUND_CODES = ["00981A", "009816"];
const MOVE_LABEL = { new: "新買", add: "加碼", cut: "減碼", exit: "出清" };
// 新買用黃色標記（使用者 2026-11-06 要求），加碼紅、減碼與出清綠（台股慣例）
const MOVE_CLASS = { new: "mv-new", add: "up", cut: "down", exit: "down" };
const lots = (n) => int(n / 1000);
const pp = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;

async function insideView() {
  const title = "你的 ETF 裡面在變什麼";
  if (!hasPrivate()) {
    return card(title,
      el("p", { class: "small" }, "這裡會列 00981A 經理人這週買賣了什麼、009816 什麼時候換股與換了哪幾檔，以及你的台股實際押在哪些公司。",
        "兩家投信不允許轉載持股，所以資料放在你的私人 repo，要先在下面設定只能讀那個 repo 的 GitHub token。"),
      privateSettings({ open: true }));
  }
  const today = taipeiToday();
  const [aR, bR, pR, calR, nR] = await Promise.allSettled([loadFund("00981A"), loadFund("009816"), loadPortfolio(), loadCalendar(), loadNewsView()]);
  const mgr = nR.status === "fulfilled" ? nR.value.managerRow : null;
  const err = [aR, bR].find((r) => r.status === "rejected");
  const ok = [aR, bR].filter((r) => r.status === "fulfilled").map((r) => r.value.doc);
  const funds = Object.fromEntries(ok.map((d) => [d.code, d]));
  return card(title,
    err && notice("warn", `讀不到私人持股：${err.reason?.message || "未知原因"}`),
    aR.status === "fulfilled" && activeFund(aR.value, mgr),
    bR.status === "fulfilled" && indexFund(bR.value, calR, today),
    exposure(pR, funds),
    ok.length > 0 && el("p", { class: "tiny" }, `${PRIVATE_NOTE}。出處：`,
      ok.map((d, i) => [i ? "、" : "", ext(d.source, d.source_name)]), " 的每日持股，平日晚上 21:30、隔天早上 07:00 收集。"),
    privateSettings({ open: !!err }));
}

function fundHead(code, label, s) {
  return [el("h3", {}, `${code} ${label}`),
    el("p", { class: "tiny" }, `${shortDate(s.date)} 持股｜股票 ${s.count} 檔｜前十大 ${s.top10.toFixed(1)}%`,
      s.cash != null ? `｜現金 ${s.cash.toFixed(1)}%` : "", s.futures ? `｜台指期 ${s.futures.toFixed(1)}%` : "",
      s.aum ? `｜規模 ${int(s.aum / 1e8)} 億` : "")];
}

function moveText(m) {
  if (m.kind === "new") return `${shortDate(m.since)} 起，現在 ${lots(m.b)} 張（權重 ${m.wb.toFixed(2)}%）`;
  if (m.kind === "exit") return `原本 ${lots(m.a)} 張（權重 ${m.wa.toFixed(2)}%）`;
  return `${lots(m.a)} → ${lots(m.b)} 張（${m.pct > 0 ? "+" : "−"}${Math.abs(m.pct).toFixed(0)}%），權重 ${m.wa.toFixed(2)}% → ${m.wb.toFixed(2)}%`;
}

function top10Table(doc, hist) {
  const rows = top10Rows(doc, hist);
  const cmp = hist.dates.length > 1;
  const first = shortDate(hist.dates[0]);
  return el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
    el("thead", {}, el("tr", {}, el("th", {}, "前十大"), el("th", {}, "權重"),
      cmp && el("th", {}, `權重比 ${first}`), cmp && el("th", {}, `股數比 ${first}`))),
    el("tbody", {}, rows.map((r) => el("tr", {}, el("td", {}, r.name), el("td", {}, `${r.weight.toFixed(2)}%`),
      cmp && el("td", { class: r.dw == null ? "" : tone(r.dw) }, r.isNew ? el("span", { class: "mv-new" }, "新進") : r.dw == null ? "—" : pp(r.dw)),
      cmp && el("td", {}, r.ds == null ? "—" : Math.abs(r.ds) < 0.5 ? "沒變" : `${r.ds > 0 ? "+" : "−"}${Math.abs(r.ds).toFixed(0)}%`))))));
}

// 00981A：經理人這週買賣了什麼、收集以來新增與出清、前十大
function activeFund({ doc, hist }, mgr) {
  const last = hist.dates.at(-1);
  const from = weekStart(hist.dates);
  const { moves, tokens } = from < last ? fundMoves(hist, from, last) : { moves: [], tokens: 0 };
  const sf = sinceFirst(hist);
  const line = (m) => el("li", {}, el("b", { class: MOVE_CLASS[m.kind] }, `${MOVE_LABEL[m.kind]} ${m.name}`), "：", moveText(m));
  return el("div", { class: "fund" },
    fundHead("00981A", "主動統一台股增長｜經理人選股", fundSummary(doc)),
    mgr && el("div", { class: "ai" }, el("b", {}, "經理人方向（AI 推論）"), mgr.fact,
      el("p", { class: "tiny" }, mgr.reason || "AI 從投信公布的每日持股推論，不是經理人說的。")),
    el("p", { class: "small" }, el("b", {}, `這週（${shortDate(from)} → ${shortDate(last)}）經理人調了什麼`),
      el("span", { class: "tiny" }, `（只列股數變化 ${MOVE_PCT}% 以上的）`)),
    from >= last ? el("p", { class: "muted small" }, "持股只收集到一天，還不能比較。")
      : moves.length ? el("ul", { class: "moves" }, moves.slice(0, 8).map(line))
        : el("p", { class: "muted small" }, `這週沒有股數變化 ${MOVE_PCT}% 以上的。`),
    moves.length > 8 && el("details", { class: "routine" }, el("summary", {}, `其他 ${moves.length - 8} 筆`),
      el("ul", { class: "moves" }, moves.slice(8).map(line))),
    el("p", { class: "tiny" }, `${shortDate(sf.first)} 開始收集以來：新增 ${sf.added.join("、") || "沒有"}；出清 ${sf.removed.join("、") || "沒有"}。`,
      tokens ? `另有 ${tokens} 檔只放幾張的象徵性持股有變動，沒有列出。` : ""),
    top10Table(doc, hist));
}

// 009816：指數規則、換股時程、最近一次換了哪幾檔、前十大
function indexFund({ doc, hist }, calR, today) {
  const closed = calR.status === "fulfilled" ? new Set(calR.value.tw_market?.closed || []) : null;
  const next = closed && review009816(today, closed);
  const ch = lastSetChange(hist);
  const reviews = (doc.reviews || []).slice(0, 3);
  return el("div", { class: "fund" },
    fundHead("009816", "凱基台灣TOP50｜照指數規則換股，不是經理人選股", fundSummary(doc)),
    el("ul", { class: "moves" },
      el("li", {}, el("b", {}, "規則"), "：追蹤臺灣指數公司特選臺灣TOP 50 指數。上市股票先篩流動性與獲利，取市值前 50 檔；自由流通市值加權，權重兼顧動能。"),
      el("li", {}, el("b", {}, "多久換一次"), "：每年 2、5、8、11 月審核，第 7 個交易日為基準日，5 個交易日後收盤生效。照規則換，你不用動作。"),
      next && el("li", {}, el("b", {}, "下一次"), `：基準日 ${dayLabel(next.base)}，約 ${dayLabel(next.effective)} 收盤後生效${next.estimate ? "（預估）" : ""}。`),
      ch ? el("li", {}, el("b", {}, `最近一次成分股變動（${shortDate(ch.from)} → ${shortDate(ch.to)}）`),
        `：納入 ${ch.added.join("、") || "沒有"}；刪除 ${ch.removed.join("、") || "沒有"}。`)
        : el("li", {}, el("b", {}, "換了哪幾檔"), `：每日持股從 ${shortDate(hist.dates[0])} 開始收集，下一次換股後會在這裡列出名單。`),
      reviews.length > 0 && el("li", {}, el("b", {}, "過去幾次（投信公布的檔數）"), "：",
        reviews.map((r) => `${shortDate(r.effective)} 生效，進 ${int(r.added)} 出 ${int(r.removed)}`).join("；"), "。")),
    top10Table(doc, hist));
}

// 你的台股實際押在哪些公司：ETF 市值 × 成分股權重
function exposure(pR, funds) {
  const head = el("b", {}, "你的台股實際押在哪些公司");
  if (pR.status === "rejected") return el("div", { class: "ai" }, head, `讀不到帳本持倉（${pR.reason?.message || "未知原因"}），算不出來。`);
  const lt = lookThrough(pR.value.positions, funds, FUND_CODES);
  if (lt.missing) return el("div", { class: "ai" }, head, `讀不到 ${lt.missing.join("、")} 的持股，先不算。`);
  if (!lt.total) return el("div", { class: "ai" }, head, "帳本沒有台股持倉。");
  const tsmc = lt.items.find((x) => x.code === "2330");
  return el("div", { class: "ai" }, head,
    `台股部位 ${twd(lt.total)}，把 ETF 拆開來看，前五大是：`,
    el("ol", { class: "hot" }, lt.items.slice(0, 5).map((x) => el("li", {}, `${x.name} ${twd(x.value)}（${(x.value / lt.total * 100).toFixed(1)}%）`))),
    tsmc && el("p", { class: "small" }, `台積電來自 ${tsmc.via.map((v) => `${v.code} ${twd(v.value)}（權重 ${v.weight.toFixed(2)}%）`).join(" ＋ ")}。`),
    el("p", { class: "tiny" }, `市值用帳本持倉 × 最新價，權重用 ${[...new Set(lt.dates)].map(shortDate).join("、")} 的持股；ETF 還有現金與期貨，所以加起來不到 100%。`));
}

// ── 展望
async function outlookView() {
  const today = taipeiToday();
  const [{ events, failed }, v] = await Promise.all([outlookEvents(today), loadNewsView().catch(() => null)]);
  const quotes = v?.outlookRows || [];
  const until = (d) => {
    const n = Math.round((Date.parse(d) - Date.parse(today)) / 864e5);
    return n === 0 ? "今天" : n === 1 ? "明天" : `${n} 天後`;
  };
  return card("展望：接下來要注意的事",
    events.length ? el("div", { class: "ev-list" }, events.map((e) => el("div", { class: "ev" },
      el("span", { class: "d" }, e.when, el("small", {}, until(e.date))),
      el("span", { class: "t" }, e.title, e.estimate && el("span", { class: "mini" }, "預估")),
      el("span", { class: "m" }, e.note))))
      : el("p", { class: "muted" }, "75 天內沒有排定的事件。"),
    quotes.length > 0 && [el("h3", {}, "法人與媒體怎麼看（引述）"),
      el("ul", { class: "nsf-list" }, quotes.map((q) => el("li", {}, q.fact,
        el("span", { class: "k" }, q.url ? ext(q.url, q.source || "出處") : q.source, q.eventTime && `・${q.eventTime}`)))),
      el("p", { class: "tiny" }, `新聞晨報 ${taipeiTime(v.generatedAt)} 整理，引述主要媒體或法人的說法，不是預測，也不是本站的看法。`)],
    el("div", { class: "ai" }, el("b", {}, "你的計畫什麼時候會變"),
      "只有你的規則會改變動作：每月 6 日入金照 80／20，4 月與 10 月檢查比例。短期漲跌、法人看多看空都不改變計畫。"),
    failed.length > 0 && el("p", { class: "tiny" }, `讀不到：${failed.join("、")}（相關事件沒有列出）。`),
    el("p", { class: "tiny" }, "只列已排定的事件與照規則算出的日期，不預測漲跌。009816 審核日照指數規則推算，以臺灣指數公司公告為準。"));
}

// ── 總經
async function macroView() {
  const [{ tiles, failed }, v] = await Promise.all([macroTiles(), loadNewsView().catch(() => null)]);
  const sum = v?.macroSummary;
  return card("總經",
    el("div", { class: "tiles" }, tiles.map((t) => el("div", { class: "mt" },
      el("div", { class: "n" }, t.name, t.date && el("span", {}, t.date)),
      t.missing ? el("div", { class: "v muted" }, "讀不到")
        : [el("div", { class: `v ${t.tone || ""}` }, t.value, t.change && el("small", {}, t.change)),
          el("div", { class: "x" }, t.text)]))),
    sum && el("div", { class: "ai" }, el("b", {}, "AI 總結"), sum.fact,
      el("p", { class: "tiny" }, `新聞晨報 ${taipeiTime(v.generatedAt)}・AI 依上面的數字與新聞整理，只描述現況，不是預測。`, sum.reason ? `資料：${sum.reason}` : "")),
    failed.length > 0 && el("p", { class: "tiny" }, `讀不到：${failed.join("、")}。`),
    el("p", { class: "tiny" }, "數字來自 market-data（美股與原油收盤、匯率、證交所三大法人、國發會景氣燈號、FRED）。說明照固定規則產生，只描述方向。"));
}

// ── 持股新聞（不經 AI）＋ 多家媒體都在報
async function feedView(arg) {
  const d = await loadHeadlines();
  const items = sortItems(d.items || []);
  const now = Date.now();
  const tabNames = TABS.map(([n]) => n);
  let cur = Math.max(0, tabNames.indexOf(arg));
  let loose = false;
  let shown = 15;

  const tabs = el("div", { class: "ftabs", role: "group", "aria-label": "篩選持股" });
  const list = el("div", { class: "feed" });
  const item = (x) => {
    const src = x.also?.length ? `${x.source} 等 ${x.also.length + 1} 家` : x.source;
    const tags = holdTags(x).map(([c, direct]) => el("span", { class: "mini hold" }, direct ? c : `內文提到 ${c}`));
    return el("div", { class: "fi" },
      el("div", { class: "fi-meta" }, el("span", {}, `${src}・${ago(timeOf(x), now)}`),
        x.tier >= 3 && el("span", { class: "mini low" }, TIER_LABEL[x.tier] === "其他" ? "非主要媒體" : TIER_LABEL[x.tier])),
      el("a", { class: "fi-title", href: x.url || x.link, target: "_blank", rel: "noopener noreferrer" }, x.title),
      tags.length > 0 && el("div", { class: "fi-tags" }, tags));
  };
  const draw = () => {
    const rows = items.filter((x) => TABS[cur][1](x, loose));
    tabs.replaceChildren(...TABS.map(([name, f], i) => el("button", {
      class: "ftab", type: "button", "aria-pressed": String(i === cur),
      onclick: () => { cur = i; shown = 15; draw(); },
    }, name, el("span", { class: "n" }, items.filter((x) => f(x, loose)).length))));
    list.replaceChildren(
      ...(rows.length ? rows.slice(0, shown).map(item) : [el("p", { class: "muted" }, "72 小時內沒有符合的新聞。")]),
      el("div", { class: "row more-btn" },
        rows.length > shown && el("button", { class: "btn", type: "button", onclick: () => { shown += 15; draw(); } },
          `顯示更多（還有 ${rows.length - shown} 則）`),
        el("button", { class: "btn ghost", type: "button", onclick: () => { loose = !loose; shown = 15; draw(); } },
          loose ? "只看標題提到持股、主要媒體的" : "也顯示內文提到、非主要媒體的")));
  };
  draw();

  const hot = hotList(items, now);
  return el("div", { class: "layout" },
    card("持股新聞", tabs, list,
      el("p", { class: "tiny" }, `${taipeiTime(d.generated_at_utc)} 整理（最近 72 小時，Google News 與中央社的標題，沒有經過 AI）。`)),
    card("多家媒體都在報",
      hot.length ? el("ol", { class: "hot" }, hot.map((x) => el("li", {},
        el("a", { href: x.url || x.link, target: "_blank", rel: "noopener noreferrer" }, x.title),
        el("span", { class: "k" }, `${x.also.length + 1} 家報導・${ago(timeOf(x), now)}`))))
        : el("p", { class: "muted small" }, "最近沒有多家同時報導的持股新聞。"),
      el("p", { class: "tiny" }, "最近 36 小時，跟持股或台股有關、不只一家報導的，依家數排。")));
}

// ── 新聞晨報整理的事件、話題、情緒
async function moreView() {
  const [vR, fg, topics] = await Promise.all([loadNewsView().then((v) => ({ v }), (e) => ({ e })),
    loadFearGreed().catch(() => null), loadTopics().catch(() => null)]);
  const v = vR.v;
  const sentiment = await sentimentParts(v || null);
  const sections = v ? SECTIONS.map((name) => {
    // 只有已不關注的代號（00411A）的事件不列
    const inSec = v.events.filter((e) => sectionOf(e) === name && !(e.codes.length && e.codes.every((c) => DROPPED.has(c))));
    // 晨報為每個沒消息的標的寫一列「無重大消息」，併成一行
    const quiet = inSec.filter((e) => /^無重大消息/.test(e.fact || ""));
    const evs = inSec.filter((e) => !quiet.includes(e));
    if (!evs.length && !quiet.length) return null;
    return el("div", {},
      el("h3", {}, `${name}（${evs.length}）`),
      evs.map((e) => evLine(e, v.ctx)),
      quiet.length > 0 && el("p", { class: "tiny" }, `無重大消息：${quiet.flatMap((e) => e.codes.length ? e.codes : e.symbols).join("、")}`));
  }) : [];
  return [
    v ? el("details", { class: "card more routine" },
      el("summary", {}, `新聞晨報整理的事件（${v.events.length} 件，有查證與來源等級）`),
      sections, topicTable(topics),
      v.summaryRow && el("p", { class: "tiny" }, `晨報輸入狀態：${v.summaryRow.fact}`))
      : notice("err", `讀不到新聞晨報：${vR.e?.message || ""}`),
    card("情緒",
      el("div", { class: "sent-grid" },
        el("div", { class: "fg-pair" },
          fg ? gaugeBlock("CNN 恐懼貪婪（美股）", `更新 ${taipeiTime(fg.time_utc)}`, cnnReading(fg), "沒有分數") : notice("err", "讀不到 CNN 恐懼貪婪"),
          pocketBlock(v?.pocket, v ? null : "讀不到新聞分頁")),
        el("div", { class: "sent-line" }, sentiment.join("・"),
          el("div", { class: "tiny" }, "情緒只當參考。")))),
  ];
}

// 第一層的話題統計（data/news/topics.json）：本週相對 30 天平均上升最多的主題
function topicTable(t) {
  const list = (t?.topics || []).filter((x) => x.count_7d > 0)
    .sort((a, b) => b.rise - a.rise || b.count_7d - a.count_7d).slice(0, 5);
  if (!list.length) return null;
  return el("div", {},
    el("h3", {}, "標題裡常出現的主題（第一層統計）"),
    el("div", { class: "table-wrap" }, el("table", { class: "nowrap" },
      el("thead", {}, el("tr", {}, ["主題", "24 小時", "7 天", "上升倍數"].map((h, i) => el("th", { class: i ? "r" : "" }, h)))),
      el("tbody", {}, list.map((x) => el("tr", {}, el("td", {}, x.label || x.topic), el("td", { class: "r" }, x.count_1d),
        el("td", { class: "r" }, x.count_7d), el("td", { class: "r" }, x.rise.toFixed(1))))))),
    el("p", { class: "tiny" }, `${t.generated_at_taipei} 統計；歷史 ${t.days_available} 天（不足 30 天時上升倍數參考就好）。固定規則計數，不做預測。`));
}

// 今天的重點與旗標（總覽也用）
export function highlightsCard(v, { title = "今天的重點", link = false } = {}) {
  const { by, items } = v.highlights;
  const list = items.length
    ? el("ol", { class: "hl-list" }, items.map((h) => el("li", { class: `hl ${h.flag !== "none" ? "flagged" : ""}` },
      el("div", { class: "ev-tags" }, codeChips(h.codes, v.ctx), h.flag !== "none" && flagBadge(h.flag)),
      el("div", { class: "hl-text" }, h.text),
      h.parts ? el("dl", { class: "hl-why" },
        [["對你", h.parts.forYou], ["為什麼", h.parts.why], ["要做什麼", h.parts.todo]].filter(([, t]) => t)
          .map(([k, t]) => el("div", {}, el("dt", {}, k), el("dd", {}, t))))
        // 舊格式（v3）的理由混著事件 ID、Tier、查證來源，收進「查證細節」（docs/INSIGHTS.md 3.1）
        : h.why && (by === "routine"
          ? el("details", { class: "more hl-meta" }, el("summary", {}, "查證細節"), el("div", { class: "tiny" }, h.why))
          : el("div", { class: "tiny" }, `為什麼列入：${h.why}`)),
      !link && h.eventId && el("button", { class: "linkish", type: "button", onclick: () => openEvent(h.eventId) }, "看明細"))))
    : el("p", { class: "muted" }, "今天沒有需要特別注意的事件。");
  const flags = v.flagged.length
    ? el("div", { class: "flag-alert", role: "alert" },
      el("strong", {}, `⚠ 有 ${v.flagged.length} 件建議旗標不是 none`),
      v.flagged.map((e) => el("div", {}, codeChips(e.codes, v.ctx), " ", flagBadge(e.flag), " ", firstSentence(e.fact, 50),
        e.reason && el("div", { class: "tiny" }, e.reason))))
    : null; // 旗標都是 none 時不顯示（內部核對用語，docs/INSIGHTS.md 3.1）
  return card(title, list, flags,
    by === "site" && el("p", { class: "tiny" }, "晨報還沒有「重點」列，先由網站依規則挑：非 none 旗標 → 持有標的、Tier 1～2 且已查證 → 必寫事項（保留一格）。"),
    link && el("p", { class: "small" }, el("a", { href: "#/news" }, `看全部新聞（${v.events.length} 件）→`)));
}

// 「看明細」：晨報事件收在折疊區裡，先打開外層再打開這一則
function openEvent(id) {
  const d = document.getElementById(`ev-${id}`);
  if (!d) return;
  d.closest("details.routine")?.setAttribute("open", "");
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
