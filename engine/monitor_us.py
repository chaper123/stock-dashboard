"""美股買點監測（規則比台股嚴格）。用法：python3 monitor_us.py config.json
config.json：
{"pool_twd": 6000, "fx_csv": "data/usdtwd.csv",
 "positions": {"GOOGL": {"shares": 0.1826, "cost_usd": 62.1}, "VOO": {"shares": 0.1262, "cost_usd": 82.4}},
 "tickers": {
   "VOO":  {"csv": "data/VOO.csv",  "role": "buy",   "kind": "etf",   "event": "none", "val": {"pe": 27.05, "px_at": 714.77}},
   "GOOGL":{"csv": "data/GOOGL.csv","role": "buy",   "kind": "stock", "event": "none", "val": {"fwd_pe": 26.18, "peg": 1.98, "px_at": 352.16}},
   "IAUM": {"csv": "data/IAUM.csv", "role": "gauge"},
   "ARKK": {"csv": "data/ARKK.csv", "role": "watch"}}}
role：buy（可給金額）/ watch（只觀察）/ gauge（市場指標）。
event：none / block（重大負面，暫停）/ boost（情緒錯殺且已修復，買區內升一級）。
val：每週估值快取；px_at 是抓估值當時的股價，程式依今日收盤等比例換算本益比與 PEG。
fx_csv：台銀美元即期賣出，欄位 date,rate（無表頭，任意排序）。
下單限制（口袋美股，使用者 2026-10-16 告知）：每筆最低 50 美元；台幣交割要圈存「委託金額 × 匯率 × 1.03」。
規則金額（台幣）換成可下單美元時先扣掉這 3%；不足 50 美元就不下單（使用者選擇「不足就不買」）。
"""
import sys, json, math
import pandas as pd
import numpy as np

# ===== 可調參數（使用者同意後才改）=====
P = dict(
    overheat_bias=8.0, overheat_rsi=70, overheat_rsi_bias=4.0,  # 追價區（乖離以 MA50 計）
    pct_z1=0.20, pct_z2=0.35, pct_z3=0.50,                     # 佔共用資金池
    run_cap=0.40,                                               # 美股單次合計上限（台股為 60%）
    z3_hi_mult=0.85,                                            # 深度買區：近一年高點 × 0.85
    fx_window=120, fx_down=2.0, fx_only_z3=4.0,                 # 匯率濾網（%）
    pe_stock=(20, 30, 45), peg_cheap=1.0, peg_rich=2.5,         # 個股 Forward PE 分級
    pe_index=(18, 24, 30),                                      # 指數 ETF 本益比分級
    min_order_usd=50.0, hold_mult=1.03,                         # 最低下單 50 美元；台幣交割圈存多 3%
)
LABELS = ["偏便宜", "合理", "偏貴", "明顯偏貴"]
ZONES = ["z1", "z2", "z3"]
PCT = {"z1": P["pct_z1"], "z2": P["pct_z2"], "z3": P["pct_z3"]}
NAMES = {"overheat": "追價區（不買）", "wait": "等待回檔", "z1": "第一買區", "z2": "第二買區", "z3": "深度買區"}


def load(path):
    df = pd.read_csv(path, names=["date", "volume", "open", "high", "low", "close"])
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").drop_duplicates("date").reset_index(drop=True)


