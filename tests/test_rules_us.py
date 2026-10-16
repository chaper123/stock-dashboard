"""美股 monitor_us.py 規則邊界案例：追價區、估值降級或禁買、匯率濾網、單次上限縮放、空頭不接刀、事件層。

直接呼叫原程式的函式（不改程式）；需要跑 main() 的上限縮放用 monkeypatch 固定 decide 的結果。
浮點數的邊界（例如乖離剛好 8%）直接給 bias50，不由價格反推，避免 0.1+0.2 這類誤差。
"""
import json

import numpy as np
import pandas as pd
import pytest

from helpers import FIX, load_module


@pytest.fixture(scope="module")
def m():
    return load_module("monitor_us.py")


def R(close=100.0, ma50=100.0, ma200=90.0, ma200_rising=True, ma50_rising=True, rsi=50.0, bias50=None):
    return dict(close=close, ma50=ma50, ma200=ma200, ma200_rising=ma200_rising, ma50_rising=ma50_rising,
                bias50=bias50 if bias50 is not None else ((close / ma50 - 1) * 100 if ma50 else None), rsi=rsi)


Z = {"z1": (95.0, 105.0), "z2": (85.0, 95.0), "z3": (70.0, 80.0)}
WIDE = {"z1": (90.0, 115.0), "z2": (80.0, 90.0), "z3": (60.0, 70.0)}  # 價格在 MA50 上方也落在第一買區


def E(fwd_pe=15.0, peg=1.5, px_at=None, kind="stock", event="none", role="buy"):
    val = {"pe": fwd_pe, "px_at": px_at} if kind == "etf" else {"fwd_pe": fwd_pe, "peg": peg, "px_at": px_at}
    return {"role": role, "kind": kind, "event": event, "val": val}


def level(m, e, r, z=Z, fx=None):
    name, lv, why, _, _ = m.decide(e, r, z, fx)
    return lv, why


# ---------- 價格位置 ----------
@pytest.mark.parametrize("close,want", [(106.0, "wait"), (105.0, "z1"), (95.0, "z2"), (80.0, "z3"), (60.0, "z3")])
def test_zone_by_price(m, close, want):
    assert level(m, E(), R(close=close))[0] == want


# ---------- 追價區 ----------
def test_overheat_bias_beats_zone(m):
    name, lv, why, _, _ = m.decide(E(), R(close=108.5), WIDE, None)
    assert (name, lv) == ("追價區（不買）", "overheat")
    assert why == ["乖離MA50 8.5% / RSI 50"]


@pytest.mark.parametrize("bias,rsi,want", [
    (8.0, 50, "z1"),          # 乖離要「超過」8%
    (8.01, 50, "overheat"),
    (4.01, 70.1, "overheat"),  # RSI > 70 且乖離 > 4%
    (4.0, 70.1, "z1"),
    (7.9, 70.0, "z1"),         # RSI 要超過 70
])
def test_overheat_boundaries(m, bias, rsi, want):
    assert level(m, E(), R(close=100.0, rsi=rsi, bias50=bias), WIDE)[0] == want


# ---------- 估值分級 ----------
@pytest.mark.parametrize("fwd_pe,peg,want", [
    (20, None, "偏便宜"), (20.01, None, "合理"), (30, None, "合理"), (30.01, None, "偏貴"),
    (45, None, "偏貴"), (45.01, None, "明顯偏貴"),
    (25, 0.99, "偏便宜"), (25, 1.0, "合理"), (25, 2.5, "合理"), (25, 2.51, "偏貴"),
    (15, 0.5, "偏便宜"),     # 不會低於「偏便宜」
    (50, 3.0, "明顯偏貴"),   # 不會高於「明顯偏貴」
    (50, 0.5, "偏貴"),       # PEG 便宜可把明顯偏貴拉回一級
    (25, 0, "合理"), (25, -1.0, "合理"),  # PEG ≤ 0 不採用
])
def test_valuation_stock(m, fwd_pe, peg, want):
    assert m.valuation(E(fwd_pe, peg), 100.0)[0] == want


@pytest.mark.parametrize("pe,want", [(18, "偏便宜"), (18.01, "合理"), (24, "合理"), (24.01, "偏貴"),
                                     (30, "偏貴"), (30.01, "明顯偏貴")])
def test_valuation_etf(m, pe, want):
    assert m.valuation(E(pe, kind="etf"), 100.0)[0] == want


