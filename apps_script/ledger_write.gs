// 共用帳本的寫入服務：Google Apps Script 網頁應用程式，綁在「投資共用帳本」試算表上（docs/LEDGER_WRITE.md）。
// 網站「記帳」頁用 POST 送 JSON（Content-Type: text/plain，不會有 CORS 預檢），這裡核對密鑰後：
// （本機測試：tests/apps_script/ledger_write_test.html，用假的 SpreadsheetApp 等服務跑這一份程式）
//   - addTrade：在「交易紀錄」加一列台股成交，並更新「持倉」的股數與總成本
//   - setMonthly：改每月定投金額，從下個月生效（寫在「定投金額」分頁）
//   - reverse：沖銷一筆記錯的台股成交（加一列數字相反的沖銷列，原列只標記），持倉照規則回推
//   - status：用請求編號查寫入結果（不寫交易；會順便恢復中斷的請求）
//   - reconcile：對帳（只讀），規則見 docs/LEDGER_CONSISTENCY.md 2.6
//   - ping：測試連線，不寫入
// 寫入密鑰只放在這個專案的指令碼屬性 WRITE_KEY：不放試算表（帳本是公開發布的），也不進 git。
// 日期一律用台北時間；寫進儲存格時用試算表序號，不受指令碼時區影響。
//
// 一致性（第 B 批，docs/LEDGER_CONSISTENCY.md）：交易紀錄是唯一的事實來源。每個寫入請求在「寫入紀錄」分頁有一列：
// 先記「處理中」（含持倉改前、改後）→ 寫交易列（帶請求編號）→ 更新持倉 → 標「完成」。整個寫入都在鎖裡，
// 所以拿到鎖時還看到「處理中」就代表那次執行中斷了：照帳本實際狀態補完，補不了就標「需要對帳」，不猜。

const TZ = "Asia/Taipei";
const SHEET_TRADES = "交易紀錄";
const SHEET_HOLD = "持倉";
const SHEET_DCA = "定投金額";
const SHEET_SET = "設定";
const SHEET_LOG = "寫入紀錄";
const TRADE_COLS = ["日期", "市場", "代號", "買賣", "股數", "成交價", "幣別", "手續費", "交割金額", "匯率", "台幣金額",
  "計入資金池", "台幣金額來源", "備註", "成交時間", "交易稅"];
const TRADE_NEW_COLS = ["請求編號", "更正"]; // 第 B 批加在交易紀錄最後；沒有就在第一次寫入時自動加表頭
const HOLD_COLS = ["市場", "代號", "名稱", "股數", "總成本", "幣別", "確認日", "來源"];
const DCA_COLS = ["生效月份", "每月定投", "設定日期", "備註"];
const LOG_COLS = ["請求編號", "動作", "內容雜湊", "狀態", "收到時間", "完成時間", "交易紀錄列", "代號",
  "持倉改前", "持倉改後", "請求內容", "回應", "說明"];
const ACTIONS = { addTrade: "新增交易", setMonthly: "改定投", reverse: "沖銷" };
const ST = { RUN: "處理中", DONE: "完成", NONE: "未寫入", CHECK: "需要對帳", MANUAL: "已人工處理" };
const NO_ROW = "（沒有這列）";
const VERSION = "2026-11-B"; // 測試連線會回報；網站用它判斷 Apps Script 有沒有查詢、沖銷、對帳
const SOURCE = "網站輸入";
const MAX_FAILS = 10;        // 密鑰錯 10 次就暫停 10 分鐘
const FAIL_WINDOW_S = 600;
const DEDUPE_S = 21600;      // 快取 6 小時：鎖外的快速路徑；真正的依據是「寫入紀錄」分頁（永久）
// 快取 req:<id> 存 { v: 2, hash, out }：hash 是這筆請求內容（action＋data）的 SHA-256，同編號不同內容就拒絕。

class UserError extends Error {}

function doGet() {
  return json_({ ok: false, error: "這是帳本寫入服務，請從網站的「記帳」頁送出" });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "");
  } catch (err) {
    return json_({ ok: false, error: "請求格式錯誤" });
  }
  // retry: true＝這次還沒處理到這筆（密鑰、暫停、帳本忙碌），修好後可以用同一個請求編號再送
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("fails") || 0);
  if (fails >= MAX_FAILS) return json_({ ok: false, retry: true, error: "密鑰錯太多次，10 分鐘後再試" });
  const want = PropertiesService.getScriptProperties().getProperty("WRITE_KEY");
  if (!want || want.length < 20) return json_({ ok: false, retry: true, error: "Apps Script 還沒設定指令碼屬性 WRITE_KEY（至少 20 個字元）" });
  if (!sameKey_(String(req.key || ""), want)) {
    cache.put("fails", String(fails + 1), FAIL_WINDOW_S);
    return json_({ ok: false, retry: true, error: "密鑰不對" });
  }

  const action = String(req.action || "");
  const data = req.data || {};
  const dry = data.dryRun === true;
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(String(req.id || "")) ? String(req.id) : null;
  const write = !dry && Object.prototype.hasOwnProperty.call(ACTIONS, action);
  if (write && !id) return json_({ ok: false, error: "缺少請求編號，請重新整理網站再送" });
  // 只有真的寫入（不是試算、查詢、對帳、ping）才查重；hash 用來分辨「同一筆重送」和「編號被拿去送另一筆」
  const hash = write ? requestHash_(action, data) : null;
  if (hash) {
    const hit = cacheHit_(cache, id, hash); // 快速路徑：不用排隊等鎖
    if (hit) return json_(hit);
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, retry: true, error: "帳本正在寫入別的資料，稍後再試" });
  }
  try {
    let out;
    if (write) out = runWrite_(cache, action, data, id, hash);
    else if (action === "status") out = status_(cache, data);
    else if (action === "reconcile") out = reconcile_();
    else if (action === "ping") out = ping_();
    else if (action === "addTrade") out = addTrade_(data, null);
    else if (action === "setMonthly") out = setMonthly_(data, null);
    else if (action === "reverse") out = reverse_(data, null);
    else throw new UserError("不支援的動作");
    if (out.ok === undefined) out.ok = true;
    return json_(out);
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message });
    console.error(err);
    const msg = "寫入失敗：" + ((err && err.message) || err);
    // 寫到一半出錯：寫入紀錄還是「處理中」，下一個請求會照帳本實際狀態補完。unknown＝可能寫了一部分，用原編號再送或查詢
    if (write) return json_({ ok: false, unknown: true, error: msg + "。可能已經寫了一部分：用同一個請求編號確認，會照帳本實際狀態補完，不會重複記帳" });
    return json_({ ok: false, error: msg });
  } finally {
    lock.releaseLock();
  }
}

