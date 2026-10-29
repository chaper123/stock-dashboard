"""backtest/sim.py：入金時程、XIRR、不使用未來資料（截斷資料後到截斷日為止的判定與買進完全相同）。
用合成日線，不需要下載資料。"""
import importlib.util
import pathlib

import numpy as np
import pandas as pd
import pytest

HERE = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bt_sim", HERE / "sim.py")
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)


def synth(path, name, n=520, seed=0, start="2019-01-01", drift=0.0003):
    rng = np.random.default_rng(seed)
    c = 50 * np.exp(np.cumsum(rng.normal(drift, 0.013, n)))
    o = c * (1 + rng.normal(0, 0.004, n))
    h = np.maximum(o, c) * (1 + rng.uniform(0, 0.01, n))
    lo = np.minimum(o, c) * (1 - rng.uniform(0, 0.01, n))
    dates = pd.bdate_range(start, periods=n)
    pd.DataFrame({"d": dates.strftime("%Y-%m-%d"), "v": rng.integers(1_000_000, 2_000_000, n),
                  "o": o.round(4), "h": h.round(4), "l": lo.round(4), "c": c.round(4)}).to_csv(
        path / f"{name}.csv", header=False, index=False)
    (path / f"{name}_div.csv").write_text("")
    return dates


@pytest.fixture
def data(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA", tmp_path)
    dates = synth(tmp_path, "0050", seed=1)
    for k, c in enumerate(["SPY", "GOOGL"]):
        synth(tmp_path, c, seed=10 + k, drift=0.0004)
    fx_dates = pd.bdate_range("2018-06-01", periods=700)
    rate = 30 + np.cumsum(np.random.default_rng(5).normal(0, 0.03, len(fx_dates)))
    pd.DataFrame({"d": fx_dates.strftime("%Y-%m-%d"), "r": rate.round(3)}).to_csv(
        tmp_path / "usdtwd_bot_sell.csv", header=False, index=False)
    monkeypatch.setattr(S, "US_TICKERS", ["SPY", "GOOGL"])
    return dates


def test_deposits():
    d = S.deposits("2024-01-02", "2024-04-10")
    assert d == [(pd.Timestamp("2024-01-02"), 6000), (pd.Timestamp("2024-01-06"), 3000),
                 (pd.Timestamp("2024-02-06"), 3000), (pd.Timestamp("2024-03-06"), 3000),
                 (pd.Timestamp("2024-04-06"), 3000)]
    assert S.deposits("2024-01-07", "2024-02-05") == [(pd.Timestamp("2024-01-07"), 6000)]


def test_xirr_known():
    flows = [(pd.Timestamp("2020-01-01"), -1000), (pd.Timestamp("2021-01-01"), 1100)]
    assert S.xirr(flows) == pytest.approx(1.1 ** (365 / 366) - 1, abs=1e-6)  # 2020 年有 366 天，年化用 365
    flows = [(pd.Timestamp("2020-01-01"), -1000), (pd.Timestamp("2020-07-01"), -1000),
             (pd.Timestamp("2021-01-01"), 2000)]
    assert S.xirr(flows) == pytest.approx(0, abs=1e-6)


@pytest.mark.parametrize("version", ["A", "B", "C"])
def test_tw_no_lookahead(data, version):
    full = S.read_bars("0050")
    start, cut = data[300], data[420]
    trunc = full[full.date <= cut].reset_index(drop=True)
    trunc.attrs["lines"] = full.attrs["lines"][:len(trunc)]
    a = S.run_tw(version, start, cut, full, {})
    b = S.run_tw(version, start, cut, trunc, {})
    assert a["signals"] == b["signals"] and a["buys"] == b["buys"]
    assert a["daily"] == b["daily"]


@pytest.mark.parametrize("version", ["A", "C"])
def test_us_no_lookahead(data, version):
    bars = {c: S.read_bars(c) for c in S.US_TICKERS}
    fx = S.read_fx()
    start, cut = data[300], data[380]
    trunc = {}
    for c, b in bars.items():
        t = b[b.date <= cut].reset_index(drop=True)
        t.attrs["lines"] = b.attrs["lines"][:len(t)]
        trunc[c] = t
    divs = {c: {} for c in bars}
    a = S.run_us(version, start, cut, bars, divs, fx)
    b = S.run_us(version, start, cut, trunc, divs, fx)
    assert a["signals"] == b["signals"] and a["buys"] == b["buys"]


def test_light_only_after_release(tmp_path, monkeypatch):
    """燈號在發布日的隔天才可使用；有實際發布日時用實際發布日。"""
    monkeypatch.setattr(S, "DATA", tmp_path)
    (tmp_path / "tw_business_cycle.csv").write_text(
        "2024-01,20,黃藍,2024-02-29,,\n2024-02,15,藍,2024-03-29,,\n2024-03,40,紅,2024-04-30,2024-04-26,40\n",
        encoding="utf-8")
    cyc = S.read_cycle()
    on = lambda d: S.light_on(cyc, pd.Timestamp(d))  # noqa: E731
    assert on("2024-02-29") is None and on("2024-03-01") == "黃藍"
    assert on("2024-03-29") == "黃藍" and on("2024-03-30") == "藍"
    assert on("2024-04-26") == "藍" and on("2024-04-27") == "紅"   # 用實際發布日 4/26，不等到 4/30


def test_tw_d_no_lookahead_and_upgrade(data, tmp_path):
    months = pd.period_range("2018-01", "2021-12", freq="M")
    rows = [f"{m},{12},藍,{(m + 1).to_timestamp():%Y-%m}-28,," for m in months]
    (tmp_path / "tw_business_cycle.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    cyc = S.read_cycle()
    full = S.read_bars("0050")
    start, cut = data[300], data[420]
    trunc = full[full.date <= cut].reset_index(drop=True)
    trunc.attrs["lines"] = full.attrs["lines"][:len(trunc)]
    a = S.run_tw("D", start, cut, full, {}, cycle=cyc)
    b = S.run_tw("D", start, cut, trunc, {}, cycle=cyc)
    assert a["signals"] == b["signals"] and a["buys"] == b["buys"]
    base = S.run_tw("A", start, cut, full, {})
    lv = {i: name for i, name, _ in base["signals"]}
    up = [(lv[i], name) for i, name, _ in a["signals"] if lv[i] != name]
    assert up and all((x, y) in {("第一買區", "第二買區"), ("第二買區", "深度買區")} for x, y in up)


def test_dca_buys_on_deposit_days(data):
    bars = S.read_bars("0050")
    r = S.run_tw("A", data[300], data[420], bars, {}, dca=True)
    deps = S.deposits(data[300], data[420])
    assert len(r["buys"]) == len(deps)
    assert sum(c for _, c in r["buys"]) <= sum(a for _, a in deps)
    assert r["cash"] < bars.open.iloc[420] * 1.01  # 只剩不到一股的零頭
