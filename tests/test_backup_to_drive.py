"""tools/backup_to_drive.py 的測試（docs/BACKUP.md 第 10 節）。

大部分是純邏輯；最後一組用暫存資料夾裡的迷你 git repo 與假的雲端根目錄跑完整流程（不碰網路、不碰真的 repo）。
"""
import datetime as dt
import json
import os
import shutil
import stat
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import backup_to_drive as b  # noqa: E402

D = dt.date


def item(date, status="OK"):
    d = D.fromisoformat(date) if isinstance(date, str) else date
    return dict(name=d.isoformat(), date=d, status=status, path="x/" + d.isoformat(), manifest={})


def days(start, n, status="OK"):
    s = D.fromisoformat(start)
    return [item(s + dt.timedelta(days=i), status) for i in range(n)]


def names(items):
    return {i["name"] for i in items}


# ---------- 保留規則 ----------

def test_first_run_keeps_the_only_backup():
    its = [item("2026-11-21")]
    keep = b.retention_keep(its, D(2026, 11, 21), 14, 12)
    assert keep == {"2026-11-21"}
    assert b.plan_deletions(its, keep, 3, "每日")[0] == []


def test_three_week_gap_does_not_wipe_old_backups():
    # 備份停了三週：按份數保留，14 份都還在，不會因為「超過 14 天」被清掉
    its = days("2026-10-01", 14)
    keep = b.retention_keep(its, D(2026, 10, 14) + dt.timedelta(days=21), 14, 12)
    assert keep == names(its)


def test_newest_14_plus_first_ok_of_each_month():
    its = days("2026-09-01", 80)  # 9/1 ~ 11/19
    today = D(2026, 11, 19)
    keep = b.retention_keep(its, today, 14, 12)
    assert {"2026-09-01", "2026-10-01", "2026-11-01"} <= keep  # 每月最早的
    newest14 = {i["name"] for i in its[-14:]}
    assert newest14 <= keep
    assert len(keep) == 14 + 3
    dele, warn = b.plan_deletions(its, keep, 100, "每日")
    assert len(dele) == 80 - 17 and warn is None


def test_month_keeps_earliest_ok_not_earliest_failed():
    its = [item("2026-09-01", "STALE"), item("2026-09-02", "PARTIAL"), item("2026-09-03", "OK"), item("2026-09-04", "OK")]
    keep = b.retention_keep(its, D(2026, 11, 20), 1, 12)
    assert "2026-09-03" in keep and "2026-09-01" not in keep


def test_month_without_ok_keeps_earliest_anything():
    its = [item("2026-08-05", "STALE"), item("2026-08-06", "PARTIAL")]
    keep = b.retention_keep(its, D(2026, 11, 20), 0, 12)
    assert keep == {"2026-08-05"}


def test_monthly_limit_counts_months_that_have_backups():
    its = [item(f"2025-{m:02d}-10") for m in range(1, 13)] + [item("2026-01-10"), item("2026-02-10")]
    keep = b.retention_keep(its, D(2026, 11, 20), 0, 12)
    assert len(keep) == 12 and "2025-01-10" not in keep and "2025-02-10" not in keep and "2025-03-10" in keep


def test_newest_ok_always_kept_even_among_many_failures():
    its = [item("2026-10-01", "OK")] + days("2026-10-02", 30, "STALE")
    keep = b.retention_keep(its, D(2026, 11, 1), 14, 0)
    assert "2026-10-01" in keep  # 唯一的 OK 不能被擠掉


def test_future_dated_backups_are_kept_and_warned():
    its = days("2026-11-01", 3) + [item("2027-05-01")]
    keep = b.retention_keep(its, D(2026, 11, 3), 14, 12)
    assert "2027-05-01" in keep
    assert "時鐘" in b.future_warning(its, D(2026, 11, 3), "每日備份")
    assert b.future_warning(days("2026-11-01", 3), D(2026, 11, 3), "x") is None


def test_future_dated_does_not_push_real_backups_out_of_newest_n():
    its = days("2026-11-01", 5) + [item("2030-01-01")]
    keep = b.retention_keep(its, D(2026, 11, 5), 5, 0)
    assert names(its[:5]) <= keep


def test_more_than_max_deletions_deletes_none():
    its = days("2026-10-01", 40)
    keep = b.retention_keep(its, D(2026, 11, 9), 14, 0)
    dele, warn = b.plan_deletions(its, keep, 3, "每日備份")
    assert dele == [] and "--allow-delete" in warn
    dele, warn = b.plan_deletions(its, keep, 40, "每日備份")
    assert len(dele) == 40 - len(keep) and warn is None


def test_normal_daily_run_deletes_one():
    its = days("2026-10-20", 16)  # 10/20 ~ 11/4，今天 11/4
    keep = b.retention_keep(its, D(2026, 11, 4), 14, 0)
    dele, _ = b.plan_deletions(its, keep, 3, "x")
    assert [i["name"] for i in dele] == ["2026-10-20", "2026-10-21"]


def test_bundle_keep_latest_two():
    its = [item("2026-10-24"), item("2026-10-31"), item("2026-11-07"), item("2026-11-14")]
    keep = b.bundle_keep(its, D(2026, 11, 15), 2)
    assert keep == {"2026-11-07", "2026-11-14"}


def test_bundle_due():
    today = D(2026, 11, 21)
    assert b.bundle_due(None, today, 7)
    assert not b.bundle_due(D(2026, 11, 15), today, 7)
    assert b.bundle_due(D(2026, 11, 14), today, 7)
    assert b.bundle_due(D(2026, 11, 21), today, 7, force=True)


def test_list_backups_ignores_bad_names_and_missing_manifest(tmp_path):
    p = tmp_path / "每日"
    for name, manifest in [("2026-11-01", True), ("2026-11-02", False), ("2026-13-45", True), ("2026-1-1", True),
                           ("notes", True), ("_未完成-2026-11-03-1", True), ("2026-11-04.zip", True)]:
        d = p / name
        d.mkdir(parents=True)
        if manifest:
            (d / "manifest.json").write_text(json.dumps({"status": "OK"}), encoding="utf-8")
    (p / "2026-11-05").write_text("我是檔案不是資料夾")
    got = b.list_backups(str(p))
    assert [i["name"] for i in got] == ["2026-11-01"]


def test_list_backups_unreadable_manifest_counts_but_is_not_ok(tmp_path):
    d = tmp_path / "每日" / "2026-11-01"
    d.mkdir(parents=True)
    (d / "manifest.json").write_text("{壞掉", encoding="utf-8")
    got = b.list_backups(str(tmp_path / "每日"))
    assert len(got) == 1 and got[0]["status"] == "?"


# ---------- 刪除路徑檢查 ----------

def test_guard_accepts_only_dated_folders_directly_under_daily_or_full(tmp_path):
    root = tmp_path / "root"
    for sub in ("每日", "完整歷史"):
        (root / sub / "2026-11-01").mkdir(parents=True)
        b.guard_delete(str(root), str(root / sub / "2026-11-01"))
    b.guard_delete(str(root), str(root / "每日" / "_未完成-2026-11-01-123"))


