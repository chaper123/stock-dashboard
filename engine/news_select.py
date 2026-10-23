"""新聞晨報（新聞第二層）的候選清單：照固定規則篩選、對應標的、排序，並標出一定要寫的事項。

不靠模型自己寫篩選程式，讓每次執行（不管哪個模型）得到相同的候選清單；模型只負責查證與判斷。
規則見 docs/NEWS_ROUTINE.md 第 3、4 節。

用法（在放資料的目錄的上一層執行）：
  python3 engine/news_select.py --data data --out candidates.json --brief   # 印精簡文字，完整 JSON 存檔
  python3 engine/news_select.py --data data [--now 2026-10-26T08:40+08:00] [--per-target 8] > candidates.json
data 目錄裡要有（缺的會記在 missing，相關項目略過）：
  headlines.json、fed.json、calendar.json、00981A.json、00411A.json、
  macro_<SPX|IXIC|SOX|VIX|TNX|DXY|GOLD|WTI|TSM>.csv、us_<VOO|GOOGL|NVDA|TSLA|SPCX|AAPL>.csv、
  tw_<009816|00981A|00411A>_norm.csv（日線：date,volume,open,high,low,close，無表頭）
輸出（JSON）：window、inputs、missing、counts、candidates、must_cover、closure_hints。
"""
import argparse
import csv
import datetime as dt
import json
import pathlib
import re
import sys
from zoneinfo import ZoneInfo

TPE = ZoneInfo("Asia/Taipei")
US = ("VOO", "GOOGL", "NVDA", "TSLA", "SPCX", "AAPL")
TW = ("009816", "00981A", "00411A")
TARGETS = US + TW + ("總經",)
TSMC = {"2330", "TSM"}
MACRO_TOPICS = {"fed", "tariff", "export_controls", "china", "taiwan", "oil", "war", "cpi", "jobs"}
KEY_TOPICS = {"earnings", "export_controls", "tariff", "antitrust", "merger", "fed"}
TIER_SCORE = {1: 40, 2: 30, 3: 20, 4: 0}
# 前一交易日的大幅變動門檻（%；TNX 是殖利率的絕對變動，單位百分點）
MACRO_MOVE = {"SPX": 2.0, "IXIC": 2.0, "SOX": 3.0, "VIX": 15.0, "TNX": 0.15, "DXY": 1.0,
              "GOLD": 2.5, "WTI": 4.0, "TSM": 3.0}
STOCK_MOVE = {"VOO": 2.0, "GOOGL": 5.0, "NVDA": 5.0, "TSLA": 5.0, "SPCX": 5.0, "AAPL": 5.0,
              "009816": 3.0, "00981A": 3.0, "00411A": 4.0}
# 來源加分：通訊社與主要媒體優先於轉載整理（Yahoo Finance 等）
SOURCE_BONUS = {"Reuters": 8, "AP News": 8, "Bloomberg.com": 5, "Bloomberg": 5, "WSJ": 5, "The Wall Street Journal": 5,
                "Financial Times": 5, "CNBC": 5, "中央社 CNA": 5, "經濟日報": 5, "工商時報": 5}
# 選股文、問句標題扣分；有實質變動字眼加分
LISTICLE = re.compile(r"[?？]\s*$|^(is|are|should|could|will)\b|stocks? to (buy|watch|own)|\bbest\b.*\bstocks?\b|\btop \d|"
                      r"\bprediction\b|\bbuy (now|today)\b|該買|值得買|存股", re.I)
SUBSTANCE = re.compile(r"跌|漲|重挫|大跌|飆|財報|財測|營收|獲利|制裁|禁令|訴訟|調查|召回|關稅|休市|plunge|slump|tumble|sink|"
                       r"surge|soar|jump|\bfall|\bdrop|rall(y|ies)|beat|miss|guidance|outlook|forecast|\bcut|\braise|ban\b|"
                       r"sanction|lawsuit|probe|recall|tariff|merger|acqui", re.I)
CLOSURE_WORDS = re.compile(r"休市|停止交易|暫停交易|颱風假|停班停課|market(s)? closed|trading (halt|suspend)", re.I)


def window_start(now):
    """台北「今天以前最近的平日」08:40（週一就是上週五 08:40）。"""
    d = now.date() - dt.timedelta(days=1)
    while d.weekday() >= 5:
        d -= dt.timedelta(days=1)
    return dt.datetime.combine(d, dt.time(8, 40), TPE)


def parse_taipei(s):
    return dt.datetime.strptime(s[:16], "%Y-%m-%d %H:%M").replace(tzinfo=TPE)


