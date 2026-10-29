"""買點規則回測：逐日呼叫 engine 現有的 main()（不改規則、不重寫），模擬實際資金流。

用法：py -3.14 backtest/sim.py [tw] [us] [spy]（先執行 backtest/fetch_data.py；不給參數就全部跑；spy＝只用 SPY 單獨模擬）
輸出：backtest/out/results_tw.json、results_us.json、tables.md（docs/BACKTEST.md 的表格由此而來）

版本：
  A  現行規則（台股 engine-v1.0 monitor.py、美股 engine-v1.1 monitor_us.py）
  B  A＋日 KDJ(9,3,3) 止跌確認：engine 判定在第一／第二／深度買區時，K 由下往上穿過 D 且 K < 30 才給金額，否則當天改成等待
  C  A＋週 KD 止跌確認（同規則，週線；本週未結束時用到當天為止的資料）
  D  A＋國發會景氣對策信號（只限台股）：當天以前已發布的最新燈號是藍或黃藍、且在買區時升一級（第三買區不再升）；
     紅燈時單次上限 60% 改 40%。發布日用 release_actual（有記錄的月份）否則 release_est，發布日的下一個交易日起才使用
  基準：定期定額（入金當天把現金全部買進）
  B、C、D 都是包在 engine 外面（換掉記憶體裡模組的 decide、D 另外暫時改模組的 run_cap），engine 檔案不動。

做法與假設（詳見 docs/BACKTEST.md）：
- 台股：替代標的 0050；判定價＝當天開盤（排程 10:17 只知道到前一天收盤的日線與當下價格），成交價也用當天開盤；
  手續費 0.1425%（最低 1 元）、整股數（零股）；溢價、事件旗標不套用（沒有歷史資料）。
- 美股：SPY（代表 VOO）、GOOGL、NVDA、AAPL、TSLA（上市滿一年才納入）；判定用到當天收盤，下一個交易日開盤成交；
  估值閘門關閉（歷史 Forward PE 拿不到，估值固定成「合理」＝不降級也不禁買）；匯率濾網、最低 50 美元與 3% 圈存照 engine；
  匯率用台銀美元即期賣出；不計美股手續費；股利扣 30% 預扣稅。
- 每天餵給 engine 最近 252 根日線（和 market-data 保留一年一致）；不使用未來資料。
- 資金：起始 6,000、每月 6 日入金 3,000，台股與美股各自獨立模擬（上限 60%／40% 由 engine 處理）。
- 股利：現金另外累積、不再投入（和帳本的可用資金公式一致），期末計入總值。
"""
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import math
import pathlib
import sys

import numpy as np
import pandas as pd

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DATA, OUT = HERE / "data", HERE / "out"

_spec = importlib.util.spec_from_file_location("bt_kdj", HERE / "kdj.py")
KDJ = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(KDJ)

ENGINE_SHA = {"monitor.py": "8c12675c1c9e78a668bd4ea941a7466300cfe39cb24244ab32b8d4e0173e0149",   # engine-v1.0
              "monitor_us.py": "045d617e4cc19661af7fb4a4104a824370030a25247bd16a4e9556e79d00c84d"}  # engine-v1.1
WINDOW = 252
START = "2008-01-02"
OOS_START = "2023-10-30"
DEPOSIT0, MONTHLY, DEPOSIT_DAY = 6000, 3000, 6
TW_FEE, TW_FEE_MIN = 0.001425, 1
US_DIV_TAX = 0.30
US_TICKERS = ["SPY", "GOOGL", "NVDA", "AAPL", "TSLA"]
VERSIONS = ["A", "B", "C"]
VERSIONS_TW = VERSIONS + ["D"]
ZONE_NAMES = {"第一買區", "第二買區", "深度買區"}
TW_LEVEL = {"第一買區": "z1", "第二買區": "z2", "深度買區": "z3"}
TW_NAME = {v: k for k, v in TW_LEVEL.items()}
CAP_RED = 0.40
HORIZONS = [60, 120, 250]


