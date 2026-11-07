// 瀏覽器測試頁共用的小工具（本機沒有 Node，用預覽瀏覽器開 tests/web/*.html 跑）。
// 伺服器要開在 repo 根目錄（例如 py -3.14 -m http.server 8769），頁面用 /site/js/… 匯入網站模組。
// 結果放在畫面與 window.__results（[名稱, 通過, 說明]），標題會變成「通過 N／N」或「失敗 K」。
export const results = [];

export function test(name, fn) {
  try {
    fn();
    results.push([name, true, ""]);
  } catch (e) {
    results.push([name, false, e.message]);
  }
}

const show = (v) => JSON.stringify(v);
export function eq(actual, expected, msg = "") {
  if (show(actual) !== show(expected)) throw new Error(`${msg} 期望 ${show(expected)}，得到 ${show(actual)}`);
}
export function near(actual, expected, tol, msg = "") {
  if (!(Math.abs(actual - expected) <= tol)) throw new Error(`${msg} 期望 ${expected}（±${tol}），得到 ${actual}`);
}
export function ok(cond, msg = "") {
  if (!cond) throw new Error(msg || "條件不成立");
}

export function report() {
  const fail = results.filter((r) => !r[1]);
  document.title = fail.length ? `失敗 ${fail.length}` : `通過 ${results.length}／${results.length}`;
  const table = document.createElement("table");
  for (const [name, pass, why] of results) {
    const tr = table.insertRow();
    tr.insertCell().textContent = pass ? "✓" : "✕";
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = why;
    tr.style.color = pass ? "" : "#d03b3b";
  }
  const h = document.createElement("h2");
  h.textContent = document.title;
  document.body.append(h, table);
  window.__results = results;
}
