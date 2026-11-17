// 試算頁「N 年後」的歷史回測推算（docs/FUNDS_BACKTEST.md）。純函式：不讀網路、不碰 DOM。
// 輸入是指數的日資料 [{ date: "YYYY-MM-DD", value }]（loadIndex("TAIEX_TR") 的結果，由舊到新）。
// 推算只是「把歷史上的月報酬套在現在的資產與定投上」，不是預測。

export const BLOCK_MONTHS = 12;     // 區塊抽樣：每次連續取 12 個月的月報酬
export const SAMPLE_PATHS = 2000;   // 抽樣推估的路徑數
export const SAMPLE_SEED = 20261113; // 固定種子：同樣的輸入每次算出來都一樣（不要改成隨機）
export const MIN_ROLLING = 24;      // 滾動區間的起點不到這個個數，標「樣本太少」
export const PERCENTILES = [0.1, 0.5, 0.9];

// 固定種子的亂數（mulberry32），回傳 [0, 1) 的小數
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 每個月最後一個交易日的收盤。資料最後一天所在的月份還沒結束，不用
export function monthEnds(series) {
  const out = [];
  for (const p of series) {
    const ym = p.date.slice(0, 7);
    if (out.length && out.at(-1).ym === ym) out[out.length - 1] = { ym, date: p.date, value: p.value };
    else out.push({ ym, date: p.date, value: p.value });
  }
  out.pop();
  return out;
}

// 月報酬：相鄰兩個月底相除減 1。ym 是這筆報酬所屬的月份（後一個月底）；第一筆是第二個月底相對第一個月底
export function monthlyReturns(series) {
  const ends = monthEnds(series);
  return ends.slice(1).map((e, i) => ({ ym: e.ym, r: e.value / ends[i].value - 1 }));
}

const rate = (x) => (typeof x === "number" ? x : x.r);

// 模擬：每月 value = value × (1 + r) + pmt（月底投入），回傳每個月底的值（長度等於 returns 的個數）
export function simulate(pv, pmt, returns) {
  const out = [];
  let v = pv;
  for (const x of returns) {
    v = v * (1 + rate(x)) + pmt;
    out.push(v);
  }
  return out;
}

// 百分位：由小到大排序，位置 p × (n − 1)，落在兩個值之間就線性內插。沒有資料回傳 null
export function percentiles(values, ps) {
  if (!values.length) return ps.map(() => null);
  const s = Float64Array.from(values).sort();
  return ps.map((p) => {
    const pos = p * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    if (s[lo] === s[hi]) return s[lo];
    if (!Number.isFinite(s[hi])) return s[hi]; // 到不了（Infinity）的路徑排在最後，內插到它就算到不了
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  });
}
export const percentile = (values, p) => percentiles(values, [p])[0];

// 歷史上真的發生過：每個能湊滿 months 個連續月報酬的起點各跑一次，取期末值。
// 回傳個數、最差／最好（期末值與開始的年月）、中位數；起點不到 MIN_ROLLING 個標 small（20 年只有約 46 個起點，彼此高度重疊）
export function rollingWindows(returns, months, pv, pmt) {
  const n = returns.length - months + 1;
  if (months <= 0 || n < 1) return { count: 0, small: true, worst: null, median: null, best: null };
  const finals = [];
  let worst = null, best = null;
  for (let i = 0; i < n; i++) {
    let v = pv;
    for (let j = 0; j < months; j++) v = v * (1 + rate(returns[i + j])) + pmt;
    finals.push(v);
    const start = returns[i].ym ?? i;
    if (!worst || v < worst.value) worst = { value: v, start };
    if (!best || v > best.value) best = { value: v, start };
  }
  return { count: n, small: n < MIN_ROLLING, worst, median: percentile(finals, 0.5), best };
}

// 一條抽樣路徑的月報酬：重複「隨機挑一個起點，取連續 block 個月（超過結尾就接回開頭）」，湊滿 months 個月後截斷
export function blockPath(returns, months, rng, block = BLOCK_MONTHS) {
  const n = returns.length, out = [];
  while (out.length < months) {
    const start = Math.floor(rng() * n);
    for (let j = 0; j < block && out.length < months; j++) out.push(rate(returns[(start + j) % n]));
  }
  return out;
}

