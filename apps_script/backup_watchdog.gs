// 備份看門狗：每天從 Google 雲端硬碟「那一側」核對 stock-dashboard 的每日備份真的上傳了、沒有停、沒有被分享，
// 有問題才寄信給自己（規格 docs/BACKUP.md 第 13 節）。
// 這是獨立的 Apps Script 專案（script.google.com 新增專案，不要放進帳本綁定的 ledger_write 專案）。
// 權限只有唯讀雲端硬碟、寄信、管理自己的觸發器、取得自己的信箱（appsscript.json）；不用 UrlFetch、不用 GitHub token。
// 程式裡不寫任何信箱、資料夾 ID、帳號：收件人是執行者自己，資料夾靠名稱與標記檔找。
//
// 函式：
//   installTrigger()  手動跑一次：建立每天 9 點（台北）的 dailyCheck 觸發器（先刪掉舊的同名觸發器）
//   dailyCheck()      觸發器呼叫：檢查，有問題才寄信（同一個問題最多每 W.REMIND_EVERY_DAYS 天一次；恢復正常寄一封）
//   dryRun()          跑一次真的檢查但不寄信，結果印在執行紀錄
//   testMail()        門檻當成 0，實際寄一封測試信給自己
//   selfTest()        用寫在下面的假資料跑 evaluate_ 與 plan_，執行紀錄印「通過 N／N」（不連雲端硬碟）
// 判斷全部在純函式 evaluate_／plan_（不碰 Apps Script 服務），讀雲端硬碟在 collect_。本機測試：
// tests/apps_script/backup_watchdog_test.html 在瀏覽器裡用假的 DriveApp 等服務原封不動跑這一份程式。

const W = {
  FOLDER_NAME: "stock-dashboard 備份",
  MARKER: "備份根目錄-請勿刪除.txt",
  MAX_OK_AGE_DAYS: 3,       // last_ok 超過幾天沒更新
  MAX_BUNDLE_AGE_DAYS: 10,  // 最新完整歷史超過幾天（Python 腳本每 7 天做一次）
  MARKET_STALE_DAYS: 4,     // market-data 最後一個 commit 超過幾天
  QUOTA_WARN: 0.8,          // 雲端硬碟用量比例
  REMIND_EVERY_DAYS: 3,     // 同一個問題最多每幾天寄一次
};
const TZ = "Asia/Taipei";
const REMIND_PROP = "REMIND";   // Script Properties：{問題代號: 上次寄送時間}
const DATE_NAME = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 純函式（不碰 Apps Script 服務；selfTest 與瀏覽器測試都跑這些）----------

const isObj_ = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const taipeiYmd_ = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const dayDiff_ = (a, b) => (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000; // YYYY-MM-DD 相差天數
const ageDays_ = (iso, now) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 86400000;
};
const fmtDays_ = (n) => (Math.round(n * 10) / 10) + " 天";

// 一份備份資料夾裡，manifest 列出、雲端應該有的檔案：[{path, bytes}]（path 是相對於那個資料夾的路徑）
function filesOf_(manifest, kind) {
  const out = [];
  if (!isObj_(manifest)) return out;
  if (kind === "bundle") {
    for (const r of Object.values(manifest.repos || {})) {
      if (r && r.bundle && r.bundle.file) out.push({ path: r.bundle.file, bytes: r.bundle.bytes });
    }
    return out;
  }
  for (const r of Object.values(manifest.repos || {})) {
    if (r && r.archive && r.archive.file) out.push({ path: r.archive.file, bytes: r.archive.bytes });
  }
  for (const f of Object.values(manifest.folders || {})) {
    if (f && f.zip && f.zip.file) out.push({ path: f.zip.file, bytes: f.zip.bytes });
  }
  for (const c of manifest.csv || []) {
    if (c && c.ok && c.file) out.push({ path: c.file, bytes: c.bytes });
  }
  return out;
}

// listing：{路徑: 位元組數}（雲端實際有的）；null＝資料夾不存在。回問題說明陣列（空＝都在、大小一致）
function missingFiles_(manifest, kind, listing) {
  const bad = [];
  if (listing === null || listing === undefined) return ["雲端找不到這份備份的資料夾"];
  if (!isObj_(manifest)) return ["資料夾裡沒有可讀的 manifest.json"];
  if (!("manifest.json" in listing)) bad.push("缺 manifest.json");
  for (const f of filesOf_(manifest, kind)) {
    if (!(f.path in listing)) bad.push(`缺 ${f.path}`);
    else if (listing[f.path] !== f.bytes) bad.push(`${f.path} 大小不符（雲端 ${listing[f.path]}、manifest ${f.bytes}）`);
  }
  return bad;
}

const short_ = (arr, n = 4) => arr.slice(0, n).join("、") + (arr.length > n ? `…等 ${arr.length} 項` : "");