// ── 寫入（鎖內） ───────────────────────────────────────

function runWrite_(cache, action, data, id, hash) {
  const book = logBook_(true); // 沒有「寫入紀錄」分頁就建
  ensureTradeCols_();          // 交易紀錄沒有「請求編號」「更正」欄就加表頭
  recoverAll_(book);           // 先把中斷的請求補完
  const ent = book.find(id);
  if (ent) {
    if (ent.hash !== hash) return conflict_();
    if (ent.state === ST.DONE) return Object.assign(book.full(ent).out || {}, { ok: true, repeated: true });
    if (ent.state === ST.CHECK || ent.state === ST.MANUAL) return needsCheck_(book.full(ent));
    // 未寫入：上次中斷時還沒寫進交易紀錄。照一般流程重新驗證、寫一次（沿用同一列紀錄）
  } else {
    const hit = cacheHit_(cache, id, hash); // 第 B 批之前只記在快取的請求
    if (hit) return hit;
  }
  const ctx = { id, hash, action, data, book, ent: ent ? book.full(ent) : null };
  const out = action === "addTrade" ? addTrade_(data, ctx) : action === "setMonthly" ? setMonthly_(data, ctx) : reverse_(data, ctx);
  try {
    cache.put("req:" + id, JSON.stringify({ v: 2, hash, out }), DEDUPE_S);
  } catch (err) {
    console.error(err); // 已經寫進帳本了，快取失敗不能回報成寫入失敗
  }
  return out;
}

function conflict_() {
  return { ok: false, conflict: true,
    error: "這個請求編號已經用在另一筆內容不同的資料，這次沒有寫入。請重新按「檢查這筆」再送。" };
}

function needsCheck_(ent) {
  return { ok: false, needsCheck: true, tradeRow: ent.tradeRow || null,
    error: "這筆寫進了交易紀錄第 " + ent.tradeRow + " 列，但持倉對不上，沒有再寫（" + ent.note + "）。請按記帳頁的「對帳」，照說明到試算表處理。" };
}

// 「處理中」：在動交易紀錄之前先記下要做什麼
function beginLog_(ctx, f) {
  const ent = ctx.ent || { row: 0, id: ctx.id };
  Object.assign(ent, { action: ctx.action, hash: ctx.hash, state: ST.RUN, at: nowText_(), doneAt: "", tradeRow: "",
    code: f.code || "", hasHold: !!f.code, before: f.before, after: f.after, data: ctx.data, out: f.out, note: "" });
  ctx.book.write(ent);
  SpreadsheetApp.flush();
  ctx.ent = ent;
}

function finishLog_(ctx, out, tradeRow) {
  out.ok = true;
  Object.assign(ctx.ent, { state: ST.DONE, doneAt: nowText_(), tradeRow: tradeRow || "", out });
  ctx.book.write(ctx.ent);
  SpreadsheetApp.flush();
}

// ── 動作 ───────────────────────────────────────────────

function ping_() {
  headers_(sheet_(SHEET_TRADES), TRADE_COLS);
  headers_(sheet_(SHEET_HOLD), HOLD_COLS);
  const rows = dcaRows_();
  const ym = todayYmd_().slice(0, 7);
  return { ledger: SpreadsheetApp.getActiveSpreadsheet().getName(), today: todayYmd_(), version: VERSION,
    monthly: dcaFor_(rows, ym), nextMonthly: dcaFor_(rows, nextYm_(ym)) };
}

// ctx 是 null＝試算（不寫入）
function addTrade_(d, ctx) {
  const date = String(d.date || "");
  if (!validYmd_(date)) throw new UserError("日期格式不對（YYYY-MM-DD）");
  const today = todayYmd_();
  if (date > today) throw new UserError("日期不能是未來");
  if (date < "2020-01-01") throw new UserError("日期太早");
  const time = String(d.time || "").trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) throw new UserError("成交時間格式不對（HH:MM）");
  const code = String(d.code || "").trim().toUpperCase();
  if (!/^\d{4,6}[A-Z]?$/.test(code)) throw new UserError("代號格式不對（台股 4～6 碼數字，可以帶一個英文字母）");
  const side = String(d.side || "");
  if (side !== "買進" && side !== "賣出") throw new UserError("買賣別要是「買進」或「賣出」");
  const shares = Number(d.shares);
  if (!Number.isInteger(shares) || shares < 1 || shares > 10000000) throw new UserError("股數要是正整數");
  const price = Number(d.price);
  if (!(price > 0 && price < 100000)) throw new UserError("成交價不對");
  const amount = Number(d.amount);
  if (!Number.isInteger(amount) || amount < 0) throw new UserError("成交價金要是整數");
  const gross = shares * price;
  if (Math.abs(amount - gross) > Math.max(1, gross * 0.001)) {
    throw new UserError("成交價金和股數 × 成交價（" + round2_(gross) + "）差太多");
  }
  if (d.fee === "" || d.fee == null) throw new UserError("手續費必填（沒有就填 0）");
  const fee = Number(d.fee);
  if (!(fee >= 0) || fee > Math.max(100, amount * 0.01)) throw new UserError("手續費不對");
  const tax = d.tax === "" || d.tax == null ? 0 : Number(d.tax);
  if (!(tax >= 0) || tax > Math.max(10, amount * 0.01)) throw new UserError("交易稅不對");
  const settle = side === "買進" ? amount + fee + tax : amount - fee - tax;
  if (settle < 0) throw new UserError("交割金額變成負的，請檢查手續費與交易稅");
  const note = String(d.note || "").trim().slice(0, 200);
  const name = String(d.name || "").trim().slice(0, 40);

  // 持倉：買進加股數與成本；賣出照平均成本扣
  const cur = holdingNow_(code);
  const before = cur || { shares: 0, cost: 0 };
  let after;
  if (side === "買進") {
    after = { shares: before.shares + shares, cost: round2_(before.cost + settle) };
  } else {
    if (!cur || before.shares < shares) throw new UserError("持倉只有 " + before.shares + " 股，不能賣出 " + shares + " 股");
    const left = before.shares - shares;
    after = { shares: left, cost: left === 0 ? 0 : round2_(before.cost - (before.cost / before.shares) * shares) };
  }

  // 當月台股買進（含手續費）與定投金額：超過定投的部分是自主加碼
  const ts = sheet_(SHEET_TRADES);
  const th = headers_(ts, TRADE_COLS);
  const month = date.slice(0, 7);
  const monthly = dcaFor_(dcaRows_(), month);
  const investedBefore = monthBuys_(ts, th, month);
  const investedAfter = investedBefore + (side === "買進" ? settle : 0);
  const result = {
    dryRun: !ctx,
    trade: { date, time, code, side, shares, price, amount, fee, tax, settle, note },
    holding: { code, isNew: !cur, before, after },
    month: { month, monthly, investedBefore, investedAfter,
      extraAfter: monthly == null ? null : Math.max(0, investedAfter - monthly) },
  };
  if (!ctx) return result;

  beginLog_(ctx, { code, before: cur, after, out: result });
  const tx = headers_(ts, TRADE_COLS.concat(TRADE_NEW_COLS));
  const row = new Array(tx._width).fill("");
  const set = (k, v) => { row[tx[k] - 1] = v; };
  set("日期", serial_(date)); set("市場", "台股"); set("代號", code); set("買賣", side);
  set("股數", shares); set("成交價", price); set("幣別", "TWD"); set("手續費", fee); set("交割金額", settle);
  set("台幣金額", settle); set("計入資金池", "是"); set("台幣金額來源", SOURCE); set("備註", note);
  set("成交時間", time); set("交易稅", tax); set("請求編號", ctx.id);
  const r = appendTrade_(ts, tx, row, ts.getLastRow());
  applyHold_(holdPlan_(ctx.ent), true);
  SpreadsheetApp.flush();
  result.rowNumber = r;
  finishLog_(ctx, result, r);
  return result;
}