@pytest.mark.parametrize("rel", [
    "每日", "完整歷史", "紀錄/2026-11-01", "2026-11-01", "每日/2026-11-01/csv", "每日/notes", "每日/../紀錄/2026-11-01",
    "每日/2026-13-01", "每日/還原說明.txt",
])
def test_guard_refuses_everything_else(tmp_path, rel):
    root = tmp_path / "root"
    root.mkdir()
    with pytest.raises(b.BackupError):
        b.guard_delete(str(root), str(root / rel))


def test_guard_refuses_path_outside_root(tmp_path):
    root = tmp_path / "root"
    other = tmp_path / "other" / "每日" / "2026-11-01"
    other.mkdir(parents=True)
    with pytest.raises(b.BackupError):
        b.guard_delete(str(root), str(other))


@pytest.mark.skipif(sys.platform == "win32", reason="Windows 建立 symlink 需要權限")
def test_guard_refuses_symlink(tmp_path):
    root = tmp_path / "root"
    (root / "每日").mkdir(parents=True)
    target = tmp_path / "precious"
    target.mkdir()
    os.symlink(target, root / "每日" / "2026-11-01")
    with pytest.raises(b.BackupError):
        b.guard_delete(str(root), str(root / "每日" / "2026-11-01"))


def test_cleanup_unfinished_only_old_own_folders(tmp_path):
    root = tmp_path / "root"
    parent = root / "每日"
    old = parent / "_未完成-2026-11-01-1"
    new = parent / "_未完成-2026-11-20-2"
    other = parent / "別人的資料夾"
    for d in (old, new, other):
        d.mkdir(parents=True)
    t = old.stat().st_mtime - 3 * 86400
    os.utime(old, (t, t))
    assert b.cleanup_unfinished(str(root), str(parent)) == 1
    assert not old.exists() and new.exists() and other.exists()


# ---------- 狀態 ----------

def test_decide_status():
    assert b.decide_status([], []) == "OK"
    assert b.decide_status([], ["csv"]) == "PARTIAL"
    assert b.decide_status(["fetch"], []) == "STALE"
    assert b.decide_status(["fetch"], ["csv"]) == "STALE"  # fetch 失敗比檔案失敗嚴重


def test_not_worse_ranking():
    assert b.not_worse("OK", "PARTIAL") and b.not_worse("OK", "OK") and b.not_worse("PARTIAL", "STALE")
    assert not b.not_worse("PARTIAL", "OK") and not b.not_worse("STALE", "PARTIAL")
    assert b.not_worse("STALE", None) and b.not_worse("STALE", "?")  # 舊的看不懂就取代


def _staged(tmp_path, content=b"data"):
    src = tmp_path / "src.bin"
    src.write_bytes(content)
    return [(str(src), "a.bin"), (str(src), "csv/b.csv")]


def test_same_day_rerun_replaces_only_when_not_worse(tmp_path):
    parent = str(tmp_path / "每日")
    files = _staged(tmp_path)
    assert b.write_dated_folder(parent, "2026-11-21", files, {"status": "PARTIAL"}) == "written"
    assert b.write_dated_folder(parent, "2026-11-21", files, {"status": "STALE"}) == "kept_old"
    assert json.loads((Path(parent) / "2026-11-21" / "manifest.json").read_text("utf-8"))["status"] == "PARTIAL"
    assert b.write_dated_folder(parent, "2026-11-21", files, {"status": "OK"}) == "replaced"
    assert json.loads((Path(parent) / "2026-11-21" / "manifest.json").read_text("utf-8"))["status"] == "OK"
    assert b.write_dated_folder(parent, "2026-11-21", files, {"status": "PARTIAL"}) == "kept_old"
    # 沒有留下半成品
    assert sorted(os.listdir(parent)) == ["2026-11-21"]
    assert (Path(parent) / "2026-11-21" / "csv" / "b.csv").read_bytes() == b"data"


def test_write_dated_folder_cleans_up_when_copy_fails(tmp_path):
    parent = tmp_path / "每日"
    files = [(str(tmp_path / "不存在.bin"), "a.bin")]
    with pytest.raises(OSError):
        b.write_dated_folder(str(parent), "2026-11-21", files, {"status": "OK"})
    assert os.listdir(parent) == []


def test_copy_verified_detects_mismatch(tmp_path, monkeypatch):
    src = tmp_path / "s"
    src.write_bytes(b"abc")
    monkeypatch.setattr(b.shutil, "copyfile", lambda s, d: Path(d).write_bytes(b"xyz"))
    with pytest.raises(b.BackupError):
        b.copy_verified(str(src), str(tmp_path / "d"))


# ---------- config.js 解析 ----------

def test_parse_real_config_gives_the_seven_published_csvs():
    text = (ROOT / "site" / "js" / "config.js").read_text("utf-8")
    got = b.parse_csv_sources(text)
    assert [(s["name"], s["gid"]) for s in got] == [
        ("ledger", 0), ("ledger", 1), ("ledger", 2), ("ledger", 10), ("ledger", 11), ("dashboard", 0), ("dashboard", 5)]
    pub = {n: p for n, p in (("ledger", "LEDGER_PUB"), ("dashboard", "DASH_PUB"))}
    for s in got:
        assert s["url"].startswith("https://docs.google.com/spreadsheets/d/e/2PACX-")
        assert f"gid={s['gid']}&single=true&output=csv" in s["url"]
    assert len({s["url"] for s in got}) == 7 and pub


def test_parse_ignores_commented_out_gids_and_null_pub():
    text = '''const LEDGER_PUB = "AAA";
const DASH_PUB = null;
// sheetCsv(LEDGER_PUB, 99)
const INCOME_GID = 11;
const x = { a: sheetCsv(LEDGER_PUB, 0), // 舊的 sheetCsv(LEDGER_PUB, 98)
  b: sheetCsv(LEDGER_PUB, 1) };'''
    assert [(s["name"], s["gid"]) for s in b.parse_csv_sources(text)] == [("ledger", 0), ("ledger", 1), ("ledger", 11)]


def test_parse_garbage_returns_nothing():
    assert b.parse_csv_sources("export const X = 1;") == []


def test_validate_csv():
    assert b.validate_csv(200, "a,b\n1,2\n".encode()) is None
    assert b.validate_csv(200, "\ufeff名稱,值\n".encode("utf-8")) is None
    assert "HTML" in b.validate_csv(200, b"<!DOCTYPE html><html>")
    assert "HTML" in b.validate_csv(200, b"\n  <html>")
    assert "404" in b.validate_csv(404, b"")
    assert "UTF-8" in b.validate_csv(200, b"\xff\xfe\x00a")


# ---------- 打包與清理 ----------

def test_zip_folder_keeps_empty_dirs_and_utf8_names(tmp_path):
    src = tmp_path / "private"
    (src / "空資料夾").mkdir(parents=True)
    (src / "sub").mkdir()
    (src / "sub" / "備註.txt").write_text("你好", encoding="utf-8")
    (src / "a.txt").write_text("a")
    dest = tmp_path / "p.zip"
    files, nbytes = b.zip_folder(str(src), str(dest))
    assert files == 2 and nbytes == len("你好".encode()) + 1
    with zipfile.ZipFile(dest) as zf:
        assert sorted(zf.namelist()) == ["a.txt", "sub/備註.txt", "空資料夾/"]
        assert zf.read("sub/備註.txt").decode("utf-8") == "你好"


def test_backup_folder_missing_is_warning_not_failure(tmp_path):
    entry, zp, warns, problems = b.backup_folder("claude-memory", str(tmp_path / "nope"), str(tmp_path))
    assert zp is None and entry["missing"] and warns and not problems


