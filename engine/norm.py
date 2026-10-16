"""鉅亨網日線（t,o,h,l,c,v；t 為 unix 秒）轉成 date,volume,open,high,low,close。
用法：python3 norm.py raw/VOO.txt data/VOO.csv
只保留「已收盤」的交易日：美東時間 16:15 以後才納入當天，否則只到前一天（排除盤中未收盤的 K 棒）。"""
import sys, csv, datetime as dt
from zoneinfo import ZoneInfo

src, dst = sys.argv[1], sys.argv[2]
now = dt.datetime.now(ZoneInfo("America/New_York"))
cut = (now if (now.hour, now.minute) >= (16, 15) else now - dt.timedelta(days=1)).strftime("%Y-%m-%d")
rows = {}
for line in open(src):
    p = line.strip().strip("`").split(",")
    if len(p) != 6:
        continue
    try:
        t = int(float(p[0]))
        o, h, l, c, v = map(float, p[1:])
    except ValueError:
        continue
    d = dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")
    if d > cut:
        continue
    rows[d] = (d, int(v), o, h, l, c)
out = sorted(rows.values())
with open(dst, "w", newline="") as f:
    csv.writer(f).writerows(out)
print(f"{dst}: {len(out)} rows, {out[0][0]} ~ {out[-1][0]}, last close {out[-1][5]} (cutoff {cut} ET)")