# ------------------------------------------------------------------ 資料
def read_bars(name):
    df = pd.read_csv(DATA / f"{name}.csv", names=["date", "volume", "open", "high", "low", "close"])
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").reset_index(drop=True)
    df.attrs["lines"] = [f"{d:%Y-%m-%d},{v},{o},{h},{lo},{c}" for d, v, o, h, lo, c in
                         zip(df.date, df.volume, df.open, df.high, df.low, df.close)]
    return df


def read_divs(name):
    p = DATA / f"{name}_div.csv"
    if p.stat().st_size == 0:
        return {}
    d = pd.read_csv(p, names=["date", "amount"])
    return {pd.Timestamp(a): float(b) for a, b in zip(d.date, d.amount)}


def read_fx():
    fx = pd.read_csv(DATA / "usdtwd_bot_sell.csv", names=["date", "rate"])
    fx["date"] = pd.to_datetime(fx["date"])
    fx = fx.sort_values("date").reset_index(drop=True)
    fx.attrs["lines"] = [f"{d:%Y-%m-%d},{r}" for d, r in zip(fx.date, fx.rate)]
    return fx


def read_cycle():
    """景氣對策信號：回傳 [(可使用日, 燈號, 資料月)]，可使用日＝發布日的隔天（之後第一個交易日起才用）。"""
    c = pd.read_csv(DATA / "tw_business_cycle.csv", names=["month", "score", "light", "release_est",
                                                            "release_actual", "score_first"], dtype=str)
    out = []
    for m, light, est, act in zip(c.month, c.light, c.release_est, c.release_actual):
        rel = act if isinstance(act, str) and act else est
        out.append((pd.Timestamp(rel) + pd.Timedelta(days=1), light, m))
    return sorted(out)


def light_on(cycle, t):
    """t 這天（台北早上）已經公布的最新燈號；沒有就 None。"""
    best = None
    for avail, light, month in cycle:
        if avail <= t and (best is None or month > best[1]):
            best = (light, month)
    return best[0] if best else None


def deposits(start, end):
    """起始日 6,000；之後每月 6 日 3,000（起始日之後的每個 6 日）。"""
    s, e = pd.Timestamp(start), pd.Timestamp(end)
    out = [(s, DEPOSIT0)]
    y, m = s.year, s.month
    while True:
        d = pd.Timestamp(y, m, DEPOSIT_DAY)
        if d > e:
            break
        if d > s:
            out.append((d, MONTHLY))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