// 檢查全部項目，回問題清單 [{code, detail}]。
// state＝最近備份.json（物件或 null）；latestManifest＝last_ok_folder 的 manifest.json；bundleManifest＝last_bundle_folder 的 manifest.json；
// listing＝{rootCount, daily, bundle}（rootCount＝找到幾個符合的備份根目錄；daily、bundle＝{相對路徑: 大小} 或 null）；
// sharing＝[{path, access, others}]；quota＝{used, limit} 或 null；now＝Date；w＝門檻（預設 W）
function evaluate_(state, latestManifest, bundleManifest, listing, sharing, quota, now, w) {
  w = w || W;
  const out = [];
  const add = (code, detail) => out.push({ code, detail });
  const rootCount = listing ? listing.rootCount : 0;
  if (rootCount !== 1) {
    add("NO_FOLDER", rootCount === 0
      ? `雲端硬碟裡找不到「${w.FOLDER_NAME}」資料夾（要是自己擁有、而且裡面有「${w.MARKER}」）`
      : `找到 ${rootCount} 個符合的「${w.FOLDER_NAME}」資料夾，不知道哪個才是備份`);
    return out;
  }
  if (!isObj_(state)) {
    add("NO_STATE", "「最近備份.json」不存在或讀不懂");
  } else {
    // STALE_OK
    if (!state.last_ok) {
      add("STALE_OK", `還沒有任何一次完全成功（OK）的備份（最近一次嘗試：${state.last_attempt || "不明"}，結果 ${state.last_attempt_status || "不明"}）`);
    } else {
      const age = ageDays_(state.last_ok, now);
      if (age === null) add("STALE_OK", `last_ok「${state.last_ok}」看不懂`);
      else if (age > w.MAX_OK_AGE_DAYS) {
        add("STALE_OK", `最近一次完全成功是 ${state.last_ok}，已 ${fmtDays_(age)}；最近一次嘗試 ${state.last_attempt || "不明"}，結果 ${state.last_attempt_status || "不明"}`);
      }
      // NOT_UPLOADED：只有雲端那一側能證明「真的上傳了」
      const folder = state.last_ok_folder;
      if (!folder || !DATE_NAME.test(folder)) {
        add("NOT_UPLOADED", `最近備份.json 的 last_ok_folder「${folder || ""}」不是日期資料夾名稱`);
      } else {
        const bad = missingFiles_(latestManifest, "daily", listing.daily);
        if (listing.dailyDup > 1) bad.unshift(`有 ${listing.dailyDup} 個同名的日期資料夾（只讀最近更新的那個，請刪掉多的）`);
        if (bad.length) add("NOT_UPLOADED", `每日\\${folder}：${short_(bad)}`);
      }
    }
    // OLD_BUNDLE
    const bf = state.last_bundle_folder;
    if (!bf || !DATE_NAME.test(bf)) {
      add("OLD_BUNDLE", "還沒有任何一份完整歷史（bundle）");
    } else {
      const parts = [];
      const age = dayDiff_(taipeiYmd_(now), bf);
      if (age > w.MAX_BUNDLE_AGE_DAYS) parts.push(`最新一份是 ${bf}，已 ${age} 天（Python 腳本每 7 天做一次）`);
      const bad = missingFiles_(bundleManifest, "bundle", listing.bundle);
      if (listing.bundleDup > 1) bad.unshift(`有 ${listing.bundleDup} 個同名的日期資料夾（只讀最近更新的那個，請刪掉多的）`);
      if (bad.length) parts.push(`完整歷史\\${bf}：${short_(bad)}`);
      if (parts.length) add("OLD_BUNDLE", parts.join("；"));
    }
    // MARKET_STALE：看的是「最近一次 OK」那份的 manifest；已經 STALE_OK 時那份本來就舊，不重複報（只會多一個假警報）
    const md = !out.some((i) => i.code === "STALE_OK") && isObj_(latestManifest) && isObj_(latestManifest.repos) ? latestManifest.repos["market-data"] : null;
    if (md && md.commit_time) {
      const age = ageDays_(md.commit_time, now);
      if (age !== null && age > w.MARKET_STALE_DAYS) {
        add("MARKET_STALE", `market-data 最後一個 commit 是 ${md.commit_time}，已 ${fmtDays_(age)}`);
      }
    }
  }
  // SHARED：整棵樹（根目錄、每個每日／完整歷史資料夾、紀錄、狀態檔、所有檔案）
  const shared = (sharing || []).filter((s) => s.access !== "PRIVATE" || (s.others && s.others.length));
  if (shared.length) {
    add("SHARED", short_(shared.map((s) => `${s.path}（${s.access !== "PRIVATE" ? "分享設定 " + s.access : "有其他人可存取"}）`)));
  }
  // QUOTA
  if (quota && quota.limit > 0 && quota.used / quota.limit > w.QUOTA_WARN) {
    add("QUOTA", `雲端硬碟已用 ${Math.round(quota.used / quota.limit * 100)}%（門檻 ${Math.round(w.QUOTA_WARN * 100)}%）`);
  }
  return out;
}

// 決定這次寄不寄：同一個問題最多每 REMIND_EVERY_DAYS 天（台北日期）寄一次；之前有問題、這次全部正常寄「恢復正常」。
// remind＝{代號: 上次寄送的 ISO 時間}；回 {send: [要寄的問題], recovered: bool, remind: 新的紀錄}
function plan_(issues, remind, now, w) {
  w = w || W;
  remind = remind || {};
  const today = taipeiYmd_(now);
  const send = [];
  // 只有 EXCEPTION（看門狗自己讀不到雲端）時，不能當成「其他問題消失了」：保留原本的提醒紀錄、不算恢復正常
  const onlyException = issues.length > 0 && issues.every((i) => i.code === "EXCEPTION");
  const next = onlyException ? Object.assign({}, remind) : {};
  for (const it of issues) {
    const last = remind[it.code];
    const due = !last || Number.isNaN(Date.parse(last)) || dayDiff_(today, taipeiYmd_(new Date(last))) >= w.REMIND_EVERY_DAYS;
    if (due) {
      send.push(it);
      next[it.code] = now.toISOString();
    } else {
      next[it.code] = last;
    }
  }
  return { send, recovered: issues.length === 0 && Object.keys(remind).length > 0, remind: next };
}

