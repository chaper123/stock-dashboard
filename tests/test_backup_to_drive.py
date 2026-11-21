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
    assert st["status"] == "OK" and st["last_ok"]
    assert list((root / "紀錄").glob("*.log"))
    # 暫存都清掉、原 repo 沒被動到
    assert not [p for p in (tmp / "tmp").iterdir() if p.name.startswith("sdbackup-") or p.name.endswith(".lock")]
    assert before_head == {n: _git(p, "rev-parse", "HEAD") for n, p in repos.items()}
    assert not [p for p in root.rglob("*") if p.name.startswith(b.UNFINISHED)]


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
    assert not list((root / "完整歷史").iterdir())  # fetch 失敗時不做完整歷史
    st = json.loads((root / "最近備份.json").read_text("utf-8"))
    assert st["status"] == "STALE" and st["last_ok"] is None


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
