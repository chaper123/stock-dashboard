// 技術指標（K 線頁）：成交量、MACD、DMI、乖離率、RSI，以及固定規則的白話描述。
// 只描述現況，不預測；10/29 回測（docs/BACKTEST.md）顯示用技術指標挑買點不比定期定額好，不是配置紀律的一部分。
// KDJ 2026-11-07 拿掉（使用者：太敏感，會影響判斷）。

export function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: +(sum / n).toFixed(4) });
  }
  return out;
}

// RSI14：和 engine/monitor.py、monitor_us.py 的 indicators() 相同——
// d = close.diff()；漲幅、跌幅各用 ewm(alpha=1/14, adjust=False, min_periods=14)；RSI = 100 − 100/(1+au/ad)。
// adjust=False 的遞迴從第一個有效值（第一筆 diff）開始，第 14 個 diff 起才有值。回傳 Map(日期 → RSI)
export function rsi14(bars) {
  const out = new Map();
  const a = 1 / 14;
  let au = null, ad = null;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (au === null) {
      au = g;
      ad = l;
    } else {
      au = (1 - a) * au + a * g;
      ad = (1 - a) * ad + a * l;
    }
    if (i >= 14) {
      const v = ad === 0 ? (au === 0 ? null : 100) : 100 - 100 / (1 + au / ad);
      if (v != null) out.set(bars[i].time, v);
    }
  }
  return out;
}

// 指數移動平均：前 n 筆的簡單平均當起點，之後 α＝2/(n+1)。回傳和 values 等長的陣列（還沒有值的位置是 null）
function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const a = 2 / (n + 1);
  let prev = null, sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (x == null) continue;
    if (prev === null) {
      sum += x;
      if (++cnt === n) out[i] = prev = sum / n;
    } else {
      out[i] = prev = prev + a * (x - prev);
    }
  }
  return out;
}

// MACD(12,26,9)：DIF＝EMA12−EMA26，DEA（訊號線）＝DIF 的 EMA9，柱＝DIF−DEA。回傳 Map(日期 → {dif, dea, hist})
export function macd(bars, fast = 12, slow = 26, signal = 9) {
  const close = bars.map((b) => b.close);
  const f = ema(close, fast), s = ema(close, slow);
  const dif = close.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const dea = ema(dif, signal);
  const out = new Map();
  bars.forEach((b, i) => {
    if (dea[i] != null) out.set(b.time, { dif: dif[i], dea: dea[i], hist: dif[i] - dea[i] });
  });
  return out;
}

// DMI(14)，Wilder 平滑：TR、+DM、−DM 先加總前 14 筆，之後 S＝S−S/14＋今天；
// +DI＝100×S(+DM)/S(TR)、−DI 同理；DX＝100×|+DI−−DI|/(+DI＋−DI)；ADX＝前 14 個 DX 平均，之後 (前ADX×13＋DX)/14。
// 回傳 Map(日期 → {pdi, mdi, adx})，ADX 還沒有值時是 null
export function dmi(bars, n = 14) {
  const out = new Map();
  let str = 0, sp = 0, sm = 0, adx = null;
  const dxs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const up = b.high - p.high, dn = p.low - b.low;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= n) {
      str += tr;
      sp += pdm;
      sm += mdm;
      if (i < n) continue;
    } else {
      str += tr - str / n;
      sp += pdm - sp / n;
      sm += mdm - sm / n;
    }
    const pdi = str ? (100 * sp) / str : 0, mdi = str ? (100 * sm) / str : 0;
    const dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (adx === null) {
      dxs.push(dx);
      if (dxs.length === n) adx = dxs.reduce((a, x) => a + x, 0) / n;
    } else {
      adx = (adx * (n - 1) + dx) / n;
    }
    out.set(b.time, { pdi, mdi, adx });
  }
  return out;
}

// 乖離率：(收盤−N 日均線)÷N 日均線×100。回傳 Map(日期 → %)
export function bias(bars, n) {
  const ma = new Map(sma(bars, n).map((x) => [x.time, x.value]));
  const out = new Map();
  for (const b of bars) {
    const m = ma.get(b.time);
    if (m) out.set(b.time, ((b.close - m) / m) * 100);
  }
  return out;
}

