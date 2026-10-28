// 恐懼貪婪半圓儀表（參考口袋晨報的樣式）：五段色帶、指針、分數、與前一日比較。
// 分段照 CNN：0–25 極度恐懼、25–45 恐懼、45–55 中性、55–75 貪婪、75–100 極度貪婪。
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

// fg：market-data 的 cnn_fear_greed.json
export function fearGreedGauge(fg) {
  const v = Math.max(0, Math.min(100, fg.score));
  const label = FG_ZH[fg.rating] || bandOf(v)[2];
  const svg = node("svg", { viewBox: "0 0 300 192", class: "fg-gauge", role: "img",
    "aria-label": `CNN 恐懼貪婪 ${v.toFixed(0)}（${label}）` });
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

  const prev = fg.previous_close;
  let change = null;
  if (isNum(prev)) {
    // 用顯示出來的整數算差，避免「27 → 34（+6）」對不起來
    const a = Math.round(prev), b = Math.round(fg.score), d = b - a;
    const fear = fg.score < 50;
    const mood = d === 0 ? "持平" : d < 0 ? (fear ? "更害怕" : "貪婪降溫") : (fear ? "恐懼減輕" : "更貪婪");
    change = `前一日 ${a} 分 → ${b} 分（${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} 分，${mood}）`;
  }
  return el("div", { class: "fg" },
    svg,
    el("div", { class: "fg-label" }, el("i", { class: "fg-dot", style: { background: bandOf(v)[3] } }), label),
    change && el("div", { class: "fg-change" }, change));
}