def test_rmtree_force_removes_read_only_files(tmp_path):
    d = tmp_path / "t" / "objects"
    d.mkdir(parents=True)
    f = d / "pack.idx"
    f.write_text("x")
    os.chmod(f, stat.S_IREAD)
    b.rmtree_force(str(tmp_path / "t"))
    assert not (tmp_path / "t").exists()


# ---------- 鎖、時間、找雲端硬碟 ----------

def test_lock_exclusive_and_stale_replaced(tmp_path):
    lock = str(tmp_path / "x.lock")
    assert b.acquire_lock(lock) == lock
    assert b.acquire_lock(lock) is None  # 第二個拿不到
    t = os.path.getmtime(lock) - 3 * 3600
    os.utime(lock, (t, t))
    assert b.acquire_lock(lock) == lock  # 超過 2 小時視為卡死
    b.release_lock(lock)
    assert not os.path.exists(lock)


def test_fixed_plus8_timezone():
    assert b.TZ.utcoffset(None) == dt.timedelta(hours=8)
    assert b.iso(b.now()).endswith("+08:00")


def test_find_root_exit_codes():
    sleeps = []
    nap = lambda s: sleeps.append(s)
    # 找到而且 GoogleDriveFS 有在跑
    assert b.find_root(0, scan=lambda: ("G:/x", False), running=lambda: True, sleep=nap) == ("G:/x", 0)
    # 完全找不到 → 10
    assert b.find_root(0, scan=lambda: (None, False), running=lambda: True, sleep=nap) == (None, 10)
    # 有資料夾但沒有標記檔 → 11
    assert b.find_root(0, scan=lambda: (None, True), running=lambda: True, sleep=nap) == (None, 11)
    # 有標記檔但 GoogleDriveFS 沒在跑 → 10
    assert b.find_root(0, scan=lambda: ("G:/x", False), running=lambda: False, sleep=nap) == (None, 10)


def test_find_root_retries_until_it_appears(monkeypatch):
    answers = iter([(None, False), (None, False), ("G:/x", False)])
    clock = [0.0]
    monkeypatch.setattr(b.time, "monotonic", lambda: clock[0])

    def nap(s):
        clock[0] += s
    got = b.find_root(600, interval=30, scan=lambda: next(answers), running=lambda: True, sleep=nap)
    assert got == ("G:/x", 0) and clock[0] == 60


def test_scan_drives_needs_marker_file(tmp_path):
    base = tmp_path / "我的雲端硬碟" / "stock-dashboard 備份"
    base.mkdir(parents=True)
    assert b.scan_drives([str(base)]) == (None, True)
    (base / b.P["MARKER"]).write_text("x", encoding="utf-8")
    assert b.scan_drives([str(base)]) == (str(base), False)
    assert b.scan_drives([str(tmp_path / "沒有")]) == (None, False)


def test_main_without_marker_exits_11_and_writes_nothing(tmp_path, monkeypatch):
    tempfile_dir(monkeypatch, tmp_path)
    root = tmp_path / "root"
    root.mkdir()
    assert b.main(["--root", str(root), "--no-notify"]) == 11
    assert os.listdir(root) == []


def tempfile_dir(monkeypatch, tmp_path):
    """把 %TEMP% 指到暫存資料夾，鎖檔與 sdbackup-* 都不會跑到真的 TEMP。"""
    import tempfile
    (tmp_path / "tmp").mkdir(exist_ok=True)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    return tempfile


def test_main_exits_12_when_locked(tmp_path, monkeypatch):
    tempfile_dir(monkeypatch, tmp_path)
    root = tmp_path / "root"
    root.mkdir()
    (root / b.P["MARKER"]).write_text("x", encoding="utf-8")
    lock = b.acquire_lock()
    try:
        assert b.main(["--root", str(root), "--no-notify"]) == 12
    finally:
        b.release_lock(lock)


def test_init_creates_marker_and_folders(tmp_path):
    root = tmp_path / "備份根"
    assert b.main(["--init", "--root", str(root)]) == 0
    assert (root / b.P["MARKER"]).is_file()
    assert {"每日", "完整歷史", "紀錄"} <= set(os.listdir(root))


# ---------- 看門狗（Apps Script）與 Python 輸出的欄位對照 ----------

GS = ROOT / "apps_script" / "backup_watchdog.gs"


def _gs_samples():
    """backup_watchdog.gs 的 selfTest 假資料（JSON 字面值，用 /*JSON:名稱*/ … /*END*/ 框起來）。"""
    import re
    text = GS.read_text("utf-8")
    got = dict(re.findall(r"/\*JSON:(\w+)\*/\s*(.*?)\s*/\*END\*/", text, re.S))
    assert set(got) == {"state", "manifest", "bundle"}
    return {k: json.loads(v) for k, v in got.items()}


def _shape_diff(a, b, path=""):
    """比對兩個 JSON 的欄位結構：dict 的鍵要一樣；list 兩邊都有元素時比第一個元素；值的內容不比。"""
    if isinstance(a, dict) and isinstance(b, dict):
        out = [f"{path}.{k} 只在假資料裡" for k in sorted(set(a) - set(b))]
        out += [f"{path}.{k} 只在 Python 輸出裡" for k in sorted(set(b) - set(a))]
        for k in set(a) & set(b):
            out += _shape_diff(a[k], b[k], f"{path}.{k}")
        return out
    if isinstance(a, list) and isinstance(b, list):
        return _shape_diff(a[0], b[0], path + "[]") if a and b else []
    if isinstance(a, (dict, list)) != isinstance(b, (dict, list)):
        return [f"{path} 型別不同"]
    return []


def _watchdog_daily_files(m):
    """跟 backup_watchdog.gs 的 filesOf_(manifest, "daily") 一樣的取法。"""
    out = [(r["archive"]["file"], r["archive"]["bytes"]) for r in m["repos"].values() if r.get("archive")]
    out += [(f["zip"]["file"], f["zip"]["bytes"]) for f in m["folders"].values() if f.get("zip")]
    out += [(c["file"], c["bytes"]) for c in m["csv"] if c.get("ok")]
    return out


def _watchdog_bundle_files(fm):
    return [(r["bundle"]["file"], r["bundle"]["bytes"]) for r in fm["repos"].values() if r.get("bundle")]


def test_watchdog_samples_have_the_documented_shape():
    s = _gs_samples()
    assert s["state"]["schema"] == 1 and s["state"]["last_ok_folder"] == s["state"]["last_ok"][:10]
    assert {"last_attempt", "last_attempt_status", "last_ok", "last_ok_folder", "last_bundle_folder"} <= set(s["state"])
    assert s["manifest"]["status"] == "OK" and len(s["manifest"]["csv"]) == 7
    assert _watchdog_bundle_files(s["bundle"]) and len(_watchdog_daily_files(s["manifest"])) == 12


def test_watchdog_manifest_json_has_only_the_four_scopes():
    m = json.loads((ROOT / "apps_script" / "backup_watchdog.appsscript.json").read_text("utf-8"))
    assert sorted(m["oauthScopes"]) == [
        "https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/script.scriptapp",
        "https://www.googleapis.com/auth/script.send_mail", "https://www.googleapis.com/auth/userinfo.email"]
    assert m["timeZone"] == "Asia/Taipei"


