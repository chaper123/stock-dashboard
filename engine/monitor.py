"""台股ETF 買點監測：指標 + 規則判定。
用法：python3 monitor.py config.json
config.json 範例：
{"pool": 6000, "last_buy_days": 6,
 "etfs": {"009816": {"csv": "data/009816_norm.csv", "held": true,  "premium": 0.42, "intraday": 16.85, "event": "none"},
          "00981A": {"csv": "data/00981A_norm.csv", "held": false, "premium": -0.09, "intraday": null, "event": "none"}}}
CSV 欄位：date,volume,open,high,low,close（無表頭，日期 YYYY-MM-DD）。
event 只能是 none / block（重大負面，暫停買入）/ boost（情緒錯殺且隔夜已修復，可升一級）。
"""
import sys, json
import pandas as pd
import numpy as np

# ===== 可調參數（使用者同意後才改）=====
P = dict(
    overheat_bias=6.0, overheat_rsi=75,          # 追價區
    starter_bias_max=4.0, starter_rsi_max=70,    # 趨勢起始倉
    prem_downgrade=1.0, prem_block=2.0,          # 溢價降級 / 禁買
    pct_starter=0.15, pct_z1=0.25, pct_z2=0.40, pct_z3=0.60,
    run_cap=0.60,                                # 單次合計上限（佔資金池）
    floor_pool=9000, floor_days=30,              # 空手提醒門檻（只提醒，不買）
)


def load(path):
    df = pd.read_csv(path, names=["date", "volume", "open", "high", "low", "close"])
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").drop_duplicates("date").reset_index(drop=True)


def checks(df):
    issues = []
    bad = df[(df.high < df[["open", "close"]].max(axis=1)) | (df.low > df[["open", "close"]].min(axis=1))]
    if len(bad):
        issues.append(f"OHLC不合理:{list(bad.date.dt.strftime('%m/%d'))}")
    if (df.date.dt.weekday >= 5).any():
        issues.append("含週末日期")
    j = df.close.pct_change().abs()
    if (j > 0.10).any():
        issues.append(f"單日變動>10%:{list(df[j > 0.10].date.dt.strftime('%m/%d'))}")
    med = df.volume.rolling(20, min_periods=5).median()
    out = df.volume > med * 50
    if out.any():
        issues.append(f"量異常已排除:{list(df[out].date.dt.strftime('%m/%d'))}")
        df.loc[out, "volume"] = np.nan
    return issues


