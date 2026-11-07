// 記帳（2026-11-05 使用者提出）：在網站記一筆台股成交，寫進共用帳本「交易紀錄」並更新「持倉」的股數與總成本；
// 也可以改每月定投金額（從下個月生效）。寫入走使用者自己部署的 Apps Script（docs/LEDGER_WRITE.md）。
// 先「檢查這筆」（Apps Script 試算、不寫入）再「確認寫入」；同一筆有請求編號，重送不會重複寫入。
// 送出前把這筆的請求編號與內容記在這台裝置（不含密鑰）：回應遺失或頁面被關掉，重開記帳頁可以用原編號確認結果。
// 網站讀帳本用「發布到網路」的 CSV，寫入後約 5 分鐘才看得到。
// 自主加碼＝當月台股買進（含手續費與稅）超過當月定投金額的部分，不影響下個月的定投。第一版只做台股新增。
import { loadTrades, loadHoldings, loadDca } from "../data.js";
import { dcaFor, minFor, monthlyInvested, addMonth, discipline } from "../discipline.js";
import { el, twd, int, price, shares, taipeiToday, daysBetween } from "../fmt.js";
import { slot, card, pageHeader, kv, notice, loading, openDialog } from "../ui.js";
import { NAMES, TRACK, DISCIPLINE as D } from "../config.js";
import {
  writeConfig, validUrl, saveConfig, clearConfig, newSecret, newRequestId, callLedger, MIN_SECRET,
  savePending, loadPending, clearPending, PENDING_STALE_MS,
} from "../ledger_write.js";

const DOC = "https://github.com/chaper123/stock-dashboard/blob/main/docs/LEDGER_WRITE.md";
const SELL_TAX = 0.001; // 台股 ETF 證交稅 0.1%，只在賣出時收（股票是 0.3%）
let flash = null;       // 重新整理後要顯示在連線設定裡的訊息

export async function render(root) {
  root.append(pageHeader("記帳", "記一筆台股成交：寫進共用帳本的「交易紀錄」，並更新「持倉」的股數與總成本。"));
  root.append(connectionCard());
  slot(root, tradeCard);
  slot(root, monthlyCard);
}

const nowHHMM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
const field = (label, input, cls = "") => el("label", { class: `field ${cls}` }, el("span", {}, label), input);
const monthName = (ym) => `${Number(ym.slice(5))} 月`;
const nameOf = (code, holds) => NAMES[code] || holds.find((h) => h.market === "tw" && h.code === code)?.name || "";

