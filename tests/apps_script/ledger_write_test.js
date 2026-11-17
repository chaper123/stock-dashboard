// 記帳寫入的瀏覽器測試：apps_script/ledger_write.gs 在假的 Apps Script 服務上跑，加上網站 site/js/ledger_write.js 的
// 未確認請求保存、查詢與錯誤分類。不連 Google、不碰正式帳本。說明見 docs/LEDGER_WRITE.md「本機測試」。
// 第 B 批（docs/LEDGER_CONSISTENCY.md）的 6 個驗收案例：同時送兩次、回應遺失後查回、同編號不同內容、中途故障恢復、沖銷、對帳。
import { makeEnv, loadGasSource, sha256, hex, TEST_KEY, serialOf } from "./fake_gas.js";

const params = new URLSearchParams(location.search);
// ?src=/tmp/ledger_write.old.gs 可以拿舊版對照（只接受同網站、.gs 結尾的路徑）
const SRC = /^\/[\w./-]+\.gs$/.test(params.get("src") || "") ? params.get("src") : "../../apps_script/ledger_write.gs";
const FAKE_URL = "https://script.google.com/macros/s/FAKE-TEST-DEPLOYMENT-0000000000/exec";
const TRADE = {
  date: "2026-11-07", time: "10:15", code: "009816", name: "凱基台灣TOP50", side: "買進",
  shares: 10, price: 14.8, amount: 148, fee: 1, tax: 0, note: "測試",
};
const SELL = { ...TRADE, side: "賣出", shares: 5, price: 15, amount: 75, fee: 1, tax: 0, note: "測試賣出" };
const NEW_CODE = { ...TRADE, code: "0050", name: "元大台灣50", shares: 1, price: 200, amount: 200, fee: 1 };
const ID = "test-id-0001-aaaaaaaaaaaa";
const ID2 = "test-id-0002-bbbbbbbbbbbb";
const N0 = 5; // 假帳本交易紀錄一開始的資料列數
const SEED_BUYS = 3492; // 基準日後買入合計：949＋2543