def test_valuation_scales_with_price(m):
    """快取當時股價 100、今天 110：Forward PE 與 PEG 都乘 1.1。"""
    label, now = m.valuation(E(28.0, 2.0, px_at=100.0), 110.0)
    assert (label, now) == ("偏貴", {"fwd_pe": 30.8, "peg": 2.2})


@pytest.mark.parametrize("e,want", [
    ({"role": "buy", "kind": "stock"}, "無資料"),
    ({"role": "buy", "kind": "stock", "val": {}}, "無資料"),
    ({"role": "buy", "kind": "stock", "val": {"fwd_pe": None, "px_at": 100}}, "無法估值"),
    ({"role": "buy", "kind": "stock", "val": {"fwd_pe": -12.0, "px_at": 100}}, "無法估值"),
    ({"role": "buy", "kind": "etf", "val": {"pe": 0, "px_at": 100}}, "無法估值"),
])
def test_valuation_missing(m, e, want):
    assert m.valuation(e, 100.0)[0] == want


# ---------- 估值閘門：只能降級或禁買 ----------
@pytest.mark.parametrize("e,close,want,why", [
    (E(35.0), 95.0, "z1", ["估值偏貴：降一級"]),        # 第二買區 → 第一買區
    (E(35.0), 100.0, "wait", ["估值偏貴：降一級"]),     # 第一買區 → 等待
    (E(60.0), 75.0, "wait", ["估值明顯偏貴：禁買"]),    # 深度買區也禁買
    ({"role": "buy", "kind": "stock"}, 75.0, "z2", ["估值無資料：降一級"]),
    ({"role": "buy", "kind": "stock", "val": {"fwd_pe": None}}, 100.0, "wait", ["估值無法估值：降一級"]),
    (E(10.0, 0.5), 106.0, "wait", []),                 # 偏便宜不會升級
    (E(10.0, 0.5), 100.0, "z1", []),
    (E(60.0), 106.0, "wait", []),                      # 不在買區時閘門不作用
])
def test_valuation_gate(m, e, close, want, why):
    assert level(m, e, R(close=close)) == (want, why)


# ---------- 匯率濾網 ----------
def test_fx_state_window_and_order(m, tmp_path):
    """只取最近 120 筆算均值；檔案任意排序也一樣。"""
    rows = [(f"2025-{1 + i // 28:02d}-{1 + i % 28:02d}", 20.0) for i in range(50)]          # 視窗外
    rows += [(str(d.date()), 30.0) for d in pd.bdate_range("2026-04-01", periods=119)]
    rows += [("2026-10-15", 31.0)]
    rng = np.random.default_rng(0)
    p = tmp_path / "fx.csv"
    p.write_text("\n".join(f"{d},{v}" for d, v in rng.permutation(rows).tolist()) + "\n")
    fx = m.fx_state(p)
    assert fx == {"date": "2026-10-15", "rate": 31.0, "mean": 30.008, "dev_pct": 3.3, "rows": 170}


@pytest.mark.parametrize("dev,close,want,why", [
    (1.99, 100.0, "z1", []),
    (2.0, 100.0, "wait", ["美元高於半年均值 2.0%：降一級"]),
    (2.0, 75.0, "z2", ["美元高於半年均值 2.0%：降一級"]),
    (3.99, 95.0, "z1", ["美元高於半年均值 3.99%：降一級"]),
    (4.0, 95.0, "wait", ["美元高於半年均值 4.0%：只允許深度買區"]),
    (4.0, 75.0, "z2", ["美元高於半年均值 4.0%：降一級"]),    # 深度買區可買，但再降一級
    (-5.0, 100.0, "z1", []),                                 # 台幣強不會升級
])
def test_fx_filter(m, dev, close, want, why):
    assert level(m, E(), R(close=close), fx={"dev_pct": dev}) == (want, why)


def test_fx_none_means_no_filter(m):
    assert level(m, E(), R(close=100.0), fx=None) == ("z1", [])


def test_valuation_and_fx_stack(m):
    """深度買區＋估值偏貴（降一級）＋美元偏高 2%（再降一級）→ 第一買區。"""
    assert level(m, E(35.0), R(close=75.0), fx={"dev_pct": 2.5}) == (
        "z1", ["估值偏貴：降一級", "美元高於半年均值 2.5%：降一級"])


def test_fx_not_applied_outside_zone(m):
    assert level(m, E(), R(close=108.5), WIDE, fx={"dev_pct": 9.0}) == ("overheat", ["乖離MA50 8.5% / RSI 50"])