// ── 連線設定：Apps Script 網址＋寫入密鑰（只存在這台裝置） ──
function connectionCard() {
  const cfg = writeConfig();
  const urlIn = el("input", { type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false",
    placeholder: "https://script.google.com/macros/s/…/exec", "aria-label": "Apps Script 網頁應用程式網址" });
  const keyIn = el("input", { type: "password", autocomplete: "off", spellcheck: "false",
    placeholder: `寫入密鑰（至少 ${MIN_SECRET} 個字元）`, "aria-label": "寫入密鑰" });
  const msg = el("div", { class: "small", role: "status" });
  if (flash) {
    msg.replaceChildren(flash);
    flash = null;
  }
  const gen = el("button", { class: "btn small", type: "button" }, "產生密鑰");
  const save = el("button", { class: "btn small", type: "button" }, cfg ? "更換並測試" : "儲存並測試");
  const test = cfg && el("button", { class: "btn small", type: "button" }, "測試連線");
  const clear = cfg && el("button", { class: "btn small", type: "button" }, "清除");

  gen.addEventListener("click", () => {
    keyIn.type = "text";
    keyIn.value = newSecret();
    keyIn.select();
    msg.replaceChildren(notice("info", "已產生一組密鑰：複製它，貼到 Apps Script「專案設定 → 指令碼屬性」的 WRITE_KEY，再貼上網址按「儲存並測試」。"));
  });
  const ping = async () => {
    const out = await callLedger("ping");
    return notice("info", `✓ 連線成功：「${out.ledger}」，本月定投 ${twd(out.monthly)}${out.nextMonthly !== out.monthly ? `、下個月起 ${twd(out.nextMonthly)}` : ""}`);
  };
  save.addEventListener("click", async () => {
    const url = urlIn.value.trim() || cfg?.url || "";
    const key = keyIn.value.trim() || cfg?.key || "";
    if (!validUrl(url)) return msg.replaceChildren(notice("warn", "網址要是 Apps Script 部署後的「網頁應用程式」網址：https://script.google.com/macros/s/…/exec"));
    if (key.length < MIN_SECRET) return msg.replaceChildren(notice("warn", `密鑰至少 ${MIN_SECRET} 個字元（可以按「產生密鑰」）`));
    if (!saveConfig(url, key)) return msg.replaceChildren(notice("warn", "這個瀏覽器不能儲存（可能是無痕模式）"));
    msg.replaceChildren(loading("測試連線中…"));
    try {
      flash = await ping();
    } catch (e) {
      flash = notice("err", `已儲存，但測試失敗：${e.message}`);
    }
    document.dispatchEvent(new Event("refresh-request"));
  });
  test?.addEventListener("click", async () => {
    msg.replaceChildren(loading("測試連線中…"));
    try {
      msg.replaceChildren(await ping());
    } catch (e) {
      msg.replaceChildren(notice("err", e.message));
    }
  });
  clear?.addEventListener("click", () => {
    clearConfig();
    flash = notice("info", "已清除這台裝置的記帳連線");
    document.dispatchEvent(new Event("refresh-request"));
  });

  return el("section", { class: "card" },
    el("details", { class: "set-box", open: !cfg },
      el("summary", {}, `⚙ 記帳連線：${cfg ? `已設定（密鑰 …${cfg.key.slice(-4)}）` : "未設定"}`),
      el("p", { class: "tiny" }, "寫入走你自己部署、綁在帳本上的 Google Apps Script。網址與密鑰只存在這台裝置的瀏覽器，只送到 script.google.com；每台裝置要各自設定，清除瀏覽器資料就會不見。設定步驟：",
        el("a", { href: DOC, target: "_blank", rel: "noopener noreferrer" }, "docs/LEDGER_WRITE.md"), "。"),
      el("div", { class: "row" }, urlIn),
      el("div", { class: "row" }, keyIn, gen),
      el("div", { class: "row" }, save, test, clear)),
    msg);
}