def test_watchdog_source_has_no_email_ids_or_http_calls():
    import re
    text = GS.read_text("utf-8")
    assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    assert not re.search(r"UrlFetchApp|getFolderById|getFileById|openById|ghp_|github_pat_", text)
    assert "const W = {" in text and "function evaluate_(" in text


def test_watchdog_flags_a_missing_file_in_a_real_backup(world):
    """用 Python 真的寫出來的雲端資料夾，照看門狗的方式核對：少一個檔就會被發現。"""
    root = world["root"]
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    day = next((root / "每日").iterdir())
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    (day / "private.zip").unlink()
    missing = [rel for rel, n in _watchdog_daily_files(m) if not (day / rel).is_file()]
    assert missing == ["private.zip"]


# ---------- 完整流程（暫存資料夾裡的迷你 repo，不碰網路與真的 repo）----------

def _git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    r = subprocess.run(["git", "-c", "core.autocrlf=false", *args], cwd=cwd, env=env, capture_output=True, text=True,
                       encoding="utf-8")
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def make_repo(base, name, files):
    """建 <name>-origin.git（假的 GitHub）與工作目錄 <name>，推上 main。"""
    origin = base / f"{name}-origin.git"
    work = base / name
    _git(base, "init", "--bare", "-q", "-b", "main", str(origin))
    # push 時 receive-pack 在 origin 那一側執行，收不到測試設的 GIT_CONFIG_* 環境變數：深路徑要在 origin 自己的設定開 longpaths
    _git(origin, "config", "core.longpaths", "true")
    _git(base, "init", "-q", "-b", "main", str(work))
    for rel, content in files.items():
        p = work / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", "init")
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "push", "-q", "origin", "main")
    return work


CSV_BODY = "名稱,值\n甲,1\n".encode("utf-8")


@pytest.fixture
def world(tmp_path, monkeypatch):
    if shutil.which("git") is None:
        pytest.skip("需要 git")
    tempfile_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    # pytest 的暫存路徑很深，Windows 上 git 會撞 MAX_PATH：測試用的 git 也開 longpaths
    monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
    monkeypatch.setenv("GIT_CONFIG_KEY_0", "core.longpaths")
    monkeypatch.setenv("GIT_CONFIG_VALUE_0", "true")
    cfg = (ROOT / "site" / "js" / "config.js").read_bytes()
    repos = {
        "stock-dashboard": make_repo(tmp_path, "stock-dashboard", {"site/js/config.js": cfg, "docs/RESTORE.md": "# 還原\n".encode()}),
        "market-data": make_repo(tmp_path, "market-data", {"data/a.csv": b"x,y\r\n1,2\r\n", "readme.txt": "舊檔\n".encode()}),
        "market-data-private": make_repo(tmp_path, "market-data-private", {"p.txt": b"secret"}),
    }
    (tmp_path / "private").mkdir()
    (tmp_path / "private" / "k.txt").write_text("k")
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "m.md").write_text("m")
    monkeypatch.setitem(b.P, "REPOS", {n: str(p) for n, p in repos.items()})
    monkeypatch.setitem(b.P, "PRIVATE_DIR", str(tmp_path / "private"))
    monkeypatch.setitem(b.P, "MEMORY_DIR", str(tmp_path / "memory"))
    monkeypatch.setattr(b, "http_get", lambda url, timeout=60: (200, CSV_BODY))
    root = tmp_path / "雲端" / "stock-dashboard 備份"
    assert b.main(["--init", "--root", str(root)]) == 0
    return dict(root=root, repos=repos, tmp=tmp_path)


def tree_listing(root):
    return sorted(str(p.relative_to(root)) for p in Path(root).rglob("*"))


def test_full_run_ok_then_restore(world, capsys):
    root, repos, tmp = world["root"], world["repos"], world["tmp"]
    before_head = {n: _git(p, "rev-parse", "HEAD") for n, p in repos.items()}
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    day = next(p for p in (root / "每日").iterdir())
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    assert m["status"] == "OK" and len(m["csv"]) == 7 and all(c["ok"] for c in m["csv"])
    assert sorted(f.name for f in day.iterdir() if f.is_file()) == [
        "claude-memory.zip", "manifest.json", "market-data-private.zip", "market-data.zip", "private.zip", "stock-dashboard.zip"]
    assert len(list((day / "csv").iterdir())) == 7
    # 所有 sha256 都對得上
    for r in m["repos"].values():
        assert b.sha256_file(str(day / r["archive"]["file"])) == r["archive"]["sha256"]
    # market-data 的 CRLF 沒被換行轉換改掉
    with zipfile.ZipFile(day / "market-data.zip") as zf:
        assert zf.read("market-data/data/a.csv") == b"x,y\r\n1,2\r\n"
    # 完整歷史
    full = next((root / "完整歷史").iterdir())
    fm = json.loads((full / "manifest.json").read_text("utf-8"))
    assert fm["status"] == "OK" and len(list(full.glob("*.bundle"))) == 3
    out = tmp / "restored"
    _git(tmp, "clone", "-q", str(full / "market-data.bundle"), str(out))
    assert _git(out, "rev-parse", "HEAD") == m["repos"]["market-data"]["commit"]
    _git(out, "fsck", "--full")
    # 還原說明、狀態檔、紀錄
    assert (root / "還原說明.txt").read_text("utf-8") == "# 還原\n"
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    assert st["schema"] == 1 and st["last_attempt_status"] == "OK" and st["last_ok"]
    assert st["last_ok_folder"] == day.name and st["last_bundle_folder"] == full.name
    assert st["last_attempt"].endswith("+08:00") and st["last_ok"].endswith("+08:00")
    assert list((root / "紀錄").glob("*.log"))
    # 暫存都清掉、原 repo 沒被動到
    assert not [p for p in (tmp / "tmp").iterdir() if p.name.startswith("sdbackup-") or p.name.endswith(".lock")]
    assert before_head == {n: _git(p, "rev-parse", "HEAD") for n, p in repos.items()}
    assert not [p for p in root.rglob("*") if p.name.startswith(b.UNFINISHED)]
    # 看門狗（apps_script/backup_watchdog.gs）靠這些欄位核對雲端檔案：路徑與大小要對得上實際寫出的檔案
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    for d, mf, listed in ((day, m, _watchdog_daily_files(m)), (full, fm, _watchdog_bundle_files(fm))):
        assert listed
        for rel, nbytes in listed:
            assert (d / rel).is_file() and (d / rel).stat().st_size == nbytes, rel
    assert len(_watchdog_daily_files(m)) == 5 + 7  # 5 個 zip、7 個 CSV
    # 看門狗用的假資料欄位與這次真的寫出來的一致
    s = _gs_samples()
    assert _shape_diff(s["state"], st) == []
    assert _shape_diff(s["manifest"], m) == []
    assert _shape_diff(s["bundle"], fm) == []


def test_dry_run_writes_nothing(world, capsys):
    root, tmp = world["root"], world["tmp"]
    snap, tsnap = tree_listing(root), tree_listing(tmp / "tmp")
    assert b.main(["--dry-run", "--root", str(root)]) == 0
    assert tree_listing(root) == snap and tree_listing(tmp / "tmp") == tsnap
    assert "dry-run" in capsys.readouterr().out