const INFO = {
  NO_FOLDER: ["找不到備份資料夾", "雲端硬碟電腦版還沒建立資料夾、資料夾被刪或改名、被移到別人的雲端硬碟、或有多個同名資料夾",
    "到 Google 雲端硬碟看「stock-dashboard 備份」資料夾還在不在、裡面有沒有「備份根目錄-請勿刪除.txt」"],
  NO_STATE: ["讀不到最近備份.json", "備份從來沒成功寫進雲端、檔案被刪、或內容壞掉",
    "到備份資料夾看有沒有「最近備份.json」；開電腦看工作排程器 StockDashboardBackup（Get-ScheduledTaskInfo StockDashboardBackup）"],
  STALE_OK: ["太久沒有成功的備份", "電腦沒開、排程被停用、雲端硬碟電腦版沒登入或暫停同步，或這幾天備份都不是 OK（GitHub 連不上、CSV 失敗）",
    "開電腦後執行 Get-ScheduledTaskInfo StockDashboardBackup 看 LastRunTime 與 LastTaskResult；看雲端硬碟電腦版的同步狀態；開「最近備份.json」看 problems（還原說明第 11 項）"],
  NOT_UPLOADED: ["最近一次 OK 的備份在雲端不完整", "雲端硬碟電腦版還沒上傳完、同步被暫停、容量不足、或檔案被刪",
    "看雲端硬碟電腦版右下角的同步狀態；到每日資料夾比對缺的檔案；必要時手動跑一次備份"],
  OLD_BUNDLE: ["完整歷史（bundle）太舊或缺檔", "有 repo 連續 fetch 失敗所以延後、備份停了，或 bundle 檔沒上傳完整",
    "看最近備份.json 的 last_bundle_folder；用 py -3.14 tools\\backup_to_drive.py --force-bundle 手動補一次"],
  MARKET_STALE: ["market-data 太久沒有新資料", "market-data 的 GitHub Actions 或 cron-job.org 停了（或遇到長假）",
    "看 market-data 的 Actions 執行紀錄與 cron-job.org 的工作狀態（這項跟備份本身無關）"],
  SHARED: ["備份被分享出去了", "有人（或有連結）可以存取備份資料夾；裡面有信託持股與排程提示詞，不可分享",
    "到雲端硬碟對該資料夾或檔案按右鍵 → 共用，改回「限制」並移除其他人；想一想是誰分享的"],
  QUOTA: ["雲端硬碟快滿了", "備份累積加上其他檔案接近容量上限，滿了之後備份會寫入失敗",
    "清理雲端硬碟，或調整備份保留份數（tools\\backup_to_drive.py 的 KEEP_DAILY 等，要先問過）"],
  EXCEPTION: ["看門狗自己出錯了", "Apps Script 權限被撤銷、服務暫時故障、或程式有 bug",
    "到 script.google.com 開這個專案，看「執行項目」的錯誤訊息；必要時重新授權"],
  TEST: ["測試信", "這是 testMail() 發的測試信，表示寄信功能正常", "不用處理"],
};

function mailBody_(issues, recovered) {
  if (recovered) return "備份看門狗之前回報的問題，這次檢查全部都正常了。";
  const lines = ["備份看門狗發現下列問題（沒有信＝一切正常）：", ""];
  for (const it of issues) {
    const [title, cause, check] = INFO[it.code] || [it.code, "", ""];
    lines.push(`■ ${it.code}：${title}`, `  發生什麼事：${it.detail}`);
    if (cause) lines.push(`  可能原因：${cause}`);
    if (check) lines.push(`  要檢查：${check}`);
    lines.push("");
  }
  lines.push("同一個問題最多每 " + W.REMIND_EVERY_DAYS + " 天寄一次；全部恢復正常會再寄一封。說明見 repo 的 docs/BACKUP.md 第 13 節、docs/RESTORE.md 第 11 點。");
  return lines.join("\n");
}

function mailSubject_(issues, recovered) {
  if (recovered) return "【備份看門狗】恢復正常";
  if (issues.length === 1 && issues[0].code === "EXCEPTION") return "【備份看門狗】執行錯誤";
  return "【備份看門狗】" + issues.map((i) => i.code).join("、");
}

// ---------- 讀雲端硬碟（包起來，不放判斷）----------

// 垃圾桶裡的項目一律當作不存在；同名的多個項目取最近更新的那個
function alive_(it) {
  const out = [];
  while (it.hasNext()) {
    const x = it.next();
    if (!x.isTrashed()) out.push(x);
  }
  return out;
}

function newest_(arr) {
  let best = null;
  for (const x of arr) {
    if (!best || x.getLastUpdated().getTime() > best.getLastUpdated().getTime()) best = x;
  }
  return best;
}

