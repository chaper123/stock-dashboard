// 測試帳本實測（第 B 批）：對真的 Apps Script 跑驗收案例 1～6。只在帳本名稱有「測試」時才送寫入。
// 網址與密鑰只在輸入欄（不存 localStorage、不寫 console）；只送到 script.google.com。說明見 docs/LEDGER_WRITE.md。
const URL_RX = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
const $ = (id) => document.getElementById(id);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const TRADE = { date: today, time: "", code: "009816", name: "凱基台灣TOP50", side: "買進", shares: 1, price: 10, amount: 10, fee: 0, tax: 0, note: "第 B 批實測（測試帳本）" };
const newId = () => "live-" + crypto.getRandomValues(new Uint32Array(3)).join("-");
const state = { ready: false, id1: null, row1: null, id4: null, data4: null };

async function post(action, data = {}, id = null) {
  const url = $("url").value.trim(), key = $("key").value.trim();
  if (!URL_RX.test(url)) throw new Error("網址要是 https://script.google.com/macros/s/…/exec");
  if (key.length < 20) throw new Error("密鑰至少 20 個字元");
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ key, action, id, data }), cache: "no-store", credentials: "omit", redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const show = (el, ok, text) => {
  const p = document.createElement("div");
  const b = document.createElement("span");
  b.className = ok === true ? "pass" : ok === false ? "fail" : "";
  b.textContent = ok === true ? "✓ 通過　" : ok === false ? "✗ 不符　" : "";
  p.append(b, text);
  el.replaceChildren(p);
};
const brief = (o) => JSON.stringify(o, (k, v) => (k === "month" ? undefined : v));
const enable = () => { for (const id of ["s1", "s2", "s3", "s4a", "s5", "s6"]) $(id).disabled = !state.ready; };
async function run(btn, out, fn) {
  btn.disabled = true;
  out.textContent = "執行中…";
  try {
    await fn();
  } catch (e) {
    show(out, false, `出錯：${e.message}`);
  } finally {
    btn.disabled = false;
    enable();
  }
}
const recon = async () => {
  const r = await post("reconcile");
  const bad = r.checks.filter((c) => c.level !== "ok");
  return { ok: bad.length === 0, text: bad.length ? bad.map((c) => `${c.id} ${c.items.join("；")}`).join("\n") : "對帳 7 條都符合" };
};

$("s0").onclick = () => run($("s0"), $("o0"), async () => {
  state.ready = false;
  const p = await post("ping");
  if (!p.ok) return show($("o0"), false, p.error);
  if (!/測試/.test(p.ledger)) return show($("o0"), false, `連到的是「${p.ledger}」，名稱沒有「測試」，這頁不會送任何寫入。請改用測試帳本的網址。`);
  if (p.version !== "2026-11-B") return show($("o0"), false, `「${p.ledger}」的 Apps Script 不是第 B 批的版本（沒有回報版本），請先貼上新版並部署新版本。`);
  state.ready = true;
  show($("o0"), true, `連到「${p.ledger}」，Apps Script 版本 ${p.version}。`);
});

$("s1").onclick = () => run($("s1"), $("o1"), async () => {
  const id = newId();
  const [a, b] = await Promise.all([post("addTrade", TRADE, id), post("addTrade", TRADE, id)]);
  const written = [a, b].filter((x) => x.ok && !x.repeated);
  const repeated = [a, b].filter((x) => x.ok && x.repeated);
  const busy = [a, b].filter((x) => x.retry);
  let again = null;
  if (busy.length) again = await post("addTrade", TRADE, id); // 等不到鎖的那個用原編號再送
  const ok = written.length === 1 && (repeated.length === 1 || (again && again.ok && again.repeated))
    && [...repeated, again].filter(Boolean).every((x) => x.rowNumber === written[0].rowNumber);
  if (ok) Object.assign(state, { id1: id, row1: written[0].rowNumber });
  const r = await recon();
  show($("o1"), ok && r.ok, `兩個回應：${brief(a)}\n${brief(b)}${again ? `\n再送一次：${brief(again)}` : ""}\n→ ${ok ? `只寫了一列（第 ${written[0].rowNumber} 列）` : "不是剛好一列，請看回應"}。${r.text}`);
});

$("s2").onclick = () => run($("s2"), $("o2"), async () => {
  if (!state.id1) return show($("o2"), false, "先做第 1 步");
  const r = await post("addTrade", { ...TRADE, shares: 2, amount: 20 }, state.id1);
  show($("o2"), r.ok === false && !!r.conflict, `回應：${brief(r)}`);
});