def make_old_backups(root, n=17, start="2026-09-01"):
    s = D.fromisoformat(start)
    for i in range(n):
        d = root / "每日" / (s + dt.timedelta(days=i)).isoformat()
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"status": "OK"}), encoding="utf-8")


def test_stale_when_fetch_fails_and_nothing_deleted(world):
    root = world["root"]
    make_old_backups(root)
    _git(world["repos"]["market-data"], "remote", "set-url", "origin", str(world["tmp"] / "不存在.git"))
    before = tree_listing(root / "每日")
    assert b.main(["--root", str(root), "--no-notify"]) == 1
    day = root / "每日" / b.now().date().isoformat()
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    assert m["status"] == "STALE" and m["repos"]["market-data"]["fetch_ok"] is False
    assert (day / "market-data.zip").is_file()  # 用上次成功 fetch 的 origin/main 打包
    assert set(before) <= set(tree_listing(root / "每日"))  # 舊的一份都沒少
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    assert st["last_attempt_status"] == "STALE" and st["last_ok"] is None and st["last_ok_folder"] is None
    # 完整歷史照做（GitHub 連不上時，本機的 commit 更要備到）：manifest 標 STALE，內容是本機現有的 origin/*
    full = root / "完整歷史" / b.now().date().isoformat()
    fm = json.loads((full / "manifest.json").read_text("utf-8"))
    assert fm["status"] == "STALE" and fm["repos"]["market-data"]["fetch_ok"] is False
    assert fm["repos"]["stock-dashboard"]["fetch_ok"] is True
    assert st["last_bundle_folder"] == full.name


def test_stale_full_history_is_redone_as_soon_as_fetch_works_again(world, capsys):
    root, wd = world["root"], world["repos"]["market-data"]
    url = _git(wd, "remote", "get-url", "origin")
    _git(wd, "remote", "set-url", "origin", str(world["tmp"] / "不存在.git"))
    assert b.main(["--root", str(root), "--no-notify"]) == 1
    full = root / "完整歷史" / b.now().date().isoformat()
    assert json.loads((full / "manifest.json").read_text("utf-8"))["status"] == "STALE"
    _git(wd, "remote", "set-url", "origin", url)  # 同一天恢復：不用等 7 天
    assert b.main(["--dry-run", "--root", str(root)]) == 0
    assert "STALE" in capsys.readouterr().out
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    fm = json.loads((full / "manifest.json").read_text("utf-8"))
    assert fm["status"] == "OK" and all(r["fetch_ok"] for r in fm["repos"].values())
    assert len(list((root / "完整歷史").iterdir())) == 1  # 同一天取代，不是多一份
    # 已經是 OK：下一次不再重做（還沒滿 7 天）
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    assert json.loads((full / "manifest.json").read_text("utf-8"))["finished"] == fm["finished"]


def test_bundle_due_stale_latest_needs_a_successful_fetch():
    t, d = D(2026, 11, 20), D(2026, 11, 21)
    assert b.bundle_due(t, d, 7, latest_status="STALE", fetch_ok=True)
    assert not b.bundle_due(t, d, 7, latest_status="STALE", fetch_ok=False)  # 又連不上：不用每次都重做
    assert not b.bundle_due(t, d, 7, latest_status="OK", fetch_ok=True)


def test_partial_when_csv_is_html_and_nothing_deleted(world, monkeypatch):
    root = world["root"]
    make_old_backups(root)
    monkeypatch.setattr(b, "http_get", lambda url, timeout=60: (200, b"<html>login</html>") if "gid=5" in url else (200, CSV_BODY))
    assert b.main(["--root", str(root), "--no-notify"]) == 1
    day = root / "每日" / b.now().date().isoformat()
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    assert m["status"] == "PARTIAL" and sum(1 for c in m["csv"] if not c["ok"]) == 1
    assert len(list((day / "csv").iterdir())) == 6
    assert len(list((root / "每日").iterdir())) == 17 + 1


def test_ok_run_deletes_old_backups_within_limit(world):
    root = world["root"]
    make_old_backups(root, 16)
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    left = sorted(p.name for p in (root / "每日").iterdir())
    assert b.now().date().isoformat() in left
    assert len(left) <= 16 + 1 and len(left) >= 14
    assert "2026-09-01" in left  # 當月最早的 OK 一直保留


def test_non_fast_forward_is_partial(world):
    root, repos = world["root"], world["repos"]
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    # 在假的 GitHub 上改寫 market-data 的歷史（強制推送）
    wd = repos["market-data"]
    _git(wd, "commit", "-q", "--amend", "-m", "rewritten", "--allow-empty")
    _git(wd, "push", "-q", "-f", "origin", "main")
    (root / "每日" / b.now().date().isoformat()).rename(root / "每日" / "2026-01-01")  # 讓第二次不是同一天
    assert b.main(["--root", str(root), "--no-notify"]) == 1
    m = json.loads((root / "每日" / b.now().date().isoformat() / "manifest.json").read_text("utf-8"))
    assert m["status"] == "PARTIAL" and m["repos"]["market-data"]["non_fast_forward"] is True


def test_unpushed_local_branch_is_bundled_and_warned(world):
    root, repos = world["root"], world["repos"]
    wd = repos["market-data"]
    _git(wd, "checkout", "-q", "-b", "wip")
    (wd / "wip.txt").write_text("尚未推上去")
    _git(wd, "add", "wip.txt")
    _git(wd, "commit", "-q", "-m", "wip")
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    day = root / "每日" / b.now().date().isoformat()
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    assert m["repos"]["market-data"]["unpushed_local_branches"] == [{"branch": "wip", "ahead": 1}]
    assert any("尚未" in w or "還沒推" in w for w in m["warnings"])
    full = next((root / "完整歷史").iterdir())
    out = world["tmp"] / "r2"
    _git(world["tmp"], "clone", "-q", "--mirror", str(full / "market-data.bundle"), str(out))
    assert "refs/heads/local/wip" in _git(out, "for-each-ref", "--format=%(refname)")
    assert _git(wd, "branch", "--show-current") == "wip"  # 原 repo 的分支沒被切換


# ---------- 審查後的修正 ----------

def test_empty_root_is_rejected_and_never_looks_for_the_real_drive(monkeypatch, capsys):
    def boom(*a, **k):
        raise AssertionError("不該去找真的雲端硬碟")
    monkeypatch.setattr(b, "scan_drives", boom)
    monkeypatch.setattr(b, "drive_fs_running", boom)
    monkeypatch.setattr(b, "candidate_bases", boom)
    for argv in (["--init", "--root", ""], ["--root", ""], ["--dry-run", "--root", ""], ["--init", "--root", "  "]):
        assert b.main(argv + ["--no-notify"]) == 2
    assert b.main(["--accept-rewrite", "不存在的repo"]) == 2


def test_stale_full_history_never_pushes_out_the_newest_ok_bundle():
    its = [item("2026-10-24"), item("2026-10-31", "STALE"), item("2026-11-07", "STALE")]
    assert b.bundle_keep(its, D(2026, 11, 8), 2) == {"2026-10-24", "2026-10-31", "2026-11-07"}