// ── 記一筆成交 ──
async function tradeCard() {
  const [csvTrades, holds, dca] = await Promise.all([
    loadTrades().catch(() => null), loadHoldings().catch(() => []), loadDca().catch(() => null)]);
  const cfg = writeConfig();
  const today = taipeiToday();
  // 這一頁剛寫入的筆數先記在本機，讓連續記兩筆（例如券商分兩次成交）時本月合計與持倉是對的
  const trades = csvTrades ? csvTrades.slice() : null;
  const held = new Map(holds.filter((h) => h.market === "tw").map((h) => [h.code, h.shares]));
  const codes = [...new Set([...TRACK.tw, ...held.keys()])];

  const f = {
    date: el("input", { type: "date", value: today, max: today, required: true }),
    time: el("input", { type: "time", value: nowHHMM(), step: 60 }),
    code: el("select", {}, codes.map((c) => el("option", { value: c }, `${c} ${nameOf(c, holds)}`)),
      el("option", { value: "" }, "其他代號…")),
    other: el("input", { type: "text", maxlength: 7, autocapitalize: "characters", spellcheck: "false",
      placeholder: "例如 0050", pattern: "\\d{4,6}[A-Za-z]?", "aria-label": "其他代號" }),
    shares: el("input", { type: "number", inputmode: "numeric", min: 1, step: 1, required: true }),
    price: el("input", { type: "number", inputmode: "decimal", min: 0.01, step: "any", required: true }),
    amount: el("input", { type: "number", inputmode: "numeric", min: 0, step: 1, required: true }),
    fee: el("input", { type: "number", inputmode: "numeric", min: 0, step: 1, required: true, placeholder: "沒有就填 0" }),
    tax: el("input", { type: "number", inputmode: "numeric", min: 0, step: 1, placeholder: "0" }),
    note: el("input", { type: "text", maxlength: 200, placeholder: "選填，例如：跌破年線加碼" }),
  };
  const sideIn = ["買進", "賣出"].map((s, i) => el("input", { type: "radio", name: "side", value: s, checked: i === 0 }));
  const otherBox = field("其他代號", f.other, "wide");
  otherBox.hidden = true;
  const taxHint = el("div", { class: "tiny", hidden: true });
  const sumBox = el("div", { class: "sum-box", role: "status" });
  const result = el("div");
  const recover = el("div");
  const submit = el("button", { class: "btn primary", type: "submit", disabled: !cfg }, "檢查這筆");
  const form = el("form", { class: "form-grid", autocomplete: "off" },
    field("成交日期", f.date), field("成交時間", f.time),
    field("代號", f.code, "wide"), otherBox,
    el("fieldset", { class: "seg wide" }, el("legend", {}, "買賣別"),
      el("div", { class: "seg-opts" }, sideIn.map((r) => el("label", {}, r, r.value)))),
    field("股數", f.shares), field("成交價", f.price),
    field("成交價金（自動算，可改）", f.amount, "wide"),
    field("手續費（必填）", f.fee), field("交易稅（選填）", f.tax),
    el("div", { class: "wide" }, taxHint),
    field("備註", f.note, "wide"),
    el("div", { class: "wide" }, sumBox),
    el("div", { class: "wide row" }, submit));

  const side = () => sideIn.find((r) => r.checked).value;
  const code = () => (f.code.value || f.other.value.trim().toUpperCase());
  const val = (x) => (x.value === "" ? null : Number(x.value));
  let amountTouched = false;
  let pending = null; // 檢查過、等確認的那一筆：{ id, data }

  function update() {
    otherBox.hidden = f.code.value !== "";
    f.other.required = f.code.value === "";
    const s = val(f.shares), p = val(f.price);
    if (!amountTouched) f.amount.value = s > 0 && p > 0 ? String(Math.floor(s * p + 1e-6)) : "";
    const amount = val(f.amount), fee = val(f.fee), tax = val(f.tax) ?? 0;
    const sell = side() === "賣出";
    const estTax = Math.floor((amount || 0) * SELL_TAX);
    taxHint.hidden = !(sell && amount > 0);
    taxHint.replaceChildren(`台股 ETF 賣出要繳 0.1% 證交稅：約 ${int(estTax)} 元（股票是 0.3%），以券商成交單為準 `,
      el("button", { class: "btn small", type: "button", onclick: () => { f.tax.value = String(estTax); update(); } }, "帶入"));
    const settle = amount == null || fee == null ? null : sell ? amount - fee - tax : amount + fee + tax;
    const lines = [settle == null ? "填好成交價金與手續費後，這裡會算交割金額。"
      : `交割金額 ${twd(settle)}（${sell ? "價金 − 手續費 − 交易稅" : "價金 ＋ 手續費 ＋ 交易稅"}）`];
    const month = (f.date.value || today).slice(0, 7);
    if (!sell && trades) {
      const before = monthlyInvested(trades).get(month)?.total || 0;
      const dep = dcaFor(dca, month);
      const after = before + (settle || 0);
      lines.push(`${monthName(month)}台股已買 ${twd(before)}${settle != null ? ` → 這筆之後 ${twd(after)}` : ""}；定投 ${twd(dep)}，自主加碼 ${twd(Math.max(0, after - dep))}`);
    }
    if (sell) {
      const have = held.get(code()) ?? 0;
      lines.push(`持倉 ${code() || "—"}：${shares(have)} 股${s > have ? "（不夠賣）" : ""}`);
    }
    sumBox.replaceChildren(...lines.map((t) => el("div", {}, t)));
  }

  f.amount.addEventListener("input", () => { amountTouched = f.amount.value !== ""; });
  form.addEventListener("input", () => {
    update();
    if (pending) {
      pending = null;
      result.replaceChildren(notice("info", "內容改了，請重新按「檢查這筆」。"));
    }
  });
  form.addEventListener("change", update);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!writeConfig() || loadPending()) return;
    const c = code();
    const data = {
      date: f.date.value, time: f.time.value, code: c, name: nameOf(c, holds), side: side(),
      shares: Number(f.shares.value), price: Number(f.price.value), amount: Number(f.amount.value),
      fee: Number(f.fee.value), tax: f.tax.value === "" ? 0 : Number(f.tax.value), note: f.note.value.trim(),
    };
    pending = null;
    submit.disabled = true;
    try {
      // 賣出前先勸一下（使用者 2026-11-05 要求）：顯示投入多久、連續投入幾個月
      if (data.side === "賣出" && !(await sellDialog(trades, dca, today))) {
        result.replaceChildren(notice("info", "好，這筆賣出先不記。繼續照計畫投入。"));
        return;
      }
      pending = { id: newRequestId(), data };
      result.replaceChildren(loading("向帳本確認中…（不會寫入）"));
      const out = await callLedger("addTrade", { ...data, dryRun: true });
      // 本月已投入（達定投 9 成）又要記買進：先問這筆是加碼還是其他規劃，選擇寫進備註；關閉就不記
      const m = out.month;
      if (data.side === "買進" && m.monthly != null && m.investedBefore >= minFor(m.monthly)) {
        const choice = await buyDialog(out);
        if (!choice) {
          pending = null;
          result.replaceChildren(notice("info", "已關閉，這筆沒有記。"));
          return;
        }
        data.note = [choice, data.note].filter(Boolean).join("；").slice(0, 200);
        out.trade.note = data.note;
      }
      const confirm = el("button", { class: "btn primary", type: "button" }, "確認寫入帳本");
      const cancel = el("button", { class: "btn", type: "button" }, "取消");
      const status = el("div", { role: "status" });
      confirm.addEventListener("click", () => write(confirm, cancel, status));
      cancel.addEventListener("click", () => { pending = null; result.replaceChildren(); });
      result.replaceChildren(previewView(out), el("div", { class: "row" }, confirm, cancel), status);
    } catch (err) {
      pending = null;
      result.replaceChildren(notice("err", err.message));
    } finally {
      submit.disabled = !!loadPending();
    }
  });

  async function write(confirm, cancel, status) {
    if (!pending) return;
    const { id, data } = pending;
    confirm.disabled = cancel.disabled = true;
    status.replaceChildren(loading("寫入中…"));
    // 先記在這台裝置：回應遺失、逾時或頁面被關掉，重開記帳頁還能用原編號確認（不存密鑰）
    const stored = savePending(id, data, writeConfig()?.url || "");
    try {
      const out = await callLedger("addTrade", data, id);
      pending = null;
      clearPending();
      done(out, true);
    } catch (err) {
      if (err.outcome === "unknown" && stored) {
        // 不知道有沒有寫入：改成「上次送出的這筆還沒確認結果」，用原編號確認，不鼓勵重填一筆
        pending = null;
        result.replaceChildren();
        showRecover(err.message);
        recover.scrollIntoView({ block: "nearest" });
        return;
      }
      if (err.outcome !== "unknown") clearPending(); // 明確沒處理或被拒絕：這台裝置不用再記著
      confirm.disabled = cancel.disabled = false; // 同一個請求編號再按一次不會重複寫入
      status.replaceChildren(notice("err", err.message));
    }
  }

  // 寫入成功（或重送拿到上次的結果）：本機先算進剛寫入的這筆；repeated 不算，發布的 CSV 可能已經有了
  function done(out, resetForm) {
    const t = out.trade;
    if (!out.repeated) {
      trades?.push({ date: t.date, market: "tw", code: t.code, side: t.side, shares: t.shares, price: t.price, twd: t.settle });
      held.set(t.code, out.holding.after.shares);
    }
    result.replaceChildren(doneView(out));
    if (resetForm) {
      for (const k of ["shares", "price", "amount", "fee", "tax", "note"]) f[k].value = "";
      amountTouched = false;
      f.time.value = nowHHMM();
    }
    update();
  }

  // 上次送出、還沒確認結果的那一筆（記在這台裝置，重開頁面也在）。處理完之前不能記新的一筆
  function showRecover(errMsg = "") {
    const p = loadPending();
    submit.disabled = !cfg || !!p;
    if (!p) return recover.replaceChildren();
    const d = p.data;
    const stale = Date.now() - p.at > PENDING_STALE_MS;
    const otherUrl = cfg && cfg.url !== p.url;
    const sentAt = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(p.at));
    const why = stale
      ? "送出已超過 5 小時：Apps Script 的重複保護只有 6 小時，再送可能重複寫入，所以不再重送。請先到帳本「交易紀錄」找這筆：有就按「放棄」；沒有就按「放棄」後重新填一筆。"
      : !cfg ? "先在上面的「記帳連線」設定網址與密鑰，才能確認。"
        : otherUrl ? "這筆是送到另一個 Apps Script 網址（例如測試帳本），和現在的記帳連線不同，不能從這裡確認。請改回原本的網址，或到那個帳本確認後按「放棄」。"
          : "可能已經寫入，也可能沒有。按「用原編號確認寫入結果」會用同一個請求編號再送一次：已經寫入就只回報結果、不會重複寫；還沒寫入就這次寫入。請不要重新填一筆。";
    const retry = el("button", { class: "btn primary", type: "button", disabled: stale || !cfg || otherUrl }, "用原編號確認寫入結果");
    const drop = el("button", { class: "btn", type: "button" }, "放棄");
    const st = el("div", { role: "status" }, errMsg && notice("err", errMsg));
    retry.addEventListener("click", async () => {
      const now = loadPending();
      if (!now || now.id !== p.id || writeConfig()?.url !== p.url) return showRecover();
      retry.disabled = drop.disabled = true;
      st.replaceChildren(loading("用原編號確認中…"));
      try {
        const out = await callLedger("addTrade", p.data, p.id);
        clearPending();
        showRecover();
        done(out, false);
      } catch (err) {
        if (err.outcome === "rejected") {
          clearPending();
          showRecover();
          result.replaceChildren(notice("err", `Apps Script 拒絕了這次重送：${err.message}。不確定第一次有沒有寫入的話，請到帳本「交易紀錄」確認。`));
        } else {
          retry.disabled = drop.disabled = false; // 還是不知道結果（或密鑰、連線要先修好）：記錄留著，可以再按
          st.replaceChildren(notice("err", err.message));
        }
      }
    });
    drop.addEventListener("click", () => {
      clearPending();
      showRecover();
      result.replaceChildren(notice("info", "已放棄：只刪掉這台裝置上的紀錄，帳本沒有變動。"));
    });
    recover.replaceChildren(notice("warn",
      el("strong", {}, "上次送出的這筆還沒確認結果"),
      el("div", {}, `${d.date} ${d.side} ${d.code} ${shares(d.shares)} 股 × ${price(d.price)}，成交價金 ${int(d.amount)}（${sentAt} 送出）`),
      el("div", { class: "small" }, why),
      el("div", { class: "row" }, retry, drop), st));
  }

  update();
  showRecover();
  return card("記一筆成交",
    !cfg && notice("warn", "先在上面的「記帳連線」貼上 Apps Script 網址與密鑰，才能寫入帳本。"),
    recover, form, result,
    el("p", { class: "tiny" }, "第一版只記台股；記錯請到試算表直接改。手續費沒有就填 0；交易稅買進通常是 0。網站讀的是試算表的發布版本，寫入後約 5 分鐘才看得到，本月合計也要等那時才含剛寫入的筆數（這一頁連續記的會先算進去）。送出後沒收到結果時，這台裝置會記下這筆的請求編號與內容（不含密鑰），重開記帳頁可以用原編號確認。"));
}

