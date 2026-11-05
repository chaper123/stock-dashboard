// 寫入共用帳本：透過使用者自己部署的 Apps Script 網頁應用程式（apps_script/ledger_write.gs，設定見 docs/LEDGER_WRITE.md）。
// 網址與寫入密鑰只存在這台裝置的 localStorage，只送到 script.google.com（放在 POST 內文，不放網址）；
// 不寫 console、不進 git、不放試算表。用 text/plain 的 POST（簡單請求，不會有 CORS 預檢）；
// Apps Script 的回應會轉址到 script.googleusercontent.com，fetch 會自動跟過去。service worker 不處理 POST。
const URL_KEY = "ledger.writeUrl";
const SECRET_KEY = "ledger.writeKey";
const URL_RX = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
export const MIN_SECRET = 20;

function get(k) {
  try {
    return localStorage.getItem(k) || null;
  } catch {
    return null;
  }
}
function put(k, v) {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export const validUrl = (u) => URL_RX.test(u);
export function writeConfig() {
  const url = get(URL_KEY), key = get(SECRET_KEY);
  return url && key && validUrl(url) ? { url, key } : null;
}
export const saveConfig = (url, key) => put(URL_KEY, url) && put(SECRET_KEY, key);
export function clearConfig() {
  put(URL_KEY, null);
  put(SECRET_KEY, null);
}

// 隨機字串（base64url）：寫入密鑰 32 字、請求編號 24 字
function random(n) {
  const b = crypto.getRandomValues(new Uint8Array(Math.ceil((n * 3) / 4)));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, n);
}
export const newSecret = () => random(32);
export const newRequestId = () => random(24);

export class WriteError extends Error {}

// action：ping／addTrade／setMonthly。id 是請求編號：同一筆重送時 Apps Script 回傳上次結果，不會重複寫入
export async function callLedger(action, data = {}, id = null) {
  const cfg = writeConfig();
  if (!cfg) throw new WriteError("還沒設定記帳連線");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(cfg.url, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ key: cfg.key, action, id, data }),
      cache: "no-store", credentials: "omit", redirect: "follow", signal: ctl.signal,
    });
  } catch (e) {
    throw new WriteError(e.name === "AbortError"
      ? "等了 30 秒沒有回應：可能已經寫入，再按一次同一個按鈕不會重複寫入"
      : "連不上 Apps Script（檢查網址與網路）");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new WriteError(`Apps Script 回應 HTTP ${res.status}`);
  let out;
  try {
    out = await res.json();
  } catch {
    throw new WriteError("Apps Script 回的不是 JSON（部署時「誰可以存取」要選「所有人」）");
  }
  if (!out || !out.ok) throw new WriteError(out?.error || "寫入失敗");
  return out;
}