def test_nff_baseline_picks_the_newer_of_prev_ok_and_accepted():
    acc = {"commit": "A", "at": "2026-11-21T10:00:00+08:00"}
    assert b.nff_baseline("P", "2026-11-21T09:00:00+08:00", acc, None) == "A"   # 確認得比上一份 OK 備份晚
    assert b.nff_baseline("P", "2026-11-21T11:00:00+08:00", acc, None) == "P"   # 之後又有 OK 備份了
    assert b.nff_baseline("P", "2026-11-21T09:00:00+08:00", None, None) == "P"
    assert b.nff_baseline(None, None, acc, None) == "A"
    assert b.nff_baseline("P", "2026-11-21T11:00:00+08:00", acc, "NOW") == "NOW"  # 這次剛下 --accept-rewrite
    assert b.nff_baseline(None, None, None, None) is None


def test_private_folder_missing_or_empty_is_a_problem_not_a_warning(tmp_path):
    src = tmp_path / "private"
    entry, zp, warns, problems = b.backup_folder("private", str(src), str(tmp_path), required=True)
    assert zp is None and problems and not warns  # 不存在
    src.mkdir()
    entry, zp, warns, problems = b.backup_folder("private", str(src), str(tmp_path), required=True)
    assert zp is None and problems and not warns  # 空的
    entry, zp, warns, problems = b.backup_folder("claude-memory", str(tmp_path / "nope"), str(tmp_path))
    assert zp is None and warns and not problems  # 記憶資料夾維持只警告


def test_private_missing_makes_partial_keeps_old_backups_and_notifies_once(world, monkeypatch):
    root = world["root"]
    make_old_backups(root)
    shutil.rmtree(world["tmp"] / "private")
    calls = []
    monkeypatch.setattr(b, "notify", lambda t, body: calls.append((t, body)))
    assert b.main(["--root", str(root)]) == 1
    day = root / "每日" / b.now().date().isoformat()
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    assert m["status"] == "PARTIAL" and any("private" in p for p in m["problems"])
    assert not (day / "private.zip").exists() and (day / "claude-memory.zip").exists()
    assert len(list((root / "每日").iterdir())) == 17 + 1
    assert len(calls) == 1 and calls[0][0] == "備份 PARTIAL" and "private" in calls[0][1]


def test_memory_folder_missing_is_still_ok(world):
    shutil.rmtree(world["tmp"] / "memory")
    assert b.main(["--root", str(world["root"]), "--no-notify"]) == 0


def test_run_cmd_timeout_kills_grandchildren_quickly():
    code = ("import subprocess, sys, time\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            "time.sleep(60)\n")
    t0 = time.monotonic()
    rc, out, err = b.run_cmd([sys.executable, "-c", code], timeout=2)
    assert rc == -1 and time.monotonic() - t0 < 15
    assert "逾時" in err.decode()


@pytest.mark.skipif(sys.platform != "win32", reason="taskkill 的程序樹行為只在 Windows 上驗證")
def test_run_cmd_returns_within_timeout_plus_30_when_a_grandchild_outlives_its_parent(tmp_path):
    """中間層程序立刻結束、孫程序（握著輸出管線）睡 70 秒：孫程序不在 taskkill 的樹裡。
    run_cmd 不能為了關管線等到孫程序結束，要在 timeout＋30 秒內回來。"""
    pidfile = tmp_path / "gc.pid"
    child = f"import os, time; open({str(pidfile)!r}, 'w').write(str(os.getpid())); time.sleep(70)"
    code = f"import subprocess, sys; subprocess.Popen([sys.executable, '-c', {child!r}])"
    t0 = time.monotonic()
    try:
        rc, out, err = b.run_cmd([sys.executable, "-c", code], timeout=2)
        elapsed = time.monotonic() - t0
    finally:
        if pidfile.exists():
            subprocess.run(["taskkill", "/PID", pidfile.read_text().strip(), "/F"], capture_output=True)
    assert rc == -1 and "逾時" in err.decode()
    assert elapsed < 40, elapsed


@pytest.mark.skipif(sys.platform != "win32", reason="git-remote-http 孫程序只在 Windows 上驗證")
def test_git_fetch_against_a_silent_server_returns_in_time_and_leaves_no_remote_helper(tmp_path):
    import socket
    import threading
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)
    conns = []
    stop = threading.Event()

    def accept():
        srv.settimeout(0.5)
        while not stop.is_set():
            try:
                conns.append(srv.accept()[0])  # 接受連線但永遠不回應
            except OSError:
                pass
    th = threading.Thread(target=accept, daemon=True)
    th.start()

    port = srv.getsockname()[1]

    def helpers():
        # 只數「這次」的：git-remote-http 的命令列帶著這次的連接埠；別的 session 同時在 fetch 不會被算進來
        ps = ("(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'git-remote-http.exe' -and "
              "$_.CommandLine -like '*127.0.0.1:" + str(port) + "*' } | Measure-Object).Count")
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True)
        return int(r.stdout.strip() or "0")
    repo = tmp_path / "r"
    _git(tmp_path, "init", "-q", str(repo))
    _git(repo, "remote", "add", "origin", f"http://127.0.0.1:{port}/x.git")
    t0 = time.monotonic()
    try:
        rc, out, err = b.git(str(repo), "fetch", "origin", timeout=3)
        elapsed = time.monotonic() - t0
    finally:
        stop.set()
        th.join(2)
        for c in conns:
            c.close()
        srv.close()
    assert rc != 0 and elapsed < 10, elapsed
    time.sleep(1)
    assert helpers() == 0


def test_cleanup_old_temp_removes_only_old_sdbackup_dirs(tmp_path):
    old, new, other, lock = tmp_path / "sdbackup-old", tmp_path / "sdbackup-new", tmp_path / "別的資料夾", tmp_path / "sdbackup.lock"
    for d in (old, new, other):
        (d / "sub").mkdir(parents=True)
        (d / "sub" / "f").write_text("x")
    lock.write_text("1")
    t = time.time() - 2 * 86400
    os.utime(old, (t, t))
    os.utime(other, (t, t))
    os.utime(lock, (t, t))
    assert b.cleanup_old_temp(str(tmp_path)) == 1
    assert not old.exists() and new.exists() and other.exists() and lock.exists()


def test_main_cleans_stale_temp_dirs_from_a_killed_run(world):
    tmpdir = world["tmp"] / "tmp"
    old = tmpdir / "sdbackup-killed"
    old.mkdir()
    t = time.time() - 3 * 86400
    os.utime(old, (t, t))
    assert b.main(["--root", str(world["root"]), "--no-notify"]) == 0
    assert not old.exists()


def test_mirror_clone_restore_keeps_every_branch(world):
    """RESTORE.md 的搬家步驟：clone --mirror → set-url → push --mirror，local/* 分支也要在新主機上。"""
    root, repos, tmp = world["root"], world["repos"], world["tmp"]
    wd = repos["market-data"]
    _git(wd, "checkout", "-q", "-b", "wip")
    (wd / "wip.txt").write_text("尚未推上去")
    _git(wd, "add", "wip.txt")
    _git(wd, "commit", "-q", "-m", "wip")
    _git(wd, "tag", "v1")
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    bundle = next((root / "完整歷史").iterdir()) / "market-data.bundle"
    mirror, newhost = tmp / "m.git", tmp / "newhost.git"
    _git(tmp, "init", "--bare", "-q", str(newhost))
    _git(tmp, "clone", "-q", "--mirror", str(bundle), str(mirror))
    _git(mirror, "remote", "set-url", "origin", str(newhost))
    _git(mirror, "push", "-q", "--mirror")
    refs = _git(newhost, "for-each-ref", "--format=%(refname)").split()
    assert {"refs/heads/main", "refs/heads/local/wip", "refs/tags/v1"} <= set(refs)
    # 一般 clone：local/* 分支出現在 origin/local/*
    plain = tmp / "plain"
    _git(tmp, "clone", "-q", str(bundle), str(plain))
    assert "origin/local/wip" in _git(plain, "branch", "-r")