function previewView(out) {
  const t = out.trade, h = out.holding, m = out.month;
  const rows = [
    ["日期", `${t.date}${t.time ? ` ${t.time}` : ""}`], ["代號", `${t.code} ${NAMES[t.code] || ""}`], ["買賣", t.side],
    ["股數", shares(t.shares)], ["成交價", price(t.price)], ["成交價金", int(t.amount)], ["手續費", int(t.fee)],
    ["交易稅", int(t.tax)], ["交割金額", twd(t.settle)], t.note && ["備註", t.note]].filter(Boolean);
  return el("div", { class: "preview" },
    el("h3", {}, "確認要寫進帳本的內容"),
    el("table", { class: "kvt" }, el("tbody", {}, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v))))),
    el("div", { class: "small" }, `持倉 ${t.code}：${shares(h.before.shares)} → ${shares(h.after.shares)} 股，總成本 ${twd(h.before.cost)} → ${twd(h.after.cost)}${h.isNew ? "（新增一列）" : ""}`),
    t.side === "買進" && m.monthly != null && el("div", { class: "small" },
      `${monthName(m.month)}台股買進 ${twd(m.investedBefore)} → ${twd(m.investedAfter)}；定投 ${twd(m.monthly)}，自主加碼 ${twd(m.extraAfter)}`));
}

