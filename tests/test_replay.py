"""正式環境回放：快照資料＋正式執行時的 config，結果要和當天排程報告一致。

數字取自 claude.ai 排程的 run log（RemoteTrigger get_run_log）：
- 台股 ETF 晨報 2026-10-16 10:17（session cse_01KNaeWCHy81cCjc9nCt178z）：用 10/15 收盤日線＋09:46 盤中價
- 美股晨報 2026-10-16 09:20（session cse_01N1iW3Wb1AM3S8fVcqUAYqZ）：當天 repo 日線過期，只拿匯率濾網比對
"""
import json

import pytest

from helpers import FIX, load_module, run_case


@pytest.fixture(scope="module")
def tw():
    return json.loads(run_case("tw_20261016"))


def test_tw_amounts_match_production(tw):
    e = tw["etfs"]
    assert (e["009816"]["status"], e["009816"]["amount"]) == ("第一買區", 595)
    # 00981A 在第一買區，溢價 1.00% 降一級成「趨勢起始倉」等級（15%），再依 60% 上限縮放
    assert (e["00981A"]["status"], e["00981A"]["amount"]) == ("趨勢起始倉", 357)
    assert e["00981A"]["why"] == ["最近溢價1.00% ≥ 1.0%：降一級"]
    assert (e["00411A"]["status"], e["00411A"]["amount"]) == ("第一買區", 595)
    assert tw["total_suggest"] == 1547
    assert tw["idle_reminder"] == {"days": 1, "pool": 2580, "alert": False}


def test_tw_zones_match_production(tw):
    e = tw["etfs"]
    assert e["009816"]["zones"] == {"starter": [16.52, 17.18], "z1": [16.4, 16.64],
                                    "z2": [15.52, 15.76], "z3": [14.8, 15.04]}
    assert {k: e["00981A"]["zones"][k] for k in ("z1", "z2", "z3")} == {
        "z1": [30.22, 31.04], "z2": [28.9, 29.72], "z3": [27.26, 28.08]}
    assert e["00411A"]["zones"] == {"starter": [10.52, 10.94], "z1": [10.41, 10.64], "z2": [9.35, 9.57]}


def test_tw_indicators_match_production(tw):
    # run log 印到小數 3 位
    v = tw["etfs"]["009816"]
    got = {k: round(v[k], 3) for k in ("close", "ma20", "ma60", "rsi", "atr", "bias20", "vol_ratio")}
    assert got == {"close": 16.19, "ma20": 16.523, "ma60": 15.642, "rsi": 45.569, "atr": 0.239,
                   "bias20": -2.015, "vol_ratio": 3.608}
    assert tw["etfs"]["00411A"]["ma60"] is None and tw["etfs"]["00411A"]["trend"] == "整理(無MA60)"


def test_us_fx_from_repo_matches_bot_table():
    """v2 改用 repo 的 fx/usdtwd_bot_sell.csv；10/16 正式執行用 WebFetch 台銀 6 個月表（125 列）算出相同的濾網數字。"""
    m = load_module("monitor_us.py")
    fx = m.fx_state(FIX / "fx" / "usdtwd_bot_sell.csv")
    assert {k: fx[k] for k in ("date", "rate", "mean", "dev_pct")} == {
        "date": "2026-10-15", "rate": 32.315, "mean": 31.877, "dev_pct": 1.38}
