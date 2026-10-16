"""測試共用：路徑、黃金測試案例、用子行程執行 engine（和排程一樣是 python monitor.py config.json）。"""
import importlib.util
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENGINE = ROOT / "engine"
FIX = ROOT / "tests" / "fixtures" / "20261015"
GOLDEN = ROOT / "tests" / "golden"

# 名稱 → (程式, config)。config 的 csv 路徑相對於 FIX，執行時 cwd=FIX
CASES = {
    "us_20261015": ("monitor_us.py", "config_us.json"),
    "us_20261015_repo_val": ("monitor_us.py", "config_us_repo_val.json"),
    "tw_20261016": ("monitor.py", "config_tw.json"),
    "tw_20261015_close": ("monitor.py", "config_tw_close.json"),
}


def run_script(args, cwd=FIX):
    """執行 python <args>，回傳 stdout 文字（換行統一成 LF，Windows 的 print 會寫 CRLF）。"""
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    p = subprocess.run([sys.executable, *map(str, args)], cwd=cwd, capture_output=True, env=env)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    return p.stdout.decode("utf-8").replace("\r\n", "\n")


def run_case(name):
    script, config = CASES[name]
    return run_script([ENGINE / script, FIX / config])


def load_module(filename, name=None):
    """以模組方式載入 engine 的檔案（不執行 __main__），給規則邊界測試直接呼叫函式。"""
    name = name or "engine_" + filename.removesuffix(".py")
    spec = importlib.util.spec_from_file_location(name, ENGINE / filename)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
