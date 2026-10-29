"""下載回測用的長歷史資料到 backtest/data/（不進 git，可隨時重抓）。只用 Python 標準庫。

用法：py -3.14 backtest/fetch_data.py

來源：
- 台股替代標的 0050（代表 009816、00981A）：FinMind TaiwanStockPrice（證交所原始日線，2003-06 起）、
  TaiwanStockDividendResult（除息日與每股現金股利）。2025-06-18 一拆四：之前的開高低收 ÷4、量 ×4、股利 ÷4。
- 匯率：FinMind TaiwanExchangeRate 的台銀美元即期賣出（2006 起，與排程用的 fx/usdtwd_bot_sell.csv 同來源）。
- 美股：Yahoo chart API（日線已做分割調整、未做除息調整；股利為每股金額）。SPY 代表 VOO（VOO 2010-09 才上市）。
- 景氣對策信號：market-data 的 data/longterm/tw_business_cycle.csv（國發會，1984 起，最新修正值）。
  （Yahoo 的 0050.TW 不用：2014 以前沒做分割調整、2025-06 停止交易期間有假 K 棒、2009 年初有超過漲跌幅的錯誤。）

輸出 data/：<代號>.csv（date,volume,open,high,low,close，無表頭，和 engine 讀的格式相同）、<代號>_div.csv（date,amount）、
usdtwd_bot_sell.csv（date,rate）、raw/（原始回應）、manifest.json（列數、起訖、檢查結果）。
"""
import csv
import datetime as dt
import json
import pathlib
import time
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "data"
RAW = OUT / "raw"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
US = ["SPY", "GOOGL", "NVDA", "AAPL", "TSLA"]
SPLIT_0050 = ("2025-06-18", 4)  # 0050 一拆四，第一個交易日


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 — 網路錯誤重試
            if i == tries - 1:
                raise
            print(f"  重試 {i + 1}：{e}")
            time.sleep(5 * (i + 1))


def finmind(dataset, data_id, start):
    q = urllib.parse.urlencode(dict(dataset=dataset, data_id=data_id, start_date=start))
    raw = get(f"https://api.finmindtrade.com/api/v4/data?{q}")
    (RAW / f"finmind_{dataset}_{data_id}.json").write_bytes(raw)
    j = json.loads(raw)
    if j.get("status") != 200:
        raise SystemExit(f"FinMind {dataset} {data_id}：{j.get('msg')}")
    return j["data"]


def write(name, rows):
    with open(OUT / name, "w", newline="") as f:
        csv.writer(f, lineterminator="\n").writerows(rows)


def tw_0050():
    split_day, k = SPLIT_0050
    rows = []
    for r in finmind("TaiwanStockPrice", "0050", "2003-06-01"):
        if r["Trading_Volume"] <= 0:
            continue
        f = k if r["date"] < split_day else 1
        rows.append([r["date"], int(r["Trading_Volume"]) * f] +
                    [round(r[c] / f, 6) for c in ("open", "max", "min", "close")])
    write("0050.csv", rows)
    divs = [[r["date"], round(r["stock_and_cache_dividend"] / (k if r["date"] < split_day else 1), 6)]
            for r in finmind("TaiwanStockDividendResult", "0050", "2003-06-01")]
    write("0050_div.csv", divs)
    jumps = []
    for a, b in zip(rows, rows[1:]):
        ch = b[5] / a[5] - 1
        if abs(ch) > 0.075:
            jumps.append((b[0], round(ch * 100, 2)))
    return dict(source="FinMind TaiwanStockPrice＋TaiwanStockDividendResult", rows=len(rows), first=rows[0][0],
                last=rows[-1][0], dividends=len(divs), split=f"{split_day} 1→{k}（之前 ÷{k}）", big_moves=jumps)


def fx():
    rows = [[r["date"], r["spot_sell"]] for r in finmind("TaiwanExchangeRate", "USD", "2005-01-01")
            if r["spot_sell"] and r["spot_sell"] > 0]
    write("usdtwd_bot_sell.csv", rows)
    return dict(source="FinMind TaiwanExchangeRate 台銀美元即期賣出", rows=len(rows), first=rows[0][0], last=rows[-1][0])


def yahoo(sym):
    url = (f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?period1=0&period2={int(time.time()) + 86400}&interval=1d&events=div%2Csplit")
    raw = get(url)
    (RAW / f"yahoo_{sym}.json").write_bytes(raw)
    res = json.loads(raw)["chart"]["result"][0]
    off, q = res["meta"]["gmtoffset"], res["indicators"]["quote"][0]
    day = lambda ts: dt.datetime.fromtimestamp(int(ts) + off, dt.timezone.utc).strftime("%Y-%m-%d")  # noqa: E731
    rows = {}
    for i, ts in enumerate(res["timestamp"]):
        v = [q[c][i] for c in ("volume", "open", "high", "low", "close")]
        if any(x is None for x in v[1:]) or min(v[1:]) <= 0:
            continue
        rows[day(ts)] = [day(ts), int(v[0] or 0)] + [round(float(x), 6) for x in v[1:]]
    out = sorted(rows.values())
    write(f"{sym}.csv", out)
    divs = sorted([day(t), d["amount"]] for t, d in (res.get("events", {}).get("dividends") or {}).items())
    write(f"{sym}_div.csv", divs)
    jumps = [(b[0], round((b[5] / a[5] - 1) * 100, 2)) for a, b in zip(out, out[1:]) if abs(b[5] / a[5] - 1) > 0.25]
    return dict(source="Yahoo chart（分割調整、未除息）", rows=len(out), first=out[0][0], last=out[-1][0],
                dividends=len(divs), big_moves=jumps)


def business_cycle():
    """國發會景氣對策信號（market-data 的 longterm 資料：最新修正值；release_est 為偏保守的估計發布日）。"""
    raw = get("https://raw.githubusercontent.com/chaper123/market-data/main/data/longterm/tw_business_cycle.csv")
    (OUT / "tw_business_cycle.csv").write_bytes(raw)
    rows = raw.decode("utf-8").strip().splitlines()
    return dict(source="market-data data/longterm/tw_business_cycle.csv（國發會，最新修正值）", rows=len(rows),
                first=rows[0].split(",")[0], last=rows[-1].split(",")[0])


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    man = {"fetched_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "files": {}}
    man["files"]["0050"] = tw_0050()
    man["files"]["usdtwd_bot_sell"] = fx()
    man["files"]["tw_business_cycle"] = business_cycle()
    for s in US:
        time.sleep(1)
        man["files"][s] = yahoo(s)
    for k, v in man["files"].items():
        print(k, {a: b for a, b in v.items() if a != "source"})
    (OUT / "manifest.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
