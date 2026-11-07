// 記帳寫入的瀏覽器測試：apps_script/ledger_write.gs 在假的 Apps Script 服務上跑，加上網站 site/js/ledger_write.js 的
// 未確認請求保存與錯誤分類。不連 Google、不碰正式帳本。說明見 docs/LEDGER_WRITE.md「本機測試」。
import { makeEnv, loadGasSource, sha256, hex, TEST_KEY } from "./fake_gas.js";

const params = new URLSearchParams(location.search);
// ?src=/tmp/ledger_write.old.gs 可以拿舊版對照（只接受同網站、.gs 結尾的路徑）
const SRC = /^\/[\w./-]+\.gs$/.test(params.get("src") || "") ? params.get("src") : "../../apps_script/ledger_write.gs";
const FAKE_URL = "https://script.google.com/macros/s/FAKE-TEST-DEPLOYMENT-0000000000/exec";
const TRADE = {
  date: "2026-11-07", time: "10:15", code: "009816", name: "凱基台灣TOP50", side: "買進",
  shares: 10, price: 14.8, amount: 148, fee: 1, tax: 0, note: "測試",
};
const ID = "test-id-0001-aaaaaaaaaaaa";

const results = [];
class Fail extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}：預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);

let source;
async function test(group, name, fn) {
  try {
    const detail = await fn();
    results.push({ group, name, pass: true, detail: detail || "" });
  } catch (e) {
    results.push({ group, name, pass: false, detail: e instanceof Fail ? e.message : `例外：${e && e.stack || e}` });
  }
}
const env = () => makeEnv(source);

// ── Apps Script（假服務） ─────────────────────────────

