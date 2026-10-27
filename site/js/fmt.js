// 格式化與 DOM 小工具。外部文字一律用 textContent 放進頁面（el 的字串子節點都是文字節點）。

const NFS = new Map();
const nf = (d) => {
  if (!NFS.has(d)) NFS.set(d, new Intl.NumberFormat("zh-TW", { minimumFractionDigits: d, maximumFractionDigits: d }));
  return NFS.get(d);
};
const NF0 = nf(0), NF2 = nf(2);

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function twd(v) {
  return isNum(v) ? `NT$${NF0.format(Math.round(v))}` : "—";
}
export function usd(v) {
  return isNum(v) ? `US$${NF2.format(v)}` : "—";
}
export function int(v) {
  return isNum(v) ? NF0.format(Math.round(v)) : "—";
}
// 價格：照原本的小數位數（最多 3 位）；100 以上至少 2 位
export function price(v) {
  if (!isNum(v)) return "—";
  const d = Math.min(3, (String(v).split(".")[1] || "").length);
  return nf(v >= 100 ? Math.max(d, 2) : d).format(v);
}
export function shares(v) {
  if (!isNum(v)) return "—";
  return Number.isInteger(v) ? NF0.format(v) : String(v);
}
export function pct(v, d = 1, sign = true) {
  if (!isNum(v)) return "—";
  const s = nf(d).format(Math.abs(v));
  if (!sign) return `${v < 0 ? "−" : ""}${s}%`;
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s}%`;
}
export function signed(v, f = int) {
  if (!isNum(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${f(Math.abs(v))}`;
}
// 台股習慣：紅漲綠跌
export const tone = (v) => (!isNum(v) || v === 0 ? "flat" : v > 0 ? "up" : "down");

// ISO 時間（含時區）→ 台北「10/27 09:22」
export function taipeiTime(iso, withYear = false) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${withYear ? `${p.year}/` : ""}${p.month}/${p.day} ${p.hour}:${p.minute}`;
}
export function shortDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || "");
  return m ? `${m[2]}/${m[3]}` : ymd || "—";
}
export function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

// 只接受 http/https 網址，其他（javascript: 等）回傳 null
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

// el("div", { class: "x", onclick: fn }, "文字", childNode, [more])
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "href") {
      const u = v.startsWith("#") ? v : safeUrl(v);
      if (u) node.setAttribute("href", u);
    } else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  append(node, children);
  return node;
}
function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function extLink(url, text) {
  const u = safeUrl(url);
  return u ? el("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, text) : text;
}

// 狀態等級 → 顯示
export const LEVELS = {
  z3: { label: "深度買區", tone: "z3", inZone: true, rank: 4 },
  z2: { label: "第二買區", tone: "z2", inZone: true, rank: 3 },
  z1: { label: "第一買區", tone: "z1", inZone: true, rank: 2 },
  starter: { label: "趨勢起始倉", tone: "starter", inZone: true, rank: 1 },
  wait: { label: "等待回檔", tone: "neutral" },
  overheat: { label: "追價區（不買）", tone: "neutral" },
  weak: { label: "等待（趨勢轉弱）", tone: "warn", icon: "⚠" },
  block: { label: "暫停", tone: "crit", icon: "⛔" },
  gauge: { label: "市場指標", tone: "outline" },
  watch: { label: "觀察", tone: "outline" },
};

export function badge(level, status) {
  const lv = LEVELS[level] || { label: status || level, tone: "neutral" };
  return el("span", { class: `badge b-${lv.tone}` }, lv.icon ? `${lv.icon} ` : "", status || lv.label);
}

// 距第一買區上緣：正數＝已低於上緣（在區內或更深）
export function distText(d) {
  if (!isNum(d)) return "—";
  if (Math.abs(d) < 0.005) return "剛好在上緣";
  return d > 0 ? `低於上緣 ${pct(d, 1, false)}` : `高於上緣 ${pct(-d, 1, false)}`;
}

// 買區一律兩位小數，上下緣對齊好比較
export function zoneText(z) {
  return Array.isArray(z) && z.length === 2 ? `${nf(2).format(z[0])}～${nf(2).format(z[1])}` : "—";
}
