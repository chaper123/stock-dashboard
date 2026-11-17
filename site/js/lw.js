// Lightweight Charts 5.2.1（固定版本＋SRI）的共用載入與預設樣式：K 線頁、資產頁用。只有進到用圖的頁面才載入。
// 滑鼠滾輪、手機兩指可以縮放，拖曳平移；顏色從 CSS 變數讀（深色模式跟著換）。
import { DataError } from "./data.js";

const LW_URL = "https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js";
const LW_SRI = "sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN";

let lwPromise = null;
export function loadLW() {
  if (window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  lwPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LW_URL;
    s.integrity = LW_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(window.LightweightCharts);
    s.onerror = () => {
      lwPromise = null;
      s.remove();
      reject(new DataError("K 線圖函式庫", "載入失敗（可能離線或 CDN 被擋）"));
    };
    document.head.append(s);
  });
  return lwPromise;
}

// 目前主題的顏色變數：v("--up")
export function cssVar() {
  const css = getComputedStyle(document.documentElement);
  return (name) => css.getPropertyValue(name).trim();
}

// #rrggbb 加透明度（Baseline 系列的填色用）；不是 #rrggbb 就原樣回傳
export function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// 時間序列圖的預設：背景與文字、格線照主題；縱向觸控拖曳不攔截（手機上手指放在圖上還是能捲頁面），橫向拖曳與兩指縮放照常
export function timeChart(LW, box, extra = {}) {
  const v = cssVar();
  return LW.createChart(box, {
    autoSize: true,
    layout: { background: { type: LW.ColorType.Solid, color: v("--surface") }, textColor: v("--ink-2"), fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { visible: false }, horzLines: { color: v("--line") } },
    rightPriceScale: { borderColor: v("--axis") },
    timeScale: { borderColor: v("--axis") },
    localization: { locale: "zh-TW", dateFormat: "yyyy/MM/dd" },
    handleScroll: { vertTouchDrag: false },
    ...extra,
  });
}

// 圖表隨主題重畫：draw() 回傳 chart；主題切換時重畫並還原目前看的範圍。離開頁面（alive() 為 false 或圖不在頁面上）時收掉
export function mountChart(box, alive, draw) {
  let chart = null;
  const run = () => {
    const range = chart?.timeScale().getVisibleLogicalRange();
    chart?.remove();
    chart = draw();
    if (range && chart) chart.timeScale().setVisibleLogicalRange(range);
  };
  const onTheme = () => {
    if (!alive() || !box.isConnected) {
      document.removeEventListener("themechange", onTheme);
      chart?.remove();
      chart = null;
      return;
    }
    run();
  };
  // 等 slot 把元素放進頁面後再畫（不用 requestAnimationFrame：分頁在背景時不會觸發）
  setTimeout(() => {
    chart = draw();
    document.addEventListener("themechange", onTheme);
  }, 0);
  // 重畫（換期間、換切換）：從頭設定資料與可見範圍
  return {
    redraw: () => {
      chart?.remove();
      chart = draw();
    },
  };
}
