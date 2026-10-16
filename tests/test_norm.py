"""norm.py：鉅亨網日線 t,o,h,l,c,v 轉 date,volume,open,high,low,close，只保留已收盤的交易日（美東 16:15 以後才收當天）。

norm.py 是腳本（讀 sys.argv、用 datetime.now），用 runpy 執行並把 datetime.now 固定在指定時間。
"""
import csv
import datetime as real_dt
import runpy
import sys
import types
from zoneinfo import ZoneInfo

import pytest

from helpers import ENGINE

ET = ZoneInfo("America/New_York")


def bar(day, close):
    """鉅亨網一根日 K：t 為當天 UTC 00:00 的 unix 秒。"""
    t = int(real_dt.datetime(2026, 10, day, tzinfo=real_dt.timezone.utc).timestamp())
    return f"{t},{close - 1},{close + 1},{close - 2},{close},12345.0"


def run_norm(monkeypatch, tmp_path, lines, now_et):
    src, dst = tmp_path / "raw.txt", tmp_path / "out.csv"
    src.write_text("\n".join(lines) + "\n")
    frozen = now_et

    class FrozenDatetime(real_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return frozen.astimezone(tz)

    fake = types.ModuleType("datetime")
    fake.__dict__.update({k: getattr(real_dt, k) for k in dir(real_dt) if not k.startswith("__")})
    fake.datetime = FrozenDatetime
    monkeypatch.setitem(sys.modules, "datetime", fake)
    monkeypatch.setattr(sys, "argv", ["norm.py", str(src), str(dst)])
    runpy.run_path(str(ENGINE / "norm.py"), run_name="__main__")
    with open(dst, newline="") as f:
        return list(csv.reader(f))


LINES = [bar(13, 100.0), bar(14, 101.0), bar(15, 102.0)]


@pytest.mark.parametrize("now,last", [
    (real_dt.datetime(2026, 10, 15, 16, 14, tzinfo=ET), "2026-10-14"),   # 收盤後 15 分鐘內不收當天
    (real_dt.datetime(2026, 10, 15, 16, 15, tzinfo=ET), "2026-10-15"),
    (real_dt.datetime(2026, 10, 16, 2, 0, tzinfo=ET), "2026-10-15"),     # 台北 10/16 14:00
])
def test_cutoff(monkeypatch, tmp_path, capsys, now, last):
    rows = run_norm(monkeypatch, tmp_path, LINES, now)
    assert rows[-1][0] == last
    assert f"last close {rows[-1][5]}" in capsys.readouterr().out


def test_format_and_cleanup(monkeypatch, tmp_path):
    """容忍反引號與雜訊行；同一天重複取最後一筆；輸出依日期排序、量轉整數。"""
    lines = ["```", "t,o,h,l,c,v", bar(14, 101.0), "`" + bar(13, 100.0) + "`", "isTrading=false",
             bar(14, 101.5), "ROWS=3"]
    rows = run_norm(monkeypatch, tmp_path, lines, real_dt.datetime(2026, 10, 15, 9, 0, tzinfo=ET))
    assert rows == [["2026-10-13", "12345", "99.0", "101.0", "98.0", "100.0"],
                    ["2026-10-14", "12345", "100.5", "102.5", "99.5", "101.5"]]
