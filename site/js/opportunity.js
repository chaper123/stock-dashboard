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