async function gasTests() {
  const G = "Apps Script";

  await test(G, "假的 SHA-256 和瀏覽器 SubtleCrypto 一致", async () => {
    eq(hex(sha256(new TextEncoder().encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "abc");
    for (const s of ["", "台股 009816 買進", JSON.stringify(TRADE), "x".repeat(200)]) {
      const b = new TextEncoder().encode(s);
      eq(hex(sha256(b)), hex(new Uint8Array(await crypto.subtle.digest("SHA-256", b))), `「${s.slice(0, 12)}」`);
    }
  });

  await test(G, "同編號連送兩次只寫一筆（第二次回傳原結果、repeated）", () => {
    const e = env();
    const n0 = e.rows("交易紀錄");
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    const r2 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r1.ok && !r1.repeated, `第一次要寫入：${JSON.stringify(r1)}`);
    ok(r2.ok && r2.repeated === true, `第二次要回傳 repeated：${JSON.stringify(r2)}`);
    eq(r2.rowNumber, r1.rowNumber, "兩次的列號");
    eq(e.rows("交易紀錄"), n0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉 009816 股數（只加一次 10 股）");
    return `第 ${r1.rowNumber} 列；持倉 1241 → 1251`;
  });

  await test(G, "兩個相同請求都在鎖外查不到、依序取得鎖：只寫一筆", () => {
    const e = env();
    const n0 = e.rows("交易紀錄");
    let rB;
    // A 在鎖外查完快取、正要等鎖時，B 整個跑完（B 也在鎖外查不到，先拿到鎖、寫入、放鎖）
    e.beforeLock.push(() => { rB = e.post({ action: "addTrade", id: ID, data: TRADE }); });
    const rA = e.post({ action: "addTrade", id: ID, data: TRADE });
    const gets = e.log.filter((x) => x.startsWith("get-"));
    eq(gets.slice(0, 2), ["get-miss", "get-miss"], "A、B 在鎖外都查不到");
    ok(rB.ok && !rB.repeated, `B 要寫入：${JSON.stringify(rB)}`);
    ok(rA.ok && rA.repeated === true, `A 拿到鎖後要在鎖內查到 B 的結果：${JSON.stringify(rA)}`);
    eq(rA.rowNumber, rB.rowNumber, "A、B 回報的列號");
    eq(e.rows("交易紀錄"), n0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉股數");
    return e.log.join(" → ");
  });

  await test(G, "同編號不同內容被拒絕，帳本不變", () => {
    const e = env();
    const n0 = e.rows("交易紀錄");
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    const r2 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, shares: 20, amount: 296 } });
    ok(r1.ok, "第一次要寫入");
    ok(r2.ok === false && r2.conflict === true, `第二次要拒絕：${JSON.stringify(r2)}`);
    ok(/內容不同/.test(r2.error), `錯誤訊息要寫清楚：${r2.error}`);
    ok(!r2.retry, "不能標成可以重送");
    eq(e.rows("交易紀錄"), n0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉股數");
    return r2.error;
  });

  await test(G, "同編號換成別的動作（setMonthly）也被拒絕", () => {
    const e = env();
    e.post({ action: "addTrade", id: ID, data: TRADE });
    const r = e.post({ action: "setMonthly", id: ID, data: { amount: 5000 } });
    ok(r.ok === false && r.conflict === true, JSON.stringify(r));
    eq(e.rows("定投金額"), 1, "定投金額列數");
  });

  await test(G, "鎖內查到內容不同的請求也拒絕（兩個不同內容的同編號請求同時到）", () => {
    const e = env();
    let rB;
    e.beforeLock.push(() => { rB = e.post({ action: "addTrade", id: ID, data: TRADE }); });
    const rA = e.post({ action: "addTrade", id: ID, data: { ...TRADE, note: "別的內容" } });
    ok(rB.ok && !rB.repeated, "B 寫入");
    ok(rA.ok === false && rA.conflict === true, `A 要被拒絕：${JSON.stringify(rA)}`);
    eq(e.rows("交易紀錄"), 3, "交易紀錄列數");
  });

  await test(G, "內容一樣只是鍵的順序不同：算同一筆", () => {
    const e = env();
    e.post({ action: "addTrade", id: ID, data: TRADE });
    const shuffled = Object.fromEntries(Object.entries(TRADE).reverse());
    const r = e.post({ action: "addTrade", id: ID, data: shuffled });
    ok(r.ok && r.repeated === true, JSON.stringify(r));
    eq(e.rows("交易紀錄"), 3, "交易紀錄列數");
  });

  await test(G, "dryRun 不受影響：不查重、不寫快取、不寫帳本", () => {
    const e = env();
    const n0 = e.rows("交易紀錄");
    const d1 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, dryRun: true } });
    const d2 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, dryRun: true } });
    ok(d1.ok && d1.dryRun === true && !d1.repeated, `試算 1：${JSON.stringify(d1)}`);
    ok(d2.ok && d2.dryRun === true && !d2.repeated, "試算 2 也不是 repeated");
    ok(!e.store.has("req:" + ID), "試算不能寫進快取");
    eq(e.rows("交易紀錄"), n0, "試算後列數");
    eq(d1.holding.after.shares, 1251, "試算的持倉結果");
    // 試算之後用同一個編號正式寫入：照常寫（試算沒有占用編號）
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(w.ok && !w.repeated && w.rowNumber === n0 + 2, `正式寫入：${JSON.stringify(w)}`);
    // 寫入之後再試算（不同內容也可以）：照最新帳本試算，不回傳快取
    const d3 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, shares: 5, amount: 74, dryRun: true } });
    ok(d3.ok && d3.dryRun === true && !d3.repeated && !d3.conflict, `寫入後試算：${JSON.stringify(d3)}`);
    eq(d3.holding.before.shares, 1251, "寫入後試算看到的持倉");
    eq(e.rows("交易紀錄"), n0 + 1, "最後列數");
    // 前端實際的試算不帶編號
    const d4 = e.post({ action: "addTrade", id: null, data: { ...TRADE, dryRun: true } });
    ok(d4.ok && d4.dryRun === true, "不帶編號的試算");
  });

  await test(G, "setMonthly 同編號連送兩次只寫一次", () => {
    const e = env();
    const r1 = e.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    const r2 = e.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    ok(r1.ok && r1.effective === "2026-12" && !r1.repeated, JSON.stringify(r1));
    ok(r2.ok && r2.repeated === true && r2.rowNumber === r1.rowNumber, JSON.stringify(r2));
    eq(e.rows("定投金額"), 2, "定投金額列數");
  });

  await test(G, "更新部署前的舊快取格式（沒有 hash）照舊回傳 repeated", () => {
    const e = env();
    e.store.set("req:legacy-id-000001", JSON.stringify({ ok: true, dryRun: false, rowNumber: 99, trade: TRADE }));
    const r = e.post({ action: "addTrade", id: "legacy-id-000001", data: TRADE });
    ok(r.ok && r.repeated === true && r.rowNumber === 99, JSON.stringify(r));
    eq(e.rows("交易紀錄"), 2, "沒有寫入");
  });

  await test(G, "鎖被占用時回「帳本正在寫入」並標 retry（這次沒處理）", () => {
    const e = env();
    let rB;
    // A 拿著鎖寫到一半（flush）時 B 來了：B 等不到鎖
    e.onFlush.push(() => { rB = e.post({ action: "addTrade", id: "test-id-0002-bbbbbbbbbbbb", data: TRADE }); });
    const rA = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(rA.ok, "A 寫入");
    ok(rB.ok === false && rB.retry === true && /正在寫入/.test(rB.error), JSON.stringify(rB));
    eq(e.rows("交易紀錄"), 3, "只有 A 寫入");
  });

  await test(G, "密鑰錯標 retry；內容錯不快取，同編號修正後可以寫", () => {
    const e = env();
    const bad = e.post({ action: "addTrade", id: ID, data: TRADE, key: "wrong-key-0000000000000000" });
    ok(bad.ok === false && bad.retry === true && bad.error === "密鑰不對", JSON.stringify(bad));
    const v = e.post({ action: "addTrade", id: ID, data: { ...TRADE, date: "2026-12-01" } });
    ok(v.ok === false && !v.retry && /未來/.test(v.error), JSON.stringify(v));
    ok(!e.store.has("req:" + ID), "錯誤不能寫進快取");
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(w.ok && !w.repeated, JSON.stringify(w));
  });

  await test(G, "ping 帶編號也不快取；請求格式錯誤照舊", () => {
    const e = env();
    const p = e.post({ action: "ping", id: ID });
    ok(p.ok && p.ledger === "測試帳本（假）" && p.monthly === 3000, JSON.stringify(p));
    ok(!e.store.has("req:" + ID), "ping 不寫快取");
    const j = e.raw("不是 JSON");
    ok(j.ok === false && j.error === "請求格式錯誤", JSON.stringify(j));
  });
}