function doneView(out) {
  const t = out.trade, h = out.holding;
  return notice("info",
    el("strong", {}, out.repeated ? `這筆之前已經寫入過（當時是交易紀錄第 ${out.rowNumber} 列），這次沒有重複寫。` : `✓ 已寫入交易紀錄第 ${out.rowNumber} 列。`),
    ` ${t.date} ${t.side} ${t.code} ${shares(t.shares)} 股，交割 ${twd(t.settle)}；持倉 ${shares(h.after.shares)} 股。`,
    "約 5 分鐘後按「↻ 重新整理」，其他頁面才看得到。");
}

// ── 警告視窗 ──

// 本月已投入又要買進：回傳要寫進備註的標記（「自主加碼」或「其他規劃：…」），關閉回傳 null
function buyDialog(out) {
  const m = out.month, t = out.trade;
  return openDialog((close) => {
    const body = el("div");
    const showChoices = () => {
      const plus = el("button", { class: "btn primary", type: "button", onclick: () => close("自主加碼") }, "算自主加碼");
      const other = el("button", { class: "btn", type: "button", onclick: showOther }, "其他規劃");
      const shut = el("button", { class: "btn", type: "button", onclick: () => close(null) }, "關閉視窗");
      body.replaceChildren(
        el("h2", {}, "這個月已經投入了"),
        el("p", {}, `${monthName(m.month)}台股已買 ${twd(m.investedBefore)}，定投 ${twd(m.monthly)} 已經完成。`),
        el("p", {}, `這筆 ${t.code} ${twd(t.settle)} 記下去，本月合計 ${twd(m.investedAfter)}，其中自主加碼 ${twd(m.extraAfter)}。要記成哪一種？`),
        el("p", { class: "tiny" }, "超過定投的部分都算自主加碼，不會改變下個月的定投金額。選擇會寫進備註；都不是就關閉視窗，這筆不記。"),
        el("div", { class: "modal-actions" }, plus, other, shut));
      plus.focus();
    };
    const showOther = () => {
      const input = el("input", { type: "text", maxlength: 80, placeholder: "例如：提前投入下個月的定投", "aria-label": "其他規劃的說明" });
      const msg = el("div", { class: "tiny", role: "status" });
      const chips = ["提前投入下個月的定投", "同一筆定投分次成交", "補偏低的一檔（再平衡）"].map((s) =>
        el("button", { class: "chip", type: "button", onclick: () => { input.value = s; input.focus(); } }, s));
      const ok = el("button", { class: "btn primary", type: "button" }, "確定");
      ok.addEventListener("click", () => {
        const v = input.value.trim();
        if (!v) {
          msg.textContent = "寫一下這筆的規劃，或按「返回」。";
          return;
        }
        close(`其他規劃：${v}`);
      });
      input.addEventListener("keydown", (e) => e.key === "Enter" && ok.click());
      body.replaceChildren(
        el("h2", {}, "這筆是什麼規劃？"),
        el("div", { class: "chips" }, chips),
        el("div", { class: "modal-field" }, input), msg,
        el("div", { class: "modal-actions" }, ok,
          el("button", { class: "btn", type: "button", onclick: showChoices }, "返回"),
          el("button", { class: "btn", type: "button", onclick: () => close(null) }, "關閉視窗")));
      input.focus();
    };
    queueMicrotask(showChoices);
    return body;
  });
}