def checks(df):
    issues = []
    bad = df[(df.high < df[["open", "close"]].max(axis=1) - 1e-6) | (df.low > df[["open", "close"]].min(axis=1) + 1e-6)]
    if len(bad):
        issues.append(f"OHLC不合理:{list(bad.date.dt.strftime('%m/%d'))}")
    if (df.date.dt.weekday >= 5).any():
        issues.append("含週末日期")
    j = df.close.pct_change().abs()
    if (j > 0.20).any():
        issues.append(f"單日變動>20%（請核對）:{list(df[j > 0.20].date.dt.strftime('%m/%d'))}")
    gap = df.date.diff().dt.days
    if (gap > 5).any():
        issues.append(f"日期缺口>5天:{list(df[gap > 5].date.dt.strftime('%m/%d'))}")
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
    ma50, ma200 = c.rolling(50).mean(), c.rolling(200).mean()
    last = lambda s: float(s.iloc[-1])
    r = dict(rows=n, last=df.date.iloc[-1].strftime("%Y-%m-%d"), close=last(c),
             chg1=(last(c) / float(c.iloc[-2]) - 1) * 100 if n >= 2 else None,
             chg20=(last(c) / float(c.iloc[-21]) - 1) * 100 if n >= 21 else None,
             ma50=last(ma50) if n >= 50 else None, ma200=last(ma200) if n >= 200 else None,
             ma50_rising=bool(ma50.iloc[-1] > ma50.iloc[-6]) if n >= 55 else None,
             ma200_rising=bool(ma200.iloc[-1] > ma200.iloc[-11]) if n >= 210 else None,
             rsi=last(rsi) if n >= 15 else None, atr=last(atr) if n >= 15 else None,
             hi52=float(df.high.tail(252).max()), lo52=float(df.low.tail(252).min()))
    r["bias50"] = (r["close"] / r["ma50"] - 1) * 100 if r["ma50"] else None
    r["bias200"] = (r["close"] / r["ma200"] - 1) * 100 if r["ma200"] else None
    r["from_hi52"] = (r["close"] / r["hi52"] - 1) * 100
    v = df.volume
    r["vol_ratio"] = float(v.iloc[-1] / v.iloc[-21:-1].mean()) if v.tail(21).notna().sum() >= 15 else None
    wk = df.set_index("date").close.resample("W-FRI").last().dropna()
    r["weekly_up"] = bool(wk.rolling(10).mean().iloc[-1] > wk.rolling(10).mean().iloc[-2]) if len(wk) >= 11 else None
    sub = df.tail(60).reset_index(drop=True)
    r["swing_lows"] = [(sub.date[i].strftime("%m/%d"), float(sub.low[i])) for i in range(3, len(sub) - 3)
                       if sub.low[i] == sub.low[i - 3:i + 4].min()][-3:]
    m50, m200, px = r["ma50"], r["ma200"], r["close"]
    if m50 and m200:
        r["trend"] = "多頭" if px > m50 > m200 else ("空頭" if px < m50 < m200 else "整理")
    elif m50:
        r["trend"] = ("多頭(無MA200)" if px > m50 and r["ma50_rising"] else
                      "空頭(無MA200)" if px < m50 and r["ma50_rising"] is False else "整理(無MA200)")
    else:
        r["trend"] = "樣本不足"
    return r


def zones(r):
    """買區由淺到深，深的一定在淺的下面。回傳 {zone: (下緣, 上緣)}。"""
    a, m50, m200 = r["atr"], r["ma50"], r["ma200"]
    z = {}
    if not a or not m50:
        return z
    z["z1"] = (m50 - 0.5 * a, m50 + 0.5 * a)
    if m200:
        top2 = min(m200 + 0.5 * a, z["z1"][0])
    elif r["swing_lows"]:
        top2 = min(min(l for _, l in r["swing_lows"]) + 0.5 * a, z["z1"][0])
    else:
        top2 = None
    if top2 is not None:
        z["z2"] = (top2 - a, top2)
    if m200 and "z2" in z:
        top3 = min(m200 - 1.5 * a, r["hi52"] * P["z3_hi_mult"], z["z2"][0])
        z["z3"] = (top3 - a, top3)
    return {k: (round(lo, 2), round(hi, 2)) for k, (lo, hi) in z.items()}


def valuation(e, px):
    v = e.get("val") or {}
    if not v:
        return "無資料", {}
    k = px / v["px_at"] if v.get("px_at") else 1.0
    if e.get("kind") == "etf":
        pe = v.get("pe")
        if not pe or pe <= 0:
            return "無法估值", {}
        pe_now = pe * k
        return LABELS[sum(pe_now > t for t in P["pe_index"])], dict(pe=round(pe_now, 1))
    fpe = v.get("fwd_pe")
    if not fpe or fpe <= 0:
        return "無法估值", {}
    fpe_now = fpe * k
    idx = sum(fpe_now > t for t in P["pe_stock"])
    peg = v.get("peg")
    peg_now = peg * k if peg and peg > 0 else None
    if peg_now is not None:
        idx += -1 if peg_now < P["peg_cheap"] else (1 if peg_now > P["peg_rich"] else 0)
    return LABELS[max(0, min(3, idx))], dict(fwd_pe=round(fpe_now, 1), peg=round(peg_now, 2) if peg_now else None)


def fx_state(path):
    fx = pd.read_csv(path, names=["date", "rate"])
    fx["date"] = pd.to_datetime(fx["date"])
    fx = fx.sort_values("date").drop_duplicates("date")
    now = float(fx.rate.iloc[-1])
    mean = float(fx.rate.tail(P["fx_window"]).mean())
    return dict(date=fx.date.iloc[-1].strftime("%Y-%m-%d"), rate=now, mean=round(mean, 3),
                dev_pct=round((now / mean - 1) * 100, 2), rows=len(fx))