const results = [];
class Fail extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}：預期 ${JSON.stringify(b)}，實際 ${JSON.stringify(a)}`);
const near = (a, b, msg) => ok(Math.abs(a - b) < 0.005, `${msg}：預期 ${b}，實際 ${a}`);

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

// 小工具
const lastLog = (e) => e.logRows().at(-1);
const logOf = (e, id) => e.logRows().find((x) => x.請求編號 === id);
const buys = (e) => e.sheets["設定"].getRange(3, 2).getValues()[0][0];
const sells = (e) => e.sheets["設定"].getRange(4, 2).getValues()[0][0];
const rec = (e) => e.post({ action: "reconcile" });
const bad = (r) => r.checks.filter((c) => c.level !== "ok").map((c) => `${c.id}：${c.items.join("；")}`);
// 交易紀錄第 r 列 → 沖銷請求的 data（網站從發布的 CSV 讀到的那幾格）
function revData(e, r, reason = "測試沖銷") {
  const v = e.rowAt("交易紀錄", r);
  const c = (h) => v[e.col("交易紀錄", h) - 1];
  return { row: r, date: c("日期"), code: c("代號"), side: c("買賣"), shares: Number(c("股數")),
    settle: c("交割金額") === "" ? null : Number(c("交割金額")), reason };
}
const crashAt = (e, sheet, op, extra = () => true) => { e.crashWhen = (w) => w.sheet === sheet && w.op === op && extra(w); };

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
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    const r2 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r1.ok && !r1.repeated, `第一次要寫入：${JSON.stringify(r1)}`);
    ok(r2.ok && r2.repeated === true, `第二次要回傳 repeated：${JSON.stringify(r2)}`);
    eq(r2.rowNumber, r1.rowNumber, "兩次的列號");
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉 009816 股數（只加一次 10 股）");
    return `第 ${r1.rowNumber} 列；持倉 1241 → 1251`;
  });

  await test(G, "案例 1：兩個相同請求都在鎖外查不到、依序取得鎖：只寫一筆", () => {
    const e = env();
    let rB;
    // A 在鎖外查完快取、正要等鎖時，B 整個跑完（B 也在鎖外查不到，先拿到鎖、寫入、放鎖）
    e.beforeLock.push(() => { rB = e.post({ action: "addTrade", id: ID, data: TRADE }); });
    const rA = e.post({ action: "addTrade", id: ID, data: TRADE });
    const gets = e.log.filter((x) => x.startsWith("get-"));
    eq(gets.slice(0, 2), ["get-miss", "get-miss"], "A、B 在鎖外都查不到");
    ok(rB.ok && !rB.repeated, `B 要寫入：${JSON.stringify(rB)}`);
    ok(rA.ok && rA.repeated === true, `A 拿到鎖後要在鎖內查到 B 的結果：${JSON.stringify(rA)}`);
    eq(rA.rowNumber, rB.rowNumber, "A、B 回報的列號");
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉股數");
    return e.log.join(" → ");
  });

  await test(G, "案例 1：快取被清掉（只剩寫入紀錄）也只寫一筆", () => {
    const e = env();
    e.post({ action: "addTrade", id: ID, data: TRADE });
    e.store.clear();
    const r = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r.ok && r.repeated === true, JSON.stringify(r));
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
    eq(e.holding("009816").shares, 1251, "持倉股數");
    eq(e.logRows().length, 1, "寫入紀錄只有一列");
  });

  await test(G, "案例 3：同編號不同內容被拒絕，帳本不變", () => {
    const e = env();
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    const r2 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, shares: 20, amount: 296 } });
    ok(r1.ok, "第一次要寫入");
    ok(r2.ok === false && r2.conflict === true, `第二次要拒絕：${JSON.stringify(r2)}`);
    ok(/內容不同/.test(r2.error), `錯誤訊息要寫清楚：${r2.error}`);
    ok(!r2.retry, "不能標成可以重送");
    e.store.clear(); // 快取不見之後：寫入紀錄的雜湊照樣擋
    const r3 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, shares: 20, amount: 296 } });
    ok(r3.ok === false && r3.conflict === true, `清掉快取後也要拒絕：${JSON.stringify(r3)}`);
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
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
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
  });

  await test(G, "內容一樣只是鍵的順序不同：算同一筆", () => {
    const e = env();
    e.post({ action: "addTrade", id: ID, data: TRADE });
    const shuffled = Object.fromEntries(Object.entries(TRADE).reverse());
    const r = e.post({ action: "addTrade", id: ID, data: shuffled });
    ok(r.ok && r.repeated === true, JSON.stringify(r));
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
  });

  await test(G, "dryRun 不受影響：不查重、不寫快取、不寫帳本、不建寫入紀錄", () => {
    const e = env();
    const d1 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, dryRun: true } });
    const d2 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, dryRun: true } });
    ok(d1.ok && d1.dryRun === true && !d1.repeated, `試算 1：${JSON.stringify(d1)}`);
    ok(d2.ok && d2.dryRun === true && !d2.repeated, "試算 2 也不是 repeated");
    ok(!e.store.has("req:" + ID), "試算不能寫進快取");
    ok(!e.sheets["寫入紀錄"], "試算不能建寫入紀錄分頁");
    eq(e.rows("交易紀錄"), N0, "試算後列數");
    eq(d1.holding.after.shares, 1251, "試算的持倉結果");
    // 試算之後用同一個編號正式寫入：照常寫（試算沒有占用編號）
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(w.ok && !w.repeated && w.rowNumber === N0 + 2, `正式寫入：${JSON.stringify(w)}`);
    // 寫入之後再試算（不同內容也可以）：照最新帳本試算，不回傳快取
    const d3 = e.post({ action: "addTrade", id: ID, data: { ...TRADE, shares: 5, amount: 74, dryRun: true } });
    ok(d3.ok && d3.dryRun === true && !d3.repeated && !d3.conflict, `寫入後試算：${JSON.stringify(d3)}`);
    eq(d3.holding.before.shares, 1251, "寫入後試算看到的持倉");
    eq(e.rows("交易紀錄"), N0 + 1, "最後列數");
    const d4 = e.post({ action: "addTrade", id: null, data: { ...TRADE, dryRun: true } });
    ok(d4.ok && d4.dryRun === true, "不帶編號的試算");
  });

  await test(G, "正式寫入一定要有請求編號", () => {
    const e = env();
    const r = e.post({ action: "addTrade", id: null, data: TRADE });
    ok(r.ok === false && /請求編號/.test(r.error), JSON.stringify(r));
    eq(e.rows("交易紀錄"), N0, "沒有寫入");
  });

  await test(G, "setMonthly 同編號連送兩次只寫一次；備註帶編號、公式欄還在", () => {
    const e = env();
    const r1 = e.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    const r2 = e.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    ok(r1.ok && r1.effective === "2026-12" && !r1.repeated, JSON.stringify(r1));
    ok(r2.ok && r2.repeated === true && r2.rowNumber === r1.rowNumber, JSON.stringify(r2));
    eq(e.rows("定投金額"), 2, "定投金額列數");
    const row = e.rowAt("定投金額", 3);
    eq(row.slice(0, 4), ["2026-12", "5000", "2026-11-07", "網站輸入（請求編號 test-id-monthly-01）"], "新的一列");
    ok(e.formula("定投金額", 3, 5) && e.formula("定投金額", 3, 6), "新的一列要從上一列補上公式");
    // 同一個生效月份再改：覆寫那一列的四格，公式不動
    const r3 = e.post({ action: "setMonthly", id: "test-id-monthly-02", data: { amount: 6000 } });
    ok(r3.ok && r3.rowNumber === 3, JSON.stringify(r3));
    eq(e.rows("定投金額"), 2, "覆寫後列數");
    ok(e.formula("定投金額", 3, 5) && e.formula("定投金額", 3, 6), "覆寫後公式還在");
  });

  await test(G, "更新部署前的舊快取格式（沒有 hash）照舊回傳 repeated", () => {
    const e = env();
    e.store.set("req:legacy-id-000001", JSON.stringify({ ok: true, dryRun: false, rowNumber: 99, trade: TRADE }));
    const r = e.post({ action: "addTrade", id: "legacy-id-000001", data: TRADE });
    ok(r.ok && r.repeated === true && r.rowNumber === 99, JSON.stringify(r));
    eq(e.rows("交易紀錄"), N0, "沒有寫入");
  });

  await test(G, "鎖被占用時回「帳本正在寫入」並標 retry（這次沒處理）", () => {
    const e = env();
    let rB;
    // A 拿著鎖寫到一半（flush）時 B 來了：B 等不到鎖
    e.onFlush.push(() => { rB = e.post({ action: "addTrade", id: ID2, data: TRADE }); });
    const rA = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(rA.ok, "A 寫入");
    ok(rB.ok === false && rB.retry === true && /正在寫入/.test(rB.error), JSON.stringify(rB));
    eq(e.rows("交易紀錄"), N0 + 1, "只有 A 寫入");
  });

  await test(G, "密鑰錯標 retry；內容錯不快取，同編號修正後可以寫", () => {
    const e = env();
    const wrong = e.post({ action: "addTrade", id: ID, data: TRADE, key: "wrong-key-0000000000000000" });
    ok(wrong.ok === false && wrong.retry === true && wrong.error === "密鑰不對", JSON.stringify(wrong));
    const v = e.post({ action: "addTrade", id: ID, data: { ...TRADE, date: "2026-12-01" } });
    ok(v.ok === false && !v.retry && !v.unknown && /未來/.test(v.error), JSON.stringify(v));
    ok(!e.store.has("req:" + ID), "錯誤不能寫進快取");
    eq(e.logRows().length, 0, "內容錯不記寫入紀錄");
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(w.ok && !w.repeated, JSON.stringify(w));
  });

  await test(G, "ping 帶編號也不快取、回報版本；請求格式錯誤照舊", () => {
    const e = env();
    const p = e.post({ action: "ping", id: ID });
    ok(p.ok && p.ledger === "測試帳本（假）" && p.monthly === 3000 && p.version === "2026-11-B", JSON.stringify(p));
    ok(!e.store.has("req:" + ID), "ping 不寫快取");
    const j = e.raw("不是 JSON");
    ok(j.ok === false && j.error === "請求格式錯誤", JSON.stringify(j));
  });
}

// ── 寫入紀錄、查詢 ───────────────────────────────────

async function logTests() {
  const G = "寫入紀錄";

  await test(G, "第一次寫入自動建「寫入紀錄」分頁與交易紀錄「請求編號」「更正」兩欄", () => {
    const e = env();
    ok(!e.sheets["寫入紀錄"], "一開始沒有");
    const r = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r.ok, JSON.stringify(r));
    ok(e.sheets["寫入紀錄"], "要建好分頁");
    eq(e.rowAt("交易紀錄", 1).slice(16, 18), ["請求編號", "更正"], "交易紀錄最後兩欄的表頭");
    eq(e.rowAt("交易紀錄", r.rowNumber)[16], ID, "交易列帶請求編號");
    const l = e.logRows();
    eq(l.length, 1, "一列紀錄");
    eq([l[0].請求編號, l[0].動作, l[0].狀態, l[0].交易紀錄列, l[0].代號], [ID, "新增交易", "完成", String(r.rowNumber), "009816"], "紀錄內容");
    eq(JSON.parse(l[0].持倉改前), { shares: 1241, cost: 17196 }, "持倉改前");
    eq(JSON.parse(l[0].持倉改後), { shares: 1251, cost: 17345 }, "持倉改後");
    ok(/^[0-9a-f]{64}$/.test(l[0].內容雜湊), "內容雜湊");
    ok(!/test-write-key/.test(JSON.stringify(l)), "紀錄裡不能有密鑰");
    ok(e.formula("持倉", 2, 8), "持倉 009816 的交易紀錄股數公式還在");
    eq(e.sheets["持倉"].getRange(2, 9).getValues()[0][0], 0, "股數差異是 0");
    return `寫入紀錄：${JSON.stringify(l[0]).slice(0, 160)}…`;
  });

  await test(G, "新的一檔：整列一次寫完，公式從上一列補上", () => {
    const e = env();
    const r = e.post({ action: "addTrade", id: ID, data: NEW_CODE });
    ok(r.ok && r.holding.isNew, JSON.stringify(r));
    const h = e.holding("0050");
    eq([h.shares, h.cost], [1, 201], "0050 持倉");
    const row = e.rowAt("持倉", h.row);
    eq([row[0], row[2], row[5], row[9]], ["台股", "元大台灣50", "TWD", "2026-11-07"], "市場、名稱、幣別、確認日");
    for (const c of [7, 8, 9]) ok(e.formula("持倉", h.row, c), `第 ${c} 欄要有公式`);
    eq(e.sheets["持倉"].getRange(h.row, 8).getValues()[0][0], 1, "交易紀錄股數公式算得出 1");
    eq(JSON.parse(lastLog(e).持倉改前 === "（沒有這列）" ? "null" : lastLog(e).持倉改前), null, "改前是「沒有這列」");
  });

  await test(G, "案例 2：回應遺失後查詢（只讀寫入紀錄、不寫交易），快取不見也查得到", () => {
    const e = env();
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    e.store.clear();
    const s = e.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(s.ok && s.state === "done" && s.result.rowNumber === w.rowNumber && s.result.repeated, JSON.stringify(s));
    eq(s.result.holding.after.shares, 1251, "查回的持倉改後");
    const none = e.post({ action: "status", data: { id: ID2, action: "addTrade", data: TRADE } });
    ok(none.ok && none.state === "none", `沒送過的編號：${JSON.stringify(none)}`);
    const diff = e.post({ action: "status", data: { id: ID, action: "addTrade", data: { ...TRADE, shares: 11, amount: 163 } } });
    ok(diff.ok === false && diff.conflict, `同編號不同內容：${JSON.stringify(diff)}`);
    eq(e.rows("交易紀錄"), N0 + 1, "查詢沒有寫入");
    const fresh = env();
    const f = fresh.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(f.ok && f.state === "none" && !fresh.sheets["寫入紀錄"], `還沒有寫入紀錄分頁：${JSON.stringify(f)}`);
    const noId = e.post({ action: "status", data: { action: "addTrade", data: TRADE } });
    ok(noId.ok === false && /請求編號/.test(noId.error), "查詢要帶編號");
  });

  await test(G, "寫到一半出錯（不是內容錯）回 unknown，不是 rejected", () => {
    const e = env();
    crashAt(e, "交易紀錄", "setValues", (w) => w.row > 1);
    const r = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r.ok === false && r.unknown === true && /同一個請求編號/.test(r.error), JSON.stringify(r));
    eq(lastLog(e).狀態, "處理中", "寫入紀錄停在處理中");
  });
}

// ── 案例 4：中途故障恢復 ─────────────────────────────

async function recoverTests() {
  const G = "案例 4：中途故障";

  await test(G, "交易列還沒寫就中斷：重送照一般流程寫一次", () => {
    const e = env();
    crashAt(e, "交易紀錄", "setValues", (w) => w.row > 1);
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r1.unknown, JSON.stringify(r1));
    eq(e.rows("交易紀錄"), N0, "交易紀錄沒變");
    const r2 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r2.ok && !r2.repeated, JSON.stringify(r2));
    eq(e.rows("交易紀錄"), N0 + 1, "只多一列");
    eq(e.holding("009816").shares, 1251, "持倉");
    eq(e.logRows().map((x) => x.狀態), ["完成"], "寫入紀錄（沿用同一列）");
  });

  await test(G, "交易列寫了、持倉沒更新：重送補更新持倉，不重複記帳", () => {
    const e = env();
    crashAt(e, "持倉", "setValues");
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r1.unknown, JSON.stringify(r1));
    eq(e.rows("交易紀錄"), N0 + 1, "交易列已經寫了");
    eq(e.holding("009816").shares, 1241, "持倉還沒更新");
    eq(lastLog(e).狀態, "處理中", "紀錄是處理中");
    ok(rec(e).checks.find((c) => c.id === "C1").level === "err", "這時對帳 C1 會抓到股數不符");
    const r2 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r2.ok && r2.repeated && r2.recovered && r2.rowNumber === N0 + 2, JSON.stringify(r2));
    eq(e.rows("交易紀錄"), N0 + 1, "沒有多寫交易列");
    eq([e.holding("009816").shares, e.holding("009816").cost], [1251, 17345], "持倉補成改後");
    eq([lastLog(e).狀態, lastLog(e).說明], ["完成", "恢復：補更新持倉"], "紀錄");
    eq(bad(rec(e)), [], "恢復後對帳全過");
    return e.log.filter((x) => x.startsWith("crash")).join("、");
  });

  await test(G, "持倉更新了、紀錄沒標完成：重送只補標完成", () => {
    const e = env();
    crashAt(e, "寫入紀錄", "setValues", (w) => w.vals?.[0]?.[3] === "完成");
    const r1 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r1.unknown, JSON.stringify(r1));
    eq(e.holding("009816").shares, 1251, "持倉已經更新");
    const r2 = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r2.ok && r2.repeated && r2.recovered, JSON.stringify(r2));
    eq(e.holding("009816").shares, 1251, "持倉沒有再加");
    eq([lastLog(e).狀態, lastLog(e).說明], ["完成", "恢復：持倉已經更新，補標完成"], "紀錄");
  });

  await test(G, "中斷後沒人重送：下一筆別的寫入先把它補完，之後查得到結果", () => {
    const e = env();
    crashAt(e, "持倉", "setValues");
    e.post({ action: "addTrade", id: ID, data: TRADE });
    const other = { ...TRADE, code: "00981A", name: "主動統一台股增長", shares: 2, price: 24, amount: 48 };
    const r = e.post({ action: "addTrade", id: ID2, data: other });
    ok(r.ok && !r.repeated, JSON.stringify(r));
    eq(e.logRows().map((x) => x.狀態), ["完成", "完成"], "兩筆都完成");
    eq(e.holding("009816").shares, 1251, "第一筆的持倉補好了");
    eq(e.holding("00981A").shares, 143, "第二筆");
    const s = e.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(s.state === "done" && s.result.recovered, JSON.stringify(s));
    eq(bad(rec(e)), [], "對帳全過");
  });

  await test(G, "查詢也會恢復卡住的請求", () => {
    const e = env();
    crashAt(e, "持倉", "setValues");
    e.post({ action: "addTrade", id: ID, data: TRADE });
    const s = e.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(s.state === "done" && s.result.rowNumber === N0 + 2, JSON.stringify(s));
    eq(e.holding("009816").shares, 1251, "持倉");
  });

  await test(G, "中斷後持倉在試算表被改過：標「需要對帳」，不動持倉、不重寫", () => {
    const e = env();
    crashAt(e, "持倉", "setValues");
    e.post({ action: "addTrade", id: ID, data: TRADE });
    e.edit("持倉", 2, 4, 1300); // 有人照券商資料改了股數
    const r = e.post({ action: "addTrade", id: ID, data: TRADE });
    ok(r.ok === false && r.needsCheck && r.tradeRow === N0 + 2 && /對帳/.test(r.error), JSON.stringify(r));
    eq(e.holding("009816").shares, 1300, "持倉沒被程式改");
    eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄沒多寫");
    eq(lastLog(e).狀態, "需要對帳", "紀錄");
    const s = e.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(s.state === "check" && /不是改前/.test(s.note), JSON.stringify(s));
    const c5 = rec(e).checks.find((c) => c.id === "C5");
    ok(c5.level === "err" && c5.items.some((x) => /需要對帳/.test(x)), JSON.stringify(c5));
    return r.error;
  });

  await test(G, "新的一檔：持倉列寫了值、還沒補公式就中斷：重送補上公式", () => {
    const e = env();
    crashAt(e, "持倉", "copyTo");
    const r1 = e.post({ action: "addTrade", id: ID, data: NEW_CODE });
    ok(r1.unknown, JSON.stringify(r1));
    const h = e.holding("0050");
    ok(h && h.shares === 1 && !e.formula("持倉", h.row, 8), "值寫了、公式還沒有");
    const r2 = e.post({ action: "addTrade", id: ID, data: NEW_CODE });
    ok(r2.ok && r2.recovered, JSON.stringify(r2));
    for (const c of [7, 8, 9]) ok(e.formula("持倉", h.row, c), `第 ${c} 欄補上公式`);
    eq(e.rows("持倉"), 4, "持倉沒有多一列");
  });

  await test(G, "改定投中斷：值還沒寫就重寫一次；值寫了就補公式、標完成", () => {
    const a = env();
    crashAt(a, "定投金額", "setValues");
    ok(a.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } }).unknown, "第一次 unknown");
    eq(a.rows("定投金額"), 1, "還沒寫");
    const a2 = a.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    ok(a2.ok && !a2.repeated && a2.rowNumber === 3, JSON.stringify(a2));
    const b = env();
    crashAt(b, "定投金額", "copyTo");
    ok(b.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } }).unknown, "第一次 unknown");
    eq(b.rows("定投金額"), 2, "值寫了");
    const b2 = b.post({ action: "setMonthly", id: "test-id-monthly-01", data: { amount: 5000 } });
    ok(b2.ok && b2.repeated && b2.recovered && b2.rowNumber === 3, JSON.stringify(b2));
    ok(b.formula("定投金額", 3, 5) && b.formula("定投金額", 3, 6), "補上公式");
    eq(b.rows("定投金額"), 2, "沒有多一列");
  });
}

// ── 案例 5：沖銷 ───────────────────────────────────

async function reverseTests() {
  const G = "案例 5：沖銷";

  await test(G, "沖銷網站寫的買進：多一列相反的沖銷列、原列標記，持倉、資金、本月合計都回到記這筆之前", () => {
    const e = env();
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    eq(buys(e), SEED_BUYS + 149, "記這筆之後的買入合計");
    const data = revData(e, w.rowNumber, "股數記錯");
    const dry = e.post({ action: "reverse", data: { ...data, dryRun: true } });
    ok(dry.ok && dry.dryRun && dry.funds.delta === 149, `試算：${JSON.stringify(dry)}`);
    eq(dry.holding.after, { shares: 1241, cost: 17196 }, "試算的持倉改後");
    eq(e.rows("交易紀錄"), N0 + 1, "試算不寫");
    const r = e.post({ action: "reverse", id: ID2, data });
    ok(r.ok && r.rowNumber === w.rowNumber + 1, JSON.stringify(r));
    const row = e.rowAt("交易紀錄", r.rowNumber);
    const c = (h) => row[e.col("交易紀錄", h) - 1];
    eq([c("日期"), c("代號"), c("買賣"), c("股數"), c("手續費"), c("交割金額"), c("台幣金額"), c("計入資金池")],
      ["2026-11-07", "009816", "買進", "-10", "-1", "-149", "-149", "是"], "沖銷列");
    eq([c("請求編號"), c("更正"), c("台幣金額來源")], [ID2, `沖銷第 ${w.rowNumber} 列`, "網站輸入"], "沖銷列的編號、更正、來源");
    ok(/^沖銷第 \d+ 列：股數記錯（2026-11-07 更正）$/.test(c("備註")), c("備註"));
    eq(e.rowAt("交易紀錄", w.rowNumber)[17], `已被第 ${r.rowNumber} 列沖銷`, "原列標記");
    eq(e.rowAt("交易紀錄", w.rowNumber)[4], "10", "原列數字不動");
    eq([e.holding("009816").shares, e.holding("009816").cost], [1241, 17196], "持倉回到記這筆之前");
    eq(buys(e), SEED_BUYS, "設定的買入合計回到原本（可用資金跟著加回）");
    eq(e.sheets["持倉"].getRange(2, 8).getValues()[0][0], 1241, "持倉的交易紀錄股數公式");
    const d = e.post({ action: "addTrade", id: null, data: { ...TRADE, dryRun: true } });
    eq(d.month.investedBefore, SEED_BUYS, "本月已買（晨報同樣的算法）抵消");
    eq(lastLog(e).動作, "沖銷", "寫入紀錄的動作");
    eq(bad(rec(e)), [], "對帳全過");
    return `沖銷第 ${w.rowNumber} 列 → 第 ${r.rowNumber} 列`;
  });

  await test(G, "手動記的買進（基準日後、有交割金額）也可以沖", () => {
    const e = env();
    const r = e.post({ action: "reverse", id: ID, data: revData(e, 6) });
    ok(r.ok, JSON.stringify(r));
    eq([e.holding("009816").shares, e.holding("009816").cost], [1068, 14653], "持倉");
    eq(buys(e), 949, "買入合計");
    eq(bad(rec(e)), [], "對帳全過");
  });

  await test(G, "拒絕：基準日前的列、美股、沖銷列、已沖銷、內容對不上、沒寫原因、列號不存在", () => {
    const e = env();
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    e.post({ action: "reverse", id: ID2, data: revData(e, w.rowNumber) });
    const n = e.rows("交易紀錄");
    const cases = [
      ["基準日前", revData(e, 2), /沒有計入資金池/],
      ["美股", revData(e, 3), /只能沖銷台股/],
      ["沖銷列", revData(e, w.rowNumber + 1), /本身是沖銷列/],
      ["已沖銷", revData(e, w.rowNumber), /已經沖銷過/],
      ["內容對不上", { ...revData(e, 6), shares: 172 }, /對不上/],
      ["沒寫原因", revData(e, 6, " "), /原因/],
      ["列號不存在", { ...revData(e, 6), row: 99 }, /沒有第 99 列/],
    ];
    const got = [];
    cases.forEach(([name, data, rx], i) => {
      const r = e.post({ action: "reverse", id: `test-reject-${String(i).padStart(4, "0")}`, data });
      ok(r.ok === false && rx.test(r.error), `${name}：${JSON.stringify(r)}`);
      got.push(`${name}→${r.error}`);
    });
    eq(e.rows("交易紀錄"), n, "被拒絕的都沒寫");
    return got.join("\n");
  });

  await test(G, "後面有賣出就要先沖賣出；沖銷網站寫的賣出會把成本精確加回", () => {
    const e = env();
    const b = e.post({ action: "addTrade", id: ID, data: TRADE });
    const s = e.post({ action: "addTrade", id: ID2, data: SELL });
    ok(b.ok && s.ok, JSON.stringify([b, s]));
    near(e.holding("009816").cost, 17275.68, "賣出照平均成本扣");
    const r1 = e.post({ action: "reverse", id: "test-rev-0001-buy", data: revData(e, b.rowNumber) });
    ok(r1.ok === false && /賣出還沒沖銷/.test(r1.error), JSON.stringify(r1));
    const r2 = e.post({ action: "reverse", id: "test-rev-0002-sell", data: revData(e, s.rowNumber) });
    ok(r2.ok && r2.funds.delta === -74, JSON.stringify(r2));
    eq([e.holding("009816").shares, e.holding("009816").cost], [1251, 17345], "沖掉賣出：回到賣出前");
    eq(sells(e), 0, "賣出回收回到 0");
    const r3 = e.post({ action: "reverse", id: "test-rev-0003-buy", data: revData(e, b.rowNumber) });
    ok(r3.ok, JSON.stringify(r3));
    eq([e.holding("009816").shares, e.holding("009816").cost], [1241, 17196], "再沖買進：回到一開始");
    eq(bad(rec(e)), [], "對帳全過");
  });

  await test(G, "手動記的賣出不能從網站沖（不知道當時減掉多少成本）", () => {
    const e = env();
    const r = e.sheets["交易紀錄"].getLastRow() + 1;
    ["2026-11-06", "台股", "009816", "賣出", 1, 15, "TWD", 1, 14, "", 14, "是", "券商", "手動", "", 0]
      .forEach((v, i) => e.edit("交易紀錄", r, i + 1, v));
    const x = e.post({ action: "reverse", id: ID, data: revData(e, r) });
    ok(x.ok === false && /不是網站寫的/.test(x.error), JSON.stringify(x));
  });

  await test(G, "沖銷同編號重送只沖一次；沖銷列寫了、原列還沒標就中斷：重送補標記與持倉", () => {
    const e = env();
    const w = e.post({ action: "addTrade", id: ID, data: TRADE });
    const data = revData(e, w.rowNumber);
    crashAt(e, "交易紀錄", "setValue");
    const r1 = e.post({ action: "reverse", id: ID2, data });
    ok(r1.unknown, JSON.stringify(r1));
    eq(e.rowAt("交易紀錄", w.rowNumber)[17] || "", "", "原列還沒標");
    eq(e.holding("009816").shares, 1251, "持倉還沒動");
    const r2 = e.post({ action: "reverse", id: ID2, data });
    ok(r2.ok && r2.recovered && r2.rowNumber === w.rowNumber + 1, JSON.stringify(r2));
    eq(e.rowAt("交易紀錄", w.rowNumber)[17], `已被第 ${w.rowNumber + 1} 列沖銷`, "補上標記");
    eq(e.holding("009816").shares, 1241, "補好持倉");
    const r3 = e.post({ action: "reverse", id: ID2, data });
    ok(r3.ok && r3.repeated, JSON.stringify(r3));
    eq(e.rows("交易紀錄"), N0 + 2, "只有一列沖銷列");
    eq(bad(rec(e)), [], "對帳全過");
  });
}

// ── 案例 6：對帳 ───────────────────────────────────

async function reconcileTests() {
  const G = "案例 6：對帳";

  await test(G, "種子帳本 7 條規則全過；美股列出股數差異與確認日；對帳不寫入", () => {
    const e = env();
    const r = rec(e);
    ok(r.ok, JSON.stringify(r));
    eq(r.checks.map((c) => c.id), ["C1", "C2", "C3", "C4", "C5", "C6", "C7"], "規則");
    eq(bad(r), [], "全過");
    eq(r.basis, "2026-10-06", "基準日");
    eq(r.us, [{ code: "VOO", shares: 1, confirmed: "2026-10-16", diff: 0 }], "美股");
    ok(!e.sheets["寫入紀錄"], "對帳不建分頁");
    eq(e.rows("交易紀錄"), N0, "對帳不寫入");
  });

  await test(G, "每條規則都抓得到錯", () => {
    const cases = [
      ["C1", "err", (e) => e.edit("持倉", 2, 4, 1240)],
      ["C2", "warn", (e) => { e.post({ action: "addTrade", id: ID, data: TRADE }); e.edit("持倉", 2, 5, 17000); }],
      ["C3", "err", (e) => e.edit("交易紀錄", 5, 12, "否")],
      ["C4", "err", (e) => e.edit("交易紀錄", 5, 9, 960)],
      ["C5", "err", (e) => { const w = e.post({ action: "addTrade", id: ID, data: TRADE }); e.edit("交易紀錄", w.rowNumber, 17, ""); }],
      ["C6", "err", (e) => {
        const w = e.post({ action: "addTrade", id: ID, data: TRADE });
        e.post({ action: "reverse", id: ID2, data: revData(e, w.rowNumber) });
        e.edit("交易紀錄", w.rowNumber, 18, "");
      }],
      ["C7", "err", (e) => e.edit("設定", 3, 2, 100)],
    ];
    const got = [];
    for (const [id, level, mess] of cases) {
      const e = env();
      mess(e);
      const r = rec(e);
      const c = r.checks.find((x) => x.id === id);
      ok(c.level === level && c.items.length > 0, `${id} 要是 ${level}：${JSON.stringify(c)}`);
      got.push(`${id}：${c.items[0]}`);
    }
    return got.join("\n");
  });
}

// ── 每天自動記配息（docs/AUTO_DIVIDENDS.md 第 2 節） ─────────

const INC = "其他入帳";
const FX_CSV = "2026-12-24,32.1\n2026-12-28,32.5\n2026-12-29,32.9\n2026-12-31,33.5\n2027-01-05,31.0\n";
const ev = (ex, pay, cash) => ({ ex_date: ex, pay_date: pay, cash, year: "115", source: "FinMind", official_checked: false });
const usEv = (ex, cash) => ({ ex_date: ex, cash });
const incAll = (e) => Array.from({ length: e.sheets[INC].getLastRow() - 1 }, (_, i) => e.rowAt(INC, i + 2));
// 把市場資料放進假網路。twEv／usEv＝{ 代號: [事件] }；today＝假的今天
function feed(e, { twEv = {}, usEvents = {}, fx = FX_CSV, today } = {}) {
  e.web.tw = { etfs: Object.fromEntries(Object.entries(twEv).map(([c, events]) => [c, { events, ttm_cash: 0, ttm_count: 0, last: null, next: null }])) };
  e.web.us = { symbols: Object.fromEntries(Object.entries(usEvents).map(([c, events]) => [c, { events, last: null, ttm_cash: 0, ttm_count: 0 }])) };
  e.web.fx = fx;
  if (today) e.today = today;
}
// 在交易紀錄最後加一列（只填會用到的欄）
function addTradeRow(e, { date, market = "台股", code, side, shares }) {
  const r = e.sheets["交易紀錄"].getLastRow() + 1;
  const put = (h, v) => e.edit("交易紀錄", r, e.col("交易紀錄", h), v);
  put("日期", date); put("市場", market); put("代號", code); put("買賣", side); put("股數", shares);
  return r;
}
const NI0 = 2; // 種子其他入帳的資料列數

async function autoDivTests() {
  const G = "自動記配息";
  const SAME = "；跟錢包實收不同可以直接改 G 欄";

  await test(G, "台股：00981A 141 股 × 0.63＝89；整列 A～K 的內容；除息日前的舊事件不記", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-06-16", "2026-07-09", 0.63), ev("2026-12-16", "2027-01-08", 0.63)], "009816": [] }, today: "2027-01-08" });
    const before = incAll(e);
    const r = e.auto();
    ok(r.ok && r.added === 1, JSON.stringify(r));
    eq(e.rows(INC), NI0 + 1, "只多一列");
    eq(e.rowAt(INC, 4), ["2027-01-08", "台股", "00981A", "配息", "", "", "89", "是", "自動估算",
      "除息 12/16，每單位 0.63 元 × 除息前 141 股" + SAME, "2026-12-16"], "新的一列");
    eq(incAll(e).slice(0, NI0), before, "原本兩列不動");
    return e.rowAt(INC, 4).join(" | ");
  });

  await test(G, "美股：VOO 0.1262 股的季配約 5 元；入帳日＝除息日＋7、匯率用入帳日或之前最近一天", () => {
    const e = env();
    e.edit("交易紀錄", 3, 5, 0.1262); // 種子的 VOO 那列改成 0.1262 股（跟實際帳本一樣）
    feed(e, { usEvents: { VOO: [usEv("2026-12-23", 1.8)], GOOGL: [] }, today: "2026-12-30" });
    const r = e.auto();
    ok(r.ok && r.added === 1, JSON.stringify(r));
    // 0.1262 × 1.8 × 0.7＝0.159；12/30 之前最近的匯率是 12/29 的 32.9（不是 12/31 的 33.5）；0.159 × 32.9＝5.23 → 5
    eq(e.rowAt(INC, 4), ["2026-12-30", "美股", "VOO", "配息", "0.159", "USD", "5", "是", "自動估算",
      "除息 12/23，每股 US$1.8 × 0.1262 股，扣 30% 預扣稅，匯率 32.9" + SAME, "2026-12-23"], "新的一列");
  });

  await test(G, "除息前股數：除息日當天買的不算、賣光的不算、沖銷的一對互相抵消", () => {
    const e = env();
    addTradeRow(e, { date: "2026-12-10", code: "00981A", side: "買進", shares: 5 });          // 算
    addTradeRow(e, { date: "2026-12-16", code: "00981A", side: "買進", shares: 10 });         // 除息日當天：不算
    addTradeRow(e, { date: "2026-12-12", code: "00981A", side: "買進", shares: 7 });          // 這筆跟下一列互相沖銷
    addTradeRow(e, { date: "2026-12-12", code: "00981A", side: "買進", shares: -7 });
    addTradeRow(e, { date: "2026-11-20", code: "0056", side: "買進", shares: 100 });          // 買了又賣光
    addTradeRow(e, { date: "2026-12-01", code: "0056", side: "賣出", shares: 100 });
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)], "0056": [ev("2026-12-16", "2027-01-08", 1.2)],
      "0050": [ev("2026-12-16", "2027-01-08", 0.6)] }, today: "2027-01-08" }); // 0050 從來沒買過
    const r = e.auto();
    ok(r.ok && r.added === 1, JSON.stringify(r));
    const row = e.rowAt(INC, 4);
    eq(row[2], "00981A", "只有 00981A");
    eq(row[6], "92", "146 股 × 0.63＝91.98 → 92");
    ok(row[9].includes("除息前 146 股"), row[9]);
  });

  await test(G, "台股：沒有 pay_date 不記、pay_date 還沒到不記；到了（含當天）才記", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "", 0.63)] }, today: "2027-01-10" });
    ok(e.auto().added === 0, "沒有 pay_date");
    e.web.tw.etfs["00981A"].events[0].pay_date = null;
    ok(e.auto().added === 0, "pay_date 是 null");
    e.web.tw.etfs["00981A"].events[0].pay_date = "2027-01-08";
    e.today = "2027-01-07";
    ok(e.auto().added === 0, "發放日是明天");
    eq(e.rows(INC), NI0, "什麼都沒寫");
    e.today = "2027-01-08";
    ok(e.auto().added === 1, "發放日當天就記");
    eq(e.rowAt(INC, 4)[0], "2027-01-08", "入帳日");
  });

  await test(G, "美股：入帳日＝除息日＋7 天，沒到不記", () => {
    const e = env();
    feed(e, { usEvents: { VOO: [usEv("2026-12-23", 1.8)] }, today: "2026-12-29" });
    ok(e.auto().added === 0, "12/29 還沒到");
    e.today = "2026-12-30";
    ok(e.auto().added === 1, "12/30＝12/23＋7");
    eq(e.rowAt(INC, 4)[0], "2026-12-30", "入帳日");
  });

  await test(G, "重複跑不會多記；格子被改成 Date、斜線文字日期、小寫代號也認得是同一筆", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, usEvents: { VOO: [usEv("2027-01-05", 1.8)] }, today: "2027-01-08" });
    ok(e.auto().added === 1, "第一次：00981A（VOO 的入帳日 1/12 還沒到）");
    ok(e.auto().added === 0, "第二次不再記");
    // 使用者把那一列的除息日改成 Date 物件、入帳日改成文字、代號改小寫：還是同一筆
    e.edit(INC, 4, 11, new Date(Date.UTC(2026, 11, 16)));
    e.edit(INC, 4, 1, "2027/1/8");
    e.edit(INC, 4, 3, "00981a");
    ok(e.auto().added === 0, "改格式後不重複");
    // 手動記的 VOO 配息，除息日填文字「2027/1/5」：入帳日到了也不重複
    e.edit(INC, 2, 11, "2027/1/5");
    e.today = "2027-01-12";
    const r = e.auto();
    ok(r.ok && r.added === 0, `手動記過的 VOO 不能再記：${JSON.stringify(r)}`);
    eq(e.rows(INC), NI0 + 1, "最後只有自動記的那一列");
  });

  await test(G, "使用者改過的 G 欄不會被動到；既有的列一個字都不變", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    e.auto();
    e.edit(INC, 4, 7, 95); // 錢包實收 95
    e.edit(INC, 4, 10, "我改的備註");
    const snap = incAll(e);
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63), ev("2027-03-17", "2027-04-09", 0.5)] }, today: "2027-04-10" });
    e.auto();
    const now = incAll(e);
    eq(now.slice(0, snap.length), snap, "原本每一列都沒變（含改過的 G 與備註）");
    eq(now.length, snap.length + 1, "只多一列");
    eq(now[snap.length][6], "71", "新的一列：141 股 × 0.5＝70.5 → 71");
    eq(now[snap.length][10], "2027-03-17", "新的一列的除息日");
  });

  await test(G, "AUTO_DIV_START（2026-11-18）：之前的除息不記，當天含", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-09-16", "2026-10-13", 0.63), ev("2026-11-17", "2026-12-10", 0.6), ev("2026-11-18", "2026-12-11", 0.7)] },
      usEvents: { VOO: [usEv("2026-11-10", 1.8)] }, today: "2026-12-31" });
    const r = e.auto();
    ok(r.ok && r.added === 1, JSON.stringify(r));
    eq(e.rowAt(INC, 4).slice(0, 3), ["2026-12-11", "台股", "00981A"], "只有 11/18 當天的");
    eq(e.rowAt(INC, 4)[10], "2026-11-18", "除息日");
  });

  await test(G, "H 欄：入帳日 ≥ 設定的基準日→是，之前→否", () => {
    const run = (basis) => {
      const e = env();
      e.edit("設定", 2, 2, serialOf(basis));
      feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
      e.auto();
      return e.rowAt(INC, 4)[7];
    };
    eq(run("2026-10-06"), "是", "基準日在入帳日之前");
    eq(run("2027-01-08"), "是", "基準日＝入帳日");
    eq(run("2027-01-09"), "否", "入帳日在基準日之前");
  });

  await test(G, "抓不到資料（HTTP 錯誤、連線失敗、不是 JSON、格式不對、沒有匯率）：整次不寫任何列，錯誤記在狀態", () => {
    const good = { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, usEvents: { VOO: [usEv("2027-01-05", 1.8)] }, today: "2027-01-08" };
    const cases = [
      ["tw 404", (e) => { e.web.tw = null; }],
      ["us 404（市場資料還沒有 us.json）", (e) => { e.web.us = null; }],
      ["fx 404", (e) => { e.web.fx = null; }],
      ["tw 連線失敗", (e) => { e.web.tw = new Error("Address unavailable"); }],
      ["us 不是 JSON", (e) => { e.web.us = "<html>oops</html>"; }],
      ["tw 格式不對", (e) => { e.web.tw = { hello: 1 }; }],
      ["us 格式不對", (e) => { e.web.us = { etfs: {} }; }],
      ["fx 沒有匯率", (e) => { e.web.fx = "date,value\n"; }],
    ];
    const got = [];
    for (const [name, mess] of cases) {
      const e = env();
      feed(e, good);
      mess(e);
      const before = incAll(e);
      const r = e.auto();
      ok(r.ok === false && r.added === 0 && r.error, `${name}：${JSON.stringify(r)}`);
      eq(incAll(e), before, `${name}：其他入帳不能變`);
      const st = JSON.parse(e.props.AUTO_DIV_STATUS);
      ok(st.error === r.error && st.added === 0 && st.lastRun, `${name}：狀態 ${JSON.stringify(st)}`);
      got.push(`${name}：${r.error}`);
      // 資料恢復後隔天照常記
      feed(e, good);
      ok(e.auto().added === 1, `${name}：恢復後要能記`);
    }
    return got.join("\n");
  });

  await test(G, "入帳日之前沒有匯率：那一筆美股不記並寫進錯誤，台股照記", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, usEvents: { VOO: [usEv("2026-12-23", 1.8)] },
      fx: "2027-01-05,31.0\n", today: "2027-01-08" });
    const r = e.auto();
    ok(r.ok === false && r.added === 1 && /VOO/.test(r.error) && /匯率/.test(r.error), JSON.stringify(r));
    eq(incAll(e).map((x) => x[2]), ["VOO", "", "00981A"], "只多了 00981A");
  });

  await test(G, "其他入帳分頁不在、缺「除息日」欄、設定找不到基準日：什麼都不寫", () => {
    const miss = env();
    feed(miss, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    delete miss.sheets[INC];
    const r1 = miss.auto();
    ok(r1.ok === false && /其他入帳/.test(r1.error), JSON.stringify(r1));
    const noK = env();
    feed(noK, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    noK.edit(INC, 1, 11, "");
    const r2 = noK.auto();
    ok(r2.ok === false && /除息日/.test(r2.error), JSON.stringify(r2));
    eq(noK.rows(INC), NI0, "沒寫");
    const noBasis = env();
    feed(noBasis, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    noBasis.edit("設定", 2, 1, "別的項目");
    const r3 = noBasis.auto();
    ok(r3.ok === false && /基準日/.test(r3.error), JSON.stringify(r3));
    eq(noBasis.rows(INC), NI0, "沒寫");
  });

  await test(G, "用鎖：跟網站記帳互斥（鎖被占住就這次不檢查、不抓資料、不寫）；跑完一定放鎖", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    e.setHeld(true);
    const busy = e.auto();
    ok(busy.ok === false && /正在寫入/.test(busy.error) && busy.added === 0, JSON.stringify(busy));
    ok(!e.log.some((x) => x.startsWith("fetch")), "鎖不到就不抓資料");
    eq(e.rows(INC), NI0, "沒寫");
    ok(JSON.parse(e.props.AUTO_DIV_STATUS).error, "狀態記下這次沒檢查");
    e.setHeld(false);
    e.log.length = 0;
    ok(e.auto().added === 1, "鎖放掉之後照常記");
    ok(e.log.indexOf("lock") >= 0 && e.log.indexOf("lock") < e.log.indexOf("fetch tw") && e.log.at(-1) === "unlock", `鎖在抓資料之前拿、最後放：${e.log.join(" → ")}`);
    // 失敗時也要放鎖：緊接著網站記帳寫得進去
    e.web.tw = null;
    e.auto();
    ok(e.post({ action: "addTrade", id: ID, data: TRADE }).ok, "自動記配息失敗後，網站記帳不能被鎖卡住");
  });

  await test(G, "ping 與 status 帶 autoDividends: { lastRun, added, error }；沒跑過是 null", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    const p0 = e.post({ action: "ping" });
    ok(p0.ok && p0.autoDividends === null, JSON.stringify(p0));
    e.auto();
    const p1 = e.post({ action: "ping" });
    eq(Object.keys(p1.autoDividends).sort(), ["added", "error", "lastRun"], "欄位");
    ok(p1.autoDividends.added === 1 && p1.autoDividends.error === "" && p1.autoDividends.lastRun.startsWith("2027-01-08 "), JSON.stringify(p1.autoDividends));
    ok(p1.version === "2026-11-B", `版本字串不變（live_check.js 認它）：${p1.version}`);
    e.web.tw = null;
    e.auto();
    const s = e.post({ action: "status", data: { id: ID, action: "addTrade", data: TRADE } });
    ok(s.ok && s.state === "none" && s.autoDividends.added === 0 && /tw_etf/.test(s.autoDividends.error), JSON.stringify(s));
  });

  await test(G, "網站記帳和自動記配息交錯：互不影響（持倉、其他入帳都對）", () => {
    const e = env();
    feed(e, { twEv: { "00981A": [ev("2026-12-16", "2027-01-08", 0.63)] }, today: "2027-01-08" });
    ok(e.post({ action: "addTrade", id: ID, data: { ...TRADE, date: "2027-01-07" } }).ok, "網站記帳");
    ok(e.auto().added === 1, "自動記配息");
    ok(e.post({ action: "addTrade", id: ID2, data: { ...TRADE, date: "2027-01-08", code: "00981A", name: "主動統一台股增長" } }).ok, "再記一筆");
    eq(bad(rec(e)), [], "對帳全過");
    eq(e.rows(INC), NI0 + 1, "其他入帳");
  });

  await test(G, "installDividendTrigger：每天台北 9 點的時間觸發器，重複執行不會多建；removeDividendTrigger 拿掉", () => {
    const e = env();
    const m1 = e.installTrigger();
    eq(e.triggers.length, 1, "建了一個");
    eq(e.triggers[0].spec, { fn: "autoDividends", everyDays: 1, atHour: 9, tz: "Asia/Taipei" }, "設定");
    const m2 = e.installTrigger();
    eq(e.triggers.length, 1, "沒有重複建");
    ok(/已經有/.test(m2), m2);
    e.triggers.push({ spec: { fn: "別的函式" }, getHandlerFunction: () => "別的函式" });
    e.removeTrigger();
    eq(e.triggers.map((t) => t.getHandlerFunction()), ["別的函式"], "只拿掉自己的");
    return `${m1}／${m2}`;
  });
}

// ── 網站 site/js/ledger_write.js ─────────────────────

const LS_KEYS = ["ledger.writeUrl", "ledger.writeKey", "ledger.pendingTrade"];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

async function siteTests() {
  const G = "網站";
  const W = await import("../../site/js/ledger_write.js");
  // 正式帳本現在的 R02 版（第 B 批之前）：網站要能和它一起用。先讀好，下面的測試會把 fetch 換成假的
  const r02 = await loadGasSource("ledger_write_r02.gs").catch(() => null);
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

    await test(G, "未確認的請求只存編號、動作、內容、時間、網址，不存密鑰", () => {
      ok(W.savePending(ID, TRADE, FAKE_URL, 1000), "要能儲存");
      const raw = localStorage.getItem("ledger.pendingTrade");
      ok(!raw.includes(TEST_KEY), "localStorage 裡不能有密鑰");
      eq(Object.keys(JSON.parse(raw)).sort(), ["action", "at", "data", "id", "url"], "存的欄位");
      eq(W.loadPending(), { id: ID, action: "addTrade", data: TRADE, at: 1000, url: FAKE_URL }, "讀回");
      W.savePending(ID2, { row: 7 }, FAKE_URL, 2000, "reverse");
      eq(W.loadPending().action, "reverse", "沖銷也可以存");
      // 第 B 批之前存的（沒有 action）當作新增成交
      localStorage.setItem("ledger.pendingTrade", JSON.stringify({ id: ID, data: TRADE, at: 1000, url: FAKE_URL }));
      eq(W.loadPending().action, "addTrade", "舊格式");
      W.clearPending();
      eq(W.loadPending(), null, "清除後");
    });

    await test(G, "壞掉的紀錄當作沒有並清掉", () => {
      for (const bad of ["{", JSON.stringify({ id: "x", data: TRADE, at: 1, url: FAKE_URL }),
        JSON.stringify({ id: ID, data: TRADE, url: FAKE_URL }), JSON.stringify({ id: ID, data: "s", at: 1, url: FAKE_URL }),
        JSON.stringify({ id: ID, action: "setMonthly", data: TRADE, at: 1, url: FAKE_URL })]) {
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
      eq(e.rows("交易紀錄"), N0 + 1, "交易紀錄列數");
      ok(seen.every((b) => b.id === ID), "兩次都用同一個編號");
      return out.rowNumber && `第 ${out.rowNumber} 列，第二次 repeated`;
    });

    await test(G, "案例 2：回應遺失後查詢（不寫交易）就拿到結果；沒收到的回 none", async () => {
      const e = env();
      let lose = true;
      route((init) => {
        const out = e.raw(init.body);
        if (lose) { lose = false; throw new TypeError("Failed to fetch"); }
        return json(out);
      });
      try { await W.callLedger("addTrade", TRADE, ID); } catch { /* 回應遺失 */ }
      const q = await W.queryLedger({ id: ID, action: "addTrade", data: TRADE });
      ok(q.state === "done" && q.result.rowNumber === N0 + 2, JSON.stringify(q));
      const n = await W.queryLedger({ id: ID2, action: "addTrade", data: TRADE });
      eq(n.state, "none", "沒送過的");
      eq(e.rows("交易紀錄"), N0 + 1, "查詢沒寫");
      const body = seen.at(-1);
      ok(body.action === "status" && body.id == null && body.data.id === ID2, `編號放在 data 裡：${JSON.stringify(body)}`);
    });

    await test(G, "舊版 Apps Script（R02，沒有查詢）：queryLedger 回 unsupported，不會被當成同編號的衝突", async () => {
      ok(r02, "讀不到 tests/apps_script/ledger_write_r02.gs");
      const e = makeEnv(r02);
      const w = e.post({ action: "addTrade", id: ID, data: TRADE }); // 舊版快取裡有這個編號
      ok(w.ok, `R02 版寫入：${JSON.stringify(w)}`);
      route((init) => json(e.raw(init.body)));
      const q = await W.queryLedger({ id: ID, action: "addTrade", data: TRADE });
      eq(q.state, "unsupported", "舊版");
      const again = await W.callLedger("addTrade", TRADE, ID); // 舊版照舊用原編號重送確認
      ok(again.repeated, JSON.stringify(again));
      eq(e.rows("交易紀錄"), N0 + 1, "只寫一筆");
    });

    await test(G, "錯誤分類：逾時、HTTP 錯、不是 JSON、寫到一半出錯是 unknown；密鑰錯、帳本忙碌是 notSent；需要對帳是 check；內容錯是 rejected", async () => {
      const cases = [
        ["逾時", () => { throw new DOMException("aborted", "AbortError"); }, "unknown"],
        ["HTTP 500", () => new Response("err", { status: 500 }), "unknown"],
        ["不是 JSON", () => new Response("<html>登入</html>", { status: 200 }), "unknown"],
        ["寫到一半出錯", () => json({ ok: false, unknown: true, error: "寫入失敗：…" }), "unknown"],
        ["密鑰不對", () => json({ ok: false, retry: true, error: "密鑰不對" }), "notSent"],
        ["帳本忙碌", () => json({ ok: false, retry: true, error: "帳本正在寫入別的資料，稍後再試" }), "notSent"],
        ["需要對帳", () => json({ ok: false, needsCheck: true, error: "持倉對不上" }), "check"],
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

    await test(G, "讀取端：沖銷列和它沖掉的原列一起拿掉（績效、K 線、持倉頁讀的 loadTrades）；記帳頁的 loadTradeRows 全部都有", async () => {
      const { SOURCES } = await import("../../site/js/config.js");
      const D = await import("../../site/js/data.js");
      const e = env();
      const w = e.post({ action: "addTrade", id: ID, data: TRADE });
      e.post({ action: "reverse", id: ID2, data: revData(e, w.rowNumber) });
      window.fetch = async (url) => {
        if (String(url) === SOURCES.ledger.trades) return new Response(e.sheets["交易紀錄"].csv(), { status: 200 });
        throw new Error(`測試不允許連到 ${url}`);
      };
      D.clearCache();
      const rows = await D.loadTradeRows();
      const eff = await D.loadTrades();
      D.clearCache();
      eq(rows.map((t) => t.row), [2, 3, 4, 5, 6, 7, 8], "全部的列號（試算表列號）");
      eq(eff.map((t) => t.row), [2, 3, 4, 5, 6], "有效成交拿掉第 7、8 列");
      eq([rows[5].reqId, rows[5].mark, rows[6].mark], [ID, "已被第 8 列沖銷", "沖銷第 7 列"], "請求編號與更正欄");
      eq(rows[6].shares, -10, "沖銷列的股數是負的");
    });

    await test(G, "送出的請求內文有密鑰（只在 POST 內文），網址沒有參數", () => {
      const posts = seen.filter((b) => b && typeof b === "object");
      ok(posts.length > 0 && posts.every((b) => b.key === TEST_KEY), "內文要有密鑰");
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
  if (!params.has("src")) { // 對照舊版時只跑上面那組
    await logTests();
    await recoverTests();
    await reverseTests();
    await reconcileTests();
    await autoDivTests();
    await siteTests();
  }
} catch (e) {
  results.push({ group: "載入", name: "測試沒辦法開始", pass: false, detail: String(e && e.stack || e) });
}
show();
