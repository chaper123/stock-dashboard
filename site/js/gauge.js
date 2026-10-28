// 恐懼貪婪半圓儀表（參考口袋晨報的樣式）：五段色帶、指針、分數、與前一次比較。
// 分段照 CNN：0–25 極度恐懼、25–45 恐懼、45–55 中性、55–75 貪婪、75–100 極度貪婪；口袋晨報的指數也用同一組色帶，評等文字照來源。
import { el, isNum } from "./fmt.js";

const SVG = "http://www.w3.org/2000/svg";
const BANDS = [
  [0, 25, "極度恐懼", "#a63a36"], [25, 45, "恐懼", "#d4554f"], [45, 55, "中性", "#807e76"],
  [55, 75, "貪婪", "#4e9a55"], [75, 100, "極度貪婪", "#2f7d3b"],
];
export const FG_ZH = { "extreme fear": "極度恐懼", fear: "恐懼", neutral: "中性", greed: "貪婪", "extreme greed": "極度貪婪" };

const CX = 150, CY = 150, R = 132, RI = 94;
const ang = (v) => Math.PI * (1 - v / 100); // 0 在左、100 在右
const pt = (v, r) => [CX + r * Math.cos(ang(v)), CY - r * Math.sin(ang(v))];
const f = (n) => n.toFixed(2);

function node(tag, attrs, text) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function band(v0, v1) {
  const [ax, ay] = pt(v0, R), [bx, by] = pt(v1, R), [cx, cy] = pt(v1, RI), [dx, dy] = pt(v0, RI);
  return `M${f(ax)},${f(ay)} A${R},${R} 0 0 1 ${f(bx)},${f(by)} L${f(cx)},${f(cy)} A${RI},${RI} 0 0 0 ${f(dx)},${f(dy)} Z`;
}

const bandOf = (v) => BANDS.find(([a, b]) => v >= a && v < b) || BANDS.at(-1);

// market-data 的 cnn_fear_greed.json → 儀表的讀數
export const cnnReading = (fg) => ({ name: "CNN 恐懼貪婪", score: fg.score, label: FG_ZH[fg.rating], previous: fg.previous_close, prevLabel: "前一日" });

// g：{ name, score, label（評等文字，沒有就用色帶名稱）, previous, prevLabel }
export function fearGreedGauge(g) {
  const v = Math.max(0, Math.min(100, g.score));
  const label = g.label || bandOf(v)[2];
  const svg = node("svg", { viewBox: "0 0 300 192", class: "fg-gauge", role: "img",
    "aria-label": `${g.name || "恐懼貪婪"} ${v.toFixed(0)}（${label}）` });
  for (const [a, b, name, color] of BANDS) {
    const p = node("path", { d: band(a, b), fill: color, class: "fg-band" });
    p.append(node("title", {}, `${name} ${a}～${b}`));
    svg.append(p);
    // 段名沿著弧線方向寫在色帶裡
    const mid = (a + b) / 2, [tx, ty] = pt(mid, (R + RI) / 2);
    const rot = 90 - (ang(mid) * 180) / Math.PI;
    svg.append(node("text", { x: f(tx), y: f(ty), class: "fg-band-label", transform: `rotate(${f(rot)} ${f(tx)} ${f(ty)})` }, name));
  }
  // 內圈刻度與數字
  for (let t = 0; t <= 100; t += 5) {
    const [x, y] = pt(t, RI - 9);
    svg.append(node("circle", { cx: f(x), cy: f(y), r: t % 25 ? 1.2 : 2, class: "fg-tick" }));
  }
  for (const t of [0, 25, 50, 75, 100]) {
    const [x, y] = pt(t, RI - 22);
    svg.append(node("text", { x: f(x), y: f(y + 4), class: "fg-num" }, String(t)));
  }
  // 指針：細長三角形＋圓心
  const [nx, ny] = pt(v, RI - 4);
  const [lx, ly] = pt(v + 50, 5), [rx, ry] = pt(v - 50, 5);
  svg.append(node("polygon", { points: `${f(nx)},${f(ny)} ${f(lx)},${f(ly)} ${f(rx)},${f(ry)}`, class: "fg-needle" }));
  svg.append(node("circle", { cx: CX, cy: CY, r: 7, class: "fg-hub" }));
  svg.append(node("text", { x: CX, y: CY + 38, class: "fg-value" }, v.toFixed(0)));

  let change = null;
  if (isNum(g.previous)) {
    // 用顯示出來的整數算差，避免「27 → 34（+6）」對不起來
    const a = Math.round(g.previous), b = Math.round(g.score), d = b - a;
    const fear = g.score < 50;
    const mood = d === 0 ? "持平" : d < 0 ? (fear ? "更害怕" : "貪婪降溫") : (fear ? "恐懼減輕" : "更貪婪");
    change = `${g.prevLabel || "前一次"} ${a} 分 → ${b} 分（${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} 分，${mood}）`;
  }
  return el("div", { class: "fg" },
    svg,
    el("div", { class: "fg-label" }, el("i", { class: "fg-dot", style: { background: bandOf(v)[3] } }), label),
    change && el("div", { class: "fg-change" }, change));
}

// 一個儀表區塊：標題列＋儀表（沒有讀數時顯示原因）
export function gaugeBlock(title, meta, reading, missingText, ...extra) {
  return el("div", { class: "fg-block" },
    el("div", { class: "spread" }, el("strong", {}, title), meta && el("span", { class: "tiny" }, meta)),
    reading && isNum(reading.score) ? fearGreedGauge(reading) : el("div", { class: "fg-missing" }, missingText),
    ...extra);
}

// 口袋晨報的恐懼貪婪（js/news.js 的 pocketReading）
export function pocketBlock(pocket, newsError) {
  const title = "口袋晨報恐懼貪婪";
  if (newsError) return gaugeBlock(title, null, null, `讀不到新聞分頁：${newsError}`);
  if (!pocket) return gaugeBlock(title, null, null, "還沒有資料：新聞晨報開始把口袋晨報的分數寫進試算表後就會顯示。");
  if (pocket.missing) return gaugeBlock(title, null, null, `今天沒有分數：${pocket.missing}`);
  const meta = [pocket.sentAt && `口袋晨報 ${pocket.sentAt}`, pocket.dataDate && `資料日 ${pocket.dataDate}`].filter(Boolean).join("・");
  return gaugeBlock(title, meta, pocket, null);
}
