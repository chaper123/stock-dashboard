"""engine/opportunity.py：加權這一段回落到過的級距（算法要和 site/js/opportunity.js 的 currentEpisode 一致）。"""
import datetime as dt
import json
import random
import re
import subprocess
import sys

import pytest

from helpers import ENGINE, ROOT, load_module

op = load_module("opportunity.py", "engine_opportunity")


def mk(closes, start="2026-01-05"):
    """收盤序列 → [(日期, 收盤)]：每個交易日一天（不管週末，只要由舊到新）。"""
    d0 = dt.date.fromisoformat(start)
    return [((d0 + dt.timedelta(days=i)).isoformat(), float(c)) for i, c in enumerate(closes)]


def csv_text(series):
    """照 index_TAIEX.csv 的格式（沒有表頭：日期,開,高,低,收,成交股數,成交金額）。"""
    return "".join(f"{d},{c},{c},{c},{c},1000,2000\n" for d, c in series)


def write(tmp_path, series, name="idx.csv"):
    p = tmp_path / name
    p.write_text(csv_text(series), encoding="utf-8")
    return p


def hits(o):
    return {h["tier"]: h["date"] for h in o["tiers"]}


def day(i, start="2026-01-05"):
    return (dt.date.fromisoformat(start) + dt.timedelta(days=i)).isoformat()


def test_each_tier_recorded_once_at_first_close(tmp_path):
    #       高點  −5%  −11%  −12%  −21%  −22%  −31%  回彈到 −15%
    s = mk([100, 95, 89, 88, 79, 78, 69, 85])
    o = op.compute(s)
    assert hits(o) == {10: day(2), 20: day(4), 30: day(6)}
    assert (o["peak"], o["top_tier"], o["at_peak"]) == ({"date": day(0), "close": 100.0}, 30, False)
    assert o["low"] == {"date": day(6), "close": 69.0, "dd_pct": pytest.approx(-31.0)}
    assert o["last"] == {"date": day(7), "close": 85.0} and o["dd_pct"] == pytest.approx(-15.0)
    assert [h["close"] for h in o["tiers"]] == [89.0, 79.0, 69.0]


def test_exactly_at_tier_counts_but_just_short_does_not():
    # (90 / 100 − 1) × 100 在浮點數是 −9.999999999999998：剛好 −10.0% 要算觸發
    assert (90 / 100 - 1) * 100 > -10
    assert hits(op.compute(mk([100, 90]))) == {10: day(1), 20: None, 30: None}
    assert hits(op.compute(mk([100, 80]))) == {10: day(1), 20: day(1), 30: None}
    assert hits(op.compute(mk([100, 70]))) == {10: day(1), 20: day(1), 30: day(1)}
    # −9.99% 不算；−9.999999% 也不算
    assert hits(op.compute(mk([100, 90.01]))) == {10: None, 20: None, 30: None}
    assert hits(op.compute(mk([10000, 9000.001]))) == {10: None, 20: None, 30: None}
    assert op.compute(mk([100, 90.01]))["top_tier"] == 0
    # 隔一天才到 −10.0%：記到達的那天，不是前一天
    assert hits(op.compute(mk([100, 90.5, 90])))[10] == day(2)


def test_new_high_restarts_the_episode():
    # 先跌到 −15%，再創新高 120，之後只跌到 −5%：舊的那段不算，這一段還沒到 −10%
    o = op.compute(mk([100, 85, 120, 114]))
    assert o["peak"] == {"date": day(2), "close": 120.0}
    assert hits(o) == {10: None, 20: None, 30: None} and o["top_tier"] == 0
    assert o["low"]["date"] == day(3) and o["dd_pct"] == pytest.approx(-5.0)
    # 新高之後又跌穿：新的一段重新記，日期是新的一段裡的
    o = op.compute(mk([100, 85, 120, 114, 107]))
    assert hits(o) == {10: day(4), 20: None, 30: None}   # 107 / 120 = −10.8%：第一次到 −10%
    o = op.compute(mk([100, 85, 120, 114, 107, 95]))
    assert hits(o) == {10: day(4), 20: day(5), 30: None}  # 95 / 120 = −20.8%