// N 日均量（只算有成交量的 K 棒）。回傳 Map(日期 → 均量)
export function volAvg(bars, n = 20) {
  const out = new Map();
  const win = [];
  let sum = 0;
  for (const b of bars) {
    if (!(b.volume > 0)) continue;
    win.push(b.volume);
    sum += b.volume;
    if (win.length > n) sum -= win.shift();
    if (win.length === n) out.set(b.time, sum / n);
  }
  return out;
}

// 成交量顯示：台股 CSV 是股數，顯示成張（1 張＝1,000 股）；美股顯示股
export function fmtVol(v, market) {
  if (!(v > 0)) return "—";
  const [n, unit] = market === "tw" ? [v / 1000, "張"] : [v, "股"];
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 億${unit}`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 萬${unit}`;
  return `${Math.round(n).toLocaleString("zh-TW")} ${unit}`;
}

const YEAR = 250; // 約一年的交易日
// 最後一個值在最近一年裡排第幾（high＝由大到小；否則由小到大）
function rankInYear(values, high) {
  const win = values.slice(-YEAR);
  const x = win.at(-1);
  const n = win.filter((v) => (high ? v > x : v < x)).length + 1;
  return { n, of: win.length };
}
const rankText = (r, word) => (r.n === 1 ? `近一年最${word}` : `近一年第 ${r.n} ${word}`);

// 白話描述（固定規則，只描述）：回傳 [{ k: 指標, t: 句子 }]
export function describe(bars, market, [n1, n2]) {
  const out = [];
  const last = bars.at(-1);

  // 成交量：最後一根沒有量（例如富果補的那根）就用最近一根有量的
  const vb = bars.filter((b) => b.volume > 0);
  const avg = volAvg(bars, 20);
  const lv = vb.at(-1);
  if (lv && avg.get(lv.time)) {
    const x = lv.volume / avg.get(lv.time);
    const r = rankInYear(vb.map((b) => b.volume), true);
    const when = lv.time === last.time ? "" : `（${lv.time.slice(5).replace("-", "/")}）`;
    out.push({ k: "成交量", t: `${fmtVol(lv.volume, market)}${when}，是 20 日均量的 ${x.toFixed(1)} 倍：${x >= 2 ? "明顯放大" : x >= 1.3 ? "放大" : x <= 0.5 ? "明顯縮小" : x <= 0.77 ? "縮小" : "跟平常差不多"}（${rankText(r, "大")}）。` });
  }

  // 乖離率
  const parts = [];
  for (const n of [n1, n2]) {
    const m = bias(bars, n);
    const vals = [...m.values()];
    if (!vals.length || !m.has(last.time)) continue;
    const b = vals.at(-1);
    const r = rankInYear(vals, b >= 0);
    parts.push(`比 MA${n} ${b >= 0 ? "高" : "低"} ${Math.abs(b).toFixed(1)}%（${rankText(r, b >= 0 ? "高" : "低")}）`);
  }
  if (parts.length) out.push({ k: "乖離率", t: `收盤${parts.join("、")}。` });

  // MACD
  const md = macd(bars);
  const mv = [...md.values()];
  if (mv.length && md.has(last.time)) {
    const neg = mv.at(-1).hist < 0;
    let k = 0;
    for (let i = mv.length - 1; i >= 0 && mv[i].hist < 0 === neg && mv[i].hist !== 0; i--) k++;
    out.push({ k: "MACD", t: `柱狀體連續 ${k} 天為${neg ? "負（短期動能比中期弱）" : "正（短期動能比中期強）"}；DIF 在 0 軸${mv.at(-1).dif < 0 ? "之下" : "之上"}。` });
  }

  // DMI
  const dm = dmi(bars).get(last.time);
  if (dm && dm.adx != null) {
    const a = dm.adx;
    out.push({ k: "DMI", t: `ADX ${a.toFixed(0)}：${a >= 25 ? "趨勢明顯" : a < 20 ? "沒有明顯趨勢" : "趨勢不強"}；${dm.mdi > dm.pdi ? "−DI 高於 +DI，下跌力道較強" : "+DI 高於 −DI，上漲力道較強"}。` });
  }

  // RSI
  const r = rsi14(bars).get(last.time);
  if (r != null) out.push({ k: "RSI14", t: `${r.toFixed(0)}：${r <= 30 ? "低於 30，近期跌得急" : r >= 70 ? "高於 70，近期漲得急" : "在 30～70 之間"}。` });
  return out;
}