def _push_amend(wd):
    _git(wd, "commit", "-q", "--amend", "-m", "rewritten " + str(time.time()), "--allow-empty")
    _git(wd, "push", "-q", "-f", "origin", "main")


def test_force_push_is_partial_until_accept_rewrite_then_ok_again(world):
    root, wd = world["root"], world["repos"]["market-data"]
    argv = ["--root", str(root), "--no-notify"]
    assert b.main(argv) == 0
    _push_amend(wd)
    assert b.main(argv) == 1  # 歷史被改寫
    assert b.main(argv) == 1  # 再跑一次還是 PARTIAL（基準沒變）
    assert b.main(argv + ["--accept-rewrite", "market-data"]) == 0
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    assert st["rewrite_accepted"]["market-data"]["commit"] == _git(wd, "rev-parse", "HEAD")
    (wd / "more.txt").write_text("正常推送")
    _git(wd, "add", "more.txt")
    _git(wd, "commit", "-q", "-m", "more")
    _git(wd, "push", "-q", "origin", "main")
    assert b.main(argv) == 0  # 之後正常推送一樣 OK


def test_nff_check_failure_is_a_problem_and_accept_rewrite_clears_it(world):
    root = world["root"]
    argv = ["--root", str(root), "--no-notify"]
    assert b.main(argv) == 0
    day = next((root / "每日").iterdir())
    m = json.loads((day / "manifest.json").read_text("utf-8"))
    m["repos"]["market-data"]["commit"] = "0" * 40  # 上一份 OK 備份記的基準 commit 在 repo 裡找不到（git 回 128）
    (day / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    day.rename(root / "每日" / "2026-01-02")  # 換一天，同一天的話新的 PARTIAL 比舊的 OK 差、不會取代，就看不到這次的結果
    assert b.main(argv) == 1
    m3 = json.loads((root / "每日" / b.now().date().isoformat() / "manifest.json").read_text("utf-8"))
    assert m3["status"] == "PARTIAL" and m3["repos"]["market-data"]["nff_check_error"]
    assert any("非快轉檢查失敗" in p for p in m3["problems"]) and not m3["repos"]["market-data"]["non_fast_forward"]
    assert b.main(argv + ["--accept-rewrite", "market-data"]) == 0


def test_stale_bundle_clone_main_equals_local_origin_main(world):
    root, wd = world["root"], world["repos"]["market-data"]
    origin_main = _git(wd, "rev-parse", "origin/main")
    _git(wd, "remote", "set-url", "origin", str(world["tmp"] / "不存在.git"))
    (wd / "local-only.txt").write_text("只在本機")
    _git(wd, "add", "local-only.txt")
    _git(wd, "commit", "-q", "-m", "local only")
    assert b.main(["--root", str(root), "--no-notify", "--force-bundle"]) == 1
    full = next((root / "完整歷史").iterdir())
    assert json.loads((full / "manifest.json").read_text("utf-8"))["status"] == "STALE"
    out = world["tmp"] / "clone"
    _git(world["tmp"], "clone", "-q", "--mirror", str(full / "market-data.bundle"), str(out))
    assert _git(out, "rev-parse", "refs/heads/main") == origin_main
    assert _git(out, "rev-parse", "refs/heads/local/main") == _git(wd, "rev-parse", "HEAD")  # 本機新的 commit 也備到了


def test_future_dated_full_history_does_not_block_the_bundle(world, capsys):
    root = world["root"]
    d = root / "完整歷史" / "2099-01-01"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps({"status": "OK"}), encoding="utf-8")
    assert b.main(["--dry-run", "--root", str(root)]) == 0
    assert "這次要做" in capsys.readouterr().out
    assert b.main(["--root", str(root), "--no-notify"]) == 0
    today = b.now().date().isoformat()
    assert (root / "完整歷史" / today / "manifest.json").is_file()
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    assert st["last_bundle_folder"] == today  # 不是 2099-01-01


def test_same_day_swap_failure_keeps_both_copies(tmp_path, monkeypatch):
    parent = tmp_path / "每日"
    files = _staged(tmp_path)
    assert b.write_dated_folder(str(parent), "2026-11-21", files, {"status": "PARTIAL"}, pid=7) == "written"
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    real = os.rename
    calls = []

    def flaky(src, dst):
        calls.append(1)
        if len(calls) == 1:  # 第一次（正式 → -舊）成功，之後全部失敗
            return real(src, dst)
        raise PermissionError("被占用")
    monkeypatch.setattr(b.os, "rename", flaky)
    with pytest.raises(b.BackupError) as ei:
        b.write_dated_folder(str(parent), "2026-11-21", files, {"status": "OK"}, pid=7)
    monkeypatch.undo()
    msg = str(ei.value)
    old, new = parent / "_未完成-2026-11-21-7-舊", parent / "_未完成-2026-11-21-7"
    assert str(old) in msg and str(new) in msg
    assert (old / "manifest.json").is_file() and (new / "manifest.json").is_file()  # 舊的新的都在
    assert not (parent / "2026-11-21").exists()
    # 清理：正式資料夾不見時，「-舊」不能被清掉
    t = time.time() - 5 * 86400
    for d in (old, new):
        os.utime(d, (t, t))
    b.cleanup_unfinished(str(tmp_path), str(parent))
    assert old.exists()  # （過期的 staging 照規格會被清掉，只有「-舊」受保護）
    # 正式資料夾回來之後，過期的「-舊」才清得掉
    (parent / "2026-11-21").mkdir()
    os.utime(old, (t, t))
    b.cleanup_unfinished(str(tmp_path), str(parent))
    assert not old.exists() and (parent / "2026-11-21").exists()


def test_same_day_swap_retry_succeeds_on_second_try(tmp_path, monkeypatch):
    parent = tmp_path / "每日"
    files = _staged(tmp_path)
    b.write_dated_folder(str(parent), "2026-11-21", files, {"status": "PARTIAL"}, pid=7)
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    real = os.rename
    calls = []

    def flaky(src, dst):
        calls.append(1)
        if len(calls) in (2, 3):  # 新→正式 失敗、舊→正式 也失敗，隔一秒再試新→正式 就成功
            raise PermissionError("被占用")
        return real(src, dst)
    monkeypatch.setattr(b.os, "rename", flaky)
    assert b.write_dated_folder(str(parent), "2026-11-21", files, {"status": "OK"}, pid=7) == "replaced"
    monkeypatch.undo()
    assert json.loads((parent / "2026-11-21" / "manifest.json").read_text("utf-8"))["status"] == "OK"
    assert sorted(os.listdir(parent)) == ["2026-11-21"]


