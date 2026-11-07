// 假的 Apps Script 服務：讓 apps_script/ledger_write.gs 原封不動在瀏覽器裡跑（只在本機測試用，不連 Google）。
// 換掉 SpreadsheetApp、LockService、CacheService、PropertiesService、ContentService、Utilities。
// 一個 env＝一份假帳本＋共用的快取、鎖、指令碼屬性；同一個 env 呼叫多次 doPost 就像同一個部署收到多個請求。

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
const EPOCH = Date.UTC(1899, 11, 30);
const ymdOf = (serial) => new Date(EPOCH + serial * 86400000).toISOString().slice(0, 10);

class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.cells = rows.map((r) => r.map((v) => ({ v, f: "" })));
  }
  getName() { return this.name; }
  cell(r, c) {
    while (this.cells.length < r) this.cells.push([]);
    const row = this.cells[r - 1];
    while (row.length < c) row.push({ v: "", f: "" });
    return row[c - 1];
  }
  filled(cell) { return cell && cell.v !== "" && cell.v != null; }
  getLastRow() {
    for (let r = this.cells.length; r >= 1; r--) if (this.cells[r - 1].some((c) => this.filled(c))) return r;
    return 0;
  }
  getLastColumn() {
    let w = 0;
    for (const row of this.cells) for (let c = row.length; c > w; c--) if (this.filled(row[c - 1])) { w = c; break; }
    return w;
  }
  getRange(row, col, nr = 1, nc = 1) { return new FakeRange(this, row, col, nr, nc); }
  display(cell) {
    const { v, f } = cell;
    if (v === "" || v == null) return "";
    if (typeof v === "number" && f === "yyyy-mm-dd") return ymdOf(v);
    if (typeof v === "number" && f === "yyyy-mm") return ymdOf(v).slice(0, 7);
    return String(v);
  }
  // 「發布到網路」的 CSV（給記帳頁沙盒用）
  csv() {
    const n = this.getLastRow(), w = this.getLastColumn();
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [];
    for (let r = 1; r <= n; r++) {
      const vals = [];
      for (let c = 1; c <= w; c++) vals.push(q(this.display(this.cell(r, c))));
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
    this.each((c, i, j) => { out[i][j] = fn(c); });
    return out;
  }
  getValues() { return this.grid((c) => (c.v == null ? "" : c.v)); }
  getDisplayValues() { return this.grid((c) => this.sh.display(c)); }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some((r) => r.length !== this.nc)) throw new Error("setValues 大小不符");
    return this.each((c, i, j) => { c.v = vals[i][j]; });
  }
  setValue(v) { return this.each((c) => { c.v = v; }); }
  setNumberFormat(f) { return this.each((c) => { c.f = f; }); }
  copyTo(dest, type) {
    const src = this.grid((c) => ({ ...c }));
    dest.each((c, i, j) => {
      const s = src[i]?.[j];
      if (!s) return;
      c.f = s.f;
      if (type !== "PASTE_FORMAT") c.v = s.v;
    });
  }
}

// 和正式帳本同樣的表頭（含「（說明）」的寫法），資料是假的
export function seedSheets() {
  return {
    交易紀錄: new FakeSheet("交易紀錄", [
      ["日期", "市場", "代號", "買賣", "股數", "成交價", "幣別", "手續費", "交割金額（原幣，含費）", "匯率", "台幣金額",
        "計入資金池", "台幣金額來源", "備註", "成交時間", "交易稅"],
      ["2026-11-05", "台股", "00981A", "買進", 40, 23.72, "TWD", 1, 949, "", 949, "是", "券商", "", "", 0],
      ["2026-11-05", "台股", "009816", "買進", 173, 14.7, "TWD", 0, 2543, "", 2543, "是", "券商", "", "", 0],
    ]),
    持倉: new FakeSheet("持倉", [
      ["市場", "代號", "名稱", "股數（券商確認）", "總成本", "幣別", "確認日", "來源"],
      ["台股", "009816", "凱基台灣TOP50", 1241, 17196, "TWD", "2026-11-05", "券商庫存"],
      ["台股", "00981A", "主動統一台股增長", 141, 3935, "TWD", "2026-11-05", "券商庫存"],
      ["美股", "VOO", "Vanguard S&P 500", 1, 500, "USD", "2026-10-16", "券商庫存"],
    ]),
    定投金額: new FakeSheet("定投金額", [
      ["生效月份", "每月定投（NT$）", "設定日期", "備註"],
      ["2026-11", 3000, "2026-11-05", "初始值"],
    ]),
  };
}

const GAS_NAMES = ["SpreadsheetApp", "LockService", "CacheService", "PropertiesService", "ContentService", "Utilities"];

export async function loadGasSource(src) {
  const res = await fetch(src, { cache: "no-store" });
  if (!res.ok) throw new Error(`讀不到 ${src}：HTTP ${res.status}`);
  return res.text();
}

// 建一個假環境：env.post(body) 回傳解析後的 JSON；env.log 記下快取讀寫與鎖的順序
export function makeEnv(source, { key = TEST_KEY } = {}) {
  const sheets = seedSheets();
  const store = new Map();
  const log = [];
  const env = { sheets, store, log, beforeLock: [], onFlush: [], props: { WRITE_KEY: key } };
  let held = false;

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ({ getName: () => "測試帳本（假）", getSheetByName: (n) => sheets[n] || null }),
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
      if (fmt !== "yyyy-MM-dd") throw new Error("假的 formatDate 只支援 yyyy-MM-dd");
      return TODAY; // 固定今天，測試結果不隨日期變
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
      if (sh.display(sh.cell(r, 2)) === code) return { shares: sh.cell(r, 4).v, cost: sh.cell(r, 5).v };
    }
    return null;
  };
  return env;
}