def load_json(path, missing):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        missing.append(path.name)
        return None


def last_two(path, missing):
    """日線最後兩列：(前一日收盤, 最後日期, 最後收盤)。"""
    try:
        rows = [r for r in csv.reader(path.read_text(encoding="utf-8").splitlines()) if r]
        (_, *p), (d, *q) = rows[-2], rows[-1]
        return float(p[4]), d, float(q[4])
    except (OSError, ValueError, IndexError):
        missing.append(path.name)
        return None


def holding_codes(h, n, strip_us=False):
    rows = sorted((h or {}).get("holdings") or [], key=lambda x: -(x.get("weight") or 0))[:n]
    codes = [str(x["code"]) for x in rows]
    return {c.removesuffix(" US") if strip_us else c for c in codes}


def map_targets(item, top981, top411):
    """標題對應到哪些標的（規則見 NEWS_ROUTINE 第 3.1 節）。"""
    syms = set(item.get("symbols") or [])
    tg = set(syms & set(US)) | (syms & set(TW))
    if syms & TSMC:
        tg |= {"009816", "00981A"}
    if syms & top981:
        tg.add("00981A")
    if item.get("tier", 4) <= 2 and syms & top411:
        tg.add("00411A")
    if not tg and set(item.get("topics") or []) & MACRO_TOPICS:
        tg.add("總經")
    return tg


def score(item, now):
    age_h = max(0.0, (now - parse_taipei(item["published_taipei"])).total_seconds() / 3600)
    s = TIER_SCORE.get(item.get("tier", 4), 0) + max(0.0, 24 - age_h)
    s += 10 if set(item.get("topics") or []) & KEY_TOPICS else 0
    s += 5 if item.get("url") else 0
    s += SOURCE_BONUS.get(item.get("source") or "", 0)
    title = item.get("title") or ""
    s += -15 if LISTICLE.search(title) else 0
    s += 6 if SUBSTANCE.search(title) else 0
    s += min(10, 2 * len(item.get("also") or []))
    return round(s, 2)


def pct(prev, last):
    return (last / prev - 1) * 100