function setMonthly_(d, ctx) {
  const amount = Number(d.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 1000000) throw new UserError("定投金額要是 0～1,000,000 的整數");
  const today = todayYmd_();
  const ym = today.slice(0, 7);
  const eff = nextYm_(ym);
  const rows = dcaRows_();
  const later = rows.find((x) => x.ym > eff);
  if (later) throw new UserError("「定投金額」分頁已經有 " + later.ym + " 的列，請到試算表手動調整");
  const same = rows.find((x) => x.ym === eff);
  const nowNext = dcaFor_(rows, eff);
  if (nowNext === amount) throw new UserError(eff + " 起已經是這個金額");
  const out = { dryRun: !ctx, effective: eff, amount, current: dcaFor_(rows, ym), previousNext: nowNext };
  if (!ctx) return out;

  beginLog_(ctx, { out });
  const sh = sheet_(SHEET_DCA);
  const h = headers_(sh, DCA_COLS);
  const r = same ? same.row : sh.getLastRow() + 1;
  if (!same && r > 2) {
    sh.getRange(r - 1, 1, 1, h._width).copyTo(sh.getRange(r, 1, 1, h._width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }
  sh.getRange(r, h["生效月份"]).setNumberFormat("yyyy-mm");
  sh.getRange(r, h["設定日期"]).setNumberFormat("yyyy-mm-dd");
  // 只寫這四格（一次寫完），這段期間入金次數、合計的公式不動；新的一列再從上一列補公式
  writeCells_(sh, r, h, { 生效月份: serial_(eff + "-01"), 每月定投: amount, 設定日期: serial_(today), 備註: dcaNote_(ctx.id) });
  if (!same) fillFormulas_(sh, r, h._width);
  SpreadsheetApp.flush();
  out.rowNumber = r;
  finishLog_(ctx, out, "");
  return out;
}

// 沖銷一列台股成交：加一列股數、手續費、交割金額、台幣金額、交易稅都取負的沖銷列（日期用原交易日），原列只在「更正」欄標記。
// 帳本的公式（持倉的交易紀錄股數、設定的買入合計與可用資金）和晨報的本月合計都會自動抵消。
function reverse_(d, ctx) {
  const n = Number(d.row);
  const reason = String(d.reason || "").trim();
  if (!reason) throw new UserError("請寫沖銷原因");
  if (reason.length > 100) throw new UserError("沖銷原因最多 100 個字");
  const ts = sheet_(SHEET_TRADES);
  const th = headers_(ts, TRADE_COLS);
  const tx = optHeaders_(ts, TRADE_NEW_COLS);
  const last = ts.getLastRow();
  if (!Number.isInteger(n) || n < 2 || n > last) throw new UserError("交易紀錄沒有第 " + d.row + " 列");
  const t = tradeRows_(ts, th, tx);
  const o = t[n - 2];
  const ds = num_(d.settle); // 網站從發布的 CSV 讀到的交割金額，空白是 null
  if (o.date !== String(d.date || "") || o.code !== normCode_(d.code || "") || o.side !== String(d.side || "")
    || o.shares !== Number(d.shares) || (o.settle == null) !== (ds == null) || (ds != null && Math.abs(o.settle - ds) > 0.005)) {
    throw new UserError("交易紀錄第 " + n + " 列的內容和要沖銷的那筆對不上（帳本可能插入或刪除過列），請重新整理記帳頁再試");
  }
  if (o.market !== "台股") throw new UserError("網站只能沖銷台股；美股請到試算表處理");
  if (o.mark.startsWith("沖銷第")) throw new UserError("這列本身是沖銷列，不能再沖；要改回來請重記一筆");
  if (o.mark) throw new UserError("這列已經沖銷過（" + o.mark + "）");
  if (o.pool !== "是") throw new UserError("這列沒有計入資金池（基準日前的列），成本不明，不能從網站沖銷");
  if (o.settle == null) throw new UserError("這列沒有交割金額，成本不明，不能從網站沖銷");
  if (!(o.shares > 0)) throw new UserError("這列的股數不是正數，不能沖銷");
  const later = t.slice(n - 1).find((x) => x.market === "台股" && x.code === o.code && x.side === "賣出" && x.shares > 0 && !x.mark);
  if (later) throw new UserError("第 " + later.row + " 列有 " + o.raw + " 的賣出還沒沖銷：賣出會改變平均成本，要先從最後一筆賣出往回沖");

  const cur = holdingNow_(o.code);
  if (!cur) throw new UserError("持倉找不到 " + o.raw);
  let after;
  if (o.side === "買進") {
    const left = cur.shares - o.shares;
    if (left < 0) throw new UserError("沖銷後持倉會變負（持倉只有 " + cur.shares + " 股），請先對帳");
    after = { shares: left, cost: left === 0 ? 0 : round2_(cur.cost - o.settle) };
    if (after.cost < 0) throw new UserError("沖銷後總成本會變負，請先對帳");
  } else {
    // 賣出當時照平均成本減掉多少成本：只有網站寫的賣出查得到（寫入紀錄的改前、改後）
    const book = logBook_(false);
    const src = book && o.id ? book.find(o.id) : null;
    const ent = src && src.state === ST.DONE ? book.full(src) : null;
    if (!ent || !ent.before || !ent.after) {
      throw new UserError("這筆賣出不是網站寫的（找不到寫入紀錄），不知道當時減掉多少成本，請到試算表處理");
    }
    after = { shares: cur.shares + o.shares, cost: round2_(cur.cost + (ent.before.cost - ent.after.cost)) };
  }
  const twdAmt = o.twd == null ? o.settle : o.twd;
  const result = {
    dryRun: !ctx,
    reverse: { row: n, date: o.date, code: o.raw, side: o.side, shares: o.shares, price: o.price, settle: o.settle, twd: twdAmt, reason },
    holding: { code: o.raw, isNew: false, before: cur, after },
    funds: { delta: o.side === "買進" ? twdAmt : -twdAmt },
  };
  if (!ctx) return result;

  beginLog_(ctx, { code: o.raw, before: cur, after, out: result });
  const tw = headers_(ts, TRADE_COLS.concat(TRADE_NEW_COLS));
  const row = ts.getRange(n, 1, 1, tw._width).getValues()[0].slice();
  for (const k of ["股數", "手續費", "交割金額", "台幣金額", "交易稅"]) {
    const v = row[tw[k] - 1];
    if (v !== "" && v != null && Number(v) !== 0) row[tw[k] - 1] = -Number(v);
  }
  row[tw["台幣金額來源"] - 1] = SOURCE;
  row[tw["備註"] - 1] = "沖銷第 " + n + " 列：" + reason + "（" + todayYmd_() + " 更正）";
  row[tw["成交時間"] - 1] = "";
  row[tw["請求編號"] - 1] = ctx.id;
  row[tw["更正"] - 1] = "沖銷第 " + n + " 列";
  const r = appendTrade_(ts, tw, row, n);
  markOriginal_(n, r);
  applyHold_(holdPlan_(ctx.ent), true);
  SpreadsheetApp.flush();
  result.rowNumber = r;
  finishLog_(ctx, result, r);
  return result;
}

// 用請求編號查結果。data＝{ id, action, data }（原本的編號、動作與內容），內容不同就回衝突。
// 編號放在 data 裡、不放請求的 id：舊版 Apps Script 收到查詢時才不會把它當成同編號的另一筆內容
function status_(cache, data) {
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(String(data.id || "")) ? String(data.id) : null;
  if (!id) throw new UserError("缺少請求編號");
  const act = String(data.action || "");
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, act)) throw new UserError("查詢要帶原本的動作");
  const hash = requestHash_(act, data.data || {});
  const book = logBook_(false);
  if (book) recoverAll_(book);
  const ent = book ? book.find(id) : null;
  if (!ent) {
    const hit = cacheHit_(cache, id, hash);
    if (hit && hit.ok === false) return hit;
    return hit ? { state: "done", result: hit } : { state: "none" };
  }
  if (ent.hash !== hash) return conflict_();
  if (ent.state === ST.DONE) return { state: "done", result: Object.assign(book.full(ent).out || {}, { ok: true, repeated: true }) };
  if (ent.state === ST.NONE) return { state: "none" };
  const full = book.full(ent);
  return { state: ent.state === ST.CHECK ? "check" : "manual", tradeRow: full.tradeRow || null, note: full.note };
}