def indicators(df):
    c, n = df.close, len(df)
    d = c.diff()
    au = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    ad = (-d.clip(upper=0)).ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    rsi = 100 - 100 / (1 + au / ad)
    pc = c.shift()
    tr = pd.concat([df.high - df.low, (df.high - pc).abs(), (df.low - pc).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / 14, adjust=False, min_periods=14).mean()
    ma20, ma60 = c.rolling(20).mean(), c.rolling(60).mean()
    r = dict(rows=n, last=df.date.iloc[-1].strftime("%Y-%m-%d"), close=float(c.iloc[-1]),
             ma20=float(ma20.iloc[-1]) if n >= 20 else None,
             ma60=float(ma60.iloc[-1]) if n >= 60 else None,
             ma20_rising=bool(ma20.iloc[-1] > ma20.iloc[-6]) if n >= 25 else None,
             ma60_rising=bool(ma60.iloc[-1] > ma60.iloc[-6]) if n >= 65 else None,
             rsi=float(rsi.iloc[-1]) if n >= 15 else None,
             atr=float(atr.iloc[-1]) if n >= 15 else None,
             hi60=float(df.high.tail(60).max()), lo20=float(df.low.tail(20).min()), hi20=float(df.high.tail(20).max()))
    r["bias20"] = (r["close"] / r["ma20"] - 1) * 100 if r["ma20"] else None
    r["bias60"] = (r["close"] / r["ma60"] - 1) * 100 if r["ma60"] else None
    v = df.volume
    r["vol_ratio"] = float(v.iloc[-1] / v.iloc[-21:-1].mean()) if v.tail(21).notna().sum() >= 15 else None
    wk = df.set_index("date").close.resample("W-FRI").last().dropna()
    r["weekly_up"] = bool(wk.rolling(10).mean().iloc[-1] > wk.rolling(10).mean().iloc[-2]) if len(wk) >= 11 else None
    sub = df.tail(60).reset_index(drop=True)
    r["swing_lows"] = [(sub.date[i].strftime("%m/%d"), float(sub.low[i])) for i in range(3, len(sub) - 3)
                       if sub.low[i] == sub.low[i - 3:i + 4].min()][-3:]
    if r["ma20"] and r["ma60"]:
        r["trend"] = "多頭" if r["close"] > r["ma20"] > r["ma60"] else ("空頭" if r["close"] < r["ma20"] < r["ma60"] else "整理")
    elif r["ma20"]:
        r["trend"] = "多頭(無MA60)" if r["close"] > r["ma20"] and r["ma20_rising"] else "整理(無MA60)"
    else:
        r["trend"] = "樣本不足"
    return r


def zones(r):
    a, m20, m60 = r["atr"], r["ma20"], r["ma60"]
    z = {}
    if m20:
        z["starter"] = (round(m20, 2), round(m20 * (1 + P["starter_bias_max"] / 100), 2))
        z["z1"] = (round(m20 - 0.5 * a, 2), round(m20 + 0.5 * a, 2))
    base2 = m60 if m60 else (min(l for _, l in r["swing_lows"]) if r["swing_lows"] else None)
    if base2:
        z["z2"] = (round(base2 - 0.5 * a, 2), round(base2 + 0.5 * a, 2))
    if m60:
        z["z3"] = (round(min(m60 - 1.5 * a, r["hi60"] * 0.88) - a, 2), round(min(m60 - 1.5 * a, r["hi60"] * 0.88), 2))
    return z


def decide(code, r, z, e, pool):
    px = e.get("intraday") or r["close"]
    prem, held, ev = e.get("premium"), e.get("held"), e.get("event", "none")
    bias = (px / r["ma20"] - 1) * 100 if r["ma20"] else None
    why, level = [], "wait"
    uptrend = r["trend"].startswith("多頭")
    if ev == "block":
        return "暫停", 0, ["重大負面事件（由事件層判定）"], px, bias
    if r["trend"] == "空頭" and r.get("ma60_rising") is False:
        why.append("空頭排列且MA60下彎：不接刀，等止穩")
        return "等待（趨勢轉弱）", 0, why, px, bias
    # RSI 用前一日收盤計算，盤中大跌時可能過時，因此 RSI 過熱需搭配乖離仍 >3% 才成立
    if bias is not None and (bias > P["overheat_bias"] or ((r["rsi"] or 0) > P["overheat_rsi"] and bias > 3)):
        why.append(f"乖離{bias:.1f}% / RSI {r['rsi']:.0f}：追價區")
        level = "overheat"
    elif "z3" in z and px <= z["z3"][1]:
        level = "z3"
    elif "z2" in z and px <= z["z2"][1]:
        level = "z2"
    elif "z1" in z and px <= z["z1"][1]:
        level = "z1"
    elif (not held) and uptrend and r.get("weekly_up") is not False and bias is not None \
            and 0 <= bias <= P["starter_bias_max"] and (r["rsi"] or 0) <= P["starter_rsi_max"]:
        level = "starter"
    order = ["overheat", "wait", "starter", "z1", "z2", "z3"]
    if ev == "boost" and level in ("wait", "starter", "z1", "z2"):
        level = order[min(order.index(level) + 1, 5)]
        why.append("事件層：情緒錯殺且隔夜已修復，升一級")
    if prem is not None and level not in ("overheat", "wait"):
        if prem >= P["prem_block"]:
            why.append(f"最近溢價{prem:.2f}% ≥ {P['prem_block']}%：禁買")
            level = "wait"
        elif prem >= P["prem_downgrade"]:
            why.append(f"最近溢價{prem:.2f}% ≥ {P['prem_downgrade']}%：降一級")
            level = order[order.index(level) - 1] if level != "starter" else "wait"
    pct = {"starter": P["pct_starter"], "z1": P["pct_z1"], "z2": P["pct_z2"], "z3": P["pct_z3"]}.get(level, 0)
    name = {"overheat": "追價區（不買）", "wait": "等待回檔", "starter": "趨勢起始倉", "z1": "第一買區",
            "z2": "第二買區", "z3": "深度買區"}[level]
    return name, round(pool * pct), why, px, bias


def main(cfg):
    pool = cfg["pool"]
    res = {}
    for code, e in cfg["etfs"].items():
        df = load(e["csv"])
        issues = checks(df)
        r = indicators(df)
        z = zones(r)
        st, amt, why, px, bias = decide(code, r, z, e, pool)
        tgt = z.get("z1", (None, None))[1]
        res[code] = dict(status=st, amount=amt, why=why, price_used=px, bias_now=bias, zones=z, issues=issues,
                         dist_to_z1_pct=((tgt / px - 1) * 100 if tgt else None), **r)
    total = sum(v["amount"] for v in res.values())
    cap = pool * P["run_cap"]
    if total > cap:
        k = cap / total
        for v in res.values():
            v["amount"] = round(v["amount"] * k)
        total = round(cap)
    # 空手提醒：只提醒機會成本，不產生買進金額（使用者偏向價值投資，不硬買）
    days = cfg.get("last_buy_days", 0)
    idle = dict(days=days, pool=pool,
                alert=(total == 0 and pool >= P["floor_pool"] and days >= P["floor_days"]))
    out = dict(pool=pool, total_suggest=sum(v["amount"] for v in res.values()), idle_reminder=idle, params=P, etfs=res)
    print(json.dumps(out, ensure_ascii=False, indent=1,
                     default=lambda x: round(x, 3) if isinstance(x, (float, np.floating)) else str(x)))


if __name__ == "__main__":
    main(json.load(open(sys.argv[1])))