def test_flat_high_also_restarts():
    # 收盤剛好等於高點也重新開始（同 opportunity.js：x.value >= peak.value），高點取最後一天
    o = op.compute(mk([100, 85, 100, 95]))
    assert o["peak"]["date"] == day(2)
    assert hits(o) == {10: None, 20: None, 30: None}
    # 這一段高點取「最後一個最高」，離高點與最低都從那天起算
    o = op.compute(mk([100, 80, 100, 92, 100]))
    assert o["peak"]["date"] == day(4) and o["at_peak"] and o["dd_pct"] == 0 and o["top_tier"] == 0


def test_one_day_crosses_two_tiers():
    o = op.compute(mk([100, 99, 75, 74]))
    assert hits(o) == {10: day(2), 20: day(2), 30: None}
    assert o["low"]["date"] == day(3)
    line = op.brief(o)
    assert f"{op.md(day(2))} 跌破 −10%、{op.md(day(2))} 跌破 −20%；−30% 沒到" in line
    # 一天跌穿三級
    assert hits(op.compute(mk([100, 60]))) == {10: day(1), 20: day(1), 30: day(1)}


def test_at_the_high_nothing_triggered():
    o = op.compute(mk([90, 95, 100]))
    assert o["at_peak"] and o["peak"] == o["last"] and o["dd_pct"] == 0
    assert o["low"]["date"] == day(2) and o["low"]["dd_pct"] == 0
    assert hits(o) == {10: None, 20: None, 30: None} and o["top_tier"] == 0
    assert op.brief(o) == f"【機會】加權離高點 0.0%（{op.md(day(2))} 收盤）；這一段高點 {op.md(day(2))}；還沒到 −10%"


def test_low_is_first_lowest_day():
    # 最低收盤出現兩次：取最早的一天（reduce 的 < 是嚴格小於）
    o = op.compute(mk([100, 80, 85, 80, 90]))
    assert o["low"]["date"] == day(1) and o["low"]["close"] == 80.0


def test_brief_long_sentence():
    # 真實 11/13 那一天的樣子：10/06 高點、11/03 跌破 −10%、11/06 跌破 −20%、現在 −12.3%
    s = [("2026-10-06", 49822.55), ("2026-11-03", 43307.54), ("2026-11-06", 39701.64), ("2026-11-12", 43691.18)]
    line = op.brief(op.compute(s))
    assert line == "【機會】加權離高點 −12.3%（11/12 收盤）；這一段高點 10/06、最深 −20.3%（11/06）；11/03 跌破 −10%、11/06 跌破 −20%；−30% 沒到"
    assert "\n" not in line


def test_brief_all_tiers_and_only_first_tier():
    # 三級都到：不寫「沒到」
    line = op.brief(op.compute(mk([100, 89, 79, 69, 70], start="2026-03-02")))
    assert line == ("【機會】加權離高點 −30.0%（03/06 收盤）；這一段高點 03/02、最深 −31.0%（03/05）；"
                    "03/03 跌破 −10%、03/04 跌破 −20%、03/05 跌破 −30%")
    # 只到 −10%：−20%、−30% 一起列在「沒到」
    line = op.brief(op.compute(mk([100, 89, 92], start="2026-03-02")))
    assert line == "【機會】加權離高點 −8.0%（03/04 收盤）；這一段高點 03/02、最深 −11.0%（03/03）；03/03 跌破 −10%；−20%、−30% 沒到"


def test_brief_before_first_tier():
    line = op.brief(op.compute(mk([100, 98, 96.9], start="2026-03-02")))
    assert line == "【機會】加權離高點 −3.1%（03/04 收盤）；這一段高點 03/02；還沒到 −10%"


def test_pct_format():
    assert op.pct(-11.25) in ("−11.2%", "−11.3%")  # 浮點的四捨五入，只要求一位小數、用「−」
    assert (op.pct(0), op.pct(-0.04), op.pct(-0.05)) == ("0.0%", "0.0%", "−0.1%")
    assert op.pct(-20.31) == "−20.3%" and op.MINUS == "−"


