"""主動式 ETF 的持股變化（給新聞晨報寫「經理人方向」用）：這週股數變化 5% 以上的（新買、加碼、減碼、出清）與收集以來的新增、出清。

規則和網站 site/js/inside.js 相同（「你的 ETF 裡面在變什麼」）：
  - 「這週」＝最新資料日，和 7 天前（含）或更早的最後一個資料日比；收集不到一週就和第一天比
  - 股數變化 5% 以上才算經理人有動作（權重變化多半只是股價漲跌）
  - 權重都低於 0.1% 的象徵性持股不列，只算檔數
資料是私人 repo chaper123/market-data-private 的 data/holdings/<代號>_history.csv（沒有標題列：日期,代號,名稱,股數,權重）。
投信網站不允許轉載持股：這裡算出來的股數、權重只給模型判斷方向，不能寫進公開的試算表或網站。
只用 Python 標準庫。依自訂規則整理的資料，不是投資建議。

用法：
  python3 engine/fund_moves.py --dir market-data-private/data/holdings --code 00981A --brief
"""
import argparse
import datetime as dt
import json
import pathlib
import sys

MOVE_PCT = 5
TOKEN_WEIGHT = 0.1
LABEL = {"new": "新買", "add": "加碼", "cut": "減碼", "exit": "出清"}
ORDER = {"new": 0, "add": 1, "cut": 2, "exit": 3}


def clean_name(s):
    return str(s or "").rstrip("*")


def parse_history(text):
    """CSV → (dates 舊到新, {日期: {代號: {...}}})；格式不對的列略過。"""
    by = {}
    for line in text.splitlines():
        parts = line.strip().split(",")
        if len(parts) < 5:
            continue
        date, code, name, shares, weight = parts[:5]
        try:
            dt.date.fromisoformat(date)
            row = {"code": code, "name": name, "shares": float(shares), "weight": float(weight)}
        except ValueError:
            continue
        if code:
            by.setdefault(date, {})[code] = row
    return sorted(by), by


def week_start(dates):
    last = dt.date.fromisoformat(dates[-1])
    cut = (last - dt.timedelta(days=7)).isoformat()
    older = [d for d in dates if d <= cut]
    return older[-1] if older else dates[0]


def moves(dates, by, start, end):
    A, B = by[start], by[end]
    out, tokens = [], 0
    for c in sorted(set(A) | set(B)):
        a, b = A.get(c), B.get(c)
        x = b or a
        pct = ((b["shares"] if b else 0) - a["shares"]) / a["shares"] * 100 if a and a["shares"] else float("inf")
        kind = "new" if not a else "exit" if not b else "add" if pct >= MOVE_PCT else "cut" if pct <= -MOVE_PCT else None
        if not kind:
            continue
        wa, wb = (a["weight"] if a else 0), (b["weight"] if b else 0)
        if max(wa, wb) < TOKEN_WEIGHT:
            tokens += 1
            continue
        since = next((d for d in dates if start < d <= end and c in by[d]), None) if kind == "new" else None
        out.append({"code": c, "name": clean_name(x["name"]), "kind": kind, "shares_from": a["shares"] if a else 0,
                    "shares_to": b["shares"] if b else 0, "weight_from": wa, "weight_to": wb,
                    "pct": None if pct == float("inf") else round(pct, 1), "since": since})
    out.sort(key=lambda m: (ORDER[m["kind"]], -abs(m["weight_to"] - m["weight_from"])))
    return out, tokens


def since_first(dates, by):
    F, L = by[dates[0]], by[dates[-1]]
    return {"first": dates[0],
            "added": [clean_name(x["name"]) for c, x in L.items() if c not in F and x["weight"] >= TOKEN_WEIGHT],
            "removed": [clean_name(x["name"]) for c, x in F.items() if c not in L and x["weight"] >= TOKEN_WEIGHT]}


def compute(text, code):
    dates, by = parse_history(text)
    if not dates:
        return {"code": code, "ok": False, "error": "沒有持股歷史"}
    start, end = week_start(dates), dates[-1]
    mv, tokens = moves(dates, by, start, end) if start < end else ([], 0)
    top = sorted(by[end].values(), key=lambda x: -x["weight"])[:10]
    return {"code": code, "ok": True, "days": len(dates), "from": start, "to": end, "comparable": start < end,
            "move_pct": MOVE_PCT, "moves": mv, "token_moves": tokens, "since_first": since_first(dates, by),
            "top10": [{"name": clean_name(x["name"]), "weight": x["weight"]} for x in top]}


def brief(o):
    if not o["ok"]:
        return f"【{o['code']} 持股變化】未取得（{o['error']}）"
    if not o["comparable"]:
        return f"【{o['code']} 持股變化】只收集到 {o['to']} 一天，還不能比較"
    L = [f"【{o['code']} 這週持股變化】{o['from']} → {o['to']}，股數變化 {o['move_pct']}% 以上的 {len(o['moves'])} 檔"
         + (f"（另有 {o['token_moves']} 檔象徵性持股有變動）" if o["token_moves"] else "")]
    for m in o["moves"]:
        tail = (f"{m['since']} 起，權重 {m['weight_to']:.2f}%" if m["kind"] == "new"
                else f"原本權重 {m['weight_from']:.2f}%" if m["kind"] == "exit"
                else f"股數 {m['pct']:+.0f}%，權重 {m['weight_from']:.2f}% → {m['weight_to']:.2f}%")
        L.append(f"- {LABEL[m['kind']]} {m['name']}（{m['code']}）：{tail}")
    sf = o["since_first"]
    L.append(f"- {sf['first']} 開始收集以來：新增 {'、'.join(sf['added']) or '沒有'}；出清 {'、'.join(sf['removed']) or '沒有'}")
    L.append("- 前十大：" + "、".join(f"{t['name']} {t['weight']:.1f}%" for t in o["top10"]))
    L.append("（股數與權重只給你判斷方向，不能寫進試算表）")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dir", required=True, help="放 <代號>_history.csv 的目錄（私人 repo 的 data/holdings）")
    ap.add_argument("--code", default="00981A")
    ap.add_argument("--out", help="完整 JSON 寫到這個檔案")
    ap.add_argument("--brief", action="store_true", help="印精簡文字；不給就印 JSON")
    a = ap.parse_args(argv)
    try:
        text = (pathlib.Path(a.dir) / f"{a.code}_history.csv").read_text(encoding="utf-8")
    except OSError as e:
        o = {"code": a.code, "ok": False, "error": f"讀不到持股歷史（{e.__class__.__name__}）"}
    else:
        o = compute(text, a.code)
    sys.stdout.reconfigure(encoding="utf-8")
    js = json.dumps(o, ensure_ascii=False)
    if a.out:
        pathlib.Path(a.out).write_text(js, encoding="utf-8")
    print(brief(o) if a.brief else js)


if __name__ == "__main__":
    main()