// 賣出前的勸阻：投入多久、累計買進、連續投入幾個月；「確定賣出」5 秒後才能按。回傳 true 才繼續
const SELL_WAIT_S = 5;
function sellDialog(trades, dca, today) {
  const buys = (trades || []).filter((t) => t.market === "tw" && t.side === "買進").sort((a, b) => a.date.localeCompare(b.date));
  const first = buys[0]?.date;
  const days = first ? daysBetween(first, today) : null;
  const total = buys.reduce((s, t) => s + (t.twd ?? (t.shares != null && t.price != null ? t.shares * t.price : 0)), 0);
  const streak = trades ? discipline({ trades, positions: [], today, dca }).streak : null;
  return openDialog((close) => {
    let timer = null;
    const done = (v) => {
      clearInterval(timer);
      close(v);
    };
    const stay = el("button", { class: "btn primary", type: "button", onclick: () => done(false) }, "我再想想，不賣了");
    const go = el("button", { class: "btn", type: "button", disabled: true, onclick: () => done(true) }, `還是要賣（${SELL_WAIT_S}）`);
    let left = SELL_WAIT_S;
    timer = setInterval(() => {
      left -= 1;
      if (left > 0) go.textContent = `還是要賣（${left}）`;
      else {
        clearInterval(timer);
        go.disabled = false;
        go.textContent = "我確定要賣出";
      }
    }, 1000);
    queueMicrotask(() => stay.focus());
    return [
      el("h2", {}, "先停一下：真的要賣嗎？"),
      first && el("p", {}, `你從 ${first.replace(/-/g, "/")} 第一次買進台股，到今天 ${int(days)} 天（約 ${Math.max(1, Math.round(days / 30.4))} 個月），台股累計買進 ${twd(total)}。`),
      streak != null && el("p", {}, `配置紀律從 ${D.start.replace("-", " 年 ")} 月起，已經連續 ${streak} 個月按時投入。`),
      el("p", {}, "定期定額靠的是時間：中途賣掉，前面累積的紀律就斷了。短期漲跌不是賣出的理由，照計畫每月投入、4 月與 10 月再檢查配置就好。"),
      el("p", { class: "tiny" }, "這是你自己設的提醒，不是投資建議。真的需要用錢或有其他規劃，5 秒後可以繼續。"),
      el("div", { class: "modal-actions" }, stay, go),
    ];
  });
}

