"""備份到 Google 雲端硬碟（規格見 docs/BACKUP.md，還原方法見 docs/RESTORE.md）。

每天由 Windows 工作排程器用 pyw.exe 執行，備份：
  1. 三個 repo（stock-dashboard、market-data、market-data-private）origin/main 的檔案，每 7 天另存完整 git 歷史（bundle）
  2. private/ 資料夾、Claude 記憶資料夾（各打成 zip）
  3. 網站讀的 7 個已發布 CSV
寫到 Google 雲端硬碟（桌面版串流模式）的「stock-dashboard 備份」資料夾；雲端硬碟寫不進去就失敗並通知，不退回寫本機。

只用 Python 標準庫。最上層不 import Windows 專屬模組（CI 在 Linux 跑）；Windows 專屬的事都放在函式裡。
時間一律用固定的 +08:00（不用 zoneinfo：排程在 Claude 以外跑，看不到 pip 裝的 tzdata）。
三個 repo 只 fetch，不 pull、不 checkout、不改任何設定。

用法：
  pyw.exe -3.14 tools\\backup_to_drive.py            # 正常備份
  py -3.14 tools\\backup_to_drive.py --dry-run       # 只列出計畫，不寫任何檔案
  --init            第一次建立雲端備份根目錄與標記檔
  --force-bundle    不管上次完整歷史是什麼時候，這次就做
  --allow-delete N  這次最多可刪 N 份舊備份（預設上限見 MAX_DELETE_PER_RUN）
  --no-notify       不跳 Windows 通知
  --root <路徑>     測試用：不找雲端硬碟，直接用這個資料夾當備份根目錄（標記檔還是要有）

結束代碼：0 正常；1 STALE 或 PARTIAL；10 雲端硬碟沒掛上；11 找到資料夾但沒有標記檔；
12 另一個備份正在跑；20 未預期的錯誤。
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

# ---- 可調參數（改動前先問使用者）----
P = dict(
    DRIVE_DIR_NAME="stock-dashboard 備份",
    DRIVE_ROOT_NAMES=("我的雲端硬碟", "My Drive"),
    MARKER="備份根目錄-請勿刪除.txt",
    REPOS={
        "stock-dashboard": r"C:\stock-dashboard",
        "market-data": r"C:\market-data",
        "market-data-private": r"C:\market-data-private",
    },
    PRIVATE_DIR=r"C:\stock-dashboard\private",
    MEMORY_DIR=r"%USERPROFILE%\.claude\projects\C--stock-dashboard\memory",
    KEEP_DAILY=14, KEEP_MONTHLY=12, MAX_DELETE_PER_RUN=3,
    BUNDLE_EVERY_DAYS=7, KEEP_BUNDLES=2,
    DRIVE_WAIT_SEC=600, FETCH_TIMEOUT_SEC=180, FETCH_TRIES=2,
    MARKET_STALE_DAYS=4, ZIP_WARN_MB=50,
)

TZ = dt.timezone(dt.timedelta(hours=8))
STATUS_RANK = {"OK": 2, "PARTIAL": 1, "STALE": 0}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EXIT_OK, EXIT_BAD, EXIT_NO_DRIVE, EXIT_NO_MARKER, EXIT_BUSY, EXIT_ERROR = 0, 1, 10, 11, 12, 20
DAILY, FULL = "每日", "完整歷史"
LOCK_STALE_SEC = 2 * 3600
UNFINISHED = "_未完成-"
UNFINISHED_KEEP_DAYS = 2
TOAST_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
RESTORE_NAME = "還原說明.txt"
STATE_NAME = "最近備份.json"
CSV_URL = "https://docs.google.com/spreadsheets/d/e/{pub}/pub?gid={gid}&single=true&output=csv"


class BackupError(Exception):
    pass


# ---------- 小工具 ----------

def now():
    return dt.datetime.now(TZ)


def iso(t):
    return t.isoformat(timespec="seconds")


def say(msg):
    """pyw 沒有主控台（stdout 是 None），輸出不能依賴 print。"""
    try:
        if sys.stdout is not None:
            print(msg, flush=True)
    except Exception:
        pass


def parse_date(name):
    """每日／完整歷史底下的資料夾名要是 YYYY-MM-DD 且是真的日期，否則回 None。"""
    if not DATE_RE.match(name):
        return None
    try:
        return dt.date.fromisoformat(name)
    except ValueError:
        return None


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_info(path, rel=None):
    return {"file": rel or os.path.basename(path), "bytes": os.path.getsize(path), "sha256": sha256_file(path)}


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def dump_json(path, obj):
    """先寫暫存檔再 os.replace，避免讀到寫一半的檔案。"""
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def rmtree_force(path):
    """刪資料夾；遇到唯讀檔先清掉唯讀屬性再刪（Windows 上 git 的物件檔是唯讀的）。"""
    def _fix(func, p, *_):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_fix)
    else:
        shutil.rmtree(path, onerror=_fix)


# ---------- 鎖 ----------

def lock_path():
    return os.path.join(tempfile.gettempdir(), "sdbackup.lock")


def acquire_lock(path=None):
    """O_EXCL 建鎖檔；超過 2 小時的舊鎖視為卡死、可以取代。拿不到回 None。"""
    path = path or lock_path()
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(path)
            except OSError:
                continue
            if age > LOCK_STALE_SEC:
                try:
                    os.remove(path)
                except OSError:
                    return None
                continue
            return None
        except OSError:
            return None
        with os.fdopen(fd, "w") as f:
            f.write(f"{os.getpid()} {iso(now())}\n")
        return path
    return None


def release_lock(path):
    if path:
        try:
            os.remove(path)
        except OSError:
            pass


# ---------- 子程序（git、tasklist、通知）----------

def _flags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


def _env():
    env = dict(os.environ)
    env.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never", GIT_OPTIONAL_LOCKS="0",
               GIT_ASKPASS="", SSH_ASKPASS="")
    return env


def run_cmd(cmd, timeout=120, cwd=None):
    """執行子程序：不開視窗、不讀 stdin、有逾時。回 (rc, stdout, stderr)；逾時或找不到程式 rc=-1。"""
    try:
        p = subprocess.run(cmd, cwd=cwd, env=_env(), stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=timeout, creationflags=_flags())
    except subprocess.TimeoutExpired:
        return -1, b"", f"逾時（{timeout} 秒）".encode()
    except OSError as e:
        return -1, b"", str(e).encode()
    return p.returncode, p.stdout, p.stderr


_GIT = None


def git_exe():
    global _GIT
    if _GIT is None:
        _GIT = shutil.which("git")
        if not _GIT:
            for c in (r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"):
                if os.path.exists(c):
                    _GIT = c
                    break
        _GIT = _GIT or "git"
    return _GIT


def git(repo, *args, timeout=120):
    """在 repo 裡跑 git（不自動 gc、不排背景維護，免得在使用者的 repo 裡留下副作用）。回 (rc, 文字輸出, 文字錯誤)。"""
    cmd = [git_exe()]
    if repo:
        cmd += ["-C", repo]
    cmd += ["-c", "gc.auto=0", "-c", "maintenance.auto=false", *args]
    rc, out, err = run_cmd(cmd, timeout=timeout)
    return rc, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


# ---------- 找雲端硬碟 ----------

def candidate_bases():
    for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
        for rn in P["DRIVE_ROOT_NAMES"]:
            yield os.path.join(f"{letter}:\\", rn, P["DRIVE_DIR_NAME"])


def scan_drives(bases=None):
    """回 (有標記檔的根目錄 or None, 有沒有看到沒標記的備份資料夾)。"""
    saw = False
    for base in (bases if bases is not None else candidate_bases()):
        if os.path.isfile(os.path.join(base, P["MARKER"])):
            return base, saw
        if os.path.isdir(base):
            saw = True
    return None, saw


def drive_fs_running():
    if sys.platform != "win32":
        return False
    rc, out, _ = run_cmd(["tasklist", "/FI", "IMAGENAME eq GoogleDriveFS.exe", "/NH"], timeout=30)
    return rc == 0 and b"GoogleDriveFS.exe" in out


def find_root(wait_sec, interval=30, scan=scan_drives, running=drive_fs_running, sleep=time.sleep):
    """每 30 秒找一次，最多等 wait_sec。回 (根目錄 or None, 結束代碼)。"""
    deadline = time.monotonic() + wait_sec
    saw_folder = found_no_fs = False
    while True:
        found, saw = scan()
        saw_folder = saw_folder or saw
        if found:
            if running():
                return found, EXIT_OK
            found_no_fs = True  # 找到標記檔但 GoogleDriveFS 沒在跑：可能是舊的快取，算沒掛上
        if time.monotonic() >= deadline:
            break
        sleep(interval)
    return None, (EXIT_NO_MARKER if saw_folder and not found_no_fs else EXIT_NO_DRIVE)


def check_root(root):
    """--root 用：標記檔一定要有。"""
    return os.path.isfile(os.path.join(root, P["MARKER"]))


# ---------- 保留規則（純邏輯）----------

def list_backups(parent):
    """只認直接子資料夾、名稱是真的日期、裡面有 manifest.json 的才算一份備份。"""
    out = []
    try:
        names = sorted(os.listdir(parent))
    except OSError:
        return out
    for name in names:
        d = parse_date(name)
        if d is None:
            continue
        p = os.path.join(parent, name)
        mf = os.path.join(p, "manifest.json")
        if not (os.path.isdir(p) and os.path.isfile(mf)):
            continue
        m = read_json(mf)
        status = m.get("status") if isinstance(m, dict) else None
        out.append(dict(name=name, date=d, status=status or "?", path=p, manifest=m if isinstance(m, dict) else {}))
    return out


def retention_keep(items, today, keep_daily, keep_monthly):
    """要保留的名稱集合（按份數，不按日曆）：
    最新 keep_daily 份 ∪ 最近 keep_monthly 個有備份的月份各自最早的 OK（沒有 OK 就最早的）∪ 最新的 OK ∪ 未來日期的。"""
    keep = {i["name"] for i in items if i["date"] > today}
    past = [i for i in items if i["date"] <= today]
    keep |= {i["name"] for i in sorted(past, key=lambda i: i["date"], reverse=True)[:keep_daily]}
    months = {}
    for i in sorted(past, key=lambda i: i["date"]):
        months.setdefault((i["date"].year, i["date"].month), []).append(i)
    for ym in sorted(months, reverse=True)[:keep_monthly]:
        grp = months[ym]
        keep.add(([i for i in grp if i["status"] == "OK"] or grp)[0]["name"])
    oks = [i for i in past if i["status"] == "OK"]
    if oks:
        keep.add(max(oks, key=lambda i: i["date"])["name"])
    return keep


def bundle_keep(items, today, keep_n):
    keep = {i["name"] for i in items if i["date"] > today}
    past = sorted((i for i in items if i["date"] <= today), key=lambda i: i["date"], reverse=True)
    keep |= {i["name"] for i in past[:keep_n]}
    return keep


def plan_deletions(items, keep, max_delete, label):
    """回 (要刪的清單, 警告 or None)。超過 max_delete 份就一份都不刪。"""
    dele = [i for i in items if i["name"] not in keep]
    if len(dele) > max_delete:
        return [], f"{label}有 {len(dele)} 份該清掉的舊備份，超過單次上限 {max_delete}，這次都沒刪（確認沒問題後用 --allow-delete {len(dele)}）"
    return dele, None


def future_warning(items, today, label):
    n = sum(1 for i in items if i["date"] > today)
    return f"{label}有 {n} 份日期在未來的備份，電腦時鐘可能不對" if n else None


def guard_delete(root, path):
    """刪除前的路徑檢查：上一層必須剛好是 <根>\\每日 或 <根>\\完整歷史，名稱要是日期或自己的 _未完成-，不能是連結。"""
    root_abs = os.path.abspath(root)
    parent = os.path.normcase(os.path.abspath(os.path.dirname(path)))
    allowed = {os.path.normcase(os.path.join(root_abs, n)) for n in (DAILY, FULL)}
    if parent not in allowed:
        raise BackupError(f"拒絕刪除：{path} 不在 {DAILY}／{FULL} 底下")
    base = os.path.basename(path)
    if parse_date(base) is None and not base.startswith(UNFINISHED):
        raise BackupError(f"拒絕刪除：{path} 的名稱不是備份資料夾")
    if os.path.islink(path) or getattr(os.path, "isjunction", lambda p: False)(path):
        raise BackupError(f"拒絕刪除：{path} 是連結")


def delete_backup(root, path):
    guard_delete(root, path)
    rmtree_force(path)


def cleanup_unfinished(root, parent, today_ts=None):
    """清掉自己留下、超過 2 天的 _未完成-*。"""
    n = 0
    ts = today_ts if today_ts is not None else time.time()
    try:
        names = os.listdir(parent)
    except OSError:
        return 0
    for name in names:
        if not name.startswith(UNFINISHED):
            continue
        p = os.path.join(parent, name)
        try:
            if os.path.isdir(p) and ts - os.path.getmtime(p) > UNFINISHED_KEEP_DAYS * 86400:
                delete_backup(root, p)
                n += 1
        except (OSError, BackupError):
            pass
    return n


# ---------- 狀態（純邏輯）----------

def decide_status(fetch_failed, problems):
    """STALE：有 repo fetch 失敗；PARTIAL：fetch 都成功但有檔案失敗或非快轉；其餘 OK。"""
    if fetch_failed:
        return "STALE"
    if problems:
        return "PARTIAL"
    return "OK"


def not_worse(new, old):
    """同一天重跑：新結果不比舊的差才取代（OK > PARTIAL > STALE；舊的看不懂當最差）。"""
    return STATUS_RANK.get(new, -1) >= STATUS_RANK.get(old, -1)


def bundle_due(latest_date, today, every_days, force=False):
    if force or latest_date is None:
        return True
    return (today - latest_date).days >= every_days


# ---------- config.js 解析（取得網站實際讀的 7 個 CSV）----------

def _strip_js_comments(text):
    lines = []
    for ln in text.splitlines():
        if ln.lstrip().startswith("//"):
            continue
        lines.append(re.sub(r"\s//\s.*$", "", ln))
    return "\n".join(lines)


def parse_csv_sources(config_text):
    """從 site/js/config.js 取出 LEDGER_PUB、DASH_PUB 與網站讀的分頁 gid。回 list of dict(name, gid, url)。"""
    t = _strip_js_comments(config_text)
    pubs = {}
    for var, name in (("LEDGER_PUB", "ledger"), ("DASH_PUB", "dashboard")):
        m = re.search(rf'\b{var}\s*=\s*"([^"]+)"', t)
        if m:
            pubs[name] = m.group(1)
    gids = {"ledger": set(), "dashboard": set()}
    for var, gid in re.findall(r"sheetCsv\(\s*(LEDGER_PUB|DASH_PUB)\s*,\s*(\d+)\s*\)", t):
        gids["ledger" if var == "LEDGER_PUB" else "dashboard"].add(int(gid))
    for m in re.finditer(r"\b(\w+_GID)\s*=\s*(\d+)\s*;", t):
        if m.group(1).startswith("INCOME"):
            gids["ledger"].add(int(m.group(2)))
    m = re.search(r"NEWS_TABS\s*=\s*\[(.*?)\]\s*;", t, re.S)
    if m:
        for g in re.findall(r"\[\s*(\d+)\s*,", m.group(1)):
            gids["dashboard"].add(int(g))
    out = []
    for name in ("ledger", "dashboard"):
        if name not in pubs:
            continue
        for gid in sorted(gids[name]):
            out.append(dict(name=name, gid=gid, url=CSV_URL.format(pub=pubs[name], gid=gid)))
    return out


# ---------- CSV 下載與驗證 ----------

def http_get(url, timeout=60):
    """回 (HTTP 狀態碼, 內容 bytes)；網路層失敗丟例外。"""
    req = urllib.request.Request(url, headers={"User-Agent": "stock-dashboard-backup/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""


def validate_csv(status, body):
    """回錯誤說明 or None。未發布的分頁會回 HTML（以 < 開頭）。"""
    if status != 200:
        return f"HTTP {status}"
    head = body.lstrip(b"\xef\xbb\xbf \t\r\n")[:1]
    if head == b"<":
        return "回傳的是 HTML（分頁可能被取消發布）"
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        return "不是 UTF-8 文字"
    return None


def download_csv(src, dest_dir):
    """下載一個 CSV 存進 dest_dir。回 manifest 項目。"""
    entry = dict(name=src["name"], gid=src["gid"], ok=False, http=None, bytes=0, sha256=None, error=None)
    fname = f"{src['name']}-gid{src['gid']}.csv"
    err = None
    for attempt in range(2):
        try:
            status, body = http_get(src["url"], 60)
            entry["http"] = status
            err = validate_csv(status, body)
            if err is None:
                break
        except Exception as e:  # 網路錯誤、逾時
            err = f"{type(e).__name__}: {e}"[:200]
        if attempt == 0:
            time.sleep(2)
    if err is not None:
        entry["error"] = err
        return entry, None
    os.makedirs(dest_dir, exist_ok=True)
    path = os.path.join(dest_dir, fname)
    with open(path, "wb") as f:
        f.write(body)
    entry.update(ok=True, file=f"csv/{fname}", bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
    return entry, path


# ---------- 資料夾打包 ----------

def zip_folder(src, dest):
    """整個資料夾打成 zip：空資料夾寫成目錄項、檔名 UTF-8、壓縮路徑相對於 src（沒有外層資料夾）。回 (檔案數, 原始位元組數)。"""
    files = nbytes = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, allowZip64=True, strict_timestamps=False) as zf:
        for dirpath, dirnames, filenames in os.walk(src):
            dirnames.sort()
            rel_dir = os.path.relpath(dirpath, src)
            if rel_dir != "." and not dirnames and not filenames:
                zf.write(dirpath, rel_dir.replace(os.sep, "/") + "/")
            for fn in sorted(filenames):
                p = os.path.join(dirpath, fn)
                arc = os.path.normpath(os.path.join(rel_dir, fn)).replace(os.sep, "/")
                zf.write(p, arc)
                files += 1
                nbytes += os.path.getsize(p)
    return files, nbytes


def backup_folder(label, src, tmp):
    """打包 private／記憶資料夾。回 (manifest 項目, zip 路徑 or None, 警告, 問題)。"""
    warns, problems = [], []
    entry = dict(path=src, files=0, bytes=0, zip=None)
    if not os.path.isdir(src):
        warns.append(f"{label} 資料夾不存在，沒有備份：{src}")
        entry["missing"] = True
        return entry, None, warns, problems
    dest = os.path.join(tmp, f"{label}.zip")
    try:
        entry["files"], entry["bytes"] = zip_folder(src, dest)
    except Exception as e:
        problems.append(f"{label} 打包失敗：{type(e).__name__}: {e}"[:200])
        return entry, None, warns, problems
    entry["zip"] = file_info(dest)
    if entry["zip"]["bytes"] > P["ZIP_WARN_MB"] * 1024 * 1024:
        warns.append(f"{label}.zip 已有 {entry['zip']['bytes'] / 1048576:.0f} MB，超過 {P['ZIP_WARN_MB']} MB")
    return entry, dest, warns, problems


# ---------- repo 備份 ----------

def fetch_repo(path, tries, wait=60):
    last = ""
    for i in range(tries):
        rc, out, err = git(path, "-c", "fetch.writeCommitGraph=false", "fetch", "--no-prune", "--quiet", "origin",
                           timeout=P["FETCH_TIMEOUT_SEC"])
        if rc == 0:
            return True, None
        last = (err or out).strip()[:300] or f"rc={rc}"
        if i + 1 < tries:
            time.sleep(wait)
    return False, last


def local_only_branches(path):
    """回 [{"branch", "ahead"}]：本機有、origin 還沒有的 commit 的分支。"""
    rc, out, _ = git(path, "for-each-ref", "--format=%(refname)", "refs/heads")
    res = []
    if rc != 0:
        return res
    for ref in out.split():
        rc, n, _ = git(path, "rev-list", "--count", ref, "--not", "--remotes=origin")
        if rc == 0 and n.strip().isdigit() and int(n) > 0:
            res.append(dict(branch=ref[len("refs/heads/"):], ahead=int(n)))
    return res


def count_dirty_worktrees(path):
    rc, out, _ = git(path, "worktree", "list", "--porcelain")
    if rc != 0:
        return 0
    n = 0
    for ln in out.splitlines():
        if not ln.startswith("worktree "):
            continue
        wt = ln[len("worktree "):].strip()
        if not os.path.isdir(wt):
            continue
        rc, st, _ = git(wt, "status", "--porcelain", timeout=60)
        if rc == 0 and st.strip():
            n += 1
    return n


def backup_repo(name, path, tmp, tries, prev_commit, prev_fetch_ok_at):
    """fetch、記錄 origin/main、打包。回 (manifest 項目, 警告, 打包 zip 路徑 or None)。"""
    r = dict(fetch_ok=False, fetch_error=None, last_fetch_ok_at=prev_fetch_ok_at, commit=None, commit_time=None,
             local_main_behind=None, non_fast_forward=False, unpushed_local_branches=[], dirty_worktrees=0,
             archive=None)
    warns = []
    if not os.path.exists(os.path.join(path, ".git")):
        r["fetch_error"] = f"找不到 repo：{path}"
        return r, warns, None
    ok, err = fetch_repo(path, tries)
    r["fetch_ok"], r["fetch_error"] = ok, err
    if ok:
        r["last_fetch_ok_at"] = iso(now())
    rc, out, _ = git(path, "rev-parse", "origin/main")
    if rc != 0:
        r["fetch_ok"] = False
        r["fetch_error"] = r["fetch_error"] or "找不到 origin/main"
        return r, warns, None
    r["commit"] = out.strip()
    rc, out, _ = git(path, "log", "-1", "--format=%cI", "origin/main")
    r["commit_time"] = out.strip() if rc == 0 else None
    rc, out, _ = git(path, "rev-list", "--count", "refs/heads/main..origin/main")
    if rc == 0 and out.strip().isdigit():
        r["local_main_behind"] = int(out)
    if prev_commit:
        rc, _, _ = git(path, "merge-base", "--is-ancestor", prev_commit, r["commit"])
        r["non_fast_forward"] = rc != 0
    r["unpushed_local_branches"] = local_only_branches(path)
    r["dirty_worktrees"] = count_dirty_worktrees(path)
    zip_path = os.path.join(tmp, f"{name}.zip")
    # -c core.autocrlf=false 一定要加：不加的話 Windows 上 market-data 有 68 個檔案的換行會被改掉
    rc, _, err = git(path, "-c", "core.autocrlf=false", "archive", "--format=zip", f"--prefix={name}/",
                     "-o", zip_path, "origin/main", timeout=300)
    if rc == 0 and os.path.isfile(zip_path):
        r["archive"] = file_info(zip_path)
    else:
        r["archive_error"] = (err.strip() or f"rc={rc}")[:300]
        zip_path = None
    ct = r["commit_time"]
    if name == "market-data" and ct:
        try:
            age = (now() - dt.datetime.fromisoformat(ct)).days
            if age > P["MARKET_STALE_DAYS"]:
                warns.append(f"market-data 已 {age} 天沒有新 commit")
        except ValueError:
            pass
    if r["unpushed_local_branches"]:
        names = "、".join(f"{b['branch']}（{b['ahead']}）" for b in r["unpushed_local_branches"][:5])
        warns.append(f"{name} 有 {len(r['unpushed_local_branches'])} 個本機分支的 commit 還沒推上 GitHub：{names}")
    if r["dirty_worktrees"]:
        warns.append(f"{name} 有 {r['dirty_worktrees']} 個工作目錄有未提交的修改（備份只含 origin/main）")
    return r, warns, zip_path


def make_bundle(name, path, tmp, local_branches, expect_commit):
    """完整歷史：用暫存 bare repo 把 origin/* 轉成 heads（git bundle --all 直接用在原 repo 會漏掉 origin/* ）。"""
    bare = os.path.join(tmp, "b", f"{name}.git")
    out_file = os.path.join(tmp, f"{name}.bundle")
    os.makedirs(os.path.dirname(bare), exist_ok=True)

    def step(*args, repo=bare, timeout=300):
        rc, out, err = git(repo, *args, timeout=timeout)
        if rc != 0:
            raise BackupError(f"{name}: git {' '.join(args[:2])} 失敗：{(err or out).strip()[:200]}")
        return out

    rc, _, err = git(None, "init", "--bare", "--quiet", bare)
    if rc != 0:
        raise BackupError(f"{name}: 建暫存 bare repo 失敗：{err.strip()[:200]}")
    refspecs = ["+refs/remotes/origin/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]
    refspecs += [f"+refs/heads/{b}:refs/heads/local/{b}" for b in local_branches]
    step("fetch", "--quiet", path, *refspecs)
    git(bare, "update-ref", "-d", "refs/heads/HEAD")  # origin/HEAD 轉出來的，沒有就算了
    step("symbolic-ref", "HEAD", "refs/heads/main")
    step("bundle", "create", out_file, "--all")
    step("bundle", "verify", out_file)  # verify 要在 repo 裡執行
    vdir = os.path.join(tmp, "v", f"{name}.git")
    os.makedirs(os.path.dirname(vdir), exist_ok=True)
    rc, _, err = git(None, "clone", "--bare", "--quiet", out_file, vdir, timeout=300)
    if rc != 0:
        raise BackupError(f"{name}: 從 bundle 還原失敗：{err.strip()[:200]}")
    head = step("rev-parse", "main", repo=vdir).strip()
    if head != expect_commit:
        raise BackupError(f"{name}: bundle 還原後 main（{head[:7]}）不是 origin/main（{expect_commit[:7]}）")
    info = file_info(out_file)
    info["commit"] = head
    info["local_branches"] = [f"local/{b}" for b in local_branches]
    rmtree_force(bare)
    rmtree_force(vdir)
    return info, out_file


# ---------- 寫進雲端 ----------

def copy_verified(src, dst):
    """複製一個檔案並比對大小與 sha256；不一致重來一次，還是不一致就丟例外。"""
    want = (os.path.getsize(src), sha256_file(src))
    for _ in range(2):
        shutil.copyfile(src, dst)
        if (os.path.getsize(dst), sha256_file(dst)) == want:
            return
    raise BackupError(f"複製後檔案不一致：{dst}")


def write_dated_folder(parent, date_str, files, manifest, pid=None):
    """先寫 _未完成-日期-PID，manifest 最後寫，全部確認後才改名成日期。
    同一天已經有的：新結果不比舊的差才取代，否則丟掉新結果。回 'written'|'replaced'|'kept_old'。"""
    pid = pid or os.getpid()
    os.makedirs(parent, exist_ok=True)
    staging = os.path.join(parent, f"{UNFINISHED}{date_str}-{pid}")
    if os.path.exists(staging):
        rmtree_force(staging)
    os.makedirs(staging)
    final = os.path.join(parent, date_str)
    bak = os.path.join(parent, f"{UNFINISHED}{date_str}-{pid}-舊")
    try:
        for src, rel in files:
            dst = os.path.join(staging, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            copy_verified(src, dst)
        dump_json(os.path.join(staging, "manifest.json"), manifest)
        if os.path.isdir(final):
            old = read_json(os.path.join(final, "manifest.json"))
            old_status = old.get("status") if isinstance(old, dict) else None
            if not not_worse(manifest["status"], old_status):
                rmtree_force(staging)
                return "kept_old"
            os.rename(final, bak)
            try:
                os.rename(staging, final)
            except OSError:
                os.rename(bak, final)
                raise
            rmtree_force(bak)
            return "replaced"
        os.rename(staging, final)
        return "written"
    except BaseException:
        if os.path.isdir(staging):
            rmtree_force(staging)
        raise


def write_text_if_changed(path, text):
    try:
        with open(path, "r", encoding="utf-8") as f:
            if f.read() == text:
                return False
    except OSError:
        pass
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)
    return True


def append_log(root, started, line):
    d = os.path.join(root, "紀錄")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, started.strftime("%Y-%m") + ".log"), "a", encoding="utf-8", newline="\n") as f:
        f.write(line + "\n")


# ---------- 通知 ----------

def notify(title, body):
    """Windows 通知（不用第三方模組）；失敗不影響備份結果。"""
    if sys.platform != "win32":
        return
    q = lambda s: s.replace("'", "''")
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
        "$n = $t.GetElementsByTagName('text');"
        f"$n.Item(0).AppendChild($t.CreateTextNode('{q(title)}')) | Out-Null;"
        f"$n.Item(1).AppendChild($t.CreateTextNode('{q(body)}')) | Out-Null;"
        f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{TOAST_APP_ID}')"
        ".Show([Windows.UI.Notifications.ToastNotification]::new($t))"
    )
    enc = base64.b64encode(ps.encode("utf-16-le")).decode("ascii")
    run_cmd(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], timeout=30)


# ---------- 主流程 ----------

def latest_ok_manifest(root):
    for it in sorted(list_backups(os.path.join(root, DAILY)), key=lambda i: i["date"], reverse=True):
        if it["status"] == "OK":
            return it["manifest"]
    return None


def csv_sources_from(stock_repo):
    """git show origin/main:site/js/config.js → 網站實際讀的 CSV 清單。回 (清單, 錯誤 or None)。"""
    rc, out, err = git(stock_repo, "show", "origin/main:site/js/config.js")
    if rc != 0:
        return [], f"讀不到 origin/main 的 site/js/config.js：{err.strip()[:150]}"
    srcs = parse_csv_sources(out)
    if not srcs:
        return [], "config.js 裡找不到任何 CSV 來源"
    return srcs, None


def restore_text(stock_repo):
    rc, out, _ = git(stock_repo, "show", "origin/main:docs/RESTORE.md")
    return out if rc == 0 and out.strip() else None


def total_bytes(manifest):
    n = 0
    for r in manifest["repos"].values():
        n += (r.get("archive") or {}).get("bytes", 0)
    for f in manifest["folders"].values():
        n += (f.get("zip") or {}).get("bytes", 0)
    for c in manifest["csv"]:
        n += c.get("bytes", 0)
    return n


def run_retention(root, today, allow_delete, warnings):
    """只有這次是 OK 才會呼叫。回刪掉的份數。"""
    max_del = allow_delete if allow_delete is not None else P["MAX_DELETE_PER_RUN"]
    deleted = 0
    for sub, label in ((DAILY, "每日備份"), (FULL, "完整歷史")):
        parent = os.path.join(root, sub)
        items = list_backups(parent)
        if sub == DAILY:
            keep = retention_keep(items, today, P["KEEP_DAILY"], P["KEEP_MONTHLY"])
        else:
            keep = bundle_keep(items, today, P["KEEP_BUNDLES"])
        fw = future_warning(items, today, label)
        if fw:
            warnings.append(fw)
        dele, w = plan_deletions(items, keep, max_del, label)
        if w:
            warnings.append(w)
        for it in dele:
            try:
                delete_backup(root, it["path"])
                deleted += 1
            except (OSError, BackupError) as e:
                warnings.append(f"刪除舊備份失敗：{it['name']}：{e}"[:200])
        deleted += cleanup_unfinished(root, parent)
    return deleted


def do_backup(args, root, started):
    tmp = tempfile.mkdtemp(prefix="sdbackup-")
    try:
        return _do_backup(args, root, started, tmp)
    finally:
        rmtree_force(tmp)


def _do_backup(args, root, started, tmp):
    today = started.date()
    date_str = today.isoformat()
    warnings, problems, fetch_failed = [], [], []
    prev_state = read_json(os.path.join(root, STATE_NAME)) or {}
    prev_ok = latest_ok_manifest(root)
    files = []  # (來源, 雲端相對路徑)
    repos, zips = {}, {}
    first_failed = False  # 第一個 repo 兩次都失敗，後面的只試一次（網路多半是壞的）
    for idx, (name, path) in enumerate(P["REPOS"].items()):
        prev_commit = (((prev_ok or {}).get("repos") or {}).get(name) or {}).get("commit")
        prev_at = ((prev_state.get("repos") or {}).get(name) or {}).get("last_fetch_ok_at")
        r, w, zp = backup_repo(name, path, tmp, 1 if first_failed else P["FETCH_TRIES"], prev_commit, prev_at)
        repos[name] = r
        warnings += w
        if not r["fetch_ok"]:
            first_failed = first_failed or idx == 0
            fetch_failed.append(f"{name} fetch 失敗：{r['fetch_error']}")
        elif zp is None:
            problems.append(f"{name} 打包失敗：{r.get('archive_error')}")
        if r["non_fast_forward"]:
            problems.append(f"{name} 的 origin/main 不是上次備份的後代（歷史被改寫或強制推送）")
        if zp:
            zips[name] = zp
            files.append((zp, f"{name}.zip"))
    folders = {}
    for label, src in (("private", P["PRIVATE_DIR"]), ("claude-memory", os.path.expandvars(P["MEMORY_DIR"]))):
        entry, zp, w, pr = backup_folder(label, src, tmp)
        folders[label] = entry
        warnings += w
        problems += pr
        if zp:
            files.append((zp, f"{label}.zip"))
    # CSV
    csvs = []
    srcs, err = csv_sources_from(P["REPOS"]["stock-dashboard"])
    if err:
        problems.append(err)
    for s in srcs:
        entry, p = download_csv(s, os.path.join(tmp, "csv"))
        csvs.append(entry)
        if p:
            files.append((p, entry["file"]))
            if entry["bytes"] == 0:
                warnings.append(f"CSV {entry['file']} 是空的")
        else:
            problems.append(f"CSV {s['name']} gid {s['gid']} 失敗：{entry['error']}")
    # 完整歷史
    bundle_info, bundle_files = None, []
    full_items = list_backups(os.path.join(root, FULL))
    latest_full = max((i["date"] for i in full_items), default=None)
    if bundle_due(latest_full, today, P["BUNDLE_EVERY_DAYS"], args.force_bundle):
        if fetch_failed or not all(r["commit"] for r in repos.values()):
            warnings.append("這次有 repo fetch 失敗，完整歷史（bundle）延到下次")
        else:
            bundle_info = {}
            try:
                for name, path in P["REPOS"].items():
                    lb = [b["branch"] for b in repos[name]["unpushed_local_branches"]]
                    info, bp = make_bundle(name, path, tmp, lb, repos[name]["commit"])
                    bundle_info[name] = info
                    bundle_files.append((bp, f"{name}.bundle"))
            except Exception as e:
                problems.append(f"完整歷史（bundle）失敗：{e}"[:300])
                bundle_info = None
    status = decide_status(fetch_failed, problems)
    all_problems = fetch_failed + problems
    finished = now()
    manifest = dict(
        schema=1, started=iso(started), finished=iso(finished), status=status,
        script_commit=repos["stock-dashboard"]["commit"],
        repos=repos, folders=folders, csv=csvs, warnings=warnings, problems=all_problems,
    )
    result = write_dated_folder(os.path.join(root, DAILY), date_str, files, manifest)
    if bundle_info is not None:
        fmf = dict(schema=1, started=iso(started), finished=iso(now()), status="OK", date=date_str,
                   repos={n: dict(bundle=i) for n, i in bundle_info.items()})
        write_dated_folder(os.path.join(root, FULL), date_str, bundle_files, fmf)
    if result == "kept_old":
        warnings.append(f"同一天（{date_str}）已有比這次更好的備份，這次的結果沒有取代它")
    # 狀態檔、還原說明、紀錄
    rt = restore_text(P["REPOS"]["stock-dashboard"])
    if rt is not None:
        write_text_if_changed(os.path.join(root, RESTORE_NAME), rt)
    else:
        warnings.append("origin/main 上還沒有 docs/RESTORE.md，雲端的還原說明沒有更新")
    state = dict(prev_state)
    for k in ("status", "backup_folder"):  # 舊版欄位名稱（看門狗用 last_attempt_status、last_ok_folder）
        state.pop(k, None)
    fulls = list_backups(os.path.join(root, FULL))
    state.update(schema=1, last_attempt=iso(started), last_attempt_status=status, warnings=warnings,
                 problems=all_problems, script_commit=manifest["script_commit"],
                 last_bundle_folder=max(fulls, key=lambda i: i["date"])["name"] if fulls else None,
                 repos={n: dict(last_fetch_ok_at=r["last_fetch_ok_at"], commit=r["commit"]) for n, r in repos.items()})
    if status == "OK":
        state["last_ok"] = iso(finished)
        state["last_ok_folder"] = date_str
    state.setdefault("last_ok", None)
    state.setdefault("last_ok_folder", None)
    dump_json(os.path.join(root, STATE_NAME), state)
    deleted = 0
    if status == "OK":
        try:
            n_warn = len(warnings)
            deleted = run_retention(root, today, args.allow_delete, warnings)
            if len(warnings) != n_warn:
                state["warnings"] = warnings
                dump_json(os.path.join(root, STATE_NAME), state)
        except Exception as e:
            warnings.append(f"保留規則執行失敗：{type(e).__name__}: {e}"[:200])
    short = " ".join(f"{n}={(r['commit'] or '-------')[:7]}" for n, r in repos.items())
    append_log(root, started, f"{iso(started)} {status} {short} {total_bytes(manifest) / 1048576:.1f}MB "
                              f"警告{len(warnings)} 刪除{deleted}" + ("" if result != "kept_old" else " 同日保留舊的"))
    say(f"備份完成：{status}，{date_str}（{result}）；總大小 {total_bytes(manifest) / 1048576:.1f} MB；警告 {len(warnings)}；刪除 {deleted}")
    for p in all_problems:
        say(f"  問題：{p}")
    if status != "OK" and not args.no_notify:
        notify(f"備份 {status}", (all_problems[0] if all_problems else "請看雲端最近備份.json"))
    return EXIT_OK if status == "OK" else EXIT_BAD


def do_init(args):
    if args.root:
        base = args.root
    else:
        base = None
        if not drive_fs_running():
            say("GoogleDriveFS 沒在執行，無法 --init")
            return EXIT_NO_DRIVE
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            for rn in P["DRIVE_ROOT_NAMES"]:
                if os.path.isdir(os.path.join(f"{letter}:\\", rn)):
                    base = base or os.path.join(f"{letter}:\\", rn, P["DRIVE_DIR_NAME"])
        if not base:
            say("找不到雲端硬碟")
            return EXIT_NO_DRIVE
    os.makedirs(base, exist_ok=True)
    marker = os.path.join(base, P["MARKER"])
    if not os.path.exists(marker):
        write_text_if_changed(marker, "這個資料夾是 stock-dashboard 每日備份的根目錄。\n"
                                      "備份腳本靠這個檔案確認雲端硬碟真的掛上了，請勿刪除或改名。\n"
                                      f"建立時間：{iso(now())}\n")
    for sub in (DAILY, FULL, "紀錄"):
        os.makedirs(os.path.join(base, sub), exist_ok=True)
    say(f"已建立備份根目錄：{base}")
    return EXIT_OK


def do_dry_run(args, started):
    say("【dry-run】只列出計畫，不寫任何檔案、不 fetch")
    if args.root:
        root, code = (args.root, EXIT_OK) if check_root(args.root) else (None, EXIT_NO_MARKER)
    else:
        found, saw = scan_drives()
        root, code = (found, EXIT_OK) if found else (None, EXIT_NO_MARKER if saw else EXIT_NO_DRIVE)
        if found and not drive_fs_running():
            root, code = None, EXIT_NO_DRIVE
    if root is None:
        say(f"找不到備份根目錄（會以代碼 {code} 結束）")
        return code
    say(f"備份根目錄：{root}")
    today = started.date()
    say(f"日期：{today.isoformat()}（固定 +08:00）")
    for name, path in P["REPOS"].items():
        rc, out, _ = git(path, "rev-parse", "origin/main")
        say(f"  repo {name}：{path}；目前 origin/main = {out.strip()[:7] if rc == 0 else '（讀不到）'}；"
            f"會 fetch 後用 git archive 打包 origin/main")
    for label, src in (("private", P["PRIVATE_DIR"]), ("claude-memory", os.path.expandvars(P["MEMORY_DIR"]))):
        say(f"  資料夾 {label}：{src}（{'存在' if os.path.isdir(src) else '不存在'}）→ {label}.zip")
    srcs, err = csv_sources_from(P["REPOS"]["stock-dashboard"])
    say(f"  CSV：{len(srcs)} 個" + (f"（{err}）" if err else ""))
    for s in srcs:
        say(f"    {s['name']}-gid{s['gid']}.csv  {s['url']}")
    full_items = list_backups(os.path.join(root, FULL))
    latest_full = max((i["date"] for i in full_items), default=None)
    due = bundle_due(latest_full, today, P["BUNDLE_EVERY_DAYS"], args.force_bundle)
    say(f"  完整歷史（bundle）：上次 {latest_full or '沒有'}；這次{'要做' if due else '不做'}")
    items = list_backups(os.path.join(root, DAILY))
    keep = retention_keep(items, today, P["KEEP_DAILY"], P["KEEP_MONTHLY"])
    max_del = args.allow_delete if args.allow_delete is not None else P["MAX_DELETE_PER_RUN"]
    dele, w = plan_deletions(items, keep, max_del, "每日備份")
    say(f"  每日備份目前 {len(items)} 份；若這次 OK，會刪 {len(dele)} 份：{[i['name'] for i in dele]}" + (f"；{w}" if w else ""))
    return EXIT_OK


def parse_args(argv):
    ap = argparse.ArgumentParser(description="備份到 Google 雲端硬碟（docs/BACKUP.md）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--init", action="store_true")
    ap.add_argument("--force-bundle", action="store_true")
    ap.add_argument("--allow-delete", type=int, default=None, metavar="N")
    ap.add_argument("--no-notify", action="store_true")
    ap.add_argument("--root", default=None, metavar="PATH")
    return ap.parse_args(argv)


def run(args, state):
    started = now()
    if args.init:
        return do_init(args)
    if args.dry_run:
        return do_dry_run(args, started)
    lock = acquire_lock()
    if lock is None:
        say("另一個備份正在執行（或鎖檔還沒過期），這次不跑")
        return EXIT_BUSY
    try:
        if args.root:
            root, code = (args.root, EXIT_OK) if check_root(args.root) else (None, EXIT_NO_MARKER)
        else:
            root, code = find_root(P["DRIVE_WAIT_SEC"])
        if root is None:
            msg = ("找到備份資料夾，但裡面沒有標記檔" if code == EXIT_NO_MARKER else "雲端硬碟沒有掛上") + "，今天沒有備份"
            say(msg)
            if not args.no_notify:
                notify("備份失敗", msg)
            return code
        state["root"] = root
        return do_backup(args, root, started)
    finally:
        release_lock(lock)


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8")
        except Exception:
            pass
    args = parse_args(argv)
    state = {}
    try:
        return run(args, state)
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"[:300]
        say(f"備份發生未預期的錯誤：{msg}")
        root = state.get("root")
        if root:
            try:
                st = read_json(os.path.join(root, STATE_NAME)) or {}
                st.update(schema=1, last_attempt=iso(now()), last_attempt_status="ERROR", problems=[msg])
                dump_json(os.path.join(root, STATE_NAME), st)
            except Exception:
                pass
        if not args.no_notify:
            notify("備份發生錯誤", msg)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