function readJson_(folder, name) {
  const f = newest_(alive_(folder.getFilesByName(name)));
  if (!f) return null;
  try {
    const v = JSON.parse(f.getBlob().getDataAsString("UTF-8"));
    return isObj_(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function children_(folder, name) {
  return alive_(folder.getFoldersByName(name));
}

function child_(folder, name) {
  return newest_(children_(folder, name));
}

// 資料夾底下所有檔案：{相對路徑: 大小}（最多往下 3 層）；同名檔案取最近更新的那個
function listFiles_(folder, prefix, out, depth, times) {
  times = times || {};
  for (const f of alive_(folder.getFiles())) {
    const key = prefix + f.getName();
    const t = f.getLastUpdated().getTime();
    if (!(key in out) || t > times[key]) {
      out[key] = f.getSize();
      times[key] = t;
    }
  }
  if (depth < 3) {
    for (const s of alive_(folder.getFolders())) listFiles_(s, prefix + s.getName() + "/", out, depth + 1, times);
  }
  return out;
}

function emails_(users, me) {
  const out = [];
  for (const u of users) {
    const e = u.getEmail();
    if (e && e !== me) out.push(e);
  }
  return out;
}

function sharingOf_(node, path, me) {
  return {
    path,
    access: String(node.getSharingAccess()),
    others: emails_(node.getEditors(), me).concat(emails_(node.getViewers(), me)),
  };
}

// 整棵樹的分享設定（資料夾與檔案，不含垃圾桶）：每個項目一筆 {path, access, others}
function sharingTree_(folder, path, me, out) {
  out.push(sharingOf_(folder, path, me));
  for (const f of alive_(folder.getFiles())) out.push(sharingOf_(f, path + "\\" + f.getName(), me));
  for (const s of alive_(folder.getFolders())) sharingTree_(s, path + "\\" + s.getName(), me, out);
}

function collect_() {
  const me = Session.getEffectiveUser().getEmail();
  const roots = [];
  const it = DriveApp.getFoldersByName(W.FOLDER_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    const owner = f.getOwner();
    if (!owner || owner.getEmail() !== me) continue;
    if (alive_(f.getFilesByName(W.MARKER)).length) roots.push(f);
  }
  const data = { state: null, latest: null, bundle: null, listing: { rootCount: roots.length, daily: null, bundle: null, dailyDup: 0, bundleDup: 0 }, sharing: [], quota: null };
  if (roots.length !== 1) return data;
  const root = roots[0];
  const state = readJson_(root, "最近備份.json");
  data.state = state;
  sharingTree_(root, "（根目錄）", me, data.sharing);
  const pick = (sub, name, kind) => {
    if (!name || !DATE_NAME.test(name)) return;
    const parent = child_(root, sub);
    const dirs = parent ? children_(parent, name) : [];
    if (!dirs.length) return;
    const dir = newest_(dirs);
    const which = kind === "latest" ? "daily" : "bundle";
    data[kind] = readJson_(dir, "manifest.json");
    data.listing[which] = listFiles_(dir, "", {}, 0);
    data.listing[which + "Dup"] = dirs.length;
  };
  if (state) {
    pick("每日", state.last_ok_folder, "latest");
    pick("完整歷史", state.last_bundle_folder, "bundle");
  }
  try {
    data.quota = { used: DriveApp.getStorageUsed(), limit: DriveApp.getStorageLimit() };
  } catch (e) {
    data.quota = null;
  }
  return data;
}

// ---------- 入口 ----------

function sendMail_(issues, recovered, prefix) {
  const to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, (prefix || "") + mailSubject_(issues, recovered), mailBody_(issues, recovered));
}

function run_(opts) {
  const now = new Date();
  const w = opts.w || W;
  let issues;
  try {
    const t0 = Date.now();
    const d = collect_();
    Logger.log(`讀雲端硬碟共 ${Math.round((Date.now() - t0) / 100) / 10} 秒，檢查了 ${d.sharing.length} 個項目的分享設定`);
    Logger.log(d.quota ? `雲端硬碟用量 ${d.quota.used}／${d.quota.limit} 位元組（${d.quota.limit > 0 ? Math.round(d.quota.used / d.quota.limit * 1000) / 10 + "%" : "上限不明"}）` : "讀不到雲端硬碟用量");
    issues = evaluate_(d.state, d.latest, d.bundle, d.listing, d.sharing, d.quota, now, w);
  } catch (e) {
    issues = [{ code: "EXCEPTION", detail: String((e && e.message) || e) }];
  }
  if (opts.test && !issues.length) issues = [{ code: "TEST", detail: "測試信（目前檢查沒有問題）" }];
  const props = PropertiesService.getScriptProperties();
  let remind = {};
  if (!opts.test) {
    try {
      remind = JSON.parse(props.getProperty(REMIND_PROP) || "{}");
    } catch (e) {
      remind = {};
    }
  }
  const plan = plan_(issues, remind, now, w);
  Logger.log("檢查結果：" + (issues.length ? issues.map((i) => i.code + "：" + i.detail).join("\n") : "全部正常"));
  Logger.log(opts.send ? `要寄信：${plan.send.map((i) => i.code).join("、") || "（沒有）"}${plan.recovered ? "（恢復正常）" : ""}` : "dryRun：不寄信");
  if (opts.send) {
    if (plan.send.length) sendMail_(plan.send, false, opts.test ? "【測試】" : "");
    else if (plan.recovered) sendMail_([], true);
    if (!opts.test) props.setProperty(REMIND_PROP, JSON.stringify(plan.remind));
  }
  return issues;
}

function dailyCheck() {
  run_({ send: true });
}

function dryRun() {
  return run_({ send: false });
}

function testMail() {
  const w = Object.assign({}, W, { MAX_OK_AGE_DAYS: 0, MAX_BUNDLE_AGE_DAYS: 0, MARKET_STALE_DAYS: 0, QUOTA_WARN: 0, REMIND_EVERY_DAYS: 0 });
  return run_({ send: true, test: true, w });
}

function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === "dailyCheck") ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger("dailyCheck").timeBased().everyDays(1).atHour(9).inTimezone(TZ).create();
  Logger.log("已建立每天 9 點（台北）的 dailyCheck 觸發器（Apps Script 會落在 9～10 點之間）");
}