// ── 中斷恢復 ───────────────────────────────────────────

function recoverAll_(book) {
  for (const ent of book.list) if (ent.state === ST.RUN) recoverOne_(book, book.full(ent));
}

// 看帳本實際狀態決定，不看程式停在哪一行（docs/LEDGER_CONSISTENCY.md 2.3）
function recoverOne_(book, ent) {
  if (ent.action === "setMonthly") {
    const r = dcaRowById_(ent.id);
    if (r) {
      const sh = sheet_(SHEET_DCA);
      fillFormulas_(sh, r, sh.getLastColumn());
      Object.assign(ent, { state: ST.DONE, note: "恢復：定投金額已經寫入，補標完成" });
      ent.out = Object.assign(ent.out || {}, { rowNumber: r, recovered: true, ok: true });
    } else {
      Object.assign(ent, { state: ST.NONE, note: "恢復：上次中斷時還沒寫入定投金額" });
    }
  } else {
    const tr = tradeRowById_(ent.id);
    if (!tr) {
      Object.assign(ent, { state: ST.NONE, note: "恢復：上次中斷時還沒寫入交易紀錄" });
    } else {
      if (ent.action === "reverse" && ent.out && ent.out.reverse) markOriginal_(ent.out.reverse.row, tr);
      const cur = holdingNow_(ent.code);
      if (sameHold_(cur, ent.after)) {
        applyHold_(holdPlan_(ent), false);
        Object.assign(ent, { state: ST.DONE, note: "恢復：持倉已經更新，補標完成" });
      } else if (sameHold_(cur, ent.before)) {
        applyHold_(holdPlan_(ent), true);
        Object.assign(ent, { state: ST.DONE, note: "恢復：補更新持倉" });
      } else {
        Object.assign(ent, { state: ST.CHECK,
          note: "持倉 " + ent.code + " 現在是 " + holdText_(cur) + "，不是改前（" + holdText_(ent.before) + "）也不是改後（"
            + holdText_(ent.after) + "）；可能在試算表改過，程式不猜" });
      }
      ent.tradeRow = tr;
      if (ent.state === ST.DONE) ent.out = Object.assign(ent.out || {}, { rowNumber: tr, recovered: true, ok: true });
    }
  }
  ent.doneAt = nowText_();
  book.write(ent);
  SpreadsheetApp.flush();
}

// ── 對帳（只讀） ─────────────────────────────────────

