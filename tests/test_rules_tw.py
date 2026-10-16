"""台股 monitor.py 規則邊界案例：追價區、趨勢起始倉、溢價降級或禁買、單次上限 60%、空頭不接刀、事件層、空手提醒。

直接呼叫原程式的函式（不改程式）。乖離由判定價（盤中價，沒有就用前收）對 MA20 計算；
價格剛好在門檻上時浮點數會略大於門檻（例如 106/100 → 6.000000000000005%），所以邊界案例用略低於門檻的價格。
"""
import json

import pytest

from helpers import FIX, load_module


@pytest.fixture(scope="module")
def m():
    return load_module("monitor.py")


def R(close=100.0, ma20=100.0, trend="多頭", ma60_rising=True, rsi=50.0, weekly_up=True):
    return dict(close=close, ma20=ma20, trend=trend, ma60_rising=ma60_rising, rsi=rsi, weekly_up=weekly_up)


Z = {"starter": (100.0, 104.0), "z1": (97.0, 103.0), "z2": (90.0, 94.0), "z3": (80.0, 85.0)}
WIDE = {"starter": (100.0, 104.0), "z1": (90.0, 110.0)}
POOL = 1000  # 起始倉 150、第一買區 250、第二買區 400、深度買區 600


def E(px=None, held=False, premium=None, event="none"):
    return {"intraday": px, "held": held, "premium": premium, "event": event}


def run(m, e, r=None, z=Z):
    name, amount, why, px, bias = m.decide("X", r or R(), z, e, POOL)
    return name, amount, why


# ---------- 價格位置與判定價 ----------
@pytest.mark.parametrize("px,want", [(103.0, ("第一買區", 250)), (94.0, ("第二買區", 400)),
                                     (85.0, ("深度買區", 600)), (70.0, ("深度買區", 600))])
def test_zone_by_price(m, px, want):
    assert run(m, E(px, held=True))[:2] == want


def test_intraday_none_uses_close(m):
    name, amount, why, px, bias = m.decide("X", R(close=94.0), Z, E(None, held=True), POOL)
    assert (px, round(bias, 6), name) == (94.0, -6.0, "第二買區")


def test_intraday_overrides_close(m):
    name, amount, why, px, bias = m.decide("X", R(close=94.0), Z, E(102.0, held=True), POOL)
    assert (px, round(bias, 6), name) == (102.0, 2.0, "第一買區")


# ---------- 追價區 ----------
def test_overheat_by_bias(m):
    assert run(m, E(106.1)) == ("追價區（不買）", 0, ["乖離6.1% / RSI 50：追價區"])


def test_overheat_beats_zone(m):
    assert run(m, E(107.0, held=True), z=WIDE)[:2] == ("追價區（不買）", 0)


@pytest.mark.parametrize("px,rsi,want", [
    (105.9, 50, "等待回檔"),         # 乖離 5.9%：未超過 6%，也超過起始倉 4% 上限
    (103.1, 75.1, "追價區（不買）"),  # RSI > 75 且乖離 > 3%
    (102.9, 75.1, "第一買區"),        # 乖離未超過 3%
    (105.0, 75.0, "等待回檔"),        # RSI 要超過 75
])
def test_overheat_boundaries(m, px, rsi, want):
    assert run(m, E(px), R(rsi=rsi))[0] == want


# ---------- 趨勢起始倉（只限未持有） ----------
@pytest.mark.parametrize("e,r,want", [
    (E(103.5), R(), ("趨勢起始倉", 150)),
    (E(103.5, held=True), R(), ("等待回檔", 0)),                    # 已持有不觸發
    (E(104.5), R(), ("等待回檔", 0)),                               # 乖離超過 4%
    (E(103.5), R(weekly_up=False), ("等待回檔", 0)),                # 週線下彎
    (E(103.5), R(weekly_up=None), ("趨勢起始倉", 150)),             # 週線樣本不足不擋（00411A）
    (E(103.5), R(rsi=70.1), ("等待回檔", 0)),
    (E(103.5), R(rsi=70.0), ("趨勢起始倉", 150)),
    (E(103.5), R(trend="多頭(無MA60)"), ("趨勢起始倉", 150)),
    (E(103.5), R(trend="整理"), ("等待回檔", 0)),
])
def test_starter(m, e, r, want):
    assert run(m, e, r)[:2] == want


# ---------- 溢價 ----------
@pytest.mark.parametrize("px,prem,want,why", [
    (103.0, None, ("第一買區", 250), []),
    (103.0, 0.99, ("第一買區", 250), []),
    (103.0, -3.0, ("第一買區", 250), []),                                   # 折價不升級
    (94.0, 1.5, ("第一買區", 250), ["最近溢價1.50% ≥ 1.0%：降一級"]),
    (85.0, 1.99, ("第二買區", 400), ["最近溢價1.99% ≥ 1.0%：降一級"]),
    (85.0, 2.0, ("等待回檔", 0), ["最近溢價2.00% ≥ 2.0%：禁買"]),
    (106.1, 5.0, ("追價區（不買）", 0), ["乖離6.1% / RSI 50：追價區"]),     # 不在買區時不看溢價
    (104.5, 5.0, ("等待回檔", 0), []),
])
def test_premium(m, px, prem, want, why):
    name, amount, w = run(m, E(px, held=True, premium=prem))
    assert ((name, amount), w) == (want, why)