$("s3").onclick = () => run($("s3"), $("o3"), async () => {
  if (!state.id1) return show($("o3"), false, "先做第 1 步");
  const a = await post("status", { id: state.id1, action: "addTrade", data: TRADE });
  const b = await post("status", { id: newId(), action: "addTrade", data: TRADE });
  const ok = a.ok && a.state === "done" && a.result.rowNumber === state.row1 && b.ok && b.state === "none";
  show($("o3"), ok, `第 1 步那筆：${a.state}（第 ${a.result?.rowNumber} 列）；沒送過的編號：${b.state}`);
});

$("s4a").onclick = () => run($("s4a"), $("o4a"), async () => {
  const id = newId();
  const data = { ...TRADE, note: "第 B 批實測：中途故障" };
  const r = await post("addTrade", data, id);
  if (!r.ok) return show($("o4a"), false, `寫入失敗：${brief(r)}`);
  Object.assign(state, { id4: id, data4: data });
  const h = r.holding;
  show($("o4a"), null, "");
  $("o4a").innerHTML = "";
  const todo = document.createElement("div");
  todo.className = "todo";
  todo.textContent = `已寫入交易紀錄第 ${r.rowNumber} 列。現在請到測試帳本：\n`
    + `① 「持倉」分頁 009816 那一列：「股數（券商確認）」改成 ${h.before.shares}、「總成本」改成 ${h.before.cost}（改回記這筆之前）。\n`
    + `② 「寫入紀錄」分頁最後一列（請求編號 ${id}）：「狀態」從「完成」改成「處理中」。\n`
    + "這樣就等於「交易列寫了、持倉還沒更新時程式中斷」。兩格都改好後，按下面的「改好了，用原編號查詢」。";
  todo.style.whiteSpace = "pre-wrap";
  $("o4a").append(todo);
  $("s4b").disabled = false;
});

$("s4b").onclick = () => run($("s4b"), $("o4b"), async () => {
  if (!state.id4) return show($("o4b"), false, "先按上面的「記一筆」");
  const s = await post("status", { id: state.id4, action: "addTrade", data: state.data4 });
  const r = await recon();
  const ok = s.ok && s.state === "done" && s.result.recovered === true;
  show($("o4b"), ok && r.ok, `查詢結果：${s.state}${s.result ? `（第 ${s.result.rowNumber} 列，recovered＝${s.result.recovered}）` : ""}${s.note ? `，${s.note}` : ""}\n`
    + `${ok ? "程式照帳本實際狀態把持倉補成改後，交易紀錄沒有多寫。" : "沒有恢復成功：請確認兩格都改了。"}${r.text}`);
});

$("s5").onclick = () => run($("s5"), $("o5"), async () => {
  if (!state.row1) return show($("o5"), false, "先做第 1 步");
  const d = { row: state.row1, date: TRADE.date, code: TRADE.code, side: TRADE.side, shares: TRADE.shares, settle: 10, reason: "第 B 批實測" };
  const pre = await post("reverse", { ...d, dryRun: true });
  if (!pre.ok) return show($("o5"), false, `試算被拒絕：${pre.error}`);
  const r = await post("reverse", d, newId());
  const c = await recon();
  const ok = r.ok && r.funds.delta === 10;
  show($("o5"), ok && c.ok, `沖銷第 ${state.row1} 列 → 沖銷列寫在第 ${r.rowNumber} 列；持倉 009816 ${r.holding?.before.shares} → ${r.holding?.after.shares} 股、`
    + `總成本 ${r.holding?.before.cost} → ${r.holding?.after.cost}；可用資金加回 ${r.funds?.delta}。\n請到測試帳本看：第 ${state.row1} 列「更正」欄是「已被第 ${r.rowNumber} 列沖銷」、`
    + `第 ${r.rowNumber} 列股數 −1、設定的可用資金加回 10。${c.text}`);
});

$("s6").onclick = () => run($("s6"), $("o6"), async () => {
  const r = await post("reconcile");
  show($("o6"), r.checks.every((c) => c.level === "ok"), r.checks.map((c) => `${c.level === "ok" ? "✓" : c.level === "warn" ? "⚠" : "✗"} ${c.id} ${c.title}${c.items.length ? `：${c.items.join("；")}` : ""}`).join("\n")
    + `\n美股：${r.us.map((u) => `${u.code} ${u.shares} 股（差 ${u.diff}，確認日 ${u.confirmed}）`).join("；")}`);
});