# ---------- 空頭不接刀、事件層 ----------
def test_weak_trend_no_catching_knife(m):
    name, lv, why, _, _ = m.decide(E(), R(close=75.0, ma50=90.0, ma200=100.0, ma200_rising=False), Z, None)
    assert (name, lv, why) == ("等待（趨勢轉弱，不接刀）", "none", ["空頭排列且長均線下彎"])


@pytest.mark.parametrize("r,want", [
    (R(close=75.0, ma50=90.0, ma200=100.0, ma200_rising=True), "z3"),    # 長均線還在上彎
    (R(close=75.0, ma50=90.0, ma200=100.0, ma200_rising=None), "z3"),    # 200～209 日樣本，無法判斷彎向
    (R(close=75.0, ma50=100.0, ma200=90.0, ma200_rising=False), "z3"),   # 不是空頭排列
    (R(close=75.0, ma50=90.0, ma200=None, ma50_rising=False), "none"),   # 無 MA200：價格在 MA50 下且 MA50 下彎
    (R(close=75.0, ma50=90.0, ma200=None, ma50_rising=None), "z3"),
])
def test_weak_trend_conditions(m, r, want):
    assert level(m, E(), r)[0] == want


def test_block_beats_everything(m):
    name, lv, why, _, _ = m.decide(E(event="block"), R(close=75.0), Z, None)
    assert (name, lv, why) == ("暫停", "none", ["重大負面事件（事件層判定）"])


@pytest.mark.parametrize("close,want,boosted", [(100.0, "z2", True), (95.0, "z3", True), (75.0, "z3", False),
                                               (106.0, "wait", False)])
def test_boost_only_inside_zone(m, close, want, boosted):
    lv, why = level(m, E(event="boost"), R(close=close))
    assert lv == want
    assert why == (["事件層：情緒錯殺且已修復，買區內升一級"] if boosted else [])


def test_boost_then_valuation_downgrade(m):
    assert level(m, E(35.0, event="boost"), R(close=100.0)) == (
        "z1", ["事件層：情緒錯殺且已修復，買區內升一級", "估值偏貴：降一級"])


def test_weak_beats_boost(m):
    assert level(m, E(event="boost"), R(close=75.0, ma50=90.0, ma200=100.0, ma200_rising=False))[0] == "none"


@pytest.mark.parametrize("role,name", [("gauge", "市場指標"), ("watch", "觀察（不給金額）")])
def test_non_buy_roles(m, role, name):
    assert m.decide({"role": role}, R(close=75.0), Z, None)[:2] == (name, "none")


# ---------- 買區由淺到深 ----------
@pytest.mark.parametrize("ma50,ma200,atr,hi52", [(100, 90, 2, 120), (100, 99, 5, 105), (100, 120, 3, 130),
                                                 (50, 20, 1, 60)])
def test_zones_ordered(m, ma50, ma200, atr, hi52):
    z = m.zones({"atr": atr, "ma50": ma50, "ma200": ma200, "hi52": hi52, "swing_lows": []})
    assert z["z3"][1] <= z["z2"][0] + 1e-9 and z["z2"][1] <= z["z1"][0] + 1e-9
    assert all(abs((hi - lo) - atr) <= 0.011 for lo, hi in z.values())  # 每個區寬 1×ATR（上下緣四捨五入到 0.01）


def test_zones_without_ma200_use_swing_low(m):
    z = m.zones({"atr": 2.0, "ma50": 100.0, "ma200": None, "hi52": 120.0,
                 "swing_lows": [("08/01", 92.0), ("09/01", 90.0)]})
    assert z == {"z1": (99.0, 101.0), "z2": (89.0, 91.0)}  # 沒有 MA200 就沒有深度買區


def test_zones_need_atr_and_ma50(m):
    assert m.zones({"atr": None, "ma50": 100.0, "ma200": 90.0, "hi52": 1, "swing_lows": []}) == {}


# ---------- 單次上限縮放（main） ----------
def run_main(m, monkeypatch, capsys, levels, pool, fx=True):
    def fake(e, r, z, fx_):
        lv = levels.get(e["_code"], "wait")
        return m.NAMES.get(lv, "等待回檔"), lv, [], "合理", {}
    monkeypatch.setattr(m, "decide", fake)
    cfg = {"pool_twd": pool, "tickers": {c: {"csv": str(FIX / "us" / f"{c}.csv"), "role": "buy", "_code": c}
                                          for c in ("VOO", "GOOGL", "NVDA")}}
    if fx:
        cfg["fx_csv"] = str(FIX / "fx" / "usdtwd_bot_sell.csv")
    m.main(cfg)
    out = json.loads(capsys.readouterr().out)
    return out, {c: (v["amount_twd"], v["amount_usd"]) for c, v in out["tickers"].items()}


