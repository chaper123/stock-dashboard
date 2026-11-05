// 共用帳本的寫入服務：Google Apps Script 網頁應用程式，綁在「投資共用帳本」試算表上（docs/LEDGER_WRITE.md）。
// 網站「記帳」頁用 POST 送 JSON（Content-Type: text/plain，不會有 CORS 預檢），這裡核對密鑰後：
//   - addTrade：在「交易紀錄」加一列台股成交，並更新「持倉」的股數與總成本
//   - setMonthly：改每月定投金額，從下個月生效（寫在「定投金額」分頁）
//   - ping：測試連線，不寫入
// 寫入密鑰只放在這個專案的指令碼屬性 WRITE_KEY：不放試算表（帳本是公開發布的），也不進 git。
// 第一版只做台股新增（2026-11-05 使用者決定）；記錯請到試算表直接改。
// 日期一律用台北時間；寫進儲存格時用試算表序號，不受指令碼時區影響。

const TZ = "Asia/Taipei";
const SHEET_TRADES = "交易紀錄";
const SHEET_HOLD = "持倉";
const SHEET_DCA = "定投金額";
const TRADE_COLS = ["日期", "市場", "代號", "買賣", "股數", "成交價", "幣別", "手續費", "交割金額", "匯率", "台幣金額",
  "計入資金池", "台幣金額來源", "備註", "成交時間", "交易稅"];
