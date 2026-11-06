// 「你的 ETF 裡面在變什麼」的計算（不碰畫面）。資料是私人 repo 的每日持股（private.js 的 loadFund）。
// 股數變化 5% 以上才算經理人有動作：權重變化多半只是股價漲跌。

export const MOVE_PCT = 5;
// 權重低於這個的（只放幾張的象徵性持股）不列進買賣清單，只算檔數
export const TOKEN_WEIGHT = 0.1;
const DAY = 864e5;

export const cleanName = (s) => String(s || "").replace(/\*+$/, "");

// 「這週」的起點：最新資料日 7 天前（含）或更早的最後一個資料日；
// 收集不到一週就用第一天
export function weekStart(dates) {
  const last = dates.at(-1);
  const cut = new Date(Date.parse(`${last}T00:00:00Z`) - 7 * DAY).toISOString().slice(0, 10);
  return [...dates].reverse().find((d) => d <= cut) || dates[0];
}

// 兩個資料日之間的動作：new 新買、add 加碼、cut 減碼、exit 出清。回傳 { moves, tokens（象徵性持股的檔數） }
export function fundMoves(hist, from, to) {
  const A = hist.by.get(from), B = hist.by.get(to);
  const moves = [];
  let tokens = 0;
  for (const c of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(c), b = B.get(c), x = b || a;
    const pct = a?.shares ? ((b?.shares || 0) - a.shares) / a.shares * 100 : Infinity;
    const kind = !a ? "new" : !b ? "exit" : pct >= MOVE_PCT ? "add" : pct <= -MOVE_PCT ? "cut" : null;
    if (!kind) continue;
    const wa = a?.weight ?? 0, wb = b?.weight ?? 0;
    if (Math.max(wa, wb) < TOKEN_WEIGHT) {
      tokens += 1;
      continue;
    }
    moves.push({ code: c, name: cleanName(x.name), kind, a: a?.shares || 0, b: b?.shares || 0, wa, wb, pct,
      since: kind === "new" ? hist.dates.find((d) => d > from && d <= to && hist.by.get(d).has(c)) : null });
  }
  const ORDER = { new: 0, add: 1, cut: 2, exit: 3 };
  moves.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || Math.abs(y.wb - y.wa) - Math.abs(x.wb - x.wa));
  return { moves, tokens };
}

// 跟第一天比：新增、出清的股票（不含象徵性持股）
export function sinceFirst(hist) {
  const F = hist.by.get(hist.dates[0]), L = hist.by.get(hist.dates.at(-1));
  const real = (x) => x.weight >= TOKEN_WEIGHT;
  return {
    first: hist.dates[0],
    added: [...L.values()].filter((x) => !F.has(x.code) && real(x)).map((x) => cleanName(x.name)),
    removed: [...F.values()].filter((x) => !L.has(x.code) && real(x)).map((x) => cleanName(x.name)),
  };
}

// 最近一次成分股變動（指數型 ETF 換股）：由新到舊找前後兩個資料日成分不同的那一次
export function lastSetChange(hist) {
  for (let i = hist.dates.length - 1; i > 0; i--) {
    const A = hist.by.get(hist.dates[i - 1]), B = hist.by.get(hist.dates[i]);
    const added = [...B.values()].filter((x) => !A.has(x.code)).map((x) => cleanName(x.name));
    const removed = [...A.values()].filter((x) => !B.has(x.code)).map((x) => cleanName(x.name));
    if (added.length || removed.length) return { from: hist.dates[i - 1], to: hist.dates[i], added, removed };
  }
  return null;
}

// 前十大跟第一天比：權重差（百分點）、股數變化（%）
export function top10Rows(doc, hist) {
  const F = hist.dates.length > 1 ? hist.by.get(hist.dates[0]) : null;
  return (doc.top10 || []).map((t) => {
    const f = F?.get(t.code);
    const l = (doc.holdings || []).find((h) => h.code === t.code);
    return {
      code: t.code, name: cleanName(t.name), weight: t.weight,
      dw: f ? t.weight - f.weight : null,
      ds: f && l?.shares ? (l.shares - f.shares) / f.shares * 100 : null,
      isNew: !!F && !f,
    };
  });
}

// 一檔 ETF 的概況：檔數、前十大合計、現金比重、期貨（多單）比重、規模
export function fundSummary(doc) {
  const cash = doc.other_assets?.["現金"];
  return {
    date: doc.date,
    count: (doc.holdings || []).length,
    top10: (doc.top10 || []).reduce((s, x) => s + x.weight, 0),
    cash: Number.isFinite(cash) && doc.net_assets ? cash / doc.net_assets * 100 : null,
    futures: (doc.futures || []).reduce((s, x) => s + (Number.isFinite(x.weight) ? x.weight : 0), 0),
    aum: doc.net_assets,
  };
}

// 你的台股部位實際押在哪些公司：每檔 ETF 的市值 × 成分股權重，直接持有的個股照算。
// positions：loadPortfolio 的 positions；funds：{ 代號: 持股 JSON }。ETF 的持股讀不到時回傳 missing，不硬算
export function lookThrough(positions, funds, fundCodes) {
  const tw = positions.filter((p) => p.market === "tw" && Number.isFinite(p.mvTwd));
  const missing = tw.filter((p) => fundCodes.includes(p.code) && !funds[p.code]).map((p) => p.code);
  if (missing.length) return { missing };
  const total = tw.reduce((s, p) => s + p.mvTwd, 0);
  const m = new Map();
  const add = (code, name, v, via, w) => {
    const x = m.get(code) || { code, name, value: 0, via: [] };
    x.value += v;
    x.via.push({ code: via, value: v, weight: w });
    m.set(code, x);
  };
  for (const p of tw) {
    const f = funds[p.code];
    if (f) for (const h of f.holdings || []) add(h.code, cleanName(h.name), p.mvTwd * h.weight / 100, p.code, h.weight);
    else add(p.code, p.name || p.code, p.mvTwd, p.code, 100);
  }
  return { total, items: [...m.values()].sort((a, b) => b.value - a.value), dates: Object.values(funds).map((f) => f.date) };
}
