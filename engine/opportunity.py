"""加權指數「這一段」回落到過哪些級距（晨報 v4.2 大波動日的機會觀察用，docs/NEWS_ROUTINE.md 第 14 節）。

算法和網站 site/js/opportunity.js 的 currentEpisode 一致：
  - 這一段＝最後一次收盤創新高（含持平）之後；收盤創新高就重新開始。
  - 離高點（%）＝收盤 ÷ 這一段高點 − 1；剛好等於級距也算跌到（容差 1e-9，90 ÷ 100 − 1 在浮點數是 −9.999999999999998）。
  - 級距 −10%、−20%、−30%，各記這一段裡第一次收盤跌到的日期，沒到是 null；一天跌穿兩級就兩級同一天。
只描述已經發生的事，不預測、不建議做法；依自訂規則的提醒，不是投資建議。只用 Python 標準庫。

用法：
  python3 engine/opportunity.py --index index_TAIEX.csv --out opportunity.json --brief
輸入：
  --index：加權指數日線 CSV（market-data 的 data/index/TAIEX.csv），沒有表頭：日期,開,高,低,收,成交股數,成交金額（由舊到新）
  --out：完整 JSON 寫到這個檔案（選用）
  --brief：印一行中文；不給就印 JSON
輸入讀不到、少於 2 列、格式不對時，在 stderr 印「錯誤：…」並以結束碼 1 結束（提示詞照「程式沒取得」處理）。
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import sys

TIERS = (10, 20, 30)  # 從這一段的高點回落（%），同 opportunity.js 的 TIERS
EPS = 1e-9            # 浮點容差，同 opportunity.js 的 reached()
MINUS = "−"      # 「−」（提示詞與網站用的負號）


class OpportunityError(Exception):
    """輸入資料讀不到或格式不對；訊息是給人看的中文。"""


def read_closes(path):
    """index_TAIEX.csv → [(YYYY-MM-DD, 收盤)]（由舊到新）。空白列略過；其他格式問題一律丟 OpportunityError。"""
    try:
        text = pathlib.Path(path).read_text(encoding="utf-8-sig")
    except OSError as e:
        raise OpportunityError(f"讀不到 {path}（{e.strerror or e}）") from e
    series = []
    for n, row in enumerate(csv.reader(text.splitlines()), 1):
        if not row or not "".join(row).strip():
            continue
        if len(row) < 5:
            raise OpportunityError(f"{path} 第 {n} 列欄位不足（要日期,開,高,低,收…，只有 {len(row)} 欄）")
        try:
            date = dt.date.fromisoformat(row[0].strip()).isoformat()
        except ValueError:
            raise OpportunityError(f"{path} 第 {n} 列日期格式不對：{row[0]!r}（要 YYYY-MM-DD，檔案不該有表頭）") from None
        try:
            close = float(row[4].replace(",", "").strip())
        except ValueError:
            raise OpportunityError(f"{path} 第 {n} 列收盤不是數字：{row[4]!r}") from None
        if not close > 0:
            raise OpportunityError(f"{path} 第 {n} 列收盤不是正數：{row[4]!r}")
        if series and date <= series[-1][0]:
            raise OpportunityError(f"{path} 第 {n} 列日期 {date} 沒有比前一列 {series[-1][0]} 晚（要由舊到新、不重複）")
        series.append((date, close))
    if not series:
        raise OpportunityError(f"{path} 沒有任何資料列")
    if len(series) < 2:
        raise OpportunityError(f"{path} 只有 1 列資料，算不出這一段（至少要 2 列）")
    return series


def reached(dd, tier):
    """離高點 dd（%，負數）到級距 tier（10 表示 −10%）沒有：剛好等於也算。"""
    return dd <= -tier + EPS


def compute(series, tiers=TIERS):
    """series：[(日期, 收盤)]（由舊到新，至少 2 列）→ 這一段的整理（算法同 currentEpisode）。"""
    if len(series) < 2:
        raise OpportunityError("資料少於 2 列，算不出這一段")
    pi = 0
    for i, (_, v) in enumerate(series):
        if v >= series[pi][1]:  # 創新高或持平：從這一天重新開始（取最後一個最高）
            pi = i
    pdate, pclose = series[pi]
    since = series[pi:]

    def dd_of(v):
        return (v / pclose - 1) * 100

    ldate, lclose = series[-1]
    mdate, mclose = since[0]
    for d, v in since:
        if v < mclose:  # 嚴格小於：同值取最早的一天
            mdate, mclose = d, v
    hits = []
    for t in tiers:
        hit = next(((d, v) for d, v in since if reached(dd_of(v), t)), None)
        hits.append({"tier": t, "date": hit[0] if hit else None, "close": hit[1] if hit else None,
                     "dd_pct": dd_of(hit[1]) if hit else None})
    reached_tiers = [h["tier"] for h in hits if h["date"]]
    return {
        "first_date": series[0][0], "rows": len(series),
        "peak": {"date": pdate, "close": pclose},
        "last": {"date": ldate, "close": lclose},
        "dd_pct": dd_of(lclose),
        "low": {"date": mdate, "close": mclose, "dd_pct": dd_of(mclose)},
        "tiers": hits,
        "top_tier": max(reached_tiers, default=0),
        "at_peak": pi == len(series) - 1,
    }


def md(date):
    """YYYY-MM-DD → MM/DD。"""
    return f"{date[5:7]}/{date[8:10]}"


def pct(x):
    """離高點的百分比，一位小數、負數用「−」；0 寫成 0.0%。"""
    s = f"{abs(x):.1f}%"
    return s if x > -0.05 else MINUS + s


def brief(o):
    """一行中文，格式固定（提示詞把數字原樣寫進重點第 1 條）。"""
    head = f"【機會】加權離高點 {pct(o['dd_pct'])}（{md(o['last']['date'])} 收盤）"
    if not o["top_tier"]:
        return f"{head}；這一段高點 {md(o['peak']['date'])}；還沒到 {MINUS}{o['tiers'][0]['tier']}%"
    low = o["low"]
    hit = "、".join(f"{md(h['date'])} 跌破 {MINUS}{h['tier']}%" for h in o["tiers"] if h["date"])
    miss = "、".join(f"{MINUS}{h['tier']}%" for h in o["tiers"] if not h["date"])
    return (f"{head}；這一段高點 {md(o['peak']['date'])}、最深 {pct(low['dd_pct'])}（{md(low['date'])}）；{hit}"
            + (f"；{miss} 沒到" if miss else ""))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--index", required=True, help="加權指數日線 CSV（沒有表頭：日期,開,高,低,收,成交股數,成交金額）")
    ap.add_argument("--out", help="完整 JSON 寫到這個檔案")
    ap.add_argument("--brief", action="store_true", help="印一行中文；不給就印 JSON")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    try:
        o = compute(read_closes(a.index))
    except OpportunityError as e:
        print(f"錯誤：{e}", file=sys.stderr)
        return 1
    text = json.dumps(o, ensure_ascii=False)
    if a.out:
        pathlib.Path(a.out).write_text(text, encoding="utf-8")
    print(brief(o) if a.brief else text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
