"""重新產生黃金測試的預期輸出（tests/golden/*.json：monitor 原始輸出，以及 engine/run.py 的精簡 JSON）。

用法：py -3.14 tests/make_golden.py
只在 engine 經使用者同意修改、或新增案例時執行；產生後用 git diff 檢查差異並寫進 commit 說明。
"""
import sys

from helpers import CASES, GOLDEN, compact_case, run_case


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    GOLDEN.mkdir(exist_ok=True)
    for name in CASES:
        out = run_case(name)
        (GOLDEN / f"{name}.json").write_bytes(out.encode("utf-8"))
        print(f"tests/golden/{name}.json  {len(out)} 字")
        c = compact_case(name)
        (GOLDEN / f"compact_{name}.json").write_bytes(c.encode("utf-8"))
        print(f"tests/golden/compact_{name}.json  {len(c)} 字")


if __name__ == "__main__":
    main()