def test_rmtree_force_retries_and_reports_leftovers(tmp_path, monkeypatch):
    d = tmp_path / "x"
    (d / "sub").mkdir(parents=True)
    (d / "sub" / "locked.txt").write_text("x")
    naps = []
    monkeypatch.setattr(b.time, "sleep", lambda s: naps.append(s))
    calls = []
    monkeypatch.setattr(b.shutil, "rmtree", lambda *a, **k: calls.append(1))  # 永遠刪不掉
    left = b.rmtree_force(str(d))
    assert len(calls) == 3 and len(naps) == 2 and left and left[0].endswith("locked.txt")
    monkeypatch.undo()
    assert b.rmtree_force(str(d)) == [] and not d.exists()


def test_delete_backup_raises_when_the_folder_survives(tmp_path, monkeypatch):
    root = tmp_path / "root"
    d = root / "每日" / "2026-11-01"
    d.mkdir(parents=True)
    monkeypatch.setattr(b, "rmtree_force", lambda p, *a, **k: [p])
    with pytest.raises(b.BackupError, match="刪不完"):
        b.delete_backup(str(root), str(d))
    assert not d.exists() and any(n.endswith("-刪除") for n in os.listdir(root / "每日"))  # 剩下的已改名，不再像一份備份


def _make_backup_folder(root, name):
    d = root / "每日" / name
    d.mkdir(parents=True)
    (d / "manifest.json").write_text(json.dumps({"status": "OK"}), encoding="utf-8")
    (d / "private.zip").write_bytes(b"x" * 100)
    return d


@pytest.mark.skipif(sys.platform != "win32", reason="只有 Windows 上開著的檔案會擋住刪除")
def test_open_file_blocks_deletion_without_deleting_anything_and_next_run_removes_it(tmp_path, monkeypatch):
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    root = tmp_path / "root"
    d = _make_backup_folder(root, "2026-10-01")
    with open(d / "private.zip", "rb"):  # 真的開著檔案：Windows 連資料夾改名都不讓
        with pytest.raises(b.BackupError, match="改名失敗"):
            b.delete_backup(str(root), str(d))
        # 什麼都沒刪：還是一份完整、可以辨認的備份（不會變成缺 manifest 的孤兒）
        assert (d / "manifest.json").is_file() and (d / "private.zip").is_file()
        assert [i["name"] for i in b.list_backups(str(root / "每日"))] == ["2026-10-01"]
    b.delete_backup(str(root), str(d))  # 關掉之後刪得掉
    assert not d.exists() and os.listdir(root / "每日") == []


def test_half_deleted_backup_is_renamed_then_retried_by_the_next_run(tmp_path, monkeypatch):
    """改名成功、但裡面有檔案刪不掉（manifest.json 先被刪掉了）：不能變成沒人管的孤兒。
    （Windows 上開著的檔案連改名都擋，所以「改名成功才刪不完」只能用模擬的：只刪 manifest.json、留下 private.zip。）"""
    monkeypatch.setattr(b.time, "sleep", lambda s: None)
    root = tmp_path / "root"
    d = _make_backup_folder(root, "2026-10-01")
    real = b.rmtree_force
    blocked = {"on": True}

    def partial(path, *a, **k):
        if blocked["on"]:
            (Path(path) / "manifest.json").unlink()
            return [os.path.join(path, "private.zip")]
        return real(path, *a, **k)
    monkeypatch.setattr(b, "rmtree_force", partial)
    with pytest.raises(b.BackupError, match="刪不完"):
        b.delete_backup(str(root), str(d))
    assert not d.exists()
    left = [n for n in os.listdir(root / "每日") if n.endswith("-刪除")]
    assert len(left) == 1 and left[0].startswith("_未完成-2026-10-01-")
    stuck = root / "每日" / left[0]
    assert (stuck / "private.zip").exists() and not (stuck / "manifest.json").exists()
    assert b.list_backups(str(root / "每日")) == []  # 不再像一份備份
    warnings = []
    b.run_retention(str(root), D(2026, 11, 4), None, warnings)  # 還是擋著：下次執行重試、仍刪不掉就寫進 warnings
    assert any("上次刪到一半" in w and left[0] in w for w in warnings), warnings
    assert stuck.exists()
    blocked["on"] = False  # 擋住的原因消失
    warnings = []
    b.run_retention(str(root), D(2026, 11, 4), None, warnings)  # 清乾淨，不用等 2 天
    assert not stuck.exists() and not warnings


def test_deleting_suffix_folders_are_retried_without_waiting_two_days(tmp_path):
    root = tmp_path / "root"
    parent = root / "每日"
    fresh = parent / "_未完成-2026-10-01-123-刪除"
    young = parent / "_未完成-2026-11-03-456"  # 一般的未完成資料夾，沒滿 2 天不動
    for x in (fresh, young):
        x.mkdir(parents=True)
        (x / "f").write_text("x")
    assert b.cleanup_unfinished(str(root), str(parent)) == 1
    assert not fresh.exists() and young.exists()


def test_retention_failure_is_a_warning_and_not_counted(tmp_path, monkeypatch):
    root = tmp_path / "root"
    make_old_backups(root, 16, "2026-10-20")
    monkeypatch.setattr(b, "rmtree_force", lambda p, *a, **k: [p])
    warnings = []
    n = b.run_retention(str(root), D(2026, 11, 4), None, warnings)
    assert n == 0 and any("刪除舊備份失敗" in w for w in warnings)


def test_undeletable_temp_leaves_a_line_in_the_cloud_log(world, monkeypatch):
    real = b.rmtree_force
    monkeypatch.setattr(b, "rmtree_force",
                        lambda p, *a, **k: ["x.lock"] if os.path.basename(p).startswith("sdbackup-") else real(p, *a, **k))
    assert b.main(["--root", str(world["root"]), "--no-notify"]) == 0
    logs = "".join(p.read_text("utf-8") for p in (world["root"] / "紀錄").glob("*.log"))
    assert "暫存資料夾刪不掉" in logs


def test_notify_passes_text_through_environment_not_the_script(monkeypatch):
    import base64
    seen = {}
    monkeypatch.setattr(b, "run_cmd", lambda cmd, timeout=120, cwd=None, env_extra=None: seen.update(cmd=cmd, env=env_extra) or (0, b"", b""))
    monkeypatch.setattr(b.sys, "platform", "win32")
    title, body = "備份 STALE’s “壞了”", "market-data fetch 失敗：don't '$(rm)' \"x\"\n第二行"
    b.notify(title, body)
    script = base64.b64decode(seen["cmd"][-1]).decode("utf-16-le")
    assert "’" not in script and "壞了" not in script and "fetch" not in script
    assert "$env:SDB_T" in script and "$env:SDB_B" in script
    assert seen["env"] == {"SDB_T": title, "SDB_B": body}


@pytest.mark.skipif(sys.platform != "win32", reason="PowerShell 只在 Windows 上驗證")
def test_environment_text_survives_powershell_unchanged():
    text = "備份 STALE’s “壞了” don't \"x\" $(1+1)"
    rc, out, err = b.run_cmd(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                              "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::Out.Write($env:SDB_T)"],
                             timeout=60, env_extra={"SDB_T": text})
    assert rc == 0 and out.decode("utf-8") == text


def test_git_always_enables_longpaths(monkeypatch):
    seen = []
    monkeypatch.setattr(b, "run_cmd", lambda cmd, timeout=120, cwd=None, env_extra=None: seen.append(cmd) or (0, b"", b""))
    b.git("C:/x", "status")
    assert "core.longpaths=true" in seen[0]