// 抽樣推估（區塊抽樣）：paths 條路徑各自模擬，回傳
// final：期末值的第 10、50、90 百分位；yearly：每一年年底的這三個百分位（畫圖用）；
// principal：投入本金合計（pv ＋ pmt × months）；below：期末值低於投入本金的路徑比例
export function blockSample(returns, months, pv, pmt, { paths = SAMPLE_PATHS, block = BLOCK_MONTHS, seed = SAMPLE_SEED } = {}) {
  const principal = pv + pmt * months;
  if (!returns.length || months <= 0) return { paths: 0, principal, final: null, yearly: [], below: null };
  const rng = mulberry32(seed);
  const years = Math.floor(months / 12);
  const atYear = Array.from({ length: years }, () => new Float64Array(paths));
  const finals = new Float64Array(paths);
  let below = 0;
  for (let k = 0; k < paths; k++) {
    const rs = blockPath(returns, months, rng, block);
    let v = pv;
    for (let m = 0; m < months; m++) {
      v = v * (1 + rs[m]) + pmt;
      if ((m + 1) % 12 === 0) atYear[(m + 1) / 12 - 1][k] = v;
    }
    finals[k] = v;
    if (v < principal) below++;
  }
  const [p10, p50, p90] = percentiles(finals, PERCENTILES);
  return {
    paths, principal, below: below / paths,
    final: { p10, p50, p90 },
    yearly: atYear.map((vals, i) => {
      const [a, b, c] = percentiles(vals, PERCENTILES);
      return { year: i + 1, p10: a, p50: b, p90: c };
    }),
  };
}

// 投入本金逐年累積：第 y 年（0～years）是 pv ＋ pmt × 12y（圖上的灰色虛線）
export function principalLine(pv, pmt, years) {
  return Array.from({ length: years + 1 }, (_, y) => pv + pmt * 12 * y);
}

// 回測期間的描述：月報酬的起訖年月、這段期間的年化報酬、最大回落（月底資料，含第一個月底當起點）
export function describeBacktest(series) {
  const ends = monthEnds(series);
  if (ends.length < 2) return null;
  const months = ends.length - 1;
  let peak = ends[0], maxDd = 0, dd = null;
  for (const e of ends) {
    if (e.value > peak.value) peak = e;
    const d = e.value / peak.value - 1;
    if (d < maxDd) {
      maxDd = d;
      dd = { peak: peak.ym, trough: e.ym };
    }
  }
  return {
    from: ends[1].ym, to: ends.at(-1).ym, base: ends[0].ym, months, years: months / 12,
    annualized: Math.pow(ends.at(-1).value / ends[0].value, 12 / months) - 1,
    maxDrawdown: maxDd, drawdown: dd,
  };
}

// ── 財富自由試算（docs/FUNDS_BACKTEST.md 第二部分）──
export const MAX_MONTHS = 1200; // 多久存到的上限：100 年，到上限還沒達標就是 Infinity（畫面寫「100 年以上」）

// 每條抽樣路徑的 G（累積成長倍數）與 A（每月月底投 1 元，累積到期末的金額）。
// 同一條路徑上，期末值 ＝ pv × G ＋ pmt × A（對 pv、pmt 都是線性的），所以需要的每月投入可以直接算、不用試誤。
// 路徑的抽法跟 blockSample 完全一樣（同一個種子、同一個順序），所以「N 年後」與這裡看的是同一批路徑
export function pathGrowth(returns, months, { paths = SAMPLE_PATHS, block = BLOCK_MONTHS, seed = SAMPLE_SEED } = {}) {
  if (!returns.length || months <= 0) return { paths: 0, months, G: new Float64Array(0), A: new Float64Array(0) };
  const rng = mulberry32(seed);
  const G = new Float64Array(paths), A = new Float64Array(paths);
  for (let k = 0; k < paths; k++) {
    let g = 1, a = 0;
    for (const r of blockPath(returns, months, rng, block)) {
      g *= 1 + r;
      a = a * (1 + r) + 1;
    }
    G[k] = g;
    A[k] = a;
  }
  return { paths, months, G, A };
}

// N 年內要達標，每月要投多少：每條路徑需要 max(0, (目標 − pv × G) ÷ A)，2,000 條取第 10、50、90 百分位。
// 第 10 是偏好的情況（投得少就夠）、第 90 是偏差的情況（要投更多）。target 是 N 年後的金額
export function requiredMonthly(ga, pv, target) {
  if (!ga.paths) return null;
  const need = new Float64Array(ga.paths);
  for (let k = 0; k < ga.paths; k++) need[k] = Math.max(0, (target - pv * ga.G[k]) / ga.A[k]);
  const [p10, p50, p90] = percentiles(need, PERCENTILES);
  return { p10, p50, p90 };
}