// ---------- 自我測試用的假資料 ----------
// 下面三份是 Python 腳本（tools/backup_to_drive.py）用假根目錄真的寫出的檔案（2026-11-21）：JSON 字面值，
// tests/test_backup_to_drive.py 會拿 Python 實際輸出的欄位對照，欄位不一致測試就會失敗。改欄位時兩邊一起改。
const SAMPLE_STATE = /*JSON:state*/ {"schema":1,"last_attempt":"2026-11-21T13:38:42+08:00","last_attempt_status":"OK","warnings":["market-data 已 5 天沒有新 commit"],"problems":[],"script_commit":"96b604926bd9fe7ac34dd77f73436787c0a5d39a","last_bundle_folder":"2026-11-21","repos":{"stock-dashboard":{"last_fetch_ok_at":"2026-11-21T13:38:43+08:00","commit":"96b604926bd9fe7ac34dd77f73436787c0a5d39a"},"market-data":{"last_fetch_ok_at":"2026-11-21T13:38:46+08:00","commit":"3d4fdbd9d149f15b74f8193f7f4772088087a847"},"market-data-private":{"last_fetch_ok_at":"2026-11-21T13:38:48+08:00","commit":"403743858536bad6f65e6ab558dc192a18ac12b4"}},"last_ok":"2026-11-21T13:39:02+08:00","last_ok_folder":"2026-11-21"} /*END*/;
const SAMPLE_MANIFEST = /*JSON:manifest*/ {"schema":1,"started":"2026-11-21T13:38:42+08:00","finished":"2026-11-21T13:39:02+08:00","status":"OK","script_commit":"96b604926bd9fe7ac34dd77f73436787c0a5d39a","repos":{"stock-dashboard":{"fetch_ok":true,"fetch_error":null,"last_fetch_ok_at":"2026-11-21T13:38:43+08:00","commit":"96b604926bd9fe7ac34dd77f73436787c0a5d39a","commit_time":"2026-11-21T03:03:33+08:00","local_main_behind":0,"non_fast_forward":false,"unpushed_local_branches":[{"branch":"claude/example","ahead":1}],"dirty_worktrees":1,"archive":{"file":"stock-dashboard.zip","bytes":786382,"sha256":"e94e5dbaebea87dfaee660015ba3f23b4c07b71d9fb1113bf3bf7caa3b3465f5"}},"market-data":{"fetch_ok":true,"fetch_error":null,"last_fetch_ok_at":"2026-11-21T13:38:46+08:00","commit":"3d4fdbd9d149f15b74f8193f7f4772088087a847","commit_time":"2026-11-20T22:23:58Z","local_main_behind":18,"non_fast_forward":false,"unpushed_local_branches":[],"dirty_worktrees":0,"archive":{"file":"market-data.zip","bytes":2023344,"sha256":"b5a57204fb56c60c40de5bae90d58673e13f4a644d4bc81dc42e4335c3f29565"}},"market-data-private":{"fetch_ok":true,"fetch_error":null,"last_fetch_ok_at":"2026-11-21T13:38:48+08:00","commit":"403743858536bad6f65e6ab558dc192a18ac12b4","commit_time":"2026-11-20T21:28:00Z","local_main_behind":20,"non_fast_forward":false,"unpushed_local_branches":[],"dirty_worktrees":0,"archive":{"file":"market-data-private.zip","bytes":23932,"sha256":"6f92f8105c9d5efea8ed56c739d0696851733dcc37ef7bd4e3a428df2cbca852"}}},"folders":{"private":{"path":"C:\\stock-dashboard\\private","files":157,"bytes":4000006,"zip":{"file":"private.zip","bytes":1671804,"sha256":"68851f8bc707b52f506e52b47ec212665715ef1332af798efc04a4a6041c3b69"}},"claude-memory":{"path":"C:\\Users\\user\\.claude\\projects\\C--stock-dashboard\\memory","files":11,"bytes":28960,"zip":{"file":"claude-memory.zip","bytes":20008,"sha256":"00058d5129528a5ffbce8d153687b47c85f2ab6ac65e0fc1b000408d08c00f88"}}},"csv":[{"name":"ledger","gid":0,"ok":true,"http":200,"bytes":1624,"sha256":"066f85033243bc992c17d092b4003c85fe6298c6a52b026b24a417152057a3aa","error":null,"file":"csv/ledger-gid0.csv"},{"name":"ledger","gid":1,"ok":true,"http":200,"bytes":3228,"sha256":"c2abab11c89695af4a4095f646a9d690f796d8fea42c98515a8e3004c23a3a63","error":null,"file":"csv/ledger-gid1.csv"},{"name":"ledger","gid":2,"ok":true,"http":200,"bytes":792,"sha256":"2ffd7a99f2ff6d9c3fa59065819e0fc8867779b08d2379edd1e64fe281fdb235","error":null,"file":"csv/ledger-gid2.csv"},{"name":"ledger","gid":10,"ok":true,"http":200,"bytes":200,"sha256":"f94316f44d255e1f24de9aa0409d1d613cc691b929551a88555bb4dd534e7afa","error":null,"file":"csv/ledger-gid10.csv"},{"name":"ledger","gid":11,"ok":true,"http":200,"bytes":623,"sha256":"73465b7dbd5d6319b116024daec1af96df510f6d60b5224146498db7752311f7","error":null,"file":"csv/ledger-gid11.csv"},{"name":"dashboard","gid":0,"ok":true,"http":200,"bytes":235151,"sha256":"caab8e906834d99521b1fc76b025b0cec7edf472e274fe7db461182de902a8c5","error":null,"file":"csv/dashboard-gid0.csv"},{"name":"dashboard","gid":5,"ok":true,"http":200,"bytes":304424,"sha256":"5cf47bb30d4656f4b29d84596696694b41dc57e69065353ed66f6bec710b108d","error":null,"file":"csv/dashboard-gid5.csv"}],"warnings":["market-data 已 5 天沒有新 commit"],"problems":[]} /*END*/;
const SAMPLE_BUNDLE = /*JSON:bundle*/ {"schema":1,"started":"2026-11-21T13:38:42+08:00","finished":"2026-11-21T13:39:02+08:00","status":"OK","date":"2026-11-21","repos":{"stock-dashboard":{"bundle":{"file":"stock-dashboard.bundle","bytes":1215989,"sha256":"58797e3ea33638f4b84c449a68ce659219d8c8f35a9f39cfae5865c1ca0fe51e","commit":"96b604926bd9fe7ac34dd77f73436787c0a5d39a","local_branches":["local/archive/design-preview-2026-11-10","local/claude/fervent-merkle-1607ac","local/claude/funds-fire-30y-122524","local/main"]},"fetch_ok":true},"market-data":{"bundle":{"file":"market-data.bundle","bytes":17464095,"sha256":"6783350d212cba006f5795360bc7188f336e8ed8f058480fee235f1184a225e7","commit":"3d4fdbd9d149f15b74f8193f7f4772088087a847","local_branches":[]},"fetch_ok":true},"market-data-private":{"bundle":{"file":"market-data-private.bundle","bytes":69495,"sha256":"4d8993df62fa9b5f1d6f584e504c9515e4217c6d18258ab7a573ec45b70cfdf6","commit":"403743858536bad6f65e6ab558dc192a18ac12b4","local_branches":[]},"fetch_ok":true}}} /*END*/;