# ------------------------------------------------------------------ engine
def load_engine(fname, tag):
    path = ROOT / "engine" / fname
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if sha != ENGINE_SHA[fname]:
        raise SystemExit(f"engine/{fname} SHA-256 {sha} 不是 {tag}")
    spec = importlib.util.spec_from_file_location(f"bt_{fname[:-3]}_{tag}", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_main(mod, cfg):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main(cfg)
    return json.loads(buf.getvalue())


def patch_confirm(mod, market, confirm):
    """B／C 版：包住 engine 的 decide（不改檔案）。在買區但當天沒有止跌確認 → 改成等待、金額 0。
    confirm 是 dict（代號 → 當天是否確認），每天由模擬迴圈更新。"""
    orig = mod.decide
    if market == "tw":
        def decide(code, r, z, e, pool):
            name, amount, why, px, bias = orig(code, r, z, e, pool)
            if name in ZONE_NAMES and not confirm.get(code, False):
                return "等待回檔", 0, why + ["止跌未確認：當天不買"], px, bias
            return name, amount, why, px, bias
    else:
        def decide(e, r, z, fx):
            name, level, why, vlabel, vnum = orig(e, r, z, fx)
            if level in mod.ZONES and not confirm.get(e.get("_code"), False):
                return mod.NAMES["wait"], "wait", why + ["止跌未確認：當天不買"], vlabel, vnum
            return name, level, why, vlabel, vnum
    mod.decide = decide


def patch_cycle(mod, state):
    """D 版（台股）：燈號藍、黃藍且在買區 → 升一級（金額照 engine 的比例重算）；紅燈的上限由迴圈改 mod.P。"""
    orig = mod.decide

    def decide(code, r, z, e, pool):
        name, amount, why, px, bias = orig(code, r, z, e, pool)
        if name in ZONE_NAMES and state.get("light") in ("藍", "黃藍") and name != "深度買區":
            up = {"z1": "z2", "z2": "z3"}[TW_LEVEL[name]]
            return TW_NAME[up], round(pool * mod.P["pct_" + up]), why + [f"景氣燈號{state['light']}：升一級"], px, bias
        return name, amount, why, px, bias
    mod.decide = decide


def confirm_series(df, version):
    if version == "B":
        return KDJ.daily_confirm(df)[0]
    if version == "C":
        return KDJ.weekly_confirm(df)[0]
    return None


# ------------------------------------------------------------------ 台股
def run_tw(version, start, end, bars, divs, dca=False, cycle=None):
    mod = load_engine("monitor.py", "engine-v1.0")
    confirm, state = {}, {}
    if version in ("B", "C"):
        patch_confirm(mod, "tw", confirm)
    if version == "D":
        patch_cycle(mod, state)
        cap_normal = mod.P["run_cap"]
    conf = confirm_series(bars, version)
    days = bars.index[(bars.date >= pd.Timestamp(start)) & (bars.date <= pd.Timestamp(end))]
    lines = bars.attrs["lines"]
    deps = deposits(start, end)
    di = 0
    cash, shares, spent, div_cash = 0.0, 0, 0.0, 0.0
    last_buy, buys, daily, signals = None, [], [], []
    light_days = {}
    new_money = False
    for i in days:
        t = bars.date[i]
        while di < len(deps) and deps[di][0] <= t:
            cash += deps[di][1]
            di += 1
            new_money = True
        if t in divs and shares:
            div_cash += shares * divs[t]
        px = float(bars.open[i])
        if dca:
            amount = cash if new_money else 0
            level = "dca"
        else:
            if conf is not None:
                confirm["0050"] = bool(conf.get(bars.date[i - 1], False))
            if version == "D":
                state["light"] = light_on(cycle, t)
                mod.P["run_cap"] = CAP_RED if state["light"] == "紅" else cap_normal
                light_days[state["light"]] = light_days.get(state["light"], 0) + 1
            cfg = {"pool": int(cash), "last_buy_days": (t - (last_buy or pd.Timestamp(start))).days,
                   "etfs": {"0050": {"csv": io.StringIO("\n".join(lines[i - WINDOW:i])), "held": shares > 0,
                                     "premium": None, "intraday": px, "event": "none"}}}
            e = run_main(mod, cfg)["etfs"]["0050"]
            amount, level = e["amount"], e["status"]
            signals.append((i, level, amount))
        new_money = False
        if amount > 0:
            n = int(min(amount, cash) // (px * (1 + TW_FEE)))
            while n > 0:
                fee = max(TW_FEE_MIN, round(n * px * TW_FEE))
                if n * px + fee <= cash + 1e-9:
                    break
                n -= 1
            if n > 0:
                cost = n * px + fee
                cash -= cost
                spent += cost
                shares += n
                last_buy = t
                buys.append((t, cost))
        daily.append((t, shares * float(bars.close[i]) + cash + div_cash, cash))
    return dict(daily=daily, deposits=[(d, a) for d, a in deps if d <= bars.date[days[-1]]], buys=buys,
                signals=signals, shares=shares, spent=spent, cash=cash, div_cash=div_cash,
                avg_cost=spent / shares if shares else None, light_days=light_days)


# ------------------------------------------------------------------ 美股
def to_usd(twd, rate):
    return math.floor(twd / (rate * 1.03) * 100 + 1e-9) / 100


def run_us(version, start, end, bars, divs, fx, dca=None):
    """dca=None：engine 規則；'SPY'：每月全數買 SPY；'rotate'：每月輪流買一檔（可買名單依序）。"""
    mod = load_engine("monitor_us.py", "engine-v1.1")
    confirm = {}
    if version in ("B", "C"):
        patch_confirm(mod, "us", confirm)
    conf = {c: confirm_series(bars[c], version) for c in US_TICKERS} if version in ("B", "C") else {}
    cal = bars["SPY"].date[(bars["SPY"].date >= pd.Timestamp(start)) & (bars["SPY"].date <= pd.Timestamp(end))]
    cal = list(cal)
    pos = {c: dict(zip(bars[c].date, bars[c].index)) for c in US_TICKERS}
    fx_by_date = fx.set_index("date")["rate"]
    fx_dates = fx.date.values
    deps = deposits(start, end)
    di, rot = 0, 0
    cash, div_cash = 0.0, 0.0
    shares = {c: 0.0 for c in US_TICKERS}
    spent_usd = {c: 0.0 for c in US_TICKERS}
    pending, buys, daily, signals = [], [], [], []
    new_money = False
    for t in cal:
        while di < len(deps) and deps[di][0] <= t:
            cash += deps[di][1]
            di += 1
            new_money = True
        j_fx = int(np.searchsorted(fx_dates, np.datetime64(t), side="right")) - 1
        rate = float(fx.rate[j_fx])
        # 前一天的委託在今天開盤成交
        for c, usd in pending:
            i = pos[c].get(t)
            if i is None:  # 這檔今天沒交易，順延
                continue
            shares[c] += usd / float(bars[c].open[i])
            spent_usd[c] += usd
        pending = [(c, u) for c, u in pending if pos[c].get(t) is None]
        for c in US_TICKERS:
            a = divs[c].get(t)
            if a and shares[c]:
                div_cash += shares[c] * a * (1 - US_DIV_TAX) * rate
        eligible = [c for c in US_TICKERS if pos[c].get(t) is not None and pos[c][t] >= WINDOW - 1]
        orders = []
        if dca:
            if new_money:
                pick = "SPY" if dca == "SPY" else eligible[rot % len(eligible)]
                usd = to_usd(cash, rate)
                if usd >= 50:
                    orders.append((pick, usd))
                    rot += 1
        else:
            tick = {}
            for c in eligible:
                i = pos[c][t]
                kind = "etf" if c == "SPY" else "stock"
                val = {"pe": 20.0, "px_at": None} if kind == "etf" else {"fwd_pe": 25.0, "peg": None, "px_at": None}
                tick[c] = {"csv": io.StringIO("\n".join(bars[c].attrs["lines"][i - WINDOW + 1:i + 1])), "role": "buy",
                           "kind": kind, "event": "none", "val": val, "_code": c}
                if c in conf:
                    confirm[c] = bool(conf[c].get(t, False))
            out = run_main(mod, {"pool_twd": int(cash),
                                 "fx_csv": io.StringIO("\n".join(fx.attrs["lines"][max(0, j_fx - 199):j_fx + 1])),
                                 "tickers": tick})
            for c, v in out["tickers"].items():
                signals.append((t, c, v["status"], v["level"], v["amount_usd"]))
                if v["amount_usd"] > 0:
                    orders.append((c, v["amount_usd"]))
        new_money = False
        for c, usd in orders:
            cost = usd * rate
            cash -= cost
            pending.append((c, usd))
            buys.append((t, c, cost))
        mv = sum(shares[c] * float(bars[c].close[pos[c][t]]) for c in US_TICKERS if pos[c].get(t) is not None)
        mv += sum(u for _, u in pending)
        daily.append((t, mv * rate + cash + div_cash, cash))
    return dict(daily=daily, deposits=[(d, a) for d, a in deps if d <= cal[-1]], buys=buys, signals=signals,
                shares=shares, spent_usd=spent_usd, cash=cash, div_cash=div_cash,
                avg_cost={c: (spent_usd[c] / shares[c] if shares[c] else None) for c in US_TICKERS})


# ------------------------------------------------------------------ 指標
def xirr(flows):
    d0 = flows[0][0]
    yrs = [((d - d0).days / 365.0, a) for d, a in flows]
    f = lambda r: sum(a / (1 + r) ** y for y, a in yrs)  # noqa: E731
    lo, hi = -0.99, 10.0
    if f(lo) * f(hi) > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def metrics(res, end_date=None):
    daily = [x for x in res["daily"] if end_date is None or x[0] <= pd.Timestamp(end_date)]
    end = daily[-1][0]
    deps = [(d, a) for d, a in res["deposits"] if d <= end]
    final = daily[-1][1]
    flows = [(d, -a) for d, a in deps] + [(end, final)]
    flows.sort(key=lambda x: x[0])
    # 時間加權淨值（扣除入金）→ 最大回撤
    dep_by_day = {}
    di = 0
    for t, _, _ in daily:
        while di < len(deps) and deps[di][0] <= t:
            dep_by_day[t] = dep_by_day.get(t, 0) + deps[di][1]
            di += 1
    nav, peak, mdd, prev = 1.0, 1.0, 0.0, None
    cash_ratio = []
    for t, w, c in daily:
        if prev:
            nav *= (w - dep_by_day.get(t, 0)) / prev
            peak = max(peak, nav)
            mdd = min(mdd, nav / peak - 1)
        prev = w
        cash_ratio.append(c / w if w else 0)
    buy_dates = sorted({b[0] for b in res["buys"] if b[0] <= end})
    gaps = [(b - a).days for a, b in zip([daily[0][0]] + buy_dates, buy_dates + [end])]
    return dict(end=f"{end:%Y-%m-%d}", deposited=sum(a for _, a in deps), final=round(final),
                xirr=xirr(flows), buys=len([b for b in res["buys"] if b[0] <= end]),
                buy_days=len(buy_dates), avg_cash_ratio=float(np.mean(cash_ratio)),
                max_idle_days=max(gaps) if gaps else None, mdd=mdd)


def forward_returns(bars, fill_idx, all_idx, horizons=HORIZONS, seed=0):
    """fill_idx：訊號後成交那根的索引；all_idx：同期間所有可成交的索引（隨機日期的母體）。報酬＝第 k 根收盤 ÷ 成交開盤 − 1。"""
    o, c = bars.open.values, bars.close.values
    rng = np.random.default_rng(seed)
    out = {}
    for h in horizons:
        sig = np.array([c[i + h] / o[i] - 1 for i in fill_idx if i + h < len(c)])
        base = np.array([c[i + h] / o[i] - 1 for i in all_idx if i + h < len(c)])
        if len(sig) == 0 or len(base) == 0:
            out[h] = None
            continue
        boots = np.array([rng.choice(base, len(sig)).mean() for _ in range(2000)])
        out[h] = dict(n=len(sig), mean=float(sig.mean()), median=float(np.median(sig)), win=float((sig > 0).mean()),
                      base_n=len(base), base_mean=float(base.mean()), base_median=float(np.median(base)),
                      base_win=float((base > 0).mean()), p_boot=float((boots >= sig.mean()).mean()))
    return out


# ------------------------------------------------------------------ 主程式
def summarize_tw(bars, res, start, end):
    days = bars.index[(bars.date >= pd.Timestamp(start)) & (bars.date <= pd.Timestamp(end))]
    s, e = pd.Timestamp(start), pd.Timestamp(end)
    sig_idx = [i for i, lv, _ in res["signals"] if (lv in ZONE_NAMES or lv == "趨勢起始倉") and s <= bars.date[i] <= e]
    return forward_returns(bars, sig_idx, list(days)), len(sig_idx)


def summarize_us(bars, res, start, end):
    out = {}
    for c in US_TICKERS:
        b = bars[c]
        posd = dict(zip(b.date, b.index))
        days = [i + 1 for d, i in posd.items() if pd.Timestamp(start) <= d <= pd.Timestamp(end) and i + 1 < len(b)]
        sig = [posd[t] + 1 for t, cc, _, lv, _ in res["signals"] if cc == c and lv in ("z1", "z2", "z3")
               and pd.Timestamp(start) <= t <= pd.Timestamp(end) and posd[t] + 1 < len(b)]
        out[c] = (forward_returns(b, sig, days), len(sig))
    return out


def main(markets=("tw", "us")):
    sys.stdout.reconfigure(encoding="utf-8")
    OUT.mkdir(exist_ok=True)
    tw = read_bars("0050")
    tw_div = read_divs("0050")
    cycle = read_cycle()
    us = {c: read_bars(c) for c in US_TICKERS}
    us_div = {c: read_divs(c) for c in US_TICKERS}
    fx = read_fx()
    end_tw, end_us = f"{tw.date.iloc[-1]:%Y-%m-%d}", f"{us['SPY'].date.iloc[-2]:%Y-%m-%d}"  # 美股最後一天的委託要隔天成交
    is_end = f"{pd.Timestamp(OOS_START) - pd.Timedelta(days=1):%Y-%m-%d}"
    periods = {"full": (START, None), "is": (START, is_end), "oos": (OOS_START, None)}
    meta = dict(start=START, oos_start=OOS_START, end_tw=end_tw, end_us=end_us, window=WINDOW, engine=ENGINE_SHA,
                manifest=json.loads((DATA / "manifest.json").read_text(encoding="utf-8")),
                generated_at=dt.datetime.now().isoformat(timespec="seconds"))
    all_us = list(US_TICKERS)
    for market in markets:
        results = {"meta": meta}
        end = end_tw if market == "tw" else end_us
        versions = (VERSIONS_TW if market == "tw" else VERSIONS) + ["DCA"] + (["DCA_SPY"] if market == "us" else [])
        # spy：只用 SPY（代表 VOO）單獨模擬，把「擇時」和「錢分給哪一檔」分開；基準是只買 SPY 的定期定額
        globals()["US_TICKERS"] = ["SPY"] if market == "spy" else all_us
        runs = {}
        for v in versions:
            for run_name, start in (("full", START), ("oos", OOS_START)):
                print(f"{market} {v} {run_name} …", flush=True)
                if market == "tw":
                    r = run_tw(v if v in VERSIONS_TW else "A", start, end, tw, tw_div, dca=(v == "DCA"), cycle=cycle)
                else:
                    dca = {"DCA": "SPY" if market == "spy" else "rotate", "DCA_SPY": "SPY"}.get(v)
                    r = run_us(v if v in VERSIONS else "A", start, end, us, us_div, fx, dca=dca)
                runs[(v, run_name)] = r
        for v in versions:
            entry = {}
            for p, (s, e) in periods.items():
                r = runs[(v, "oos" if p == "oos" else "full")]
                m = metrics(r, e)
                entry[p] = m
            full = runs[(v, "full")]
            if market == "tw":
                entry["avg_cost"] = full["avg_cost"]
                entry["shares"] = full["shares"]
                if v in VERSIONS:
                    for p, (s, e) in periods.items():
                        r = runs[(v, "oos" if p == "oos" else "full")]
                        fr, n = summarize_tw(tw, r, s, e or end)
                        entry.setdefault("forward", {})[p] = fr
                        entry.setdefault("signal_days", {})[p] = n
                if v == "D":
                    entry["light_days"] = full.get("light_days")
            else:
                entry["avg_cost"] = full["avg_cost"]
                entry["spent_usd"] = full["spent_usd"]
                if v in VERSIONS:
                    for p, (s, e) in periods.items():
                        r = runs[(v, "oos" if p == "oos" else "full")]
                        entry.setdefault("forward", {})[p] = summarize_us(us, r, s, e or end)
            results[v] = entry
        (OUT / f"results_{market}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str),
                                                    encoding="utf-8")
    globals()["US_TICKERS"] = all_us
    R = {"meta": meta}
    for market in ("tw", "us", "spy"):
        p = OUT / f"results_{market}.json"
        if p.exists():
            d = json.loads(p.read_text(encoding="utf-8"))
            R[market] = {k: v for k, v in d.items() if k != "meta"}
            R["meta"][f"generated_{market}"] = d["meta"]["generated_at"]
    (OUT / "tables.md").write_text(tables(R), encoding="utf-8")
    print((OUT / "tables.md").read_text(encoding="utf-8"))


# ------------------------------------------------------------------ 表格
def pct(x, d=1):
    return "—" if x is None else f"{x * 100:.{d}f}%"


def tables(R):
    lines = [f"資料：台股 {R['meta']['start']}～{R['meta']['end_tw']}，美股 {R['meta']['start']}～{R['meta']['end_us']}；"
             f"樣本外從 {R['meta']['oos_start']} 起（重新從 6,000 開始）。", ""]
    names = {"A": "A 現行規則", "B": "B ＋日 KDJ 確認", "C": "C ＋週 KD 確認", "D": "D ＋景氣燈號",
             "DCA": "定期定額", "DCA_SPY": "定期定額（只買 SPY）"}
    hget = lambda f, h: (f.get(h) or f.get(str(h))) if f else None  # noqa: E731 — JSON 讀回後鍵是字串
    for market, title in (("tw", "台股（0050 代替）"), ("us", "美股（SPY＋四檔個股）"), ("spy", "美股只用 SPY（代表 VOO）")):
        if market not in R:
            continue
        ticks = ["SPY"] if market == "spy" else US_TICKERS
        for p, ptitle in (("full", "全期間"), ("is", "樣本內"), ("oos", "樣本外（重新起算）")):
            lines += [f"### {title}｜{ptitle}", "",
                      "| 版本 | 投入 | 期末總值 | XIRR | 與定期定額差（XIRR） | 期末差 | 買進次數 | 平均現金比例 | 最長閒置（天） | 最大回撤 |",
                      "|---|---|---|---|---|---|---|---|---|---|"]
            base = R[market]["DCA"][p]
            for v in [k for k in names if k in R[market]]:
                m = R[market][v][p]
                dx = None if m["xirr"] is None or base["xirr"] is None else m["xirr"] - base["xirr"]
                lines.append(f"| {names[v]} | {m['deposited']:,} | {m['final']:,} | {pct(m['xirr'], 2)} | "
                             f"{'—' if v == 'DCA' else (('+' if dx >= 0 else '') + f'{dx * 100:.2f} 個百分點')} | "
                             f"{'—' if v == 'DCA' else pct(m['final'] / base['final'] - 1)} | {m['buys']} | "
                             f"{pct(m['avg_cash_ratio'])} | {m['max_idle_days']} | {pct(m['mdd'])} |")
            lines.append("")
        lines += [f"### {title}｜平均成本（全期間）", ""]
        if market == "tw":
            lines += ["| 版本 | 平均成本（元／股，含費） | 相對定期定額 |", "|---|---|---|"]
            b = R["tw"]["DCA"]["avg_cost"]
            for v in [k for k in ["A", "B", "C", "D", "DCA"] if k in R["tw"]]:
                a = R["tw"][v]["avg_cost"]
                lines.append(f"| {names[v]} | {a:.2f} | {pct(a / b - 1) if v != 'DCA' else '—'} |")
        else:
            lines += ["| 版本 | " + " | ".join(ticks) + " |", "|---|" + "---|" * len(ticks)]
            for v in ["A", "B", "C", "DCA"]:
                ac = R[market][v]["avg_cost"]
                b = R[market]["DCA"]["avg_cost"]
                cells = []
                for c in ticks:
                    if ac.get(c) is None:
                        cells.append("未買")
                    elif v == "DCA" or b.get(c) is None:
                        cells.append(f"{ac[c]:.2f}")
                    else:
                        cells.append(f"{ac[c]:.2f}（{pct(ac[c] / b[c] - 1)}）")
                lines.append(f"| {names[v]} | " + " | ".join(cells) + " |")
            lines.append("")
            lines.append("定期定額只買 SPY（3% 圈存、最低 50 美元同規則）；括號內為相對定期定額平均成本。" if market == "spy" else
                         "美股定期定額為每月輪流買一檔（3% 圈存、最低 50 美元同規則）；括號內為相對同一檔定期定額平均成本。")
        lines.append("")
        lines += [f"### {title}｜買進訊號後報酬 vs 隨機日期", "",
                  "| 版本 | 期間 | 標的 | 訊號天數 | 60 日（訊號／隨機） | 120 日 | 250 日 | 250 日勝率（訊號／隨機） | 250 日 p |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for v in VERSIONS:
            for p in ("is", "oos"):
                fw = R[market][v]["forward"][p]
                items = [("0050", fw, R[market][v]["signal_days"][p])] if market == "tw" else \
                    [(c, fw[c][0], fw[c][1]) for c in ticks]
                for code, f, n in items:
                    def cell(h):
                        x = hget(f, h)
                        return "—" if not x else f"{pct(x['mean'])}／{pct(x['base_mean'])}"
                    x250 = hget(f, 250)
                    lines.append(f"| {v} | {'樣本內' if p == 'is' else '樣本外'} | {code} | {n} | {cell(60)} | {cell(120)} | "
                                 f"{cell(250)} | {'—' if not x250 else pct(x250['win'], 0) + '／' + pct(x250['base_win'], 0)} | "
                                 f"{'—' if not x250 else f'{x250['p_boot']:.2f}'} |")
        lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    main(tuple(a for a in sys.argv[1:] if a in ("tw", "us", "spy")) or ("tw", "us", "spy"))
