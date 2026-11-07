// 假的 Apps Script 服務：讓 apps_script/ledger_write.gs 原封不動在瀏覽器裡跑（只在本機測試用，不連 Google）。
// 換掉 SpreadsheetApp、LockService、CacheService、PropertiesService、ContentService、Utilities。
// 一個 env＝一份假帳本＋共用的快取、鎖、指令碼屬性；同一個 env 呼叫多次 doPost 就像同一個部署收到多個請求。
// 假帳本有和正式帳本一樣意思的公式欄（用 JS 算），也可以在任何一次寫入時「故障」（env.crashWhen），模擬執行中斷。

export const TEST_KEY = "test-write-key-0123456789abcdef"; // 只給假服務用的測試密鑰
export const TODAY = "2026-11-07";

// ── SHA-256（同步，Utilities.computeDigest 是同步的；用 SubtleCrypto 對過，見測試） ──
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
const PRIMES = (() => {
  const out = [];
  for (let n = 2; out.length < 64; n++) if (out.every((p) => n % p)) out.push(n);
  return out;
})();
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = Uint32Array.from(PRIMES, (p) => frac32(Math.cbrt(p)));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => frac32(Math.sqrt(p)));

export function sha256(bytes) {
  const l = bytes.length;
  const buf = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  buf.set(bytes);
  buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor((l * 8) / 2 ** 32));
  dv.setUint32(buf.length - 4, (l * 8) >>> 0);
  const H = H0.slice();
  const W = new Uint32Array(64);
  for (let i = 0; i < buf.length; i += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, k) => { H[k] = (H[k] + v) >>> 0; });
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  H.forEach((v, k) => ov.setUint32(k * 4, v));
  return out;
}
export const hex = (bytes) => [...bytes].map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");

// ── 假試算表 ──
// 儲存格 { v, f, fx }：v 值、f 數字格式、fx 公式 { text, fn(book, row) }。fn 用所在的列計算，所以複製到別列就像相對參照。
const EPOCH = Date.UTC(1899, 11, 30);
const ymdOf = (serial) => new Date(EPOCH + serial * 86400000).toISOString().slice(0, 10);
const blank = () => ({ v: "", f: "", fx: null });
const asCell = (x) => (x && typeof x === "object" && ("fx" in x || "v" in x) ? { ...blank(), ...x } : { ...blank(), v: x });

class FakeSheet {
  constructor(name, rows, book, env) {
    Object.assign(this, { name, book, env });
    this.cells = rows.map((r) => r.map(asCell));
  }
  getName() { return this.name; }
  cell(r, c) {
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1];
    while (row.length < c) row.push(blank());
    return row[c - 1];
  }
  filled(cell) { return !!cell && (!!cell.fx || (cell.v !== "" && cell.v != null)); }
  getLastRow() {
    for (let r = this.cells.length; r >= 1; r--) if (this.cells[r - 1].some((c) => this.filled(c))) return r;
    return 0;
  }
  getLastColumn() {
    let w = 0;
    for (const row of this.cells) for (let c = row.length; c > w; c--) if (this.filled(row[c - 1])) { w = c; break; }
    return w;
  }
  getMaxColumns() { return 26; }
  insertColumnsAfter() {}
  setFrozenRows() {}
  getRange(row, col, nr = 1, nc = 1) { return new FakeRange(this, row, col, nr, nc); }
  value(cell, r) { return cell.fx ? cell.fx.fn(this.book, r) : cell.v == null ? "" : cell.v; }
  display(cell, r) {
    const v = this.value(cell, r);
    if (v === "" || v == null) return "";
    if (typeof v === "number" && cell.f === "yyyy-mm-dd") return ymdOf(v);
    if (typeof v === "number" && cell.f === "yyyy-mm") return ymdOf(v).slice(0, 7);
    return String(v);
  }
  // 「發布到網路」的 CSV（給記帳頁沙盒用）
  csv() {
    const n = this.getLastRow(), w = this.getLastColumn();
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [];
    for (let r = 1; r <= n; r++) {
      const vals = [];
      for (let c = 1; c <= w; c++) vals.push(q(this.display(this.cell(r, c), r)));
      lines.push(vals.join(","));
    }
    return lines.join("\n");
  }
}