def test_matches_tier_crossings_on_random_series():
    """另一種寫法（opportunity.js 的 tierCrossings：逐日走一遍、創新高就重新開始）的最後一段要和這裡一樣。"""
    rng = random.Random(20261114)
    for _ in range(300):
        v, closes = 100.0, []
        for _ in range(rng.randint(2, 80)):
            v = max(1.0, round(v * (1 + rng.uniform(-0.06, 0.06)), 2))
            closes.append(v)
            if rng.random() < 0.1:
                closes.append(v)  # 偶爾持平
        s = mk(closes)
        # tierCrossings 的寫法
        peak, seen, last_hits = s[0], set(), {}
        for d, x in s:
            if x >= peak[1]:
                peak, seen, last_hits = (d, x), set(), {}
                continue
            dd = (x / peak[1] - 1) * 100
            for t in op.TIERS:
                if dd <= -t + 1e-9 and t not in seen:
                    seen.add(t)
                    last_hits[t] = d
        o = op.compute(s)
        assert o["peak"]["date"] == peak[0]
        assert hits(o) == {t: last_hits.get(t) for t in op.TIERS}


def test_constants_match_site():
    js = (ROOT / "site" / "js" / "opportunity.js").read_text(encoding="utf-8")
    m = re.search(r"export const TIERS = \[([\d,\s]+)\]", js)
    assert m and tuple(int(x) for x in m.group(1).split(",")) == op.TIERS
    assert "dd <= -tier + 1e-9" in js and op.EPS == 1e-9


# ── 輸入檔的問題：回報清楚的錯誤，不是 traceback ──────────────────────────────────────────


def test_empty_and_single_row_report_clear_errors(tmp_path):
    empty = tmp_path / "empty.csv"
    empty.write_text("", encoding="utf-8")
    blank = tmp_path / "blank.csv"
    blank.write_text("\n  \n\n", encoding="utf-8")
    one = write(tmp_path, mk([100]), "one.csv")
    for p, want in ((empty, "沒有任何資料列"), (blank, "沒有任何資料列"), (one, "只有 1 列")):
        with pytest.raises(op.OpportunityError, match=want):
            op.read_closes(p)
        r = subprocess.run([sys.executable, str(ENGINE / "opportunity.py"), "--index", str(p), "--brief"], capture_output=True)
        assert r.returncode == 1 and r.stdout == b"" and "Traceback" not in r.stderr.decode("utf-8", "replace")
        assert r.stderr.decode("utf-8").startswith("錯誤：") and want in r.stderr.decode("utf-8")
    with pytest.raises(op.OpportunityError, match="少於 2 列"):
        op.compute(mk([100]))


def test_bad_input_reports_clear_errors(tmp_path):
    cases = {
        "missing.csv": (None, "讀不到"),
        "header.csv": ("日期,開,高,低,收,成交股數,成交金額\n2026-01-05,1,1,1,1,1,1\n2026-01-06,1,1,1,1,1,1\n", "第 1 列日期格式不對"),
        "short.csv": ("2026-01-05,1,1,1,1\n2026-01-06,1\n", "第 2 列欄位不足"),
        "nan.csv": ("2026-01-05,1,1,1,abc,1,1\n2026-01-06,1,1,1,1,1,1\n", "第 1 列收盤不是數字"),
        "zero.csv": ("2026-01-05,1,1,1,0,1,1\n2026-01-06,1,1,1,1,1,1\n", "第 1 列收盤不是正數"),
        "order.csv": ("2026-01-06,1,1,1,1,1,1\n2026-01-05,1,1,1,1,1,1\n", "第 2 列日期 2026-01-05 沒有比前一列"),
        "dup.csv": ("2026-01-05,1,1,1,1,1,1\n2026-01-05,1,1,1,1,1,1\n", "第 2 列日期 2026-01-05 沒有比前一列"),
    }
    for name, (text, want) in cases.items():
        p = tmp_path / name
        if text is not None:
            p.write_text(text, encoding="utf-8")
        with pytest.raises(op.OpportunityError, match=want):
            op.read_closes(p)
        r = subprocess.run([sys.executable, str(ENGINE / "opportunity.py"), "--index", str(p)], capture_output=True)
        assert r.returncode == 1 and want in r.stderr.decode("utf-8") and r.stdout == b""


def test_reader_tolerates_blank_lines_bom_and_thousands(tmp_path):
    p = tmp_path / "ok.csv"
    p.write_bytes(b"\xef\xbb\xbf2026-01-05,1,1,1,\"1,000.5\",1,1\n\n2026-01-06,1,1,1,900,1,1\r\n   \n")
    assert op.read_closes(p) == [("2026-01-05", 1000.5), ("2026-01-06", 900.0)]


# ── 命令列 ─────────────────────────────────────────────────────────────────────────────


