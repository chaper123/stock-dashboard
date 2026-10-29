"""KDJ(9,3,3) 與止跌確認（回測用，不屬於 engine 規則）。

算法和網站 K 線頁一致（site/js/pages/charts.js 的 kdj()，c5400e0）：
RSV＝(收盤−9日最低)÷(9日最高−9日最低)×100，分母為 0 時沿用前一個 RSV；
K＝2/3 前K＋1/3 RSV、D＝2/3 前D＋1/3 K，起始 K＝D＝50（RSV 起始也是 50）；J＝3K−2D。
前 8 根沒有值（NaN）。

止跌確認（回測 B／C 版）：K 由下往上穿過 D（前一根 K ≤ D、這一根 K > D），而且這一根 K < 30。
"""
import numpy as np
import pandas as pd

N = 9
K_MAX = 30.0


def kdj(high, low, close, n=N):
    """回傳 DataFrame(k, d, j)，索引同輸入；前 n−1 根是 NaN。"""
    h, lo, c = (np.asarray(x, dtype=float) for x in (high, low, close))
    k_out, d_out = np.full(len(c), np.nan), np.full(len(c), np.nan)
    k = d = rsv = 50.0
    for i in range(n - 1, len(c)):
        hi_, lo_ = h[i - n + 1:i + 1].max(), lo[i - n + 1:i + 1].min()
        if hi_ > lo_:
            rsv = (c[i] - lo_) / (hi_ - lo_) * 100
        k = 2 / 3 * k + rsv / 3
        d = 2 / 3 * d + k / 3
        k_out[i], d_out[i] = k, d
    idx = close.index if isinstance(close, pd.Series) else None
    return pd.DataFrame({"k": k_out, "d": d_out, "j": 3 * k_out - 2 * d_out}, index=idx)


def cross_up(k_prev, d_prev, k_now, d_now, k_max=K_MAX):
    """止跌確認：K 由下往上穿過 D 且 K < k_max。任何一個值缺就是 False。"""
    vals = (k_prev, d_prev, k_now, d_now)
    if any(v is None or (isinstance(v, float) and np.isnan(v)) for v in vals):
        return False
    return bool(k_prev <= d_prev and k_now > d_now and k_now < k_max)


def daily_confirm(df):
    """日 KDJ 止跌確認：回傳以日期為索引的布林 Series，值代表「用到這一天收盤為止」是否確認。"""
    kd = kdj(df["high"], df["low"], df["close"])
    kp, dp = kd["k"].shift(1), kd["d"].shift(1)
    ok = [cross_up(a, b, c, e) for a, b, c, e in zip(kp, dp, kd["k"], kd["d"])]
    return pd.Series(ok, index=df["date"].values), kd.set_index(df["date"].values)


def weekly_asof(df, n=N):
    """週 KD（週五為一週，與 engine 的 resample('W-FRI') 相同）在每個交易日收盤當下的值。
    當週還沒結束時，用「前 n−1 個完整週＋本週到今天為止」算 RSV（和那天只用到當天資料重算週 K 線的結果相同）。
    回傳 DataFrame(index=日期, k, d, k_prev, d_prev)：k、d 是本週（可能未完）的值，k_prev、d_prev 是上一個完整週。"""
    d = df[["date", "high", "low", "close"]].copy()
    d["week"] = pd.to_datetime(d["date"]).dt.to_period("W-FRI")
    wk = d.groupby("week").agg(high=("high", "max"), low=("low", "min"), close=("close", "last"))
    full = kdj(wk["high"], wk["low"], wk["close"], n)
    weeks = list(wk.index)
    pos = {w: i for i, w in enumerate(weeks)}
    # 各週 K、D 的遞迴需要「上一週結束時」的 K、D 與 RSV（分母為 0 時沿用）
    rsv_full = []
    rsv = 50.0
    for i in range(len(weeks)):
        if i >= n - 1:
            hi_, lo_ = wk["high"].iloc[i - n + 1:i + 1].max(), wk["low"].iloc[i - n + 1:i + 1].min()
            if hi_ > lo_:
                rsv = (wk["close"].iloc[i] - lo_) / (hi_ - lo_) * 100
        rsv_full.append(rsv)
    out = []
    run_hi = run_lo = None
    cur = None
    for row in d.itertuples(index=False):
        if row.week != cur:
            cur, run_hi, run_lo = row.week, row.high, row.low
        else:
            run_hi, run_lo = max(run_hi, row.high), min(run_lo, row.low)
        i = pos[cur]
        if i < n - 1:
            out.append((row.date, np.nan, np.nan, np.nan, np.nan))
            continue
        hi_ = max(wk["high"].iloc[i - n + 1:i].max(), run_hi) if n > 1 else run_hi
        lo_ = min(wk["low"].iloc[i - n + 1:i].min(), run_lo) if n > 1 else run_lo
        prev_rsv = rsv_full[i - 1] if i >= 1 else 50.0
        rsv_now = (row.close - lo_) / (hi_ - lo_) * 100 if hi_ > lo_ else prev_rsv
        kp = full["k"].iloc[i - 1] if i - 1 >= n - 1 else 50.0
        dp = full["d"].iloc[i - 1] if i - 1 >= n - 1 else 50.0
        k = 2 / 3 * kp + rsv_now / 3
        dd = 2 / 3 * dp + k / 3
        prev_ok = i - 1 >= n - 1
        out.append((row.date, k, dd, kp if prev_ok else np.nan, dp if prev_ok else np.nan))
    return pd.DataFrame(out, columns=["date", "k", "d", "k_prev", "d_prev"]).set_index("date")


def weekly_confirm(df):
    w = weekly_asof(df)
    ok = [cross_up(a, b, c, e) for a, b, c, e in zip(w["k_prev"], w["d_prev"], w["k"], w["d"])]
    return pd.Series(ok, index=w.index), w