function reconcile_() {
  const ts = sheet_(SHEET_TRADES);
  const th = headers_(ts, TRADE_COLS);
  const tx = optHeaders_(ts, TRADE_NEW_COLS);
  const t = tradeRows_(ts, th, tx);
  const holds = holdRows_();
  const set = settings_();
  const book = logBook_(false);
  const ents = book ? book.list.map((x) => book.full(x)) : [];
  const checks = [];
  const add = (id, title, items, level) => checks.push({ id, title, level: items.length ? level : "ok", items });
  const key = (m, c) => m + " " + c;

  // C1 股數：持倉＝交易紀錄買進－賣出（含沖銷列）
  const net = new Map();
  for (const x of t) {
    if (x.shares == null || (x.side !== "買進" && x.side !== "賣出")) continue;
    const k = key(x.market, x.code);
    net.set(k, (net.get(k) || 0) + (x.side === "買進" ? x.shares : -x.shares));
  }
  const c1 = [];
  const seen = new Set();
  for (const h of holds) {
    const k = key(h.market, h.code);
    if (seen.has(k)) c1.push("持倉有兩列 " + h.market + " " + h.raw + "（第 " + h.row + " 列）");
    seen.add(k);
    const n = round6_(net.get(k) || 0);
    if (Math.abs((h.shares || 0) - n) > 1e-6) c1.push(h.market + " " + h.raw + "：持倉 " + h.shares + " 股，交易紀錄 " + n + " 股");
  }
  for (const [k, n] of net) if (!seen.has(k) && Math.abs(n) > 1e-6) c1.push(k + "：交易紀錄 " + round6_(n) + " 股，持倉沒有這一檔");
  add("C1", "股數：持倉＝交易紀錄買進－賣出", c1, "err");

  // C2 成本鏈：最後一筆完成的網站寫入的持倉改後＝現在的持倉（提醒：照券商確認改持倉本來就合理）
  const lastBy = new Map();
  for (const e of ents) if (e.state === ST.DONE && e.hasHold && e.after) lastBy.set(normCode_(e.code), e);
  const c2 = [];
  for (const [c, e] of lastBy) {
    const h = holds.find((x) => x.market === "台股" && x.code === c);
    const cur = h ? { shares: h.shares, cost: h.cost } : null;
    if (!sameHold_(cur, e.after)) {
      c2.push(e.code + "：上次網站寫入（" + e.doneAt + "）後是 " + holdText_(e.after) + "，現在是 " + holdText_(cur)
        + "。在試算表改過；照券商確認改的就沒問題");
    }
  }
  add("C2", "成本鏈：網站上次寫入後持倉沒被改過", c2, "warn");

  // C3 資金池欄位：基準日之後的列要計入資金池而且有台幣金額；之前的列不計入
  const c3 = [];
  if (!set.basis) c3.push("設定分頁找不到「基準日」");
  else {
    for (const x of t) {
      if (!x.date) continue;
      if (x.date > set.basis && (x.pool !== "是" || x.twd == null)) c3.push("第 " + x.row + " 列（" + x.date + " " + x.raw + "）在基準日後，要「計入資金池＝是」而且有台幣金額");
      if (x.date < set.basis && x.pool === "是") c3.push("第 " + x.row + " 列（" + x.date + " " + x.raw + "）在基準日前，卻計入資金池");
    }
  }
  add("C3", "資金池欄位：基準日（" + (set.basis || "—") + "）後計入、之前不計入", c3, "err");

  // C4 台股交割金額：買進＝價金＋手續費＋交易稅，賣出＝價金－手續費－交易稅；台幣金額＝交割金額
  const c4 = [];
  for (const x of t) {
    if (x.market !== "台股" || x.settle == null || x.shares == null || x.price == null) continue;
    const gross = x.shares * x.price;
    const fee = x.fee || 0, tax = x.tax || 0;
    const implied = x.side === "賣出" ? x.settle + fee + tax : x.settle - fee - tax;
    if (Math.abs(implied - gross) > Math.max(1, Math.abs(gross) * 0.001) + 1e-9) {
      c4.push("第 " + x.row + " 列（" + x.date + " " + x.raw + "）：交割金額 " + x.settle + " 算回價金 " + round2_(implied) + "，股數 × 成交價是 " + round2_(gross));
    }
    if (x.twd != null && Math.abs(x.twd - x.settle) > 0.005) c4.push("第 " + x.row + " 列：台幣金額 " + x.twd + " 和交割金額 " + x.settle + " 不同");
  }
  add("C4", "台股交割金額算式", c4, "err");

  // C5 寫入紀錄對交易紀錄
  const c5 = [];
  const byId = new Map();
  for (const x of t) {
    if (!x.id) continue;
    if (byId.has(x.id)) c5.push("請求編號 " + x.id + " 出現在第 " + byId.get(x.id) + "、" + x.row + " 列");
    else byId.set(x.id, x.row);
  }
  const done = new Map(ents.filter((e) => e.state !== ST.NONE).map((e) => [e.id, e])); // 處理中另外列
  for (const e of ents) {
    if (e.state === ST.RUN) c5.push("請求 " + e.id + "（" + e.at + " " + (ACTIONS[e.action] || e.action) + "）卡在處理中：下一次寫入或查詢時會自動恢復");
    if (e.state === ST.CHECK) c5.push("請求 " + e.id + " 需要對帳：" + e.note + "。到試算表照券商資料改好持倉後，把寫入紀錄這列的狀態改成「" + ST.MANUAL + "」");
    if (e.state === ST.DONE && e.action !== "setMonthly" && !byId.has(e.id)) c5.push("請求 " + e.id + " 標完成，但交易紀錄找不到這個請求編號");
  }
  for (const [id, r] of byId) if (!done.has(id)) c5.push("第 " + r + " 列有請求編號 " + id + "，寫入紀錄卻沒有完成的紀錄");
  add("C5", "寫入紀錄與交易紀錄互相對得上", c5, c5.some((s) => !/處理中/.test(s)) ? "err" : "warn");

  // C6 沖銷列成對
  const c6 = [];
  for (const x of t) {
    let m = /^沖銷第 (\d+) 列/.exec(x.mark);
    if (m) {
      const o = t[Number(m[1]) - 2];
      if (!o) c6.push("第 " + x.row + " 列沖銷的第 " + m[1] + " 列不存在");
      else {
        if (o.mark !== "已被第 " + x.row + " 列沖銷") c6.push("第 " + o.row + " 列沒有標「已被第 " + x.row + " 列沖銷」");
        const opp = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a + b) < 0.005);
        if (o.code !== x.code || o.side !== x.side || o.date !== x.date || !opp(o.shares, x.shares) || !opp(o.settle, x.settle) || !opp(o.twd, x.twd)) {
          c6.push("第 " + x.row + " 列和第 " + o.row + " 列的代號、買賣、日期或數字沒有剛好相反");
        }
      }
      continue;
    }
    m = /^已被第 (\d+) 列沖銷/.exec(x.mark);
    if (m) {
      const r = t[Number(m[1]) - 2];
      if (!r || r.mark !== "沖銷第 " + x.row + " 列") c6.push("第 " + x.row + " 列標「" + x.mark + "」，但那一列不是它的沖銷列");
    }
  }
  add("C6", "沖銷列成對", c6, "err");

  // C7 資金重算：設定的「基準日後買入合計」「基準日後賣出回收」＝交易紀錄重算
  const c7 = [];
  let buys = 0, sells = 0;
  for (const x of t) {
    if (x.pool !== "是" || x.twd == null) continue;
    if (x.side === "買進") buys += x.twd;
    if (x.side === "賣出") sells += x.twd;
  }
  if (set.buys == null) c7.push("設定分頁找不到「基準日後買入合計」");
  else if (Math.abs(set.buys - buys) > 0.5) c7.push("設定的買入合計 " + set.buys + "，交易紀錄重算 " + round2_(buys));
  if (set.sells == null) c7.push("設定分頁找不到「基準日後賣出回收」");
  else if (Math.abs(set.sells - sells) > 0.5) c7.push("設定的賣出回收 " + set.sells + "，交易紀錄重算 " + round2_(sells));
  add("C7", "資金重算：設定的買入、賣出合計", c7, "err");

  // 美股：網站不做輸入，配息、手續費、賣出、更正都在試算表維護；列出股數差異與券商確認日
  const us = holds.filter((h) => h.market === "美股").map((h) => ({ code: h.raw, shares: h.shares, confirmed: h.confirmed,
    diff: round6_((h.shares || 0) - (net.get(key("美股", h.code)) || 0)) }));
  return { checks, us, basis: set.basis, at: nowText_(), ledger: SpreadsheetApp.getActiveSpreadsheet().getName() };
}