class FakeRange {
  constructor(sh, row, col, nr, nc) {
    if (!(row >= 1 && col >= 1 && nr >= 1 && nc >= 1)) throw new Error(`範圍不對：${row},${col},${nr},${nc}`);
    Object.assign(this, { sh, row, col, nr, nc });
  }
  each(fn) {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sh.cell(this.row + i, this.col + j), i, j);
    return this;
  }
  grid(fn) {
    const out = Array.from({ length: this.nr }, () => new Array(this.nc));
    this.each((c, i, j) => { out[i][j] = fn(c, this.row + i); });
    return out;
  }
  // 寫入前問測試要不要在這裡「故障」（模擬 Apps Script 執行中斷：這次寫入沒有發生）
  guard(op, vals) {
    this.sh.env.guard({ sheet: this.sh.name, op, row: this.row, col: this.col, nr: this.nr, nc: this.nc, vals });
  }
  getValues() { return this.grid((c, r) => this.sh.value(c, r)); }
  getDisplayValues() { return this.grid((c, r) => this.sh.display(c, r)); }
  getFormulas() { return this.grid((c, r) => (c.fx ? c.fx.text.replaceAll("{r}", r) : "")); }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error("setValues 大小不符");
    this.guard("setValues", vals);
    return this.each((c, i, j) => { c.v = vals[i][j]; c.fx = null; });
  }
  setValue(v) {
    this.guard("setValue", [[v]]);
    return this.each((c) => { c.v = v; c.fx = null; });
  }
  setNumberFormat(f) { return this.each((c) => { c.f = f; }); }
  copyTo(dest, type) {
    dest.guard(type === "PASTE_FORMAT" ? "copyFormat" : "copyTo");
    const src = this.grid((c) => ({ ...c }));
    dest.each((c, i, j) => {
      const s = src[i]?.[j];
      if (!s) return;
      c.f = s.f;
      if (type !== "PASTE_FORMAT") { c.v = s.v; c.fx = s.fx; }
    });
  }
}

// ── 公式：和正式帳本一樣的意思，用 JS 算 ──
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
const normCode = (v) => String(v).trim().toUpperCase().replace(/^0+/, "");
function tradeRows(book) {
  const ts = book["交易紀錄"];
  const out = [];
  for (let r = 2; r <= ts.getLastRow(); r++) out.push((c) => ts.value(ts.cell(r, c), r));
  return out;
}
const at = (sh, r, c) => sh.value(sh.cell(r, c), r);
export const FX = {
  // 持倉：平均成本＝總成本÷股數；交易紀錄股數＝同代號買進－賣出（SUMPRODUCT）；股數差異＝股數－交易紀錄股數
  avg: { text: "=IF(D{r}=0,0,E{r}/D{r})", fn: (b, r) => { const d = num(at(b["持倉"], r, 4)); return d ? num(at(b["持倉"], r, 5)) / d : 0; } },
  net: {
    text: "=SUMPRODUCT(交易紀錄 同代號 B{r} 買進－賣出)",
    fn: (b, r) => {
      const code = normCode(at(b["持倉"], r, 2));
      let s = 0;
      for (const g of tradeRows(b)) if (normCode(g(3)) === code) s += g(4) === "買進" ? num(g(5)) : g(4) === "賣出" ? -num(g(5)) : 0;
      return Math.round(s * 1e6) / 1e6;
    },
  },
  diff: { text: "=D{r}-H{r}", fn: (b, r) => num(at(b["持倉"], r, 4)) - num(at(b["持倉"], r, 8)) },
  // 設定：基準日後買入合計／賣出回收＝SUMIFS(交易紀錄 K, L="是", D=買進／賣出)
  pool: (side) => ({
    text: `=SUMIFS('交易紀錄'!K:K,'交易紀錄'!L:L,"是",'交易紀錄'!D:D,"${side}")`,
    fn: (b) => {
      let s = 0;
      for (const g of tradeRows(b)) if (g(12) === "是" && g(4) === side) s += num(g(11));
      return Math.round(s * 100) / 100;
    },
  }),
  // 定投金額：這段期間入金次數、合計（假的，只要是公式就好）
  dcaCount: { text: "=入金次數(A{r})", fn: () => 1 },
  dcaSum: { text: "=B{r}*E{r}", fn: (b, r) => num(at(b["定投金額"], r, 2)) * num(at(b["定投金額"], r, 5)) },
};
const hold = (m, c, n, sh, cost, cur, conf, src) => [m, c, n, sh, cost, cur, { fx: FX.avg }, { fx: FX.net }, { fx: FX.diff }, conf, src];
export const BASIS = 46301; // 基準日 2026-10-06 的試算表序號