// ── 網站 site/js/ledger_write.js ─────────────────────

const LS_KEYS = ["ledger.writeUrl", "ledger.writeKey", "ledger.pendingTrade"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function siteTests() {
  const G = "網站";
  const W = await import("../../site/js/ledger_write.js");
  const saved = Object.fromEntries(LS_KEYS.map((k) => [k, localStorage.getItem(k)]));
  const realFetch = window.fetch;
  const seen = [];
  // 只接受假網址；其他網址一律丟錯，確保測試不會連到任何真的服務
  const route = (handler) => {
    window.fetch = async (url, init) => {
      if (url !== FAKE_URL) throw new Error(`測試不允許連到 ${url}`);
      seen.push(JSON.parse(init.body));
      return handler(init);
    };
  };
  try {
    localStorage.setItem("ledger.writeUrl", FAKE_URL);
    localStorage.setItem("ledger.writeKey", TEST_KEY);

    await test(G, "未確認的請求只存編號、內容、時間、網址，不存密鑰", () => {
      ok(W.savePending(ID, TRADE, FAKE_URL, 1000), "要能儲存");
      const raw = localStorage.getItem("ledger.pendingTrade");
      ok(!raw.includes(TEST_KEY), "localStorage 裡不能有密鑰");
      eq(Object.keys(JSON.parse(raw)).sort(), ["at", "data", "id", "url"], "存的欄位");
      eq(W.loadPending(), { id: ID, data: TRADE, at: 1000, url: FAKE_URL }, "讀回");
      W.clearPending();
      eq(W.loadPending(), null, "清除後");
      eq(W.PENDING_STALE_MS, 5 * 3600 * 1000, "超過 5 小時就不再重送");
    });

    await test(G, "壞掉的紀錄當作沒有並清掉", () => {
      for (const bad of ["{", JSON.stringify({ id: "x", data: TRADE, at: 1, url: FAKE_URL }),
        JSON.stringify({ id: ID, data: TRADE, url: FAKE_URL }), JSON.stringify({ id: ID, data: "s", at: 1, url: FAKE_URL })]) {
        localStorage.setItem("ledger.pendingTrade", bad);
        eq(W.loadPending(), null, bad);
        eq(localStorage.getItem("ledger.pendingTrade"), null, "要清掉");
      }
    });

    await test(G, "回應遺失後用原編號重送：只寫一筆", async () => {
      const e = env();
      let lose = true;
      route((init) => {
        const out = e.raw(init.body); // 假 Apps Script 真的處理了
        if (lose) { lose = false; throw new TypeError("Failed to fetch"); } // 回應在路上不見
        return json(out);
      });
      let err;
      try { await W.callLedger("addTrade", TRADE, ID); } catch (x) { err = x; }
      ok(err instanceof W.WriteError && err.outcome === "unknown", `第一次要是 unknown：${err && err.outcome} ${err && err.message}`);
      ok(/不確定有沒有寫入/.test(err.message), err.message);
      const out = await W.callLedger("addTrade", TRADE, ID);
      ok(out.ok && out.repeated === true, JSON.stringify(out));
      eq(e.rows("交易紀錄"), 3, "交易紀錄列數");
      ok(seen.every((b) => b.id === ID), "兩次都用同一個編號");
      return out.rowNumber && `第 ${out.rowNumber} 列，第二次 repeated`;
    });

    await test(G, "錯誤分類：逾時、HTTP 錯、不是 JSON 是 unknown；密鑰錯、帳本忙碌是 notSent；內容錯是 rejected", async () => {
      const cases = [
        ["逾時", () => { throw new DOMException("aborted", "AbortError"); }, "unknown"],
        ["HTTP 500", () => new Response("err", { status: 500 }), "unknown"],
        ["不是 JSON", () => new Response("<html>登入</html>", { status: 200 }), "unknown"],
        ["密鑰不對", () => json({ ok: false, retry: true, error: "密鑰不對" }), "notSent"],
        ["帳本忙碌", () => json({ ok: false, retry: true, error: "帳本正在寫入別的資料，稍後再試" }), "notSent"],
        ["內容錯", () => json({ ok: false, error: "日期不能是未來" }), "rejected"],
        ["同編號不同內容", () => json({ ok: false, conflict: true, error: "內容不同" }), "rejected"],
        ["舊版 Apps Script 的密鑰錯（沒有 retry）", () => json({ ok: false, error: "密鑰不對" }), "rejected"],
      ];
      const got = [];
      for (const [name, handler, want] of cases) {
        route(handler);
        let err;
        try { await W.callLedger("addTrade", TRADE, ID); } catch (x) { err = x; }
        ok(err instanceof W.WriteError, `${name} 要丟 WriteError`);
        eq(err.outcome, want, name);
        got.push(`${name}→${err.outcome}`);
      }
      localStorage.removeItem("ledger.writeUrl");
      let err;
      try { await W.callLedger("addTrade", TRADE, ID); } catch (x) { err = x; }
      eq(err && err.outcome, "notSent", "沒設定連線");
      localStorage.setItem("ledger.writeUrl", FAKE_URL);
      return got.join("、");
    });

    await test(G, "送出的請求內文有密鑰（只在 POST 內文），網址沒有參數", () => {
      ok(seen.length > 0 && seen.every((b) => b.key === TEST_KEY), "內文要有密鑰");
    });
  } finally {
    window.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    }
  }
}

// ── 執行與顯示 ─────────────────────────────────────

function show() {
  const pass = results.filter((r) => r.pass).length;
  const all = pass === results.length;
  document.getElementById("src").textContent = SRC;
  const sum = document.getElementById("summary");
  sum.textContent = `${all ? "全部通過" : "有失敗"}：${pass}／${results.length}`;
  sum.className = all ? "pass" : "fail";
  document.title = `${all ? "PASS" : "FAIL"} ${pass}/${results.length} 記帳寫入測試`;
  const tbody = document.getElementById("rows");
  tbody.replaceChildren(...results.map((r) => {
    const tr = document.createElement("tr");
    tr.className = r.pass ? "pass" : "fail";
    for (const v of [r.group, r.pass ? "✓" : "✗", r.name, r.detail]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  }));
  window.testResults = { pass, total: results.length, results };
}

try {
  source = await loadGasSource(SRC);
  await gasTests();
  if (!params.has("src")) await siteTests(); // 對照舊版時只跑 Apps Script
} catch (e) {
  results.push({ group: "載入", name: "測試沒辦法開始", pass: false, detail: String(e && e.stack || e) });
}
show();