// 照現在的每月投入，N 年內達標的機率：期末值大於等於目標的路徑比例
export function hitProbability(ga, pv, pmt, target) {
  if (!ga.paths) return null;
  let hit = 0;
  for (let k = 0; k < ga.paths; k++) if (pv * ga.G[k] + pmt * ga.A[k] >= target) hit++;
  return hit / ga.paths;
}

// 多久存到目標：每條路徑照現在的每月投入一個月一個月往下跑（區塊不夠就繼續抽），到資產大於等於「當月的目標」為止。
// targetAt(n) 是第 n 個月底的目標（有通膨時每個月跟著長）；第 0 個月就達標回 0；到 max 個月還沒達標是 Infinity。
// 回傳第 10、50、90 百分位（單位：月；第 10 是偏好的情況、比較快，第 90 是偏差的情況、比較慢）與沒達標的路徑比例。
// 這一項自己從種子開始抽，不跟其他計算共用亂數
export function monthsToTarget(returns, pv, pmt, targetAt, { paths = SAMPLE_PATHS, block = BLOCK_MONTHS, seed = SAMPLE_SEED, max = MAX_MONTHS } = {}) {
  const len = returns.length;
  if (!len) return null;
  const rng = mulberry32(seed);
  const out = new Float64Array(paths);
  let never = 0;
  for (let k = 0; k < paths; k++) {
    let v = pv, hit = Infinity, start = 0, j = block;
    if (v >= targetAt(0)) hit = 0;
    else {
      for (let n = 1; n <= max; n++) {
        if (j >= block) {
          start = Math.floor(rng() * len);
          j = 0;
        }
        v = v * (1 + rate(returns[(start + j++) % len])) + pmt;
        if (v >= targetAt(n)) {
          hit = n;
          break;
        }
      }
    }
    out[k] = hit;
    if (hit === Infinity) never++;
  }
  const [p10, p50, p90] = percentiles(out, PERCENTILES);
  return { p10, p50, p90, unreached: never / paths };
}

// 歷史上真的發生過：每個能湊滿 months 個連續月報酬的起點，實際需要的每月投入。
// best 是需要最少的（含起始年月）、worst 是需要最多的、median 是中位數；起點不到 MIN_ROLLING 個標 small
export function rollingRequired(returns, months, pv, target) {
  const n = returns.length - months + 1;
  if (months <= 0 || n < 1) return { count: 0, small: true, worst: null, median: null, best: null };
  const need = [];
  let worst = null, best = null;
  for (let i = 0; i < n; i++) {
    let g = 1, a = 0;
    for (let j = 0; j < months; j++) {
      const r = rate(returns[i + j]);
      g *= 1 + r;
      a = a * (1 + r) + 1;
    }
    const v = Math.max(0, (target - pv * g) / a);
    need.push(v);
    const start = returns[i].ym ?? i;
    if (!best || v < best.value) best = { value: v, start };
    if (!worst || v > worst.value) worst = { value: v, start };
  }
  return { count: n, small: n < MIN_ROLLING, worst, median: percentile(need, 0.5), best };
}

// ── 生命週期試算（docs/FUNDS_BACKTEST.md 第三部分）──
// 現在到退休每月投入、退休後每月提領（今天的錢，每月跟著通膨長）到預期壽命。路徑與第一部分一樣：固定種子、依序 blockPath，
// lifecycleSpend 與 lifecycleRun 各自從種子重新開始，所以看的是同一組 2,000 條路徑。

// 年齡 → 存錢月數 S、提領月數 D、總月數 N；退休 ≤ 現在或壽命 ≤ 退休時不算（回傳 null）
export function lifecycleSpan(now, retire, life) {
  if (![now, retire, life].every(Number.isFinite) || retire <= now || life <= retire) return null;
  const S = Math.round((retire - now) * 12), D = Math.round((life - retire) * 12);
  return { S, D, N: S + D };
}
// 月通膨：年通膨換成等值的月通膨
export const monthlyInflation = (infl) => Math.pow(1 + infl, 1 / 12) - 1;