# 測試匯率檔最後一筆 32.315：50 美元要圈存 50 × 32.315 × 1.03 ≈ NT$1,664.2
def test_min_order_numbers(m):
    fx = {"rate": 32.315}
    assert [m.to_usd(t, fx) for t in (516, 1664, 1665, 1800)] == [15.5, 49.99, 50.02, 54.07]
    assert {lv: m.min_pool(lv, fx) for lv in m.ZONES} == {"z1": 8323, "z2": 4756, "z3": 4162}
    assert m.to_usd(round(8323 * 0.2), fx) >= 50 > m.to_usd(round(8322 * 0.2), fx)


def test_below_min_order_not_bought(m, monkeypatch, capsys):
    """10/16 正式執行：兩檔第一買區各 NT$516（約 15.5 美元），不足 50 美元，都不下單。"""
    out, a = run_main(m, monkeypatch, capsys, {"GOOGL": "z1", "NVDA": "z1"}, 2580)
    assert (out["cap_twd"], out["total_twd"]) == (1032, 0)
    assert a == {"VOO": (0, 0), "GOOGL": (0, 0), "NVDA": (0, 0)}
    t = out["tickers"]
    assert t["GOOGL"]["status"] == "第一買區" and t["GOOGL"]["level"] == "z1"    # 價格位置照實寫
    assert t["GOOGL"]["why"] == ["規則金額 NT$516（扣 3% 圈存可下單約 US$15.50）不足最低下單 50 美元：不下單；"
                                 "這個買區要資金池約 NT$8,323 才買得到"]
    assert out["min_order"] == {"usd": 50.0, "hold_mult": 1.03, "twd": 1665,
                                "pool_needed": {"z1": 8323, "z2": 4756, "z3": 4162}}


def test_min_order_met(m, monkeypatch, capsys):
    out, a = run_main(m, monkeypatch, capsys, {"GOOGL": "z1"}, 9000)
    assert a["GOOGL"] == (1800, 54.07) and out["tickers"]["GOOGL"]["hold_twd"] == 1800
    assert out["tickers"]["GOOGL"]["why"] == [] and out["total_twd"] == 1800


def test_single_deep_zone_capped_then_too_small(m, monkeypatch, capsys):
    """深度買區 50% 先被上限壓到 40%（NT$1,032），仍不足 50 美元。"""
    out, a = run_main(m, monkeypatch, capsys, {"NVDA": "z3"}, 2580)
    assert a["NVDA"] == (0, 0) and out["total_twd"] == 0
    assert "NT$1,032" in out["tickers"]["NVDA"]["why"][0] and "NT$4,162" in out["tickers"]["NVDA"]["why"][0]


def test_single_deep_zone_capped(m, monkeypatch, capsys):
    out, a = run_main(m, monkeypatch, capsys, {"NVDA": "z3"}, 5000)
    assert a["NVDA"] == (2000, 60.08) and out["total_twd"] == 2000


def test_three_zone1_drop_lowest_priority(m, monkeypatch, capsys):
    """三檔第一買區各 1,800，合計超過上限 3,600；等比例縮成 1,200 都不足 50 美元，
    所以拿掉優先順序最低的一檔，其餘兩檔各 1,800 剛好用滿上限。"""
    out, a = run_main(m, monkeypatch, capsys, {"VOO": "z1", "GOOGL": "z1", "NVDA": "z1"}, 9000)
    bought = {c for c, (twd, _) in a.items() if twd}
    assert len(bought) == 2 and all(a[c] == (1800, 54.07) for c in bought) and out["total_twd"] == 3600
    (dropped,) = set(a) - bought
    assert out["tickers"][dropped]["why"] == ["同時有優先順序較高的訊號，美股單次上限 NT$3,600 不夠再下一筆 50 美元：不下單"]


def test_mixed_scaled_below_min(m, monkeypatch, capsys):
    """第二買區 3,500＋深度買區 5,000 超過上限 4,000：等比例後第二買區 1,647（49.48 美元）不足，
    拿掉它；深度買區單獨用滿上限 4,000。"""
    out, a = run_main(m, monkeypatch, capsys, {"VOO": "z2", "GOOGL": "z3"}, 10000)
    assert (a["VOO"], a["GOOGL"], out["cap_twd"], out["total_twd"]) == ((0, 0), (4000, 120.17), 4000, 4000)


