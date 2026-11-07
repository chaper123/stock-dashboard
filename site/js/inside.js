// 「你的 ETF 裡面在變什麼」的計算（不碰畫面）。資料是私人 repo 的每日持股（private.js 的 loadFund）。
// 股數變化 5% 以上才列出：權重變化多半只是股價漲跌，只有價格變動不會被當成買賣。
// 改進報告 R06：基金規模變大（有人申購）時照原比例買進，股數也會增加，所以有兩天的流通單位數時改看「每單位持股」
// （持股股數 ÷ 流通單位數）的變化，等比例擴張不算加碼；沒有單位數時只寫「股數增加／減少」，結論比較弱。
// 股數剛好變成整數倍、權重卻幾乎沒變的，比較像成分股分割或合併，不列成買賣；同名換了代號的列成代號異動。

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

// 股數變成 k 倍（或 1/k）、k 是 2 以上的整數，權重卻幾乎沒變：比較像分割或合併（股價跟著變成 1/k），不是買賣
const SPLIT_TOL = 0.02, SPLIT_WEIGHT_TOL = 0.35;
export function looksLikeSplit(a, b) {
  if (!(a?.shares > 0 && b?.shares > 0 && a.weight > 0 && b.weight > 0)) return false;
  const r = b.shares / a.shares, k = r >= 1 ? Math.round(r) : 1 / Math.round(1 / r);
  if (Math.abs(r >= 1 ? k : 1 / k) < 2 || Math.abs(r / k - 1) > SPLIT_TOL) return false;
  return Math.abs(b.weight / a.weight - 1) < SPLIT_WEIGHT_TOL;
}

// 兩個資料日之間的動作：new 新買、add 增加、cut 減少、exit 出清、split 疑似分割或合併、rename 代號異動。
// units：{ a: from 那天的流通單位數, b: to 那天的 }，兩個都有時 add／cut 用每單位持股的變化判斷（perUnit 是 true）。
// 回傳 { moves, tokens（象徵性持股的檔數）, perUnit, unitPct（流通單位數的變化 %） }
export function fundMoves(hist, from, to, units = null) {
  const A = hist.by.get(from), B = hist.by.get(to);
  const perUnit = units?.a > 0 && units?.b > 0;
  const scale = perUnit ? units.a / units.b : 1; // 每單位持股的變化＝股數變化 × 這個比例
  const moves = [], both = [];
  let tokens = 0;
  for (const c of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(c), b = B.get(c), x = b || a;
    const raw = a?.shares ? ((b?.shares || 0) - a.shares) / a.shares * 100 : Infinity;
    const pct = a?.shares && b ? ((b.shares * scale) / a.shares - 1) * 100 : raw;
    const split = !!a && !!b && looksLikeSplit(a, b);
    if (a?.shares && b && !split) both.push(pct);
    const kind = !a ? "new" : !b ? "exit" : split ? "split" : pct >= MOVE_PCT ? "add" : pct <= -MOVE_PCT ? "cut" : null;
    if (!kind) continue;
    const wa = a?.weight ?? 0, wb = b?.weight ?? 0;
    if (Math.max(wa, wb) < TOKEN_WEIGHT) {
      tokens += 1;
      continue;
    }
    moves.push({ code: c, name: cleanName(x.name), kind, a: a?.shares || 0, b: b?.shares || 0, wa, wb, pct, raw,
      since: kind === "new" ? hist.dates.find((d) => d > from && d <= to && hist.by.get(d).has(c)) : null });
  }
  // 同一個名稱一邊出清、一邊新買：比較像代號異動（或資料源換了代號），合成一筆，不當成買賣
  for (const n of moves.filter((m) => m.kind === "new")) {
    const o = moves.find((m) => m.kind === "exit" && m.name && m.name === n.name);
    if (!o) continue;
    Object.assign(n, { kind: "rename", from: o.code, a: o.a, wa: o.wa });
    moves.splice(moves.indexOf(o), 1);
  }
  const ORDER = { new: 0, add: 1, cut: 2, exit: 3, split: 4, rename: 5 };
  moves.sort((x, y) => ORDER[x.kind] - ORDER[y.kind] || Math.abs(y.wb - y.wa) - Math.abs(x.wb - x.wa));
  // 兩天都有的持股，變化的中位數：每單位持股大多一起減少（或增加）時，比較像申購（贖回）的錢還沒買賣完
  both.sort((x, y) => x - y);
  const median = both.length ? (both.length % 2 ? both[(both.length - 1) / 2] : (both[both.length / 2 - 1] + both[both.length / 2]) / 2) : null;
  return { moves, tokens, perUnit, unitPct: perUnit ? (units.b / units.a - 1) * 100 : null, median };
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