def select(data, now, per_target=8):
    missing = []
    start = window_start(now)
    h = load_json(data / "headlines.json", missing) or {}
    fed = load_json(data / "fed.json", missing) or {}
    cal = load_json(data / "calendar.json", missing) or {}
    top981 = holding_codes(load_json(data / "00981A.json", missing), 10)
    top411 = holding_codes(load_json(data / "00411A.json", missing), 5, strip_us=True)

    items = [x for x in h.get("items") or [] if x.get("published_taipei")
             and start <= parse_taipei(x["published_taipei"]) <= now]
    buckets = {t: [] for t in TARGETS}
    seen = {t: set() for t in TARGETS}
    for x in items:
        tg = map_targets(x, top981, top411)
        norm = re.sub(r"\W+", "", (x.get("title") or "").lower())
        for t in tg:
            if norm in seen[t]:
                continue
            seen[t].add(norm)
            buckets[t].append({"id": x.get("id"), "time": x["published_taipei"], "source": x.get("source"),
                               "tier": x.get("tier"), "title": x.get("title"), "url": x.get("url"),
                               "link": x.get("link"), "also": x.get("also") or [], "topics": x.get("topics") or [],
                               "symbols": x.get("symbols") or [], "other_targets": sorted(tg - {t}),
                               "score": score(x, now)})
    counts, candidates = {}, {}
    for t, lst in buckets.items():
        by_tier = {str(k): sum(1 for c in lst if c["tier"] == k) for k in (1, 2, 3, 4)}
        counts[t] = {"total": len(lst), "by_tier": by_tier}
        candidates[t] = sorted(lst, key=lambda c: (-c["score"], c["time"]))[:per_target]

    must = []
    for s, th in MACRO_MOVE.items():
        r = last_two(data / f"macro_{s}.csv", missing)
        if r:
            prev, d, last = r
            chg = last - prev if s == "TNX" else pct(prev, last)
            if abs(chg) >= th:
                must.append({"type": "big_move", "target": "總經" if s != "TSM" else "009816",
                             "symbol": s, "date": d, "change": round(chg, 3),
                             "unit": "百分點" if s == "TNX" else "%", "threshold": th})
    for s, th in STOCK_MOVE.items():
        f = f"us_{s}.csv" if s in US else f"tw_{s}_norm.csv"
        r = last_two(data / f, missing)
        if r:
            prev, d, last = r
            chg = pct(prev, last)
            if abs(chg) >= th:
                must.append({"type": "big_move", "target": s, "symbol": s, "date": d,
                             "change": round(chg, 3), "unit": "%", "threshold": th})
    lo = start.date() - dt.timedelta(days=1)
    for s, e in ((cal.get("earnings") or {}).get("symbols") or {}).items():
        for d in e.get("dates") or []:
            if lo <= dt.date.fromisoformat(d) <= now.date():
                must.append({"type": "earnings", "target": s, "symbol": s, "date": d,
                             "is_estimate": e.get("is_estimate"), "note": "時間窗內公布財報：寫出營收、獲利、財測與預期差異"})
    today = now.date().isoformat()
    if today in ((cal.get("tw_market") or {}).get("closed") or []):
        must.append({"type": "tw_closed", "target": "009816", "date": today, "note": "行事曆：今天台股休市"})
    for x in fed.get("items") or []:
        if x.get("published_taipei") and start <= parse_taipei(x["published_taipei"]) <= now:
            must.append({"type": "fed", "target": "總經", "date": x.get("date"), "title": x.get("title"),
                         "link": x.get("link"), "kind": x.get("type")})
    hints = [{"time": x["published_taipei"], "source": x.get("source"), "tier": x.get("tier"),
              "title": x.get("title"), "url": x.get("url"), "link": x.get("link")}
             for x in items if CLOSURE_WORDS.search(x.get("title") or "")]
    hints.sort(key=lambda c: (c["tier"] or 4, c["time"]))
    if any((c["tier"] or 4) <= 2 for c in hints):
        must.append({"type": "possible_closure", "target": "009816", "date": today,
                     "note": "標題提到休市或停止交易：確認台股（或美股）今天是否開盤，影響晨報判斷", "count": len(hints)})

    return {"window": {"start": start.isoformat(timespec="minutes"), "end": now.isoformat(timespec="minutes")},
            "inputs": {"headlines_generated": h.get("generated_at_taipei"), "headlines_status": h.get("status"),
                       "feeds_ok": f"{sum(1 for f in h.get('feeds') or [] if f.get('ok'))}/{len(h.get('feeds') or [])}",
                       "items_in_window": len(items), "fed_in_window": sum(1 for m in must if m["type"] == "fed"),
                       "top10_00981A": sorted(top981), "top5_00411A": sorted(top411)},
            "missing": sorted(set(missing)), "counts": counts, "candidates": candidates,
            "must_cover": must, "closure_hints": hints[:8]}


def brief(out, n=5):
    """給模型看的精簡文字：輸入狀態、必寫事項、各標的前 n 名。"""
    L = [f"時間窗 {out['window']['start']} ～ {out['window']['end']}",
         f"輸入 {json.dumps(out['inputs'], ensure_ascii=False)}", f"缺檔 {out['missing'] or '無'}",
         "件數 " + "、".join(f"{t} {c['total']}" for t, c in out["counts"].items()), "", "【必寫事項】"]
    L += [f"- {json.dumps(m, ensure_ascii=False)}" for m in out["must_cover"]] or ["- 無"]
    L += ["", "【休市相關標題】"] + [f"- {h['time']}｜{h['source']}（{h['tier']}）｜{h['title']}" for h in out["closure_hints"]]
    for t, lst in out["candidates"].items():
        L += ["", f"【{t}】"]
        L += [f"- {c['time']}｜{c['source']}（{c['tier']}）｜{c['title']}｜{'有原文網址' if c['url'] else '無原文網址'}"
              f"｜其他標的 {','.join(c['other_targets']) or '—'}｜id {c['id']}" for c in lst[:n]] or ["- 無"]
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default="data")
    ap.add_argument("--now", help="台北時間 ISO，例如 2026-10-26T08:40+08:00；不給就用現在")
    ap.add_argument("--per-target", type=int, default=8)
    ap.add_argument("--brief", action="store_true", help="印精簡文字（必寫事項與各標的前 5 名），完整 JSON 另存 --out")
    ap.add_argument("--out", help="完整 JSON 寫到這個檔案")
    a = ap.parse_args(argv)
    now = dt.datetime.fromisoformat(a.now).astimezone(TPE) if a.now else dt.datetime.now(TPE)
    out = select(pathlib.Path(a.data), now, a.per_target)
    sys.stdout.reconfigure(encoding="utf-8")
    text = json.dumps(out, ensure_ascii=False)
    if a.out:
        pathlib.Path(a.out).write_text(text, encoding="utf-8")
    print(brief(out) if a.brief else text)


if __name__ == "__main__":
    main()