def test_premium_downgrade_from_zone1_gives_starter_level_even_if_held(m):
    """既有行為：第一買區降一級是「趨勢起始倉」等級（15%），已持有也一樣（10/16 正式執行的 00981A）。"""
    assert run(m, E(103.0, held=True, premium=1.0)) == ("趨勢起始倉", 150, ["最近溢價1.00% ≥ 1.0%：降一級"])


def test_premium_downgrade_from_starter_is_wait(m):
    assert run(m, E(103.5, premium=1.0)) == ("等待回檔", 0, ["最近溢價1.00% ≥ 1.0%：降一級"])


# ---------- 空頭不接刀、事件層 ----------
def test_weak_trend_no_catching_knife(m):
    assert run(m, E(85.0, held=True), R(trend="空頭", ma60_rising=False)) == (
        "等待（趨勢轉弱）", 0, ["空頭排列且MA60下彎：不接刀，等止穩"])


@pytest.mark.parametrize("r", [R(trend="空頭", ma60_rising=True), R(trend="空頭", ma60_rising=None),
                               R(trend="整理", ma60_rising=False)])
def test_weak_needs_both_conditions(m, r):
    assert run(m, E(85.0, held=True), r)[:2] == ("深度買區", 600)


def test_block_beats_weak(m):
    assert run(m, E(85.0, event="block"), R(trend="空頭", ma60_rising=False)) == (
        "暫停", 0, ["重大負面事件（由事件層判定）"])


def test_weak_beats_boost(m):
    assert run(m, E(85.0, event="boost"), R(trend="空頭", ma60_rising=False))[:2] == ("等待（趨勢轉弱）", 0)


@pytest.mark.parametrize("px,held,want", [
    (104.5, True, ("趨勢起始倉", 150)),   # 等待 → 起始倉等級（已持有也會，既有行為）
    (103.5, False, ("第一買區", 250)),    # 起始倉 → 第一買區
    (103.0, True, ("第二買區", 400)),
    (94.0, True, ("深度買區", 600)),
    (85.0, True, ("深度買區", 600)),      # 深度買區不再升
    (106.1, True, ("追價區（不買）", 0)),  # 追價區不升
])
def test_boost(m, px, held, want):
    assert run(m, E(px, held=held, event="boost"))[:2] == want


def test_boost_then_premium_downgrade(m):
    assert run(m, E(103.0, held=True, premium=1.2, event="boost")) == (
        "第一買區", 250, ["事件層：情緒錯殺且隔夜已修復，升一級", "最近溢價1.20% ≥ 1.0%：降一級"])


# ---------- 買區 ----------
def test_zones_formula(m):
    r = {"atr": 1.0, "ma20": 100.0, "ma60": 95.0, "hi60": 110.0, "swing_lows": [("09/01", 90.0)]}
    assert m.zones(r) == {"starter": (100.0, 104.0), "z1": (99.5, 100.5), "z2": (94.5, 95.5),
                          "z3": (92.5, 93.5)}  # min(MA60 − 1.5×ATR, 60 日高點 × 0.88) 往下 1×ATR


def test_zones_deep_uses_60d_high(m):
    r = {"atr": 1.0, "ma20": 100.0, "ma60": 95.0, "hi60": 100.0, "swing_lows": []}
    assert m.zones(r)["z3"] == (87.0, 88.0)  # 60 日高點 × 0.88 比 MA60 − 1.5×ATR 低


def test_zones_without_ma60_use_swing_low(m):
    r = {"atr": 0.2, "ma20": 10.5, "ma60": None, "hi60": 11.0, "swing_lows": [("09/03", 9.48), ("09/14", 9.46)]}
    assert m.zones(r) == {"starter": (10.5, 10.92), "z1": (10.4, 10.6), "z2": (9.36, 9.56)}


# ---------- 單次上限 60% 與空手提醒（main） ----------
def run_main(m, monkeypatch, capsys, pcts, pool, days):
    def fake(code, r, z, e, pool_):
        p = pcts.get(code, 0)
        return ("第二買區" if p else "等待回檔"), round(pool_ * p), [], r["close"], 0.0
    monkeypatch.setattr(m, "decide", fake)
    m.main({"pool": pool, "last_buy_days": days,
            "etfs": {c: {"csv": str(FIX / "tw" / f"{c}_norm.csv")} for c in ("009816", "00981A", "00411A")}})
    return json.loads(capsys.readouterr().out)


def test_cap_scales_to_60pct(m, monkeypatch, capsys):
    out = run_main(m, monkeypatch, capsys, {"009816": 0.40, "00981A": 0.40, "00411A": 0.40}, 2580, 1)
    assert [v["amount"] for v in out["etfs"].values()] == [516, 516, 516]
    assert out["total_suggest"] == 1548


def test_cap_not_hit(m, monkeypatch, capsys):
    out = run_main(m, monkeypatch, capsys, {"009816": 0.25, "00981A": 0.25}, 2580, 1)
    assert [v["amount"] for v in out["etfs"].values()] == [645, 645, 0]
    assert out["total_suggest"] == 1290


@pytest.mark.parametrize("pcts,pool,days,alert", [
    ({}, 9000, 30, True),
    ({}, 8999, 30, False),
    ({}, 9000, 29, False),
    ({"009816": 0.25}, 9000, 30, False),   # 有訊號就不提醒
])
def test_idle_reminder(m, monkeypatch, capsys, pcts, pool, days, alert):
    out = run_main(m, monkeypatch, capsys, pcts, pool, days)
    assert out["idle_reminder"] == {"days": days, "pool": pool, "alert": alert}