// ── 每月定投金額（下個月生效） ──
async function monthlyCard() {
  const dca = await loadDca().catch(() => null);
  const cfg = writeConfig();
  const ym = taipeiToday().slice(0, 7);
  const next = addMonth(ym, 1);
  const cur = dcaFor(dca, ym), nxt = dcaFor(dca, next);
  const input = el("input", { type: "number", inputmode: "numeric", min: 0, max: 1000000, step: 1, value: nxt, "aria-label": "新的每月定投金額" });
  const btn = el("button", { class: "btn", type: "button", disabled: !cfg }, `從 ${monthName(next)}起改成這個金額`);
  const out = el("div", { role: "status" });
  btn.addEventListener("click", async () => {
    const amount = Number(input.value);
    if (!Number.isInteger(amount) || amount < 0 || amount > 1000000) return out.replaceChildren(notice("warn", "金額要是 0～1,000,000 的整數"));
    btn.disabled = true;
    out.replaceChildren(loading("向帳本確認中…（不會寫入）"));
    try {
      const pre = await callLedger("setMonthly", { amount, dryRun: true });
      const id = newRequestId();
      const ok = el("button", { class: "btn primary", type: "button" }, "確定");
      const no = el("button", { class: "btn", type: "button" }, "取消");
      const st = el("div", { role: "status" });
      ok.addEventListener("click", async () => {
        ok.disabled = no.disabled = true;
        st.replaceChildren(loading("寫入中…"));
        try {
          const r = await callLedger("setMonthly", { amount }, id);
          out.replaceChildren(notice("info", el("strong", {}, `✓ 已設定：${r.effective.replace("-", " 年 ")} 月起每月定投 ${twd(r.amount)}`),
            `（「定投金額」分頁第 ${r.rowNumber} 列）。約 5 分鐘後重新整理才會更新。`));
        } catch (e) {
          ok.disabled = no.disabled = false;
          st.replaceChildren(notice("err", e.message));
        }
      });
      no.addEventListener("click", () => out.replaceChildren());
      out.replaceChildren(notice("warn", `確定把 ${pre.effective.replace("-", " 年 ")} 月起的每月定投從 ${twd(pre.previousNext)} 改成 ${twd(pre.amount)}？這個月（${monthName(ym)}）仍是 ${twd(pre.current)}。`),
        el("div", { class: "row" }, ok, no), st);
    } catch (e) {
      out.replaceChildren(notice("err", e.message));
    } finally {
      btn.disabled = !writeConfig();
    }
  });
  return card("每月定投金額",
    el("div", { class: "grid two" }, kv(`本月（${monthName(ym)}）`, twd(cur)), kv(`下個月（${monthName(next)}）起`, twd(nxt))),
    el("div", { class: "row dca-row" }, input, btn),
    out,
    el("p", { class: "tiny" }, "改金額從下個月生效，這個月不變；超過定投金額的買進算自主加碼，不會改變下個月的定投。帳本的可用資金照「定投金額」分頁逐月加總。注意：新聞晨報的「本月紀律」（engine/discipline.py）目前固定用 3,000 計算，改金額後要另外更新排程。"));
}