def down(level, why, reason):
    why.append(reason)
    return {"z3": "z2", "z2": "z1", "z1": "wait"}.get(level, level)


def to_usd(twd, fx):
    """台幣預算 → 可下單美元。圈存 = 委託金額 × 匯率 × 1.03，所以除以 (匯率 × 1.03)，無條件捨去到 0.01。"""
    return math.floor(twd / (fx["rate"] * P["hold_mult"]) * 100 + 1e-9) / 100


def min_pool(level, fx):
    """這個買區單獨出現時，資金池至少要多少台幣，規則金額才夠下單最低 50 美元（上限 40% 也算進去）。"""
    eff = min(PCT[level], P["run_cap"])
    pool = math.ceil(P["min_order_usd"] * fx["rate"] * P["hold_mult"] / eff)
    while to_usd(round(pool * eff), fx) < P["min_order_usd"]:
        pool += 1
    return pool


def allocate(res, order, pool, fx):
    """分配本次美股金額（就地修改 res）。
    1. 每檔先照買區比例算規則金額；合計超過上限 40% 時等比例縮小（和原本相同）。
    2. 換成可下單美元（扣 3% 圈存）；有一檔不足 50 美元，就拿掉其中優先順序最低的一檔，其餘重算，直到都夠或都拿掉。
    優先順序：買區越深越前面 → 估值越便宜越前面 → 價格低於第一買區上緣越多越前面 → config 順序。"""
    cap = pool * P["run_cap"]
    val_rank = {"偏便宜": 0, "合理": 1, "偏貴": 2}
    cand = [c for c in order if res[c]["amount_twd"] > 0]
    cand.sort(key=lambda c: (-ZONES.index(res[c]["level"]), val_rank.get(res[c]["valuation"], 3),
                             -(res[c]["dist_to_z1_pct"] or 0), order.index(c)))
    budget = {c: res[c]["amount_twd"] for c in cand}
    for v in res.values():
        v["amount_twd"], v["amount_usd"], v["hold_twd"] = 0, 0, 0
    if not cand:
        return
    if not fx:
        for c in cand:
            res[c]["why"].append(f"匯率未取得，無法確認是否達最低下單 {P['min_order_usd']:.0f} 美元：不下單")
        return
    keep, alloc = list(cand), {}
    while keep:
        total = sum(budget[c] for c in keep)
        k = cap / total if total > cap else 1
        alloc = {c: round(budget[c] * k) if k < 1 else budget[c] for c in keep}
        low = [c for c in keep if to_usd(alloc[c], fx) < P["min_order_usd"]]
        if not low:
            break
        c = low[-1]
        alone = min(budget[c], round(cap))
        if to_usd(alone, fx) < P["min_order_usd"]:
            res[c]["why"].append(f"規則金額 NT${alone:,}（扣 3% 圈存可下單約 US${to_usd(alone, fx):.2f}）"
                                 f"不足最低下單 {P['min_order_usd']:.0f} 美元：不下單；"
                                 f"這個買區要資金池約 NT${min_pool(res[c]['level'], fx):,} 才買得到")
        else:
            res[c]["why"].append(f"同時有優先順序較高的訊號，美股單次上限 NT${round(cap):,} "
                                 f"不夠再下一筆 {P['min_order_usd']:.0f} 美元：不下單")
        keep.remove(c)
    for c in keep:
        usd = to_usd(alloc[c], fx)
        res[c]["amount_twd"], res[c]["amount_usd"] = alloc[c], usd
        res[c]["hold_twd"] = math.ceil(usd * fx["rate"] * P["hold_mult"])