// ── 帳本讀寫小工具 ─────────────────────────────────────

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// 快取裡有這個請求編號：內容相同回傳上次的結果（repeated: true）；內容不同就拒絕；沒有回傳 null
function cacheHit_(cache, id, hash) {
  const raw = cache.get("req:" + id);
  if (!raw) return null;
  const hit = JSON.parse(raw);
  // 更早的版本存的是結果本身、沒有 hash：照舊回傳
  if (hit.v !== 2) return Object.assign(hit, { repeated: true });
  if (hit.hash !== hash) return conflict_();
  return Object.assign(hit.out, { repeated: true });
}

// 「寫入紀錄」分頁：create＝沒有就建。list 只有編號、雜湊、狀態（每次請求都要讀，所以只讀這三欄），full() 才讀整列
function logBook_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_LOG);
  if (!sh) {
    if (!create) return null;
    sh = ss.insertSheet(SHEET_LOG, ss.getSheets().length); // 放在最後一個分頁
    sh.getRange(1, 1, 1, LOG_COLS.length).setValues([LOG_COLS]);
    sh.setFrozenRows(1);
  }
  const h = headers_(sh, LOG_COLS);
  const n = sh.getLastRow() - 1;
  const col = (k) => (n > 0 ? sh.getRange(2, h[k], n, 1).getValues().map((r) => String(r[0]).trim()) : []);
  const ids = col("請求編號"), hashes = col("內容雜湊"), states = col("狀態");
  const list = ids.map((id, i) => ({ row: i + 2, id, hash: hashes[i], state: states[i] }));
  const parse = (s) => {
    if (s === "" || s == null) return undefined;
    if (s === NO_ROW) return null;
    try {
      return JSON.parse(s);
    } catch (err) {
      return undefined;
    }
  };
  const actionOf = (label) => Object.keys(ACTIONS).find((k) => ACTIONS[k] === label) || label;
  return {
    list,
    find: (id) => list.find((x) => x.id === id) || null,
    full(x) {
      const r = sh.getRange(x.row, 1, 1, h._width).getValues()[0].map((v) => (v == null ? "" : String(v)));
      const g = (k) => r[h[k] - 1].trim();
      return { row: x.row, id: g("請求編號"), action: actionOf(g("動作")), hash: g("內容雜湊"), state: g("狀態"),
        at: g("收到時間"), doneAt: g("完成時間"), tradeRow: Number(g("交易紀錄列")) || "", code: g("代號"), hasHold: !!g("代號"),
        before: parse(g("持倉改前")), after: parse(g("持倉改後")), data: parse(g("請求內容")), out: parse(g("回應")), note: g("說明") };
    },
    write(e) {
      const hold = (v) => (!e.hasHold || v === undefined ? "" : v === null ? NO_ROW : JSON.stringify(v));
      const vals = { 請求編號: e.id, 動作: ACTIONS[e.action] || e.action, 內容雜湊: e.hash, 狀態: e.state, 收到時間: e.at,
        完成時間: e.doneAt, 交易紀錄列: e.tradeRow === "" ? "" : String(e.tradeRow), 代號: e.code,
        持倉改前: hold(e.before), 持倉改後: hold(e.after), 請求內容: e.data === undefined ? "" : JSON.stringify(e.data),
        回應: e.out === undefined ? "" : JSON.stringify(e.out), 說明: e.note || "" };
      if (!e.row) e.row = sh.getLastRow() + 1;
      const rg = sh.getRange(e.row, 1, 1, h._width);
      const row = rg.getValues()[0];
      for (const k of LOG_COLS) row[h[k] - 1] = vals[k] == null ? "" : String(vals[k]);
      rg.setNumberFormat("@"); // 編號、時間都當文字，不讓試算表自動轉成數字或日期
      rg.setValues([row]);
      const i = list.findIndex((x) => x.row === e.row);
      const item = { row: e.row, id: e.id, hash: e.hash, state: e.state };
      if (i >= 0) list[i] = item;
      else list.push(item);
    },
  };
}