const HOLD_COLS = ["市場", "代號", "名稱", "股數", "總成本", "幣別", "確認日", "來源"];
const DCA_COLS = ["生效月份", "每月定投", "設定日期", "備註"];
const SOURCE = "網站輸入";
const MAX_FAILS = 10;        // 密鑰錯 10 次就暫停 10 分鐘
const FAIL_WINDOW_S = 600;
const DEDUPE_S = 21600;      // 同一個請求編號 6 小時內重送，回傳上次的結果，不會重複寫入

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
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("fails") || 0);
  if (fails >= MAX_FAILS) return json_({ ok: false, error: "密鑰錯太多次，10 分鐘後再試" });
  const want = PropertiesService.getScriptProperties().getProperty("WRITE_KEY");
  if (!want || want.length < 20) return json_({ ok: false, error: "Apps Script 還沒設定指令碼屬性 WRITE_KEY（至少 20 個字元）" });
  if (!sameKey_(String(req.key || ""), want)) {
    cache.put("fails", String(fails + 1), FAIL_WINDOW_S);
    return json_({ ok: false, error: "密鑰不對" });
  }

  const data = req.data || {};
  const dry = data.dryRun === true;
  const id = /^[A-Za-z0-9_-]{8,64}$/.test(String(req.id || "")) ? String(req.id) : null;
  if (id && !dry) {
    const hit = cache.get("req:" + id);
    if (hit) return json_(Object.assign(JSON.parse(hit), { repeated: true }));
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: "帳本正在寫入別的資料，稍後再試" });
  }
  try {
    let out;
    if (req.action === "ping") out = ping_();
    else if (req.action === "addTrade") out = addTrade_(data, dry);
    else if (req.action === "setMonthly") out = setMonthly_(data, dry);
    else throw new UserError("不支援的動作");
    out.ok = true;
    if (id && !dry && req.action !== "ping") cache.put("req:" + id, JSON.stringify(out), DEDUPE_S);
    return json_(out);
  } catch (err) {
    if (err instanceof UserError) return json_({ ok: false, error: err.message });
    console.error(err);
    return json_({ ok: false, error: "寫入失敗：" + ((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

// ── 動作 ───────────────────────────────────────────────

function ping_() {
  headers_(sheet_(SHEET_TRADES), TRADE_COLS);
  headers_(sheet_(SHEET_HOLD), HOLD_COLS);
  const rows = dcaRows_();
  const ym = todayYmd_().slice(0, 7);
  return { ledger: SpreadsheetApp.getActiveSpreadsheet().getName(), today: todayYmd_(),
    monthly: dcaFor_(rows, ym), nextMonthly: dcaFor_(rows, nextYm_(ym)) };
}

function addTrade_(d, dry) {
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
  const hs = sheet_(SHEET_HOLD);
  const hh = headers_(hs, HOLD_COLS);
  const hn = hs.getLastRow() - 1;
  const hv = hn > 0 ? hs.getRange(2, 1, hn, hh._width).getValues() : [];
  const hd = hn > 0 ? hs.getRange(2, 1, hn, hh._width).getDisplayValues() : [];
  const idx = hd.findIndex((r) => r[hh["市場"] - 1].trim() === "台股" && normCode_(r[hh["代號"] - 1]) === normCode_(code));
  const before = idx >= 0
    ? { shares: Number(hv[idx][hh["股數"] - 1]) || 0, cost: Number(hv[idx][hh["總成本"] - 1]) || 0 }
    : { shares: 0, cost: 0 };
  let after;
  if (side === "買進") {
    after = { shares: before.shares + shares, cost: round2_(before.cost + settle) };
  } else {
    if (idx < 0 || before.shares < shares) throw new UserError("持倉只有 " + before.shares + " 股，不能賣出 " + shares + " 股");
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
    dryRun: dry,
    trade: { date, time, code, side, shares, price, amount, fee, tax, settle, note },
    holding: { code, isNew: idx < 0, before, after },
    month: { month, monthly, investedBefore, investedAfter,
      extraAfter: monthly == null ? null : Math.max(0, investedAfter - monthly) },
  };
  if (dry) return result;

  const row = new Array(th._width).fill("");
  const set = (k, v) => { row[th[k] - 1] = v; };
  set("日期", serial_(date)); set("市場", "台股"); set("代號", code); set("買賣", side);
  set("股數", shares); set("成交價", price); set("幣別", "TWD"); set("手續費", fee); set("交割金額", settle);
  set("台幣金額", settle); set("計入資金池", "是"); set("台幣金額來源", SOURCE); set("備註", note);
  set("成交時間", time); set("交易稅", tax);
  const r = ts.getLastRow() + 1;
  if (r > 2) {
    ts.getRange(r - 1, 1, 1, th._width).copyTo(ts.getRange(r, 1, 1, th._width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  }
  ts.getRange(r, th["日期"]).setNumberFormat("yyyy-mm-dd");
  ts.getRange(r, th["代號"]).setNumberFormat("@");   // 009816 的前導 0 要保留
  ts.getRange(r, th["成交時間"]).setNumberFormat("@");
  ts.getRange(r, 1, 1, th._width).setValues([row]);

  const tag = SOURCE + "：" + date + " " + side + " " + shares + " 股";
  if (idx >= 0) {
    const hr = idx + 2;
    hs.getRange(hr, hh["股數"]).setValue(after.shares);
    hs.getRange(hr, hh["總成本"]).setValue(after.cost);
    if (date >= hd[idx][hh["確認日"] - 1].trim()) {
      hs.getRange(hr, hh["確認日"]).setNumberFormat("yyyy-mm-dd").setValue(serial_(date));
    }
    const src = String(hd[idx][hh["來源"] - 1] || "").replace(/；?網站輸入：.*$/, "");
    hs.getRange(hr, hh["來源"]).setValue(src ? src + "；" + tag : tag);
  } else {
    // 新的一檔：複製最後一列（平均成本、交易紀錄股數、股數差異的公式會跟著調整）再填值
    const nr = hs.getLastRow() + 1;
    if (nr > 2) hs.getRange(nr - 1, 1, 1, hh._width).copyTo(hs.getRange(nr, 1, 1, hh._width));
    hs.getRange(nr, hh["代號"]).setNumberFormat("@");
    hs.getRange(nr, hh["確認日"]).setNumberFormat("yyyy-mm-dd");
    const put = (k, v) => hs.getRange(nr, hh[k]).setValue(v);
    put("市場", "台股"); put("代號", code); put("名稱", name || code); put("股數", after.shares); put("總成本", after.cost);
    put("幣別", "TWD"); put("確認日", serial_(date)); put("來源", tag);
  }
  SpreadsheetApp.flush();
  result.rowNumber = r;
  return result;
}

function setMonthly_(d, dry) {
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
  const out = { dryRun: dry, effective: eff, amount, current: dcaFor_(rows, ym), previousNext: nowNext };
  if (dry) return out;

  const sh = sheet_(SHEET_DCA);
  const h = headers_(sh, DCA_COLS);
  let r = same ? same.row : sh.getLastRow() + 1;
  if (!same && r > 2) {
    // 複製上一列（這段期間入金次數、合計的公式會跟著調整）再填值
    sh.getRange(r - 1, 1, 1, h._width).copyTo(sh.getRange(r, 1, 1, h._width));
  }
  sh.getRange(r, h["生效月份"]).setNumberFormat("yyyy-mm").setValue(serial_(eff + "-01"));
  sh.getRange(r, h["每月定投"]).setValue(amount);
  sh.getRange(r, h["設定日期"]).setNumberFormat("yyyy-mm-dd").setValue(serial_(today));
  sh.getRange(r, h["備註"]).setValue(SOURCE);
  SpreadsheetApp.flush();
  out.rowNumber = r;
  return out;
}

// ── 小工具 ─────────────────────────────────────────────

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sameKey_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new UserError("帳本找不到「" + name + "」分頁");
  return sh;
}

// 表頭 → 欄號（1 起算）。先找完全相同，再找「名稱（說明）」，例如「股數（券商確認）」「交割金額（原幣，含費）」
function headers_(sh, need) {
  const width = sh.getLastColumn();
  const row = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map((x) => String(x).trim());
  const map = { _width: width };
  for (const name of need) {
    let i = row.indexOf(name);
    if (i < 0) i = row.findIndex((x) => x.startsWith(name + "（"));
    if (i < 0) throw new UserError("「" + sh.getName() + "」缺少欄位：" + name);
    map[name] = i + 1;
  }
  return map;
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

// 當月台股買進合計（台幣金額＝交割金額，含手續費；空白時用股數 × 成交價），與網站、engine/discipline.py 相同
function monthBuys_(ts, th, month) {
  const n = ts.getLastRow() - 1;
  if (n < 1) return 0;
  const disp = ts.getRange(2, 1, n, th._width).getDisplayValues();
  const vals = ts.getRange(2, 1, n, th._width).getValues();
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = disp[i];
    if (!r[th["日期"] - 1].startsWith(month) || r[th["市場"] - 1].trim() !== "台股" || r[th["買賣"] - 1].trim() !== "買進") continue;
    const v = vals[i][th["台幣金額"] - 1];
    sum += v !== "" && Number.isFinite(Number(v)) ? Number(v)
      : (Number(vals[i][th["股數"] - 1]) * Number(vals[i][th["成交價"] - 1]) || 0);
  }
  return Math.round(sum);
}

const todayYmd_ = () => Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");

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

// 試算表日期序號（1899-12-30 起算的天數）
function serial_(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

const normCode_ = (v) => String(v).trim().toUpperCase().replace(/^0+/, "");
const round2_ = (v) => Math.round(v * 100) / 100;