function selfTest() {
  const NOW = new Date("2026-11-22T09:10:00+08:00"); // 假的「現在」：last_ok 之後 0.8 天
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const listingOf = (m, kind) => {
    const o = { "manifest.json": 100 };
    for (const f of filesOf_(m, kind)) o[f.path] = f.bytes;
    return o;
  };
  const base = () => ({
    state: clone(SAMPLE_STATE), latest: clone(SAMPLE_MANIFEST), bundle: clone(SAMPLE_BUNDLE),
    listing: { rootCount: 1, daily: listingOf(SAMPLE_MANIFEST, "daily"), bundle: listingOf(SAMPLE_BUNDLE, "bundle") },
    sharing: [{ path: "（根目錄）", access: "PRIVATE", others: [] }, { path: "每日\\2026-11-21", access: "PRIVATE", others: [] }],
    quota: { used: 1, limit: 100 },
  });
  const check = (d, now) => evaluate_(d.state, d.latest, d.bundle, d.listing, d.sharing, d.quota, now || NOW);
  const codes = (issues) => issues.map((i) => i.code).join(",");
  const at = (iso, days) => new Date(Date.parse(iso) + days * 86400000);
  let passed = 0, total = 0;
  const failures = [];
  const t = (name, actual, expected) => {
    total++;
    if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
    else failures.push(`${name}：預期 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
  };
  const okAt = Date.parse(SAMPLE_STATE.last_ok);
  const nowPlus = (days) => new Date(okAt + days * 86400000);

  // 全部正常
  t("全部正常", codes(check(base())), "");
  t("假資料有 13 個檔（5 zip、1 manifest、7 CSV）", Object.keys(listingOf(SAMPLE_MANIFEST, "daily")).length, 1 + 5 + 7);
  // NO_FOLDER
  let d = base(); d.listing.rootCount = 0;
  t("NO_FOLDER 零個", codes(check(d)), "NO_FOLDER");
  d = base(); d.listing.rootCount = 2;
  t("NO_FOLDER 兩個", codes(check(d)), "NO_FOLDER");
  // NO_STATE
  d = base(); d.state = null;
  t("NO_STATE", codes(check(d)), "NO_STATE");
  // STALE_OK 與邊界
  t("STALE_OK 剛好 3 天不算", codes(check(base(), nowPlus(3))), "");
  t("STALE_OK 超過 3 天一分鐘", codes(check(base(), nowPlus(3 + 1 / 1440))), "STALE_OK");
  d = base(); d.state.last_ok = null; d.state.last_ok_folder = null;
  t("STALE_OK 從來沒有 OK", codes(check(d)), "STALE_OK");
  d = base(); d.state.last_ok = "亂寫的";
  t("STALE_OK 時間看不懂", codes(check(d)), "STALE_OK");
  // NOT_UPLOADED
  d = base(); d.listing.daily = null;
  t("NOT_UPLOADED 資料夾不存在", codes(check(d)), "NOT_UPLOADED");
  d = base(); d.latest = null;
  t("NOT_UPLOADED 沒有 manifest", codes(check(d)), "NOT_UPLOADED");
  d = base(); delete d.listing.daily["market-data.zip"];
  t("NOT_UPLOADED 缺 zip", codes(check(d)), "NOT_UPLOADED");
  d = base(); d.listing.daily["private.zip"] += 1;
  t("NOT_UPLOADED 大小不同", codes(check(d)), "NOT_UPLOADED");
  d = base(); delete d.listing.daily["csv/ledger-gid0.csv"];
  t("NOT_UPLOADED 缺 CSV", codes(check(d)), "NOT_UPLOADED");
  d = base(); delete d.listing.daily["manifest.json"];
  t("NOT_UPLOADED 缺 manifest.json", codes(check(d)), "NOT_UPLOADED");
  d = base(); d.state.last_ok_folder = null;
  t("NOT_UPLOADED 狀態檔沒有 last_ok_folder", codes(check(d)), "NOT_UPLOADED");
  d = base(); d.state.last_ok_folder = "../2026-11-21";
  t("NOT_UPLOADED 資料夾名稱不是日期", codes(check(d)), "NOT_UPLOADED");
  d = base(); d.latest.csv[0].ok = false; delete d.listing.daily["csv/ledger-gid0.csv"];
  t("CSV 當天就失敗（ok=false）的不算缺檔", codes(check(d)), "");
  // OLD_BUNDLE 與邊界
  const has = (issues, c) => issues.some((i) => i.code === c);
  t("OLD_BUNDLE 剛好 10 天不算", has(check(base(), new Date("2026-12-01T12:00:00+08:00")), "OLD_BUNDLE"), false);
  t("OLD_BUNDLE 超過 10 天", has(check(base(), new Date("2026-12-02T12:00:00+08:00")), "OLD_BUNDLE"), true);
  d = base(); d.state.last_bundle_folder = null;
  t("OLD_BUNDLE 沒有任何一份", codes(check(d)), "OLD_BUNDLE");
  d = base(); d.listing.bundle = null;
  t("OLD_BUNDLE 資料夾不存在", codes(check(d)), "OLD_BUNDLE");
  d = base(); delete d.listing.bundle["market-data.bundle"];
  t("OLD_BUNDLE 缺 bundle", codes(check(d)), "OLD_BUNDLE");
  d = base(); d.listing.bundle["stock-dashboard.bundle"] -= 1;
  t("OLD_BUNDLE 大小不同", codes(check(d)), "OLD_BUNDLE");
  d = base(); d.bundle = null;
  t("OLD_BUNDLE 沒有 manifest", codes(check(d)), "OLD_BUNDLE");
  // MARKET_STALE 與邊界
  const mdTime = Date.parse(SAMPLE_MANIFEST.repos["market-data"].commit_time);
  const marketCount = (dd, now) => evaluate_(dd.state, dd.latest, dd.bundle, dd.listing, dd.sharing, dd.quota, now).filter((i) => i.code === "MARKET_STALE").length;
  const freshOk = (dd, now) => { dd.state.last_ok = new Date(now.getTime() - 3600000).toISOString(); };
  let nowM = new Date(mdTime + 4 * 86400000);
  d = base(); freshOk(d, nowM);
  t("MARKET_STALE 剛好 4 天不算", marketCount(d, nowM), 0);
  nowM = new Date(mdTime + 4 * 86400000 + 3600000);
  d = base(); freshOk(d, nowM);
  t("MARKET_STALE 超過 4 天一小時", marketCount(d, nowM), 1);
  d = base(); d.latest.repos["market-data"].commit_time = null;
  t("MARKET_STALE 沒有 commit_time 就跳過", codes(check(d)), "");
  // MARKET_STALE 不跟 STALE_OK／NO_STATE 一起報（那份 manifest 本來就舊）
  d = base();
  t("W5 同時 STALE_OK 時不報 MARKET_STALE", [marketCount(d, nowM), has(evaluate_(d.state, d.latest, d.bundle, d.listing, d.sharing, d.quota, nowM), "STALE_OK")], [0, true]);
  d = base(); d.state = null;
  t("W5 NO_STATE 時不報 MARKET_STALE", codes(evaluate_(d.state, d.latest, d.bundle, d.listing, d.sharing, d.quota, nowM)), "NO_STATE");
  // 同名日期資料夾（垃圾桶以外還有兩個以上）
  d = base(); d.listing.dailyDup = 2;
  t("W2 每日有 2 個同名資料夾", [codes(check(d)), check(d)[0].detail.includes("2 個同名")], ["NOT_UPLOADED", true]);
  d = base(); d.listing.bundleDup = 3;
  t("W2 完整歷史有 3 個同名資料夾", [codes(check(d)), check(d)[0].detail.includes("3 個同名")], ["OLD_BUNDLE", true]);
  d = base(); d.listing.dailyDup = 1; d.listing.bundleDup = 1;
  t("W2 各一個不算", codes(check(d)), "");
  // SHARED
  d = base(); d.sharing[1].access = "ANYONE_WITH_LINK";
  t("SHARED 知道連結的人", codes(check(d)), "SHARED");
  d = base(); d.sharing[0].others = ["其他使用者"];
  t("SHARED 有其他人", codes(check(d)), "SHARED");
  d = base(); d.sharing[0].others = [];
  t("SHARED 只有自己不算", codes(check(d)), "");
  // QUOTA 與邊界
  d = base(); d.quota = { used: 80, limit: 100 };
  t("QUOTA 剛好 80% 不算", codes(check(d)), "");
  d = base(); d.quota = { used: 81, limit: 100 };
  t("QUOTA 81%", codes(check(d)), "QUOTA");
  d = base(); d.quota = { used: 99, limit: 0 };
  t("QUOTA 上限 0 跳過", codes(check(d)), "");
  d = base(); d.quota = null;
  t("QUOTA 讀不到跳過", codes(check(d)), "");
  // 多個問題同時
  d = base(); d.sharing[0].access = "DOMAIN"; d.quota = { used: 90, limit: 100 }; delete d.listing.daily["private.zip"];
  t("多個問題", codes(check(d)), "NOT_UPLOADED,SHARED,QUOTA");
  // plan_：提醒間隔與恢復正常
  const iss = [{ code: "STALE_OK", detail: "x" }];
  const day0 = new Date("2026-11-22T09:10:00+08:00");
  let p = plan_(iss, {}, day0);
  t("plan 第一次要寄", p.send.length, 1);
  t("plan 第一次記下時間", Object.keys(p.remind), ["STALE_OK"]);
  const r0 = p.remind;
  t("plan 隔 1 天不寄", plan_(iss, r0, at("2026-11-22T09:10:00+08:00", 1)).send.length, 0);
  t("plan 隔 2 天不寄", plan_(iss, r0, at("2026-11-22T09:10:00+08:00", 2)).send.length, 0);
  t("plan 隔 3 天（台北日期）要寄，即使時間早一點", plan_(iss, r0, at("2026-11-22T09:00:00+08:00", 3)).send.length, 1);
  p = plan_(iss, r0, at("2026-11-22T09:10:00+08:00", 1));
  t("plan 不寄時保留上次寄送時間", p.remind.STALE_OK, r0.STALE_OK);
  p = plan_([], r0, day0);
  t("plan 恢復正常要寄", p.recovered, true);
  t("plan 恢復正常後清掉紀錄", p.remind, {});
  t("plan 本來就正常不寄", plan_([], {}, day0).recovered, false);
  p = plan_([{ code: "SHARED", detail: "y" }], r0, at("2026-11-22T09:10:00+08:00", 1));
  t("plan 新問題要寄、舊問題移除", [p.send.map((i) => i.code), Object.keys(p.remind), p.recovered], [["SHARED"], ["SHARED"], false]);
  t("plan REMIND_EVERY_DAYS=0 每次都寄", plan_(iss, r0, day0, Object.assign({}, W, { REMIND_EVERY_DAYS: 0 })).send.length, 1);
  // 看門狗自己出錯（EXCEPTION）不能洗掉原本的提醒紀錄，也不算恢復正常（5 天：STALE_OK 只在第 0、3 天寄）
  const EXC = [{ code: "EXCEPTION", detail: "讀不到雲端" }];
  const mailedOn = {};
  let rem = {};
  const seq = [["STALE_OK"], ["EXCEPTION"], ["STALE_OK"], ["STALE_OK"], ["STALE_OK"]];
  seq.forEach((codesToday, i) => {
    const q = plan_(codesToday.map((c) => ({ code: c, detail: "x" })), rem, at("2026-11-22T09:10:00+08:00", i));
    mailedOn[i] = q.send.map((x) => x.code).join(",");
    rem = q.remind;
    if (i === 1) t("W4 例外那天不算恢復正常", q.recovered, false);
  });
  t("W4 五天的寄信紀錄（STALE_OK 只在第 0、3 天；EXCEPTION 第 1 天）", mailedOn, { 0: "STALE_OK", 1: "EXCEPTION", 2: "", 3: "STALE_OK", 4: "" });
  p = plan_(EXC, r0, at("2026-11-22T09:10:00+08:00", 1));
  t("W4 只有例外時保留原本紀錄並加上 EXCEPTION", Object.keys(p.remind).sort(), ["EXCEPTION", "STALE_OK"]);
  t("W4 例外保留的 STALE_OK 時間不變", p.remind.STALE_OK, r0.STALE_OK);
  p = plan_([], p.remind, at("2026-11-22T09:10:00+08:00", 2));
  t("W4 例外之後真的恢復正常要寄恢復信並清掉紀錄", [p.recovered, p.remind], [true, {}]);
  p = plan_([{ code: "EXCEPTION", detail: "x" }, { code: "SHARED", detail: "y" }], r0, at("2026-11-22T09:10:00+08:00", 1));
  t("W4 例外加上別的問題時照原本方式（只留現在有的）", Object.keys(p.remind).sort(), ["EXCEPTION", "SHARED"]);
  // 信件內容
  const body =mailBody_([{ code: "SHARED", detail: "每日\\2026-11-21" }], false);
  t("信件有代號、說明與要檢查的事", [body.includes("SHARED"), body.includes("可能原因"), body.includes("要檢查")], [true, true, true]);
  t("信件主旨", mailSubject_([{ code: "STALE_OK" }, { code: "SHARED" }], false), "【備份看門狗】STALE_OK、SHARED");
  t("例外主旨", mailSubject_([{ code: "EXCEPTION" }], false), "【備份看門狗】執行錯誤");
  t("恢復主旨", mailSubject_([], true), "【備份看門狗】恢復正常");
  t("每個問題代號都有說明", ["NO_FOLDER", "NO_STATE", "STALE_OK", "NOT_UPLOADED", "OLD_BUNDLE", "MARKET_STALE", "SHARED", "QUOTA", "EXCEPTION", "TEST"].every((c) => INFO[c]), true);
  // 日期工具
  t("台北日期（UTC 16:30 已是隔天）", taipeiYmd_(new Date("2026-11-21T16:30:00Z")), "2026-11-22");
  t("日期差", dayDiff_("2026-12-01", "2026-11-21"), 10);

  Logger.log(`通過 ${passed}／${total}`);
  for (const f of failures) Logger.log("失敗：" + f);
  if (passed !== total) throw new Error(`selfTest 失敗：通過 ${passed}／${total}`);
  return { passed, total };
}