function ensureTradeCols_() {
  const ts = sheet_(SHEET_TRADES);
  const width = ts.getLastColumn();
  const head = ts.getRange(1, 1, 1, width).getDisplayValues()[0].map((x) => String(x).trim());
  let w = width;
  for (const name of TRADE_NEW_COLS) {
    if (head.indexOf(name) >= 0) continue;
    w += 1;
    if (w > ts.getMaxColumns()) ts.insertColumnsAfter(ts.getMaxColumns(), w - ts.getMaxColumns());
    ts.getRange(1, w - 1).copyTo(ts.getRange(1, w), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    ts.getRange(1, w).setValue(name);
  }
}

// 在交易紀錄最後加一列（一次寫完），格式照 fmtRow 那一列
function appendTrade_(ts, tx, row, fmtRow) {
  const r = ts.getLastRow() + 1;
  if (fmtRow >= 2) ts.getRange(fmtRow, 1, 1, tx._width).copyTo(ts.getRange(r, 1, 1, tx._width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  ts.getRange(r, tx["日期"]).setNumberFormat("yyyy-mm-dd");
  ts.getRange(r, tx["代號"]).setNumberFormat("@"); // 009816 的前導 0 要保留
  ts.getRange(r, tx["成交時間"]).setNumberFormat("@");
  ts.getRange(r, tx["請求編號"]).setNumberFormat("@");
  ts.getRange(r, 1, 1, tx._width).setValues([row]);
  SpreadsheetApp.flush();
  return r;
}

// 沖銷時在原列的「更正」欄標記（已經標過就不動）
function markOriginal_(n, r) {
  const ts = sheet_(SHEET_TRADES);
  const tx = headers_(ts, ["更正"]);
  const cell = ts.getRange(n, tx["更正"]);
  if (!String(cell.getValues()[0][0] || "").trim()) cell.setValue("已被第 " + r + " 列沖銷");
}

// 持倉要改成什麼、來源欄寫什麼：從寫入紀錄的內容推回來（正常寫入與恢復共用）
function holdPlan_(ent) {
  const o = ent.out || {};
  if (ent.action === "reverse") {
    const v = o.reverse || {};
    return { code: ent.code, after: ent.after, confirmDate: null, name: "",
      tag: SOURCE + "：沖銷第 " + v.row + " 列（" + v.date + " " + v.side + " " + v.shares + " 股）" };
  }
  const t = o.trade || {};
  return { code: ent.code, after: ent.after, confirmDate: t.date, name: (ent.data && ent.data.name) || "",
    tag: SOURCE + "：" + t.date + " " + t.side + " " + t.shares + " 股" };
}

// 更新持倉。keyNeeded＝要寫股數與總成本（恢復時已經是改後就不用）；確認日、來源、公式每次都補（重複做也一樣）
function applyHold_(p, keyNeeded) {
  const hs = sheet_(SHEET_HOLD);
  const hh = headers_(hs, HOLD_COLS);
  const r = holdRowOf_(hs, hh, p.code);
  if (!r) {
    // 新的一檔：整列一次寫完（不再先複製上一列再改值，免得中途壞掉留下一列重複的舊代號），再從上一列補公式
    const nr = hs.getLastRow() + 1;
    if (nr > 2) hs.getRange(nr - 1, 1, 1, hh._width).copyTo(hs.getRange(nr, 1, 1, hh._width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    hs.getRange(nr, hh["代號"]).setNumberFormat("@");
    hs.getRange(nr, hh["確認日"]).setNumberFormat("yyyy-mm-dd");
    const row = new Array(hh._width).fill("");
    const put = (k, v) => { row[hh[k] - 1] = v; };
    put("市場", "台股"); put("代號", p.code); put("名稱", p.name || p.code); put("股數", p.after.shares); put("總成本", p.after.cost);
    put("幣別", "TWD"); put("確認日", p.confirmDate ? serial_(p.confirmDate) : ""); put("來源", p.tag);
    hs.getRange(nr, 1, 1, hh._width).setValues([row]);
    fillFormulas_(hs, nr, hh._width);
    return;
  }
  fillFormulas_(hs, r, hh._width);
  if (keyNeeded) writeCells_(hs, r, hh, { 股數: p.after.shares, 總成本: p.after.cost });
  const disp = hs.getRange(r, 1, 1, hh._width).getDisplayValues()[0];
  if (p.confirmDate && p.confirmDate >= normYmd_(disp[hh["確認日"] - 1])) {
    hs.getRange(r, hh["確認日"]).setNumberFormat("yyyy-mm-dd").setValue(serial_(p.confirmDate));
  }
  const src = String(disp[hh["來源"] - 1] || "").replace(/；?網站輸入：.*$/, "");
  const tag = src ? src + "；" + p.tag : p.tag;
  if (tag !== disp[hh["來源"] - 1]) hs.getRange(r, hh["來源"]).setValue(tag);
}

// 上一列有公式、這一列同一格是空的（沒有公式也沒有值），從上一列複製（相對參照會跟著調整）。使用者手動填的值不動
function fillFormulas_(sh, r, width) {
  if (r <= 2) return;
  const prev = sh.getRange(r - 1, 1, 1, width).getFormulas()[0];
  const rg = sh.getRange(r, 1, 1, width);
  const cur = rg.getFormulas()[0], vals = rg.getValues()[0];
  for (let c = 0; c < width; c++) {
    if (prev[c] && !cur[c] && (vals[c] === "" || vals[c] == null)) sh.getRange(r - 1, c + 1).copyTo(sh.getRange(r, c + 1));
  }
}

// 一次寫好幾格：相鄰的欄合成一次 setValues，不碰其他格（公式）
function writeCells_(sh, r, h, vals) {
  const cols = Object.keys(vals).map((k) => ({ c: h[k], v: vals[k] })).sort((a, b) => a.c - b.c);
  let i = 0;
  while (i < cols.length) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1].c === cols[j].c + 1) j++;
    sh.getRange(r, cols[i].c, 1, j - i + 1).setValues([cols.slice(i, j + 1).map((x) => x.v)]);
    i = j + 1;
  }
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new UserError("帳本找不到「" + name + "」分頁");
  return sh;
}

// 表頭 → 欄號（1 起算）。先找完全相同，再找「名稱（說明）」，例如「股數（券商確認）」「交割金額（原幣，含費）」
function headers_(sh, need) {
  const map = optHeaders_(sh, need);
  for (const name of need) if (!map[name]) throw new UserError("「" + sh.getName() + "」缺少欄位：" + name);
  return map;
}

// 同上，但找不到的欄是 0（第 B 批之前的帳本沒有「請求編號」「更正」）
function optHeaders_(sh, need) {
  const width = sh.getLastColumn();
  const row = width > 0 ? sh.getRange(1, 1, 1, width).getDisplayValues()[0].map((x) => String(x).trim()) : [];
  const map = { _width: width };
  for (const name of need) {
    let i = row.indexOf(name);
    if (i < 0) i = row.findIndex((x) => x.startsWith(name + "（"));
    map[name] = i + 1;
  }
  return map;
}

// 交易紀錄每一列（第 2 列起），數字欄空白是 null
function tradeRows_(ts, th, tx) {
  const n = ts.getLastRow() - 1;
  if (n < 1) return [];
  const w = Math.max(th._width, tx._width || 0);
  const vals = ts.getRange(2, 1, n, w).getValues();
  const disp = ts.getRange(2, 1, n, w).getDisplayValues();
  return vals.map((v, i) => {
    const d = (k) => String(disp[i][th[k] - 1]).trim();
    const x = (k) => num_(v[th[k] - 1]);
    const opt = (k) => (tx[k] ? String(v[tx[k] - 1] == null ? "" : v[tx[k] - 1]).trim() : "");
    return { row: i + 2, date: normYmd_(d("日期")), market: d("市場"), code: normCode_(d("代號")), raw: d("代號"), side: d("買賣"),
      shares: x("股數"), price: x("成交價"), fee: x("手續費"), settle: x("交割金額"), twd: x("台幣金額"), tax: x("交易稅"),
      pool: d("計入資金池"), id: opt("請求編號"), mark: opt("更正") };
  });
}

function holdRows_() {
  const hs = sheet_(SHEET_HOLD);
  const hh = headers_(hs, HOLD_COLS);
  const n = hs.getLastRow() - 1;
  if (n < 1) return [];
  const vals = hs.getRange(2, 1, n, hh._width).getValues();
  const disp = hs.getRange(2, 1, n, hh._width).getDisplayValues();
  return vals.map((v, i) => ({ row: i + 2, market: String(disp[i][hh["市場"] - 1]).trim(), code: normCode_(disp[i][hh["代號"] - 1]),
    raw: String(disp[i][hh["代號"] - 1]).trim(), shares: num_(v[hh["股數"] - 1]), cost: num_(v[hh["總成本"] - 1]),
    confirmed: normYmd_(disp[i][hh["確認日"] - 1]) })).filter((h) => h.code);
}

function holdRowOf_(hs, hh, code) {
  const n = hs.getLastRow() - 1;
  if (n < 1) return 0;
  const disp = hs.getRange(2, 1, n, hh._width).getDisplayValues();
  const i = disp.findIndex((r) => r[hh["市場"] - 1].trim() === "台股" && normCode_(r[hh["代號"] - 1]) === normCode_(code));
  return i < 0 ? 0 : i + 2;
}

// 持倉某一檔台股現在的股數與總成本；沒有這一列回傳 null
function holdingNow_(code) {
  const hs = sheet_(SHEET_HOLD);
  const hh = headers_(hs, HOLD_COLS);
  const r = holdRowOf_(hs, hh, code);
  if (!r) return null;
  const v = hs.getRange(r, 1, 1, hh._width).getValues()[0];
  return { shares: Number(v[hh["股數"] - 1]) || 0, cost: Number(v[hh["總成本"] - 1]) || 0 };
}

function sameHold_(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a.shares - b.shares) < 1e-9 && Math.abs(a.cost - b.cost) < 0.005;
}
const holdText_ = (h) => (h ? h.shares + " 股／總成本 " + h.cost : "沒有這列");

// 交易紀錄裡帶這個請求編號的列號（沒有回傳 0）
function tradeRowById_(id) {
  const ts = sheet_(SHEET_TRADES);
  const tx = optHeaders_(ts, ["請求編號"]);
  const n = ts.getLastRow() - 1;
  if (!tx["請求編號"] || n < 1) return 0;
  const i = ts.getRange(2, tx["請求編號"], n, 1).getValues().findIndex((r) => String(r[0]).trim() === id);
  return i < 0 ? 0 : i + 2;
}

const dcaNote_ = (id) => SOURCE + "（請求編號 " + id + "）";
function dcaRowById_(id) {
  const sh = sheet_(SHEET_DCA);
  const h = headers_(sh, DCA_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  const i = sh.getRange(2, h["備註"], n, 1).getValues().findIndex((r) => String(r[0]).trim() === dcaNote_(id));
  return i < 0 ? 0 : i + 2;
}

// 設定分頁：基準日、基準日後買入合計、基準日後賣出回收（照 A 欄的項目名稱找）
function settings_() {
  const out = { basis: null, buys: null, sells: null };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SET);
  if (!sh) return out;
  const n = sh.getLastRow();
  if (n < 1) return out;
  const disp = sh.getRange(1, 1, n, 2).getDisplayValues();
  const vals = sh.getRange(1, 1, n, 2).getValues();
  disp.forEach((r, i) => {
    const label = String(r[0]).trim();
    if (label === "基準日") out.basis = normYmd_(r[1]) || null;
    else if (label.startsWith("基準日後買入合計")) out.buys = num_(vals[i][1]);
    else if (label.startsWith("基準日後賣出回收")) out.sells = num_(vals[i][1]);
  });
  return out;
}

// 請求內容的 SHA-256（十六進位）：action＋data，物件的鍵排序後再序列化，dryRun 不算
function requestHash_(action, data) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    canon_({ action: String(action), data }), Utilities.Charset.UTF_8);
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(""); // Apps Script 的位元組是 -128～127
}