def decide(e, r, z, fx):
    px, ev, why = r["close"], e.get("event", "none"), []
    vlabel, vnum = valuation(e, px) if e.get("role", "buy") == "buy" else ("—", {})
    if e.get("role", "buy") != "buy":
        return ("市場指標" if e.get("role") == "gauge" else "觀察（不給金額）"), "none", why, vlabel, vnum
    if ev == "block":
        return "暫停", "none", ["重大負面事件（事件層判定）"], vlabel, vnum
    weak = (r["ma200"] and r["close"] < r["ma50"] < r["ma200"] and r["ma200_rising"] is False) or \
           (not r["ma200"] and r["ma50"] and r["close"] < r["ma50"] and r["ma50_rising"] is False)
    if weak:
        return "等待（趨勢轉弱，不接刀）", "none", ["空頭排列且長均線下彎"], vlabel, vnum
    b = r["bias50"]
    if b is not None and (b > P["overheat_bias"] or ((r["rsi"] or 0) > P["overheat_rsi"] and b > P["overheat_rsi_bias"])):
        why.append(f"乖離MA50 {b:.1f}% / RSI {r['rsi']:.0f}")
        level = "overheat"
    elif "z3" in z and px <= z["z3"][1]:
        level = "z3"
    elif "z2" in z and px <= z["z2"][1]:
        level = "z2"
    elif "z1" in z and px <= z["z1"][1]:
        level = "z1"
    else:
        level = "wait"
    if ev == "boost" and level in ("z1", "z2"):
        level = {"z1": "z2", "z2": "z3"}[level]
        why.append("事件層：情緒錯殺且已修復，買區內升一級")
    if level in ZONES:
        if vlabel == "明顯偏貴":
            why.append("估值明顯偏貴：禁買")
            level = "wait"
        elif vlabel in ("偏貴", "無法估值", "無資料"):
            level = down(level, why, f"估值{vlabel}：降一級")
    if level in ZONES and fx:
        if fx["dev_pct"] >= P["fx_only_z3"] and level != "z3":
            why.append(f"美元高於半年均值 {fx['dev_pct']}%：只允許深度買區")
            level = "wait"
        elif fx["dev_pct"] >= P["fx_down"]:
            level = down(level, why, f"美元高於半年均值 {fx['dev_pct']}%：降一級")
    return NAMES[level], level, why, vlabel, vnum


def main(cfg):
    pool = cfg["pool_twd"]
    fx = fx_state(cfg["fx_csv"]) if cfg.get("fx_csv") else None
    res = {}
    for code, e in cfg["tickers"].items():
        df = load(e["csv"])
        issues = checks(df)
        r = indicators(df)
        z = zones(r)
        st, level, why, vlabel, vnum = decide(e, r, z, fx)
        pct = PCT.get(level, 0)
        tgt = z.get("z1", (None, None))[1]
        res[code] = dict(role=e.get("role", "buy"), status=st, level=level, amount_twd=round(pool * pct), why=why,
                         valuation=vlabel, val_now=vnum, zones=z, issues=issues,
                         dist_to_z1_pct=((tgt / r["close"] - 1) * 100 if tgt else None), **r)
    cap = pool * P["run_cap"]
    allocate(res, list(cfg["tickers"]), pool, fx)
    min_order = dict(usd=P["min_order_usd"], hold_mult=P["hold_mult"], twd=None, pool_needed=None)
    if fx:
        min_order.update(twd=math.ceil(P["min_order_usd"] * fx["rate"] * P["hold_mult"]),
                         pool_needed={lv: min_pool(lv, fx) for lv in ZONES})
    pos = {}
    for code, p in cfg.get("positions", {}).items():
        if code in res:
            mv = p["shares"] * res[code]["close"]
            pos[code] = dict(shares=p["shares"], cost_usd=p["cost_usd"], cost_px=round(p["cost_usd"] / p["shares"], 2),
                             close=res[code]["close"], mv_usd=round(mv, 2), pnl_usd=round(mv - p["cost_usd"], 2),
                             pnl_pct=round((mv / p["cost_usd"] - 1) * 100, 2))
    g, s = res.get("IAUM"), res.get("VOO")
    gauge = None
    if g and s and g["chg20"] is not None and s["chg20"] is not None:
        tag = ("避險升溫" if g["chg20"] >= 4 and s["chg20"] <= 0 else
               "風險偏好" if g["chg20"] <= 0 and s["chg20"] >= 2 else "中性")
        gauge = dict(iaum_chg20=round(g["chg20"], 2), voo_chg20=round(s["chg20"], 2), iaum_trend=g["trend"], tag=tag)
    out = dict(pool_twd=pool, cap_twd=round(cap), total_twd=sum(v["amount_twd"] for v in res.values()),
               fx=fx, min_order=min_order, gauge=gauge, positions=pos, params=P, tickers=res)
    def rnd(o):
        if isinstance(o, dict):
            return {k: rnd(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [rnd(v) for v in o]
        if isinstance(o, (float, np.floating)):
            return round(float(o), 4)
        return o
    print(json.dumps(rnd(out), ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main(json.load(open(sys.argv[1])))