def test_mixed_both_fit(m, monkeypatch, capsys):
    out, a = run_main(m, monkeypatch, capsys, {"VOO": "z2", "GOOGL": "z3"}, 12000)
    assert (a["VOO"][0], a["GOOGL"][0], out["total_twd"]) == (1976, 2824, 4800)
    assert a["VOO"][1] >= 50 and a["GOOGL"][1] >= 50


def test_priority_order(m):
    """優先順序：買區深 → 估值便宜 → 低於第一買區上緣越多 → config 順序。"""
    def bought(pool):
        res = {"A": ("z1", "偏便宜", 5.0), "B": ("z2", "偏貴", 0.0), "C": ("z1", "合理", 9.0),
               "D": ("z1", "合理", 1.0), "E": ("z1", "合理", 1.0)}
        res = {k: {"level": lv, "valuation": val, "dist_to_z1_pct": d, "amount_twd": 1600, "why": []}
               for k, (lv, val, d) in res.items()}
        m.allocate(res, list(res), pool, {"rate": 30.0})      # 每筆 1,600 ≈ 51.78 美元，上限 = 資金池 40%
        return sorted(k for k, v in res.items() if v["amount_twd"])
    assert bought(4000) == ["B"]                    # 上限 1,600 只夠一筆：買區最深的 B
    assert bought(8000) == ["A", "B"]               # 再來是估值最便宜的 A
    assert bought(12000) == ["A", "B", "C"]         # 同估值時低於第一買區上緣較多的 C
    assert bought(16000) == ["A", "B", "C", "D"]    # 完全相同時照 config 順序
    assert bought(10 ** 6) == ["A", "B", "C", "D", "E"]


def test_no_fx_no_order(m, monkeypatch, capsys):
    """匯率未取得就無法確認是否達 50 美元，不下單。"""
    out, a = run_main(m, monkeypatch, capsys, {"GOOGL": "z1"}, 9000, fx=False)
    assert out["fx"] is None and a["GOOGL"] == (0, 0) and out["total_twd"] == 0
    assert out["tickers"]["GOOGL"]["why"] == ["匯率未取得，無法確認是否達最低下單 50 美元：不下單"]
    assert out["min_order"] == {"usd": 50.0, "hold_mult": 1.03, "twd": None, "pool_needed": None}


# ---------- 端到端：一路下跌的合成日線 ----------
def write_daily(path, closes, volume=1_000_000, start="2025-06-02"):
    dates = pd.bdate_range(start, periods=len(closes))
    lines = []
    for d, c in zip(dates, closes):
        lines.append(f"{d.date()},{volume},{c:.4f},{c * 1.01:.4f},{c * 0.99:.4f},{c:.4f}")
    path.write_text("\n".join(lines) + "\n")


def test_end_to_end_downtrend_is_weak(m, tmp_path, capsys):
    closes = 200 * np.exp(-0.003 * np.arange(260)) * (1 + 0.004 * np.sin(np.arange(260)))
    write_daily(tmp_path / "X.csv", closes)
    m.main({"pool_twd": 2580, "tickers": {"X": {"csv": str(tmp_path / "X.csv"), "role": "buy", "kind": "stock",
                                                "event": "none", "val": {"fwd_pe": 15, "peg": 1.0, "px_at": None}}}})
    x = json.loads(capsys.readouterr().out)["tickers"]["X"]
    assert x["trend"] == "空頭" and x["ma200_rising"] is False
    assert (x["status"], x["amount_twd"]) == ("等待（趨勢轉弱，不接刀）", 0)


def test_volume_outlier_excluded(m, tmp_path):
    """量超過 20 日中位數 50 倍視為異常，改成 NaN（pandas 3 也不會出錯）。"""
    p = tmp_path / "V.csv"
    write_daily(p, np.linspace(100, 110, 40))
    lines = p.read_text().splitlines()
    d, v, *rest = lines[30].split(",")
    lines[30] = ",".join([d, str(int(v) * 100), *rest])
    p.write_text("\n".join(lines) + "\n")
    df = m.load(p)
    issues = m.checks(df)
    assert issues == [f"量異常已排除:['{pd.Timestamp(d):%m/%d}']"]
    assert np.isnan(df.volume.iloc[30])
