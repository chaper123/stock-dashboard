// 記帳頁沙盒（網址加 ?gs=r02 改用 R02 版 Apps Script）：網站的 record.js 原封不動渲染，fetch 換成假的——Apps Script 網址交給假服務（tests/apps_script/fake_gas.js），
// 帳本的發布 CSV 從假帳本產生，其他網址一律擋掉。localStorage 只在這個 localhost 網址放假網址與假密鑰。
// 「模擬重開記帳頁」只重畫頁面、保留假帳本；按瀏覽器重新整理會連假帳本一起重來。
import { makeEnv, loadGasSource, TEST_KEY } from "./fake_gas.js";
import { SOURCES } from "../../site/js/config.js";
import { clearCache } from "../../site/js/data.js";
import { render } from "../../site/js/pages/record.js";

const FAKE_URL = "https://script.google.com/macros/s/FAKE-TEST-DEPLOYMENT-0000000000/exec";
// ?gs=r02：改用正式帳本現在的 R02 版（第 B 批之前），看網站和舊版一起用時的畫面
const R02 = new URLSearchParams(location.search).get("gs") === "r02";
const env = makeEnv(await loadGasSource(R02 ? "ledger_write_r02.gs" : "../../apps_script/ledger_write.gs"));
const CSV = { [SOURCES.ledger.trades]: "交易紀錄", [SOURCES.ledger.holdings]: "持倉", [SOURCES.ledger.dca]: "定投金額" };
const modeIn = document.getElementById("mode");
const view = document.getElementById("view");

window.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === FAKE_URL) {
    const body = JSON.parse(init.body);
    const isWrite = body.id && !(body.data && body.data.dryRun);
    const mode = isWrite ? modeIn.value : "normal";
    if (isWrite) modeIn.value = "normal"; // 只影響下一次
    await new Promise((r) => setTimeout(r, 300));
    if (mode === "drop") throw new TypeError("Failed to fetch");
    const out = env.raw(init.body);
    showState();
    if (mode === "lose") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (CSV[url]) return new Response(env.sheets[CSV[url]].csv(), { status: 200 });
  return new Response("sandbox: blocked", { status: 404 });
};

function showState() {
  const h = env.holding("009816");
  document.getElementById("state").textContent =
    `假帳本：交易紀錄 ${env.rows("交易紀錄")} 列、持倉 009816 ${h.shares} 股／${h.cost}、定投金額 ${env.rows("定投金額")} 列\n` +
    `localStorage ledger.pendingTrade：${localStorage.getItem("ledger.pendingTrade") || "（沒有）"}`;
}

function reopen() {
  clearCache();
  view.replaceChildren();
  render(view);
  setTimeout(showState, 100);
}

localStorage.removeItem("ledger.awaitPublish"); // 假帳本每次載入都重來，上次的「等發布」不適用
localStorage.setItem("ledger.writeUrl", FAKE_URL);
localStorage.setItem("ledger.writeKey", TEST_KEY);
document.addEventListener("refresh-request", reopen);
document.getElementById("reopen").addEventListener("click", reopen);
document.getElementById("age").addEventListener("click", () => {
  const raw = localStorage.getItem("ledger.pendingTrade");
  if (!raw) return;
  const p = JSON.parse(raw);
  p.at = Date.now() - 6 * 3600 * 1000;
  localStorage.setItem("ledger.pendingTrade", JSON.stringify(p));
  reopen();
});
document.getElementById("reset").addEventListener("click", () => {
  localStorage.removeItem("ledger.pendingTrade");
  localStorage.removeItem("ledger.awaitPublish");
  reopen();
});
reopen();
