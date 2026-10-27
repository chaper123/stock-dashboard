// 共用版面元件：區塊載入、錯誤提示、卡片、頁首。
import { el } from "./fmt.js";
import { DataError } from "./data.js";

export const loading = (text = "讀取中…") => el("div", { class: "loading", role: "status" }, text);

export function errorBox(err, retry) {
  const known = err instanceof DataError;
  return el("div", { class: "notice err", role: "alert" },
    el("strong", {}, known ? `讀不到${err.source}` : "這一塊顯示失敗"),
    el("span", {}, `：${err.message || err}`),
    retry && el("button", { class: "btn small", type: "button", onclick: retry }, "重試"));
}

export const notice = (kind, ...children) => el("div", { class: `notice ${kind}` }, ...children);

// 先顯示「讀取中」，完成後換成內容；失敗只影響這一塊，其他區塊照常
export function slot(parent, build, cls = "") {
  const box = el("div", { class: `slot ${cls}` });
  parent.append(box);
  const run = async () => {
    box.replaceChildren(loading());
    try {
      const node = await build();
      box.replaceChildren(...[node].flat().filter(Boolean));
    } catch (e) {
      if (!(e instanceof DataError)) console.error(e);
      box.replaceChildren(errorBox(e, run));
    } finally {
      document.dispatchEvent(new Event("data-settled"));
    }
  };
  run();
  return box;
}

export function card(title, ...children) {
  return el("section", { class: "card" }, title && el("h2", {}, title), ...children);
}

export function pageHeader(title, sub) {
  return el("header", { class: "page-head" },
    el("h1", {}, title),
    sub && el("p", { class: "sub" }, sub),
    el("p", { class: "disclaimer-line" }, "依自訂規則的訊號，不是投資建議。"));
}

// 標籤＋數值的小格子
export function kv(label, value, extra) {
  return el("div", { class: "kv" }, el("span", { class: "k" }, label), el("span", { class: "v" }, value), extra);
}
