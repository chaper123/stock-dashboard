// 機會頁的計算（docs/INSIGHTS.md 5.2，第一版）：加權指數每一段回落第一次跌到各級距的那天、
// 之後 1／3／6／12 個月的報酬、觸發後這一段還多跌多少、任一交易日買進的對照、加碼試算。
// 全部是純函式：只描述已經發生的事，不預測，也不算「該加碼多少」（使用者 2026-11-11 決定：這頁只當參考、不設預備金）。

export const TIERS = [10, 20, 30]; // 從這一段的高點回落（%）
export const EXPAND_FROM = 20;     // 到這個級距才展開三種做法；10 只提醒
export const HORIZONS = [["1 個月", 21], ["3 個月", 63], ["6 個月", 126], ["12 個月", 252]]; // [說法, 交易日數]

// 回落幅度到了級距沒有：剛好 −10% 也算（(90 / 100 − 1) × 100 在浮點數是 −9.999999999999998，所以留一點容差）
const reached = (dd, tier) => dd <= -tier + 1e-9;

// series：[{date, value}]（由舊到新，收盤）。
// 每一段回落（收盤創新高就重新開始）第一次收盤跌到各級距的那天；一段裡每個級距只記一次
export function tierCrossings(series, tiers = TIERS) {
  const out = new Map(tiers.map((t) => [t, []]));
  if (!series.length) return out;
  let peak = series[0], hit = new Set();
  series.forEach((x, i) => {
    if (x.value >= peak.value) {
      peak = x;
      hit = new Set();
      return;
    }
    const dd = (x.value / peak.value - 1) * 100;
    for (const t of tiers) {
      if (reached(dd, t) && !hit.has(t)) {
        hit.add(t);
        out.get(t).push({ i, date: x.date, value: x.value, peak, dd });
      }
    }
  });
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// 一組報酬（%）的整理：幾次、幾次上漲、最差、中位數、最好；沒有資料回傳 null
export function summarize(rets) {
  if (!rets.length) return null;
  let min = Infinity, max = -Infinity, up = 0;
  for (const r of rets) {
    if (r < min) min = r;
    if (r > max) max = r;
    if (r > 0) up++;
  }
  return { n: rets.length, up, min, median: median(rets), max };
}

// 觸發之後 n 個交易日的報酬（%）；資料還不夠長是 null
export const forward = (series, ev, n) => (ev.i + n < series.length ? (series[ev.i + n].value / ev.value - 1) * 100 : null);

// 觸發之後、回到這一段高點之前的最低收盤，比觸發那天再跌多少（%；0 表示觸發那天就是最低）。
// recovered：回到高點的日子；還沒回到是 null（這時 pct 只是到目前為止）
export function furtherDrop(series, ev) {
  let low = ev.value, lowDate = ev.date, j = ev.i;
  for (; j < series.length && series[j].value < ev.peak.value; j++) {
    if (series[j].value < low) {
      low = series[j].value;
      lowDate = series[j].date;
    }
  }
  return { pct: (low / ev.value - 1) * 100, lowDate, recovered: j < series.length ? series[j].date : null };
}

// 一個級距的整理：每一次（含各期間報酬、還多跌多少）與統計。
// 「還多跌」的統計只算已經回到高點的那幾段，還沒結束的那一段另外列在 rows 裡
export function tierReport(series, events) {
  const rows = events.map((ev) => ({ ...ev, fwd: HORIZONS.map(([, n]) => forward(series, ev, n)), further: furtherDrop(series, ev) }));
  return {
    rows,
    stats: HORIZONS.map(([label], k) => ({ label, s: summarize(rows.map((r) => r.fwd[k]).filter((v) => v != null)) })),
    further: summarize(rows.filter((r) => r.further.recovered).map((r) => r.further.pct)),
  };
}

// 對照：任一交易日買進、n 個交易日後的報酬
export function baseline(series, n) {
  const rets = [];
  for (let i = 0; i + n < series.length; i++) rets.push((series[i + n].value / series[i].value - 1) * 100);
  return summarize(rets);
}

// 現在這一段：高點、最近收盤、離高點、這一段最低、每個級距第一次觸發的那天、到過的最深級距（沒有是 0）
export function currentEpisode(series, tiers = TIERS) {
  let peak = series[0];
  for (const x of series) if (x.value >= peak.value) peak = x;
  const last = series.at(-1);
  const since = series.filter((x) => x.date >= peak.date);
  const low = since.reduce((a, x) => (x.value < a.value ? x : a), since[0]);
  const ddOf = (x) => (x.value / peak.value - 1) * 100;
  const hits = tiers.map((t) => ({ tier: t, hit: since.find((x) => reached(ddOf(x), t)) || null }));
  return { peak, last, dd: ddOf(last), low, lowDd: ddOf(low), hits, top: hits.filter((h) => h.hit).at(-1)?.tier ?? 0 };
}

// 試算：另外拿 amount 元照目標比例買，兩檔各多少、買完的比例。金額由使用者自己輸入，這裡不建議金額。
// target：核心的目標比例（0.8）；price 有給才估股數（零股，無條件捨去）
export function whatIf({ coreMv, satMv, amount, target = 0.8, corePrice = null, satPrice = null }) {
  const addCore = amount * target, addSat = amount - addCore;
  const total = coreMv + satMv, after = total + amount;
  const w = (c, t) => (t > 0 ? (c / t) * 100 : null);
  const dev = (c, t) => (t > 0 ? w(c, t) - target * 100 : null);
  return {
    addCore, addSat,
    sharesCore: corePrice > 0 ? Math.floor(addCore / corePrice) : null,
    sharesSat: satPrice > 0 ? Math.floor(addSat / satPrice) : null,
    before: { core: w(coreMv, total), dev: dev(coreMv, total) },
    after: { core: w(coreMv + addCore, after), dev: dev(coreMv + addCore, after) },
    growth: total > 0 ? (amount / total) * 100 : null, // 台股部位變大多少（%）
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 第二版：新標的候選篩選（docs/OPPORTUNITY.md 第 4 節）
// 從候選 ETF 裡照固定條件排名：分散型（跟現有組合的連動低）、進攻型（這一段跌得深）。只描述事實，不寫「買哪一檔」。
// 報酬在內部用小數（0.01 ＝ 1%）；輸出的漲跌幅（downAvg、ret、vol、episodeDd…）用百分比（單位 %），和上面一樣可以直接給 pct() 顯示。
// 序列都和行事曆（closes.csv 的日期）等長：index 就是行事曆的第幾個交易日，沒有資料的格子是 null。
// ════════════════════════════════════════════════════════════════════════════

export const WINDOW_DAYS = 250;      // 視窗：行事曆最近 250 個交易日
export const MIN_DAYS = 120;         // 整體連動至少要幾天，不足是「資料不足」
export const MIN_DOWN_DAYS = 40;     // 下跌日連動至少要幾天
export const SPLIT_LIMIT = 0.3;      // 單日漲跌超過 30% 視為分割或資料異常，那一天不算
export const HIGH_CORR = 0.8;        // 連動 ≥ 0.8：幾乎同步
export const MID_CORR = 0.5;         // 0.5～0.8：部分同步；< 0.5：連動低
export const THIN_VALUE = 1e8;       // 日均成交金額 < 1 億元：成交量小
export const MIN_EPISODE_DAYS = 5;   // 這一段（加權指數高點起）不到 5 個交易日，進攻型不排名
export const TRADING_DAYS = 252;     // 年化用
export const TOP_N = 5;              // 每個清單列前幾名
const EPS = 1e-9;                    // 浮點容差：130 ÷ 100 − 1 在浮點數是 0.30000000000000004，剛好 30% 不能算超過

// 每天的報酬：只在「前後兩個交易日都有收盤」時才有值；|報酬| > 30% 那天不算，記在 filtered（i＝行事曆的第幾天）
export function dailyReturns(closes) {
  const r = closes.map(() => null), filtered = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    if (!(a > 0) || !(b > 0)) continue;
    const x = b / a - 1;
    if (Math.abs(x) > SPLIT_LIMIT + EPS) filtered.push({ i, r: x });
    else r[i] = x;
  }
  return { r, filtered };
}

// 還原序列：起點 1，把「算進去的」報酬連乘。present[i] 為真的日子才有值；沒有報酬的日子（空白後的第一天、被濾掉的分割）乘 1，
// 所以分割夾著停牌日（0052 一拆七）也不會出現一個假的大跌
export function adjustedSeries(present, r) {
  let v = null;
  return present.map((p, i) => {
    if (!p) return null;
    v = v === null ? 1 : v * (1 + (r[i] ?? 0));
    return v;
  });
}

// 現有組合的日報酬：核心與衛星「兩檔都有值」的日子才有值
export function portfolioReturns(rCore, rSat, wCore) {
  return rCore.map((x, i) => (x != null && rSat[i] != null ? wCore * x + (1 - wCore) * rSat[i] : null));
}

const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;

// 樣本標準差（n − 1）；不到兩筆是 null
export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// 皮爾森相關係數（−1～1）；不到兩筆、或其中一邊完全不動時是 null
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-20 || syy < 1e-20) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

// 視窗內的年化波動（％，樣本標準差 × √252）與漲跌（％，視窗內報酬連乘）。days：視窗內的日子（行事曆 index）
export function periodStats(r, days) {
  const xs = days.map((i) => r[i]);
  const sd = stdev(xs);
  return {
    vol: sd == null ? null : sd * Math.sqrt(TRADING_DAYS) * 100,
    ret: xs.length ? (xs.reduce((a, x) => a * (1 + x), 1) - 1) * 100 : null,
  };
}

// 行事曆最近 size 個交易日裡，r 有值的日子（index）
function windowDays(r, size = WINDOW_DAYS) {
  const days = [];
  for (let i = Math.max(1, r.length - size); i < r.length; i++) if (r[i] != null) days.push(i);
  return days;
}

// 候選與現有組合的連動。rp、rc：組合與候選的日報酬（與行事曆等長）。
// 視窗＝行事曆最近 size 個交易日裡，兩邊都有報酬的日子（n 天）；整體連動 n < minDays、下跌日連動（只取組合 r_p < 0 的日子）nDown < minDown 都是「資料不足」（值是 null，*Enough 為 false）
export function linkage(rp, rc, { size = WINDOW_DAYS, minDays = MIN_DAYS, minDown = MIN_DOWN_DAYS } = {}) {
  const days = windowDays(rp.map((x, i) => (x != null && rc[i] != null ? x : null)), size);
  const down = days.filter((i) => rp[i] < 0);
  const corrEnough = days.length >= minDays, downEnough = down.length >= minDown;
  return {
    n: days.length,
    corrEnough,
    corr: corrEnough ? pearson(days.map((i) => rp[i]), days.map((i) => rc[i])) : null,
    nDown: down.length,
    downEnough,
    downCorr: downEnough ? pearson(down.map((i) => rp[i]), down.map((i) => rc[i])) : null,
    downAvg: down.length ? mean(down.map((i) => rc[i])) * 100 : null,   // 組合下跌的那些日子，候選的平均漲跌（％）
    downAvgP: down.length ? mean(down.map((i) => rp[i])) * 100 : null,  // 同一批日子，組合自己的平均（％）
    ...periodStats(rc, days),
  };
}

// 這一段（startDate 起，含）的跌幅，用還原序列 adj（與 dates 等長，沒有值是 null）：
// episodeDd＝區間內「最高到其後最低」的最大跌幅；nowDd＝現在（最後一個有值的日子）離區間內最高；rebound＝從區間最低點到現在。單位 ％
export function episodeStats(adj, dates, startDate) {
  let n = 0, runMax = -Infinity, max = -Infinity, min = Infinity, last = null, dd = 0;
  adj.forEach((v, i) => {
    if (v == null || dates[i] < startDate) return;
    n++;
    runMax = Math.max(runMax, v);
    dd = Math.min(dd, v / runMax - 1);
    max = Math.max(max, v);
    min = Math.min(min, v);
    last = v;
  });
  if (n < 2) return { points: n, episodeDd: null, nowDd: null, rebound: null };
  return { points: n, episodeDd: dd * 100, nowDd: (last / max - 1) * 100, rebound: (last / min - 1) * 100 };
}

// 日線（loadDaily 的 [{time, close}]）對齊行事曆：沒有那天的收盤是 null
export function alignCloses(dates, bars) {
  const m = new Map(bars.map((b) => [b.time, b.close]));
  return dates.map((d) => m.get(d) ?? null);
}

const lastIndex = (xs) => {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return i;
  return -1;
};

// 算出所有候選與三列對照（現有組合、核心、衛星）。
//   dates：行事曆；closes：Map(代號 → 收盤序列)；items：universe.json 的 items
//   core、sat：{ code, name, closes }（closes 已對齊 dates，用 data/tw/ 的日線）；target：核心的目標比例（0.8）；peakDate：加權指數這一段高點的日期
// 現有兩檔不進排名（rows 裡拿掉，放在 refs 當對照）
export function evaluateCandidates({ dates, closes, items, core, sat, target = 0.8, peakDate }) {
  const filtered = [];
  const prep = (code, series) => {
    const { r, filtered: f } = dailyReturns(series);
    for (const x of f) filtered.push({ code, date: dates[x.i], r: x.r * 100 });
    return { r, adj: adjustedSeries(series.map((c) => c != null), r) };
  };
  const pCore = prep(core.code, core.closes), pSat = prep(sat.code, sat.closes);
  const rp = portfolioReturns(pCore.r, pSat.r, target);
  const presentP = core.closes.map((c, i) => c != null && sat.closes[i] != null);
  const adjP = adjustedSeries(presentP, rp);

  const episodeDays = dates.filter((d) => d >= peakDate).length;
  const base = (series, adj) => {
    const li = lastIndex(series);
    return { lastDate: li >= 0 ? dates[li] : null, lastClose: li >= 0 ? series[li] : null, ...episodeStats(adj, dates, peakDate) };
  };

  const pdays = windowDays(rp);
  const portfolio = {
    code: "portfolio", name: "現有組合", category: "ref",
    ...base(presentP.map((p) => (p ? 1 : null)), adjP), lastClose: null,
    ...linkage(rp, rp),   // 對自己的連動是 1，只拿它的天數、下跌日平均、年化波動、近一年漲跌
  };
  const refRow = (c, p) => ({ code: c.code, name: c.name, category: "ref", ...base(c.closes, p.adj), ...linkage(rp, p.r) });

  const skipped = [], missing = [], rows = [];
  for (const it of items) {
    if (it.code === core.code || it.code === sat.code) {
      skipped.push(it.code);
      continue;
    }
    const series = closes.get(it.code);
    if (!series) {
      missing.push(it.code);
      continue;
    }
    const p = prep(it.code, series);
    rows.push({
      code: it.code, name: it.name, category: it.category, listed: it.listed, avgValue: it.avg_value ?? null, rank: it.rank ?? rows.length + 1,
      ...base(series, p.adj), ...linkage(rp, p.r),
    });
  }
  return {
    rows, refs: [portfolio, refRow(core, pCore), refRow(sat, pSat)], filtered, skipped, missing,
    window: { size: WINDOW_DAYS, n: pdays.length, from: pdays.length ? dates[pdays[0]] : null, to: pdays.length ? dates[pdays.at(-1)] : null },
    episode: { startDate: peakDate, days: episodeDays, ok: episodeDays >= MIN_EPISODE_DAYS },
    lastDate: dates.at(-1),
  };
}

// 排序：空值（資料不足、沒有資料）一律排最後，同值照日均成交金額名次。dir：1 由小到大，−1 由大到小
export function sortRows(rows, get, dir = 1) {
  const byRank = (a, b) => (a.rank ?? 0) - (b.rank ?? 0);
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null || y == null) return x == null && y == null ? byRank(a, b) : x == null ? 1 : -1;
    const c = typeof x === "string" ? (x < y ? -1 : x > y ? 1 : 0) : x - y;
    return c ? c * dir : byRank(a, b);
  });
}
export const rankDiversifiers = (rows) => sortRows(rows, (r) => r.corr, 1);        // 整體連動由低到高
export const rankAggressive = (rows) => sortRows(rows, (r) => r.episodeDd, 1);     // 這一段跌幅由深到淺（負得多的在前）

export const corrBand = (corr) => (corr == null ? null : corr >= HIGH_CORR ? "high" : corr >= MID_CORR ? "mid" : "low");

// 判讀句：固定規則，只寫事實、理由與代價。kind：「diversify」或「aggressive」
export function verdict(row, kind) {
  const out = [];
  const band = corrBand(row.corr);
  if (band === "high") out.push("和現有持股幾乎同步，分散效果有限");
  else if (band === "mid") out.push("部分同步");
  else if (band === "low") out.push("連動低");
  else if (!row.corrEnough) out.push(`連動資料不足（只有 ${row.n} 天，至少要 ${MIN_DAYS} 天）`);
  if (row.category === "overseas") out.push("多一層匯率；美股收盤比台股晚，用日資料算的連動會偏低");
  if (row.avgValue != null && row.avgValue < THIN_VALUE) out.push("成交量小，買賣價差可能較大");
  if (kind === "aggressive") out.push("跌得深不代表會彈得多；連動高等於加碼同一個風險");
  return out;
}