// 和正式帳本同樣的表頭（含「（說明）」的寫法）與公式欄，資料是假的；一開始股數、資金池欄位、交割金額都對得上（對帳全過）
export function seedRows() {
  return {
    設定: [
      ["項目", "數值", "說明"],
      ["基準日", { v: BASIS, f: "yyyy-mm-dd" }, "假的"],
      ["基準日後買入合計（NT$）", { fx: FX.pool("買進") }, ""],
      ["基準日後賣出回收（NT$）", { fx: FX.pool("賣出") }, ""],
    ],
    交易紀錄: [
      ["日期", "市場", "代號", "買賣", "股數", "成交價", "幣別", "手續費", "交割金額（原幣，含費）", "匯率（USD/TWD）", "台幣金額",
        "計入資金池", "台幣金額來源", "備註", "成交時間", "交易稅"],
      ["2026-04-08", "台股", "009816", "買進", 1068, 11.19, "TWD", "", "", "", "", "否", "未提供", "基準日前", "", ""],
      ["2026-04-17", "美股", "VOO", "買進", 1, 500, "USD", 0.07, 500.07, "", "", "否", "未提供", "基準日前", "", ""],
      ["2026-09-30", "台股", "00981A", "買進", 101, 30, "TWD", "", "", "", "", "否", "未提供", "基準日前", "", ""],
      ["2026-11-05", "台股", "00981A", "買進", 40, 23.72, "TWD", 1, 949, "", 949, "是", "券商", "", "", 0],
      ["2026-11-05", "台股", "009816", "買進", 173, 14.7, "TWD", 0, 2543, "", 2543, "是", "券商", "", "", 0],
    ],
    持倉: [
      ["市場", "代號", "名稱", "股數（券商確認）", "總成本（原幣，含費）", "幣別", "平均成本", "交易紀錄股數", "股數差異", "確認日", "來源"],
      hold("台股", "009816", "凱基台灣TOP50", 1241, 17196, "TWD", "2026-11-05", "券商庫存"),
      hold("台股", "00981A", "主動統一台股增長", 141, 3935, "TWD", "2026-11-05", "券商庫存"),
      hold("美股", "VOO", "Vanguard S&P 500", 1, 500.07, "USD", "2026-10-16", "券商庫存"),
    ],
    定投金額: [
      ["生效月份", "每月定投（NT$）", "設定日期", "備註", "這段期間入金次數", "這段期間入金合計（NT$）"],
      ["2026-11", 3000, "2026-11-05", "初始值", { fx: FX.dcaCount }, { fx: FX.dcaSum }],
    ],
  };
}

const GAS_NAMES = ["SpreadsheetApp", "LockService", "CacheService", "PropertiesService", "ContentService", "Utilities"];

export async function loadGasSource(src) {
  const res = await fetch(src, { cache: "no-store" });
  if (!res.ok) throw new Error(`讀不到 ${src}：HTTP ${res.status}`);
  return res.text();
}

