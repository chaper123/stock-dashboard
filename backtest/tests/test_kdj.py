"""backtest/kdj.py：KDJ 算法（與網站 K 線頁一致）、止跌確認、週 KD 的「當天為止」計算不用到未來資料。"""
import importlib.util
import pathlib

import numpy as np
import pandas as pd
import pytest

HERE = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bt_kdj", HERE / "kdj.py")
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)


def js_kdj(bars, n=9):
    """網站 charts.js kdj() 的逐行移植（對照組）。"""
    out = {}
    k = d = rsv = 50.0
    for i in range(n - 1, len(bars)):
        win = bars[i - n + 1:i + 1]
        hi, lo = max(b["high"] for b in win), min(b["low"] for b in win)
        if hi > lo:
            rsv = (bars[i]["close"] - lo) / (hi - lo) * 100
        k = (2 / 3) * k + rsv / 3
        d = (2 / 3) * d + k / 3
        out[i] = (k, d, 3 * k - 2 * d)
    return out


def bars_df(n=300, seed=1):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(0, 0.015, n)))
    h = c * (1 + rng.uniform(0, 0.02, n))
    lo = c * (1 - rng.uniform(0, 0.02, n))
    dates = pd.bdate_range("2024-01-01", periods=n)
    return pd.DataFrame({"date": dates, "high": h, "low": lo, "close": c})


def test_hand_example():
    """前 9 根：最高 10、最低 1、收 7 → RSV 66.67；K＝2/3×50＋66.67/3＝55.56；D＝2/3×50＋55.56/3＝51.85。"""
    high = [2, 3, 4, 5, 6, 7, 8, 9, 10]
    low = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    close = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 7]
    out = K.kdj(high, low, close)
    assert out["k"].iloc[:8].isna().all()
    assert out["k"].iloc[8] == pytest.approx(50 * 2 / 3 + (6 / 9 * 100) / 3)
    assert out["d"].iloc[8] == pytest.approx(50 * 2 / 3 + out["k"].iloc[8] / 3)
    assert out["j"].iloc[8] == pytest.approx(3 * out["k"].iloc[8] - 2 * out["d"].iloc[8])


def test_matches_site_algorithm():
    df = bars_df()
    ours = K.kdj(df["high"], df["low"], df["close"])
    site = js_kdj(df.to_dict("records"))
    for i, (k, d, j) in site.items():
        assert (ours["k"].iloc[i], ours["d"].iloc[i], ours["j"].iloc[i]) == pytest.approx((k, d, j), abs=1e-12)


def test_flat_window_keeps_previous_rsv():
    """9 根高低相同（分母 0）時沿用前一個 RSV，不會變成 NaN。"""
    high = [10] * 12 + [12, 12]
    low = [10] * 12 + [9, 9]
    close = [10] * 12 + [11, 9]
    out = K.kdj(high, low, close)
    assert out["k"].iloc[8] == pytest.approx(50)  # 起始 RSV 50
    assert not out["k"].iloc[8:].isna().any()


@pytest.mark.parametrize("kp,dp,kn,dn,want", [
    (20, 25, 26, 25.5, True),    # 由下往上穿過且 K < 30
    (25, 25, 26, 25.5, True),    # 前一根 K＝D 也算在下方
    (20, 25, 31, 27, False),     # K 已經 ≥ 30
    (26, 25, 28, 26, False),     # 前一根已在 D 之上（不是穿過）
    (20, 25, 24, 24.5, False),   # 還在 D 下方
    (np.nan, 25, 26, 25, False),
])
def test_cross_up(kp, dp, kn, dn, want):
    assert K.cross_up(kp, dp, kn, dn) is want


def test_daily_confirm_uses_only_past_and_today():
    df = bars_df(200, seed=3)
    ok, kd = K.daily_confirm(df)
    cut = 120
    ok2, _ = K.daily_confirm(df.iloc[:cut + 1])
    assert ok.iloc[:cut + 1].tolist() == ok2.tolist()  # 加入未來的 K 棒不會改變過去的判定


def test_weekly_asof_equals_recompute_with_data_to_date():
    """每個交易日的週 KD＝只用到那天為止的日線重算週 K 線後，最後一根（本週）與前一根（上週）的 K、D。"""
    df = bars_df(260, seed=7)
    w = K.weekly_asof(df)
    rng = np.random.default_rng(0)
    for i in sorted(rng.choice(np.arange(60, len(df)), 25, replace=False)):
        part = df.iloc[:i + 1].copy()
        part["week"] = part["date"].dt.to_period("W-FRI")
        wk = part.groupby("week").agg(high=("high", "max"), low=("low", "min"), close=("close", "last"))
        kd = K.kdj(wk["high"], wk["low"], wk["close"])
        row = w.loc[df["date"].iloc[i]]
        assert (row["k"], row["d"]) == pytest.approx((kd["k"].iloc[-1], kd["d"].iloc[-1]), abs=1e-9)
        assert (row["k_prev"], row["d_prev"]) == pytest.approx((kd["k"].iloc[-2], kd["d"].iloc[-2]), abs=1e-9)