function canon_(v) {
  if (Array.isArray(v)) return "[" + v.map(canon_).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).filter((k) => k !== "dryRun" && v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ":" + canon_(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

function sameKey_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 「定投金額」分頁：[{ ym: "2026-11", amount: 3000, row: 2 }]，依生效月份由舊到新
function dcaRows_() {
  const sh = sheet_(SHEET_DCA);
  const h = headers_(sh, DCA_COLS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const disp = sh.getRange(2, h["生效月份"], n, 1).getDisplayValues();
  const vals = sh.getRange(2, h["每月定投"], n, 1).getValues();
  const out = [];
  disp.forEach((r, i) => {
    const m = /^(\d{4})[-/](\d{1,2})/.exec(String(r[0]).trim());
    if (m) out.push({ ym: m[1] + "-" + ("0" + m[2]).slice(-2), amount: Number(vals[i][0]) || 0, row: i + 2 });
  });
  return out.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
}

// 某個月的定投金額：生效月份不晚於這個月的最後一列；比第一列還早就用第一列
function dcaFor_(rows, ym) {
  let a = rows.length ? rows[0].amount : null;
  for (const r of rows) if (r.ym <= ym) a = r.amount;
  return a;
}

// 當月台股買進合計（台幣金額＝交割金額，含手續費；空白時用股數 × 成交價），與網站、engine/discipline.py 相同。沖銷列是負的，自動抵消
function monthBuys_(ts, th, month) {
  const n = ts.getLastRow() - 1;
  if (n < 1) return 0;
  const disp = ts.getRange(2, 1, n, th._width).getDisplayValues();
  const vals = ts.getRange(2, 1, n, th._width).getValues();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = disp[i];
    if (!normYmd_(r[th["日期"] - 1]).startsWith(month) || r[th["市場"] - 1].trim() !== "台股" || r[th["買賣"] - 1].trim() !== "買進") continue;
    const v = vals[i][th["台幣金額"] - 1];
    sum += v !== "" && Number.isFinite(Number(v)) ? Number(v)
      : (Number(vals[i][th["股數"] - 1]) * Number(vals[i][th["成交價"] - 1]) || 0);
  }
  return Math.round(sum);
}

const todayYmd_ = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
const nowText_ = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");

function nextYm_(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? (y + 1) + "-01" : y + "-" + ("0" + (m + 1)).slice(-2);
}

function validYmd_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// 顯示值的日期 → YYYY-MM-DD（2026/11/5、2026-11-05 都可以）；不是日期回傳 ""
function normYmd_(s) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(s || "").trim());
  return m ? m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2) : "";
}

// 試算表日期序號（1899-12-30 起算的天數）
function serial_(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

function num_(v) {
  if (v === "" || v == null) return null;
  const n = Number(typeof v === "string" ? v.replace(/,/g, "") : v);
  return Number.isFinite(n) ? n : null;
}
const normCode_ = (v) => String(v).trim().toUpperCase().replace(/^0+/, "");
const round2_ = (v) => Math.round(v * 100) / 100;
const round6_ = (v) => Math.round(v * 1e6) / 1e6;