// 建一個假環境：env.post(body) 回傳解析後的 JSON；env.log 記下快取讀寫、鎖、故障的順序。
// 故障注入：env.crashWhen = (w) => bool，w＝{ sheet, op, row, col, nr, nc, vals }；第一次符合的寫入丟錯（只觸發一次）
export function makeEnv(source, { key = TEST_KEY } = {}) {
  const sheets = {};
  const order = [];
  const store = new Map();
  const log = [];
  const env = { sheets, store, log, beforeLock: [], onFlush: [], props: { WRITE_KEY: key }, crashWhen: null };
  env.guard = (w) => {
    if (env.crashWhen && env.crashWhen(w)) {
      env.crashWhen = null;
      log.push(`crash ${w.sheet} ${w.op} 第 ${w.row} 列`);
      throw new Error("模擬故障（執行中斷）");
    }
  };
  const add = (name, rows) => {
    sheets[name] = new FakeSheet(name, rows, sheets, env);
    order.push(name);
    return sheets[name];
  };
  for (const [name, rows] of Object.entries(seedRows())) add(name, rows);
  let held = false;
  let clock = 0;

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getName: () => "測試帳本（假）",
      getSheetByName: (n) => sheets[n] || null,
      getSheets: () => order.map((n) => sheets[n]),
      insertSheet: (n) => {
        if (sheets[n]) throw new Error("分頁已存在");
        log.push(`insertSheet ${n}`);
        return add(n, []);
      },
    }),
    flush: () => { log.push("flush"); const fn = env.onFlush.shift(); if (fn) fn(); },
    CopyPasteType: { PASTE_FORMAT: "PASTE_FORMAT" },
  };
  const LockService = {
    getScriptLock: () => ({
      waitLock() {
        const fn = env.beforeLock.shift(); // 測試在這裡插入「另一個請求」
        if (fn) fn();
        if (held) { log.push("lock-timeout"); throw new Error("Lock timeout"); }
        held = true;
        log.push("lock");
      },
      releaseLock() { held = false; log.push("unlock"); },
    }),
  };
  const CacheService = {
    getScriptCache: () => ({
      get(k) {
        const v = store.has(k) ? store.get(k) : null;
        if (k.startsWith("req:")) log.push(v == null ? "get-miss" : "get-hit");
        return v;
      },
      put(k, v) {
        store.set(k, String(v));
        if (k.startsWith("req:")) log.push("put");
      },
    }),
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => env.props[k] ?? null }) };
  const ContentService = {
    createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return this.s; } }),
    MimeType: { JSON: "JSON" },
  };
  const Utilities = {
    formatDate: (d, tz, fmt) => {
      if (fmt === "yyyy-MM-dd") return TODAY; // 固定今天，測試結果不隨日期變
      if (fmt === "yyyy-MM-dd HH:mm:ss") { // 每次加一秒，紀錄的先後看得出來
        clock += 1;
        return `${TODAY} 10:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}`;
      }
      throw new Error(`假的 formatDate 不支援 ${fmt}`);
    },
    computeDigest: (alg, text, charset) => {
      if (alg !== "SHA_256" || charset !== "UTF_8") throw new Error("假的 computeDigest 只支援 SHA_256＋UTF_8");
      return [...sha256(new TextEncoder().encode(text))].map((b) => (b > 127 ? b - 256 : b)); // 和 Apps Script 一樣是有號位元組
    },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
  };

  // eslint-disable-next-line no-new-func
  const gas = new Function(...GAS_NAMES, `${source}\n;return { doPost, doGet };`)(
    SpreadsheetApp, LockService, CacheService, PropertiesService, ContentService, Utilities);

  env.raw = (contents) => JSON.parse(gas.doPost({ postData: { contents } }).getContent());
  env.post = (body) => env.raw(JSON.stringify({ key, ...body }));
  env.rows = (name) => sheets[name].getLastRow() - 1;
  env.holding = (code) => {
    const sh = sheets["持倉"];
    for (let r = 2; r <= sh.getLastRow(); r++) {
      if (sh.display(sh.cell(r, 2), r) === code) return { shares: sh.cell(r, 4).v, cost: sh.cell(r, 5).v, row: r };
    }
    return null;
  };
  // 某分頁第 r 列的顯示值（陣列）；某一格的公式文字；改一格的值（模擬有人在試算表手動改）
  env.rowAt = (name, r) => {
    const sh = sheets[name];
    return sh.getRange(r, 1, 1, Math.max(1, sh.getLastColumn())).getDisplayValues()[0];
  };
  env.formula = (name, r, c) => sheets[name].getRange(r, c).getFormulas()[0][0];
  env.edit = (name, r, c, v) => { const cell = sheets[name].cell(r, c); cell.v = v; cell.fx = null; };
  // 交易紀錄某欄的欄號（照表頭找）
  env.col = (name, head) => env.rowAt(name, 1).findIndex((h) => h === head || h.startsWith(head + "（")) + 1;
  // 寫入紀錄的每一列：[{ 請求編號, 狀態, … }]
  env.logRows = () => {
    const sh = sheets["寫入紀錄"];
    if (!sh) return [];
    const head = env.rowAt("寫入紀錄", 1);
    const out = [];
    for (let r = 2; r <= sh.getLastRow(); r++) out.push(Object.fromEntries(env.rowAt("寫入紀錄", r).map((v, i) => [head[i], v])));
    return out;
  };
  return env;
}
