"""engine/fund_moves.py：主動式 ETF 這週的持股變化（規則和網站 site/js/inside.js 相同）。資料是假的，不是投信的持股。"""
import json
import subprocess
import sys

from helpers import ENGINE, load_module

fm = load_module("fund_moves.py", "engine_fund_moves")

# 日期,代號,名稱,股數,權重（沒有標題列）
HIST = "\n".join([
    "2026-10-20,1111,甲,100000,10.0", "2026-10-20,2222,乙,50000,5.0", "2026-10-20,3333,丙*,20000,2.0",
    "2026-10-20,4444,丁,1000,0.05", "2026-10-20,5555,戊,30000,1.0",
    "2026-10-27,1111,甲,100000,10.0", "2026-10-27,2222,乙,50000,5.0", "2026-10-27,3333,丙*,20000,2.0",
    "2026-10-27,4444,丁,1000,0.05", "2026-10-27,5555,戊,30000,1.0",
    "2026-10-30,1111,甲,120000,12.0", "2026-10-30,2222,乙,47000,4.8", "2026-10-30,3333,丙*,20000,2.0",
    "2026-10-30,4444,丁,1000,0.05", "2026-10-30,5555,戊,30000,1.0", "2026-10-30,6666,己,8000,0.6",
    "2026-11-03,1111,甲,125000,12.5", "2026-11-03,2222,乙,40000,4.0", "2026-11-03,3333,丙*,20400,2.1",
    "2026-11-03,4444,丁,2000,0.08", "2026-11-03,6666,己,9000,0.7", "2026-11-03,7777,庚,500,0.02",
    "壞掉的列", "2026-13-01,1,x,1,1", "",
])


def test_week_start():
    assert fm.week_start(["2026-10-20", "2026-10-27", "2026-10-30", "2026-11-03"]) == "2026-10-27"
    assert fm.week_start(["2026-11-01", "2026-11-03"]) == "2026-11-01"  # 不到一週用第一天
    assert fm.week_start(["2026-11-03"]) == "2026-11-03"


def test_moves_rules():
    o = fm.compute(HIST, "00981A")
    assert (o["ok"], o["days"], o["from"], o["to"], o["comparable"]) == (True, 4, "2026-10-27", "2026-11-03", True)
    got = [(m["kind"], m["code"], m["pct"], m["since"]) for m in o["moves"]]
    # 甲 +25% 加碼、乙 −20% 減碼、戊出清、己 10/30 新買；丙 +2% 不算；丁、庚權重都低於 0.1% 只算檔數
    assert got == [("new", "6666", None, "2026-10-30"), ("add", "1111", 25.0, None), ("cut", "2222", -20.0, None),
                   ("exit", "5555", -100.0, None)]
    assert o["token_moves"] == 2
    assert o["since_first"] == {"first": "2026-10-20", "added": ["己"], "removed": ["戊"]}
    assert [t["name"] for t in o["top10"]][:3] == ["甲", "乙", "丙"]  # 名稱去掉結尾的 *


def test_brief_and_single_day():
    text = fm.brief(fm.compute(HIST, "00981A"))
    assert "【00981A 這週持股變化】2026-10-27 → 2026-11-03，股數變化 5% 以上的 4 檔（另有 2 檔象徵性持股有變動）" in text
    assert "- 新買 己（6666）：2026-10-30 起，權重 0.70%" in text and "- 加碼 甲（1111）：股數 +25%，權重 10.00% → 12.50%" in text
    assert "- 出清 戊（5555）：原本權重 1.00%" in text and "不能寫進試算表" in text
    one = fm.compute("2026-11-03,1111,甲,1,1", "00981A")
    assert one["comparable"] is False and one["moves"] == [] and "只收集到 2026-11-03 一天" in fm.brief(one)
    none = fm.compute("", "00981A")
    assert none["ok"] is False and "未取得" in fm.brief(none)


def test_cli(tmp_path):
    (tmp_path / "00981A_history.csv").write_text(HIST, encoding="utf-8")
    base = [sys.executable, str(ENGINE / "fund_moves.py"), "--dir", str(tmp_path)]
    p = subprocess.run(base + ["--brief"], capture_output=True)
    assert p.returncode == 0 and "加碼 甲" in p.stdout.decode("utf-8")
    p = subprocess.run(base + ["--code", "009816"], capture_output=True)
    o = json.loads(p.stdout.decode("utf-8"))
    assert p.returncode == 0 and o["ok"] is False and o["error"].startswith("讀不到持股歷史")