def test_cli_brief_json_and_out(tmp_path):
    p = write(tmp_path, mk([100, 95, 89, 88, 79, 85], start="2026-03-02"))
    out = tmp_path / "o.json"
    base = [sys.executable, str(ENGINE / "opportunity.py"), "--index", str(p)]
    r = subprocess.run(base + ["--brief", "--out", str(out)], capture_output=True)
    assert r.returncode == 0, r.stderr.decode("utf-8", "replace")
    text = r.stdout.decode("utf-8").replace("\r\n", "\n")
    assert text == ("【機會】加權離高點 −15.0%（03/07 收盤）；這一段高點 03/02、最深 −21.0%（03/06）；"
                    "03/04 跌破 −10%、03/06 跌破 −20%；−30% 沒到\n")
    o = json.loads(out.read_text(encoding="utf-8"))
    assert o["peak"] == {"date": "2026-03-02", "close": 100.0} and o["top_tier"] == 20 and o["rows"] == 6
    assert {h["tier"]: h["date"] for h in o["tiers"]} == {10: "2026-03-04", 20: "2026-03-06", 30: None}
    # 不給 --brief 印完整 JSON，內容和 --out 一樣
    r = subprocess.run(base, capture_output=True)
    assert r.returncode == 0 and json.loads(r.stdout.decode("utf-8")) == o


# ── 真實資料：market-data 的 data/index/TAIEX.csv（2026-09-29 到 11-13 的收盤，逐字） ────────────────
REAL = """2026-09-29,47631.96 2026-09-30,47940.13 2026-10-01,48353.49 2026-10-02,48475.74 2026-10-05,49712.04
2026-10-06,49822.55 2026-10-07,49806.37 2026-10-08,49313.44 2026-10-12,49301.96 2026-10-13,48341.31
2026-10-14,48625.83 2026-10-15,46969.87 2026-10-16,47111.26 2026-10-19,46822.08 2026-10-20,46292.93
2026-10-21,46887.77 2026-10-22,46041.43 2026-10-27,46096.23 2026-10-28,47035.58 2026-10-29,46368.33
2026-10-30,45211.83 2026-11-02,44920.14 2026-11-03,43307.54 2026-11-04,42948.91 2026-11-05,41574.72
2026-11-06,39701.64 2026-11-09,41661.7 2026-11-10,42711.92 2026-11-11,44257.15 2026-11-12,43091.87
2026-11-13,43675.12"""


def real_series():
    return [(d, float(c)) for d, c in (x.split(",") for x in REAL.split())]


def test_real_data_2026_11_13():
    o = op.compute(real_series())
    assert o["peak"] == {"date": "2026-10-06", "close": 49822.55}
    assert hits(o) == {10: "2026-11-03", 20: "2026-11-06", 30: None}
    assert [h["close"] for h in o["tiers"]] == [43307.54, 39701.64, None]
    assert o["low"]["date"] == "2026-11-06" and o["low"]["close"] == 39701.64 and o["low"]["dd_pct"] == pytest.approx(-20.3, abs=0.05)
    assert o["last"] == {"date": "2026-11-13", "close": 43675.12} and o["dd_pct"] == pytest.approx(-12.34, abs=0.01)
    assert op.brief(o) == ("【機會】加權離高點 −12.3%（11/13 收盤）；這一段高點 10/06、最深 −20.3%（11/06）；"
                           "11/03 跌破 −10%、11/06 跌破 −20%；−30% 沒到")


def test_real_data_each_day_brief():
    # 11/12：−13.5%；11/06 當天：已經 −20.3%、剛跌破 −20%
    assert op.brief(op.compute([x for x in real_series() if x[0] <= "2026-11-12"])).startswith("【機會】加權離高點 −13.5%（11/12 收盤）")
    line = op.brief(op.compute([x for x in real_series() if x[0] <= "2026-11-06"]))
    assert line == ("【機會】加權離高點 −20.3%（11/06 收盤）；這一段高點 10/06、最深 −20.3%（11/06）；"
                    "11/03 跌破 −10%、11/06 跌破 −20%；−30% 沒到")
    # 10/06 當天：在高點
    assert op.brief(op.compute([x for x in real_series() if x[0] <= "2026-10-06"])) == (
        "【機會】加權離高點 0.0%（10/06 收盤）；這一段高點 10/06；還沒到 −10%")