// 每月可花多少：每條路徑算 G（整段累積倍數）、A（存錢期每月投 1 元累積到第 N 個月）、B（提領期每月領「今天的 1 元」累積到第 N 個月），
// 第 N 個月的資產 ＝ pv × G ＋ pmt × A − W × B，對 W 線性，所以剛好用完的花費 W* ＝ max(0, (pv × G ＋ pmt × A) ÷ B)，直接算。
// retire 是退休時（第 S 個月月底）的資產，換成今天的錢（除以 f_S）；retireNominal 是名目；spend 是 W* 的百分位（今天的錢）。
// W（Float64Array）與 retireAssets（今天的錢）是每條路徑的值，測試與核對用
export function lifecycleSpend(returns, { pv, pmt, infl, S, D }, { paths = SAMPLE_PATHS, block = BLOCK_MONTHS, seed = SAMPLE_SEED } = {}) {
  const N = S + D;
  if (!returns.length || !(S > 0) || !(D > 0)) return { paths: 0, S, D, N, retire: null, retireNominal: null, spend: null, W: new Float64Array(0), retireAssets: new Float64Array(0) };
  const m = monthlyInflation(infl);
  const f = new Float64Array(N + 1); // f[t]：第 t 個月的通膨倍數
  for (let t = 0; t <= N; t++) f[t] = Math.pow(1 + m, t);
  const rng = mulberry32(seed);
  const W = new Float64Array(paths), retireAssets = new Float64Array(paths), retireNom = new Float64Array(paths);
  for (let k = 0; k < paths; k++) {
    const rs = blockPath(returns, N, rng, block);
    let g = 1, a = 0, b = 0, gS = 1, aS = 0;
    for (let t = 1; t <= N; t++) {
      const r1 = 1 + rs[t - 1];
      g *= r1;
      a = a * r1 + (t <= S ? 1 : 0);
      b = b * r1 + (t > S ? f[t] : 0);
      if (t === S) { gS = g; aS = a; }
    }
    W[k] = Math.max(0, (pv * g + pmt * a) / b);
    retireNom[k] = pv * gS + pmt * aS;
    retireAssets[k] = retireNom[k] / f[S];
  }
  const [r10, r50, r90] = percentiles(retireAssets, PERCENTILES);
  const [n10, n50, n90] = percentiles(retireNom, PERCENTILES);
  const [w10, w50, w90] = percentiles(W, PERCENTILES);
  return {
    paths, S, D, N, W, retireAssets,
    retire: { p10: r10, p50: r50, p90: r90 },
    retireNominal: { p10: n10, p50: n50, p90: n90 },
    spend: { p10: w10, p50: w50, p90: w90 },
  };
}

// 照某個花費 W（今天的錢，每月）跑一遍：某個月算完小於 0 就記為「第 t 個月用完」，之後資產當 0、不再提領。
// survive：錢撐到預期壽命的機率（沒有用完的路徑比例）；depleted：用完月份的第 10、50 百分位（沒用完的路徑當成無限大，
// 內插碰到沒用完的路徑記成 null）；yearly：第 0、1、…、N ÷ 12 年年底資產（用完後是 0，換成今天的錢）的第 10、50、90 百分位，第 0 年就是 pv
export function lifecycleRun(returns, { pv, pmt, infl, S, D, W }, { paths = SAMPLE_PATHS, block = BLOCK_MONTHS, seed = SAMPLE_SEED } = {}) {
  const N = S + D;
  if (!returns.length || !(S > 0) || !(D > 0)) return { paths: 0, S, D, N, survive: null, depleted: null, yearly: [], depleteMonths: new Float64Array(0) };
  const m = monthlyInflation(infl);
  const f = new Float64Array(N + 1);
  for (let t = 0; t <= N; t++) f[t] = Math.pow(1 + m, t);
  const years = Math.floor(N / 12);
  const atYear = Array.from({ length: years + 1 }, () => new Float64Array(paths));
  atYear[0].fill(pv);
  const ends = new Float64Array(paths); // 用完的月份（沒用完是 Infinity）
  const rng = mulberry32(seed);
  let alive = 0;
  for (let k = 0; k < paths; k++) {
    const rs = blockPath(returns, N, rng, block);
    let v = pv, dead = Infinity;
    for (let t = 1; t <= N; t++) {
      if (dead === Infinity) {
        v = v * (1 + rs[t - 1]) + (t <= S ? pmt : -W * f[t]);
        if (v < 0) { dead = t; v = 0; }
      }
      if (t % 12 === 0) atYear[t / 12][k] = v / f[t];
    }
    ends[k] = dead;
    if (dead === Infinity) alive++;
  }
  const fin = (x) => (Number.isFinite(x) ? x : null);
  const [d10, d50] = percentiles(ends, [0.1, 0.5]);
  return {
    paths, S, D, N, survive: alive / paths, depleteMonths: ends,
    depleted: { p10: fin(d10), p50: fin(d50) },
    yearly: atYear.map((vals, y) => {
      const [a, b, c] = percentiles(vals, PERCENTILES);
      return { year: y, p10: a, p50: b, p90: c };
    }),
  };
}
