"""新聞晨報（新聞第二層）的候選清單：照固定規則篩選、對應標的、排序，並標出一定要寫的事項（v3）。

不靠模型自己寫篩選程式，讓每次執行（不管哪個模型）得到相同的候選清單；模型只負責查證與判斷。
規則見 docs/NEWS_ROUTINE.md 第 3、4 節與 docs/PIVOT.md 第 2、4 節（台股配置紀律＋每天兩次新聞）。

用法（在放資料的目錄的上一層執行）：
  python3 engine/news_select.py --data data --holdings holdings.json --out candidates.json --brief
  python3 engine/news_select.py --data data --holdings holdings.json --since 2026-10-30T08:40+08:00 --brief   （11:30 那次）
  python3 engine/news_select.py --data data [--now 2026-10-26T08:40+08:00] [--per-target 8] > candidates.json
data 目錄裡要有（缺的會記在 missing，相關項目略過）：
  headlines.json、fed.json、calendar.json、00981A.json、
  macro_<SPX|IXIC|SOX|VIX|TNX|DXY|GOLD|WTI|TSM>.csv、us_<VOO|GOOGL|NVDA|TSLA|SPCX|AAPL>.csv、
  tw_<009816|00981A>_norm.csv（日線：date,volume,open,high,low,close，無表頭）
  可以沒有（沒有就略過，記在 optional_missing）：intraday.json（台股盤中快照）、topics.json（市場話題）、
  tw_etf.json（ETF 除息日，market-data 的 data/dividends/tw_etf.json）
--holdings：帳本「持倉」分頁 get_values 的回傳（{"values": [[表頭…], [列…]]}），用「代號」與「股數（券商確認）」
  判斷持有（股數 > 0）。沒給時當作 009816、00981A 持有、美股都沒有持有。
--since：時間窗起點（台北 ISO）；不給就是「前一個平日 08:40」。11:30 那次給當天 08:40，只看早上之後的新消息。

標的與權重（預設；多個標的取最大）：
  配置內的台股 009816、00981A＝3；持有的美股（目前 VOO、GOOGL）＝2；其他追蹤（美股、Anthropic、OpenAI）＝1；
  總經＝1，但今晚的 FOMC、CPI 排程事件＝2。
  Anthropic、OpenAI 是虛擬標的：對應 headlines 的 symbols "ANTHROPIC"、"OPENAI"，沒有時用標題關鍵字。
輸出（JSON）：window、inputs、missing、optional_missing、focus、counts、filtered、candidates、must_cover、agenda、
  highlight_slots、closure_hints、topics。
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
AI = ("ANTHROPIC", "OPENAI")
TW = ("009816", "00981A")
TARGETS = US + AI + TW + ("總經",)
LABEL = {"ANTHROPIC": "Anthropic", "OPENAI": "OpenAI"}
# 虛擬標的的標題關鍵字（第一層還沒有 symbols 時的備援）
AI_WORDS = {"ANTHROPIC": re.compile(r"\bAnthropic\b", re.I),
            "OPENAI": re.compile(r"\bOpen ?AI\b|ChatGPT|Sam Altman|奧特曼", re.I)}
TSMC = {"2330", "TSM"}
MACRO_TOPICS = {"fed", "tariff", "export_controls", "china", "taiwan", "oil", "war", "cpi", "jobs"}
KEY_TOPICS = {"earnings", "export_controls", "tariff", "antitrust", "merger", "fed"}
TIER_SCORE = {1: 40, 2: 30, 3: 20, 4: 0}
# 權重（預設）：配置內台股 3、持有的美股 2、其他追蹤 1、總經 1；今晚的 FOMC、CPI 2
W_ALLOC, W_HELD, W_OTHER, W_MACRO, W_MACRO_EVENT = 3, 2, 1, 1, 2
DEFAULT_HELD = TW
# 前一交易日的大幅變動門檻（%；TNX 是殖利率的絕對變動，單位百分點）
MACRO_MOVE = {"SPX": 2.0, "IXIC": 2.0, "SOX": 3.0, "VIX": 15.0, "TNX": 0.15, "DXY": 1.0,
              "GOLD": 2.5, "WTI": 4.0, "TSM": 3.0}
STOCK_MOVE = {"VOO": 2.0, "GOOGL": 5.0, "NVDA": 5.0, "TSLA": 5.0, "SPCX": 5.0, "AAPL": 5.0,
              "009816": 3.0, "00981A": 3.0}
# 台股盤中相對昨收的變動門檻（%）：兩檔 ETF 沿用 STOCK_MOVE，加權指數 2%
INTRADAY_MOVE = {"009816": STOCK_MOVE["009816"], "00981A": STOCK_MOVE["00981A"], "TAIEX": 2.0}
EX_DIV_DAYS = 7      # 除息日在今天起 7 天內就列進 agenda
TOPICS_TOP = 5       # 市場話題、上升詞各取前幾名
# 來源加分：通訊社與主要媒體優先於轉載整理（Yahoo Finance 等）
SOURCE_BONUS = {"Reuters": 8, "AP News": 8, "Bloomberg.com": 5, "Bloomberg": 5, "WSJ": 5, "The Wall Street Journal": 5,
                "Financial Times": 5, "CNBC": 5, "中央社 CNA": 5, "中央社": 5, "經濟日報": 5, "工商時報": 5}
# 選股文、問句標題扣分；有實質變動字眼加分
LISTICLE = re.compile(r"[?？]\s*$|^(is|are|should|could|will)\b|stocks? to (buy|watch|own)|\bbest\b.*\bstocks?\b|\btop \d|"
                      r"\bprediction\b|\bbuy (now|today)\b|該買|值得買|存股", re.I)
SUBSTANCE = re.compile(r"跌|漲|重挫|大跌|飆|財報|財測|營收|獲利|制裁|禁令|訴訟|調查|召回|關稅|休市|plunge|slump|tumble|sink|"
                       r"surge|soar|jump|\bfall|\bdrop|rall(y|ies)|beat|miss|guidance|outlook|forecast|\bcut|\braise|ban\b|"
                       r"sanction|lawsuit|probe|recall|tariff|merger|acqui|\bIPO\b|funding|valuation|上市|募資|估值", re.I)
CLOSURE_WORDS = re.compile(r"休市|停止交易|暫停交易|颱風假|停班停課|market(s)? closed|trading (halt|suspend)", re.I)
# 和持股無關的消息（一般產品發表與評測、消費者抱怨、地方稅務或地方訴訟）：不列入候選
NOISE = re.compile(r"\b(unveils?|introduces|hands[- ]on|first look|review|pre-?orders?|best .{0,20}deals|how to|tips|"
                   r"complain(t|ts|s)?|users? (report|say)|backlash|crackgate|glitch|screen (problems?|issues?|cracks?)|"
                   r"county|parish|city council|school board|state tax|property tax|tax (break|incentive|deal)s?|"
                   r"major issue|new features?|adds .{0,40}features?|MacBook|iMac|iPad|AirPods|Apple Watch|Vision Pro|"
                   r"Pixel \d+|Chromebook)\b|"
                   r"^(Final Trades|Options Action|Lightning Round|Mad Money|Halftime Report)\b|What.s News for|"
                   r"發表會|開箱|評測|預購|優惠|折扣|抱怨|網友|災情", re.I)
NOT_NOISE = re.compile(r"antitrust|\bDOJ\b|\bFTC\b|\bSEC\b|\bEU\b|European Commission|regulat|export|tariff|recall|"
                       r"guidance|earnings|反壟斷|監管|出口|關稅|召回|財報|財測", re.I)
NY = ZoneInfo("America/New_York")
SAME_TIME_GROUP = 5  # 第一層沒有做時間檢查時：同一來源這麼多則發布時間完全相同，視為批次重新索引


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


def holding_codes(h, n):
    rows = sorted((h or {}).get("holdings") or [], key=lambda x: -(x.get("weight") or 0))[:n]
    return {str(x["code"]) for x in rows}


def num(s):
    """帳本的數字（可能帶千分位、空白）→ float；不是數字就 None。"""
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def parse_holdings(obj):
    """帳本「持倉」get_values 回傳 → 有股數（> 0）的代號集合。找不到欄位就丟 ValueError。"""
    rows = (obj or {}).get("values") or []
    if not rows:
        raise ValueError("持倉沒有資料")
    head = [str(h).strip() for h in rows[0]]
    try:
        ci = head.index("代號")
    except ValueError:
        raise ValueError(f"持倉表頭沒有「代號」：{head}") from None
    si = next((i for i, h in enumerate(head) if h == "股數（券商確認）"), None)
    if si is None:
        si = next((i for i, h in enumerate(head) if h.startswith("股數")), None)
    if si is None:
        raise ValueError(f"持倉表頭沒有「股數（券商確認）」：{head}")
    held = set()
    for r in rows[1:]:
        if len(r) > max(ci, si) and (num(r[si]) or 0) > 0:
            held.add(str(r[ci]).strip())
    return held


def load_focus(path, missing):
    """持有與配置：--holdings 給帳本持倉；沒給就當作 009816、00981A 持有。"""
    held, source = set(DEFAULT_HELD), "預設（未提供帳本持倉：當作 009816、00981A 持有）"
    if path:
        obj = load_json(pathlib.Path(path), missing)
        try:
            held, source = parse_holdings(obj), "帳本持倉"
        except ValueError as e:
            missing.append(f"{pathlib.Path(path).name}（{e}）")
    return {"held": sorted(held & set(US + TW)), "allocation": list(TW), "other_held": sorted(held - set(US + TW)),
            "source": source, "loaded": source == "帳本持倉"}


def weight(targets, focus):
    """標的的重要性：配置內台股 3、持有的美股 2、其他追蹤 1、總經 1。多個標的取最大。"""
    w = 0
    for t in targets:
        if t in TW:
            w = max(w, W_ALLOC)
        elif t in US and t in focus["held"]:
            w = max(w, W_HELD)
        elif t == "總經":
            w = max(w, W_MACRO)
        else:
            w = max(w, W_OTHER)
    return w


def focus_note(targets, focus):
    parts = []
    for t in targets:
        tags = (["配置內"] if t in focus["allocation"] else []) + (["持有"] if t in focus["held"] else [])
        if tags:
            parts.append(f"{t}（{'、'.join(tags)}）")
    return "、".join(parts)


def map_targets(item, top981):
    """標題對應到哪些標的（規則見 NEWS_ROUTINE 第 3.1 節）。"""
    syms = set(item.get("symbols") or [])
    tg = set(syms & set(US)) | (syms & set(TW)) | (syms & set(AI))
    title = item.get("title") or ""
    for t, rx in AI_WORDS.items():
        if t not in tg and rx.search(title):
            tg.add(t)
    if syms & TSMC:
        tg |= set(TW)
    if syms & top981:
        tg.add("00981A")
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


def noise_reason(title):
    if NOISE.search(title) and not NOT_NOISE.search(title):
        return "雜訊（產品發表、消費者抱怨或地方事務）"
    return None


def suspect_ids(h):
    """發布時間不可靠的標題 id：第一層標的 time_suspect；第一層沒做時間檢查時，自己找同來源批次相同時間。"""
    items = h.get("items") or []
    ids = {x.get("id") for x in items if x.get("time_suspect")}
    if "time_check" not in (h.get("stats") or {}):
        groups = {}
        for x in items:
            groups.setdefault((x.get("source"), x.get("published_taipei")), []).append(x.get("id"))
        ids |= {i for g in groups.values() if len(g) >= SAME_TIME_GROUP for i in g}
    return ids


def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return None


def dividend_events(obj, code=None):
    """從除息檔找出 (代號, 除息日, 每單位金額, 發放日)。格式以 market-data 為準，這裡接受常見的幾種：
    清單裡每筆有 code／stock_id／symbol 與 ex_date／ex_dividend_date／date；或用代號當鍵（值是清單或一筆）。"""
    out = []
    if isinstance(obj, list):
        for x in obj:
            out += dividend_events(x, code)
    elif isinstance(obj, dict):
        c = first(obj, "code", "stock_id", "symbol") or code
        d = first(obj, "ex_date", "ex_dividend_date", "next_ex_date")
        if d is None and c is not None and first(obj, "amount", "cash_dividend", "dividend") is not None:
            d = first(obj, "date")
        if c is not None and isinstance(d, str) and re.match(r"\d{4}-\d{2}-\d{2}", d):
            out.append((str(c), d[:10], first(obj, "amount", "cash_dividend", "dividend", "per_unit"),
                        first(obj, "pay_date", "payment_date", "paid_date")))
        for k, v in obj.items():
            if isinstance(v, (list, dict)):
                out += dividend_events(v, k if k in TW else c)
    return out


def agenda(cal, now, focus, divs=None):
    """接下來的排程事件：今晚到明天中午（台北）的監測標的財報、FOMC 決議、CPI；以及 7 天內兩檔台股 ETF 除息。"""
    horizon = dt.datetime.combine(now.date() + dt.timedelta(days=1), dt.time(12, 0), TPE)
    out = []

    def add(kind, symbol, when, targets, note, w=None, after=now, until=horizon):
        if after < when <= until:
            w = weight(targets, focus) if w is None else w
            out.append({"type": kind, "symbol": symbol, "when_taipei": when.strftime("%Y-%m-%d %H:%M"),
                        "targets": targets, "weight": w, "focus": focus_note(targets, focus) or
                        ("影響所有部位" if targets == ["總經"] else ""), "note": note})
    for s, e in ((cal.get("earnings") or {}).get("symbols") or {}).items():
        for d in e.get("dates") or []:
            when = dt.datetime.combine(dt.date.fromisoformat(d), dt.time(16, 0), NY).astimezone(TPE)
            add("earnings", s, when, [s], f"財報（美股盤後，約台北 {when:%m/%d} 清晨）"
                f"{'，日期為估計' if e.get('is_estimate') else ''}")
    for m in cal.get("fomc") or []:
        if m.get("end"):
            when = dt.datetime.combine(dt.date.fromisoformat(m["end"]), dt.time(14, 0), NY).astimezone(TPE)
            add("fomc", "FOMC", when, ["總經"], f"FOMC 決議（台北 {when:%m/%d %H:%M}）", W_MACRO_EVENT)
    cpi = cal.get("cpi")
    dates = cpi.get("dates") or [] if isinstance(cpi, dict) else [x.get("date") for x in cpi or [] if isinstance(x, dict)]
    for d in dates:
        if d:
            when = dt.datetime.combine(dt.date.fromisoformat(d), dt.time(8, 30), NY).astimezone(TPE)
            add("cpi", "CPI", when, ["總經"], f"美國 CPI（台北 {when:%m/%d %H:%M}）", W_MACRO_EVENT)
    # 除息：今天（含今天，開盤就生效）起 7 天內
    seen = set()
    day0 = dt.datetime.combine(now.date(), dt.time(0, 0), TPE)
    for code, d, amount, pay in divs or []:
        if code not in TW or (code, d) in seen:
            continue
        seen.add((code, d))
        when = dt.datetime.combine(dt.date.fromisoformat(d), dt.time(9, 0), TPE)
        note = (f"除息日 {d}" + ("（今天）" if when.date() == now.date() else "")
                + (f"，每單位 {amount} 元" if amount is not None else "") + (f"，發放日 {pay}" if pay else ""))
        add("ex_dividend", code, when, [code], note, after=day0 - dt.timedelta(seconds=1),
            until=day0 + dt.timedelta(days=EX_DIV_DAYS, hours=23, minutes=59))
    return sorted(out, key=lambda a: (-a["weight"], a["when_taipei"]))


def intraday_moves(intra, now):
    """台股盤中相對昨收超過門檻（只看今天的快照）。"""
    out = []
    quotes = (intra or {}).get("quotes") or {}
    for s, th in INTRADAY_MOVE.items():
        q = quotes.get(s) or {}
        if not q.get("is_today") or q.get("data_date") != now.date().isoformat() or q.get("change_pct") is None:
            continue
        if abs(q["change_pct"]) >= th:
            out.append({"type": "intraday_move", "target": "總經" if s == "TAIEX" else s, "symbol": s,
                        "date": q.get("data_date"), "time": q.get("time"), "price": q.get("price"),
                        "price_field": q.get("price_field"), "change": q.get("change_pct"), "unit": "%",
                        "threshold": th, "session": (intra or {}).get("session")})
    return out


def market_topics(tp, h):
    """市場話題（第一層 topics.json）：rise 前幾名＋上升詞前幾名，附樣本標題。沒有檔案就空。"""
    if not tp:
        return {"generated_at_taipei": None, "top": [], "rising_terms": []}
    by_id = {x.get("id"): x for x in (h or {}).get("items") or []}

    def samples(ids):
        return [{"id": i, "title": by_id[i].get("title"), "source": by_id[i].get("source"),
                 "time": by_id[i].get("published_taipei")} for i in ids or [] if i in by_id][:3]
    topics = [t for t in tp.get("topics") or [] if isinstance(t.get("rise"), (int, float))]
    top = sorted(topics, key=lambda t: -t["rise"])[:TOPICS_TOP]
    return {"generated_at_taipei": tp.get("generated_at_taipei"),
            "top": [{k: t.get(k) for k in ("topic", "label", "count_1d", "count_7d", "count_30d", "rise")}
                    | {"samples": samples(t.get("sample_ids"))} for t in top],
            "rising_terms": [{k: t.get(k) for k in ("term", "count_1d", "count_30d")}
                             | {"samples": samples(t.get("sample_ids"))}
                             for t in (tp.get("rising_terms") or [])[:TOPICS_TOP]]}


def highlight_slots(must, agenda_items, candidates, focus, n=8):
    """「今日重點」的建議順序：先是配置內台股與持有美股（排程事件、必寫事項、Tier 1～2 消息；今晚的 FOMC、CPI
    權重 2，和持有美股同級），其次是 Fed 新聞稿，最後是其他必寫事項（總經大幅變動等）。模型照順序挑最多 3 條。"""
    slots = []
    for a in agenda_items:
        p = 1 if a["weight"] >= 2 else 2
        slots.append({"priority": p, "kind": "agenda", "type": a["type"], "targets": a["targets"],
                      "weight": a["weight"], "focus": a["focus"], "when_taipei": a["when_taipei"], "note": a["note"]})
    for m in must:
        if m["type"] in ("tw_closed", "possible_closure") or m.get("symbol") in ("TSM", "TAIEX"):
            tg = list(TW)
        else:
            tg = [m["target"]]
        w = weight(tg, focus)
        p = 1 if w >= 2 else (2 if m["type"] == "fed" else 3)
        slots.append({"priority": p, "kind": "must_cover", "type": m["type"], "targets": tg, "weight": w,
                      "focus": focus_note(tg, focus),
                      "ref": {k: m.get(k) for k in ("symbol", "date", "time", "change", "unit") if m.get(k) is not None}})
    # 權重 ≥ 2 的標的各取最好的一則 Tier 1～2 消息（同一則消息只算一次），最多 4 則
    news, used, covered = [], set(), set()
    for t in sorted(candidates, key=lambda t: -weight([t], focus)):
        w = weight([t], focus)
        pool = sorted((c for c in candidates[t] if (c["tier"] or 4) <= 2 and c["id"] not in used),
                      key=lambda c: (c["tier"], -c["score"]))
        c = pool[0] if pool else None
        if w >= 2 and c and tuple(sorted([t] + c["other_targets"])) not in covered and t not in covered:
            used.add(c["id"])
            tg = [t] + c["other_targets"]
            covered |= {tuple(sorted(tg))} | set(tg)
            news.append({"priority": 1, "kind": "news", "type": "news", "targets": tg, "weight": max(w, weight(tg, focus)),
                         "focus": focus_note(tg, focus), "id": c["id"], "title": c["title"], "tier": c["tier"],
                         "url": c["url"]})
    slots += news[:4]
    rank = {"agenda": 0, "must_cover": 1, "news": 2}
    slots.sort(key=lambda s: (s["priority"], -s["weight"], rank[s["kind"]]))
    return slots[:n]


def select(data, now, per_target=8, holdings=None, since=None):
    missing, optional = [], []
    start = since or window_start(now)
    h = load_json(data / "headlines.json", missing) or {}
    fed = load_json(data / "fed.json", missing) or {}
    cal = load_json(data / "calendar.json", missing) or {}
    top981 = holding_codes(load_json(data / "00981A.json", missing), 10)
    intra = load_json(data / "intraday.json", optional)
    tp = load_json(data / "topics.json", optional)
    divs = dividend_events(load_json(data / "tw_etf.json", optional))
    focus = load_focus(holdings, missing)

    suspect = suspect_ids(h)
    items = [x for x in h.get("items") or [] if x.get("published_taipei") and x.get("id") not in suspect
             and start <= parse_taipei(x["published_taipei"]) <= now]
    buckets = {t: [] for t in TARGETS}
    seen = {t: set() for t in TARGETS}
    for x in items:
        tg = map_targets(x, top981)
        norm = re.sub(r"\W+", "", (x.get("title") or "").lower())
        for t in tg:
            if norm in seen[t]:
                continue
            seen[t].add(norm)
            buckets[t].append({"id": x.get("id"), "time": x["published_taipei"], "source": x.get("source"),
                               "tier": x.get("tier"), "title": x.get("title"), "url": x.get("url"),
                               "link": x.get("link"), "also": x.get("also") or [], "topics": x.get("topics") or [],
                               "symbols": x.get("symbols") or [], "other_targets": sorted(tg - {t}),
                               "score": score(x, now), "noise": noise_reason(x.get("title") or "")})
    counts, candidates, filtered = {}, {}, {}
    for t, lst in buckets.items():
        by_tier = {str(k): sum(1 for c in lst if c["tier"] == k) for k in (1, 2, 3, 4)}
        counts[t] = {"total": len(lst), "by_tier": by_tier, "weight": weight([t], focus)}
        keep = [c for c in lst if not c["noise"]]
        # Tier 4 只在這個標的沒有其他消息時才留
        if any((c["tier"] or 4) <= 3 for c in keep):
            keep = [c for c in keep if (c["tier"] or 4) <= 3]
        filtered[t] = {"noise": sum(1 for c in lst if c["noise"]),
                       "tier4": sum(1 for c in lst if not c["noise"]) - len(keep)}
        for c in keep:
            del c["noise"]
        candidates[t] = sorted(keep, key=lambda c: (-c["score"], c["time"]))[:per_target]

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
    must += intraday_moves(intra, now)
    # 財報當作美股盤後（美東 16:00）公布：時間已過才是必寫，還沒到的放在 agenda。
    # 08:40 那次往前多看一天（週末、連假），11:30 那次（--since）只看時間窗內，避免重複 08:40 已寫的
    lo = start if since else start - dt.timedelta(days=1)
    for s, e in ((cal.get("earnings") or {}).get("symbols") or {}).items():
        for d in e.get("dates") or []:
            when = dt.datetime.combine(dt.date.fromisoformat(d), dt.time(16, 0), NY).astimezone(TPE)
            if lo <= when <= now:
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
                     "note": "標題提到休市或停止交易：確認台股（或美股）今天是否開盤", "count": len(hints)})

    ag = agenda(cal, now, focus, divs)
    return {"window": {"start": start.isoformat(timespec="minutes"), "end": now.isoformat(timespec="minutes"),
                       "since_given": since is not None},
            "inputs": {"headlines_generated": h.get("generated_at_taipei"), "headlines_status": h.get("status"),
                       "feeds_ok": f"{sum(1 for f in h.get('feeds') or [] if f.get('ok'))}/{len(h.get('feeds') or [])}",
                       "items_in_window": len(items), "fed_in_window": sum(1 for m in must if m["type"] == "fed"),
                       "time_suspect_skipped": len(suspect), "top10_00981A": sorted(top981),
                       "intraday": {"fetched_at_taipei": (intra or {}).get("fetched_at_taipei"),
                                    "session": (intra or {}).get("session")} if intra else None,
                       "topics_generated": (tp or {}).get("generated_at_taipei"),
                       "ex_dividend_events": len(divs)},
            "missing": sorted(set(missing)), "optional_missing": sorted(set(optional)), "focus": focus,
            "counts": counts, "filtered": filtered, "candidates": candidates, "must_cover": must, "agenda": ag,
            "highlight_slots": highlight_slots(must, ag, candidates, focus), "closure_hints": hints[:8],
            "topics": market_topics(tp, h)}


def name(t):
    return LABEL.get(t, t)


def brief(out, n=5):
    """給模型看的精簡文字：輸入狀態、持有、接下來、重點順序、必寫事項、市場話題、各標的前 n 名。"""
    fc = out["focus"]
    w = out["window"]
    L = [f"時間窗 {w['start']} ～ {w['end']}" + ("（--since）" if w.get("since_given") else ""),
         f"輸入 {json.dumps(out['inputs'], ensure_ascii=False)}", f"缺檔 {out['missing'] or '無'}"
         + (f"；選用檔案沒有 {out['optional_missing']}" if out["optional_missing"] else ""),
         "件數 " + "、".join(f"{name(t)} {c['total']}" for t, c in out["counts"].items()),
         "過濾 " + ("、".join(f"{name(t)} 雜訊{f['noise']}／Tier4 {f['tier4']}" for t, f in out["filtered"].items()
                            if f["noise"] or f["tier4"]) or "無"),
         "", f"【持有】（{fc['source']}）",
         f"- 配置內 {'、'.join(fc['allocation'])}；持有 {'、'.join(fc['held']) or '無'}"
         + (f"；其他持有 {'、'.join(fc['other_held'])}" if fc["other_held"] else ""),
         "", "【接下來】（今晚／明早的財報、FOMC、CPI；7 天內除息）"]
    L += [f"- {a['when_taipei']}｜{name(a['symbol'])}｜{a['note']}｜影響 {','.join(name(t) for t in a['targets'])}"
          + (f"｜{a['focus']}" if a["focus"] else "") for a in out["agenda"]] or ["- 無"]
    L += ["", "【重點順序建議】（照順序挑最多 3 條；同一件事合併）"]
    L += [f"- P{s['priority']} {s['kind']}｜{s.get('title') or s['type']}"
          + (f"｜{json.dumps(s['ref'], ensure_ascii=False)}" if s.get("ref") else "")
          + (f"｜{s['when_taipei']}" if s.get("when_taipei") else "")
          + f"｜影響 {','.join(name(t) for t in s['targets'])}" + (f"｜{s['focus']}" if s["focus"] else "")
          + (f"｜id {s['id']}" if s.get("id") else "") for s in out["highlight_slots"]] or ["- 無"]
    L += ["", "【必寫事項】"]
    L += [f"- {json.dumps(m, ensure_ascii=False)}" for m in out["must_cover"]] or ["- 無"]
    tp = out["topics"]
    L += ["", "【市場話題】" + (f"（第一層 {tp['generated_at_taipei']}）" if tp["generated_at_taipei"] else "（沒有 topics.json）")]
    for t in tp["top"]:
        L.append(f"- {t.get('label') or t.get('topic')}｜1 天 {t.get('count_1d')}、7 天 {t.get('count_7d')}、"
                 f"30 天 {t.get('count_30d')}｜上升 {t.get('rise')}")
        L += [f"  · {s['time']}｜{s['source']}｜{s['title']}" for s in t["samples"]]
    for t in tp["rising_terms"]:
        L.append(f"- 上升詞「{t.get('term')}」｜1 天 {t.get('count_1d')}、30 天 {t.get('count_30d')}")
        L += [f"  · {s['time']}｜{s['source']}｜{s['title']}" for s in t["samples"]]
    if not tp["top"] and not tp["rising_terms"]:
        L.append("- 無")
    L += ["", "【休市相關標題】"] + [f"- {h['time']}｜{h['source']}（{h['tier']}）｜{h['title']}" for h in out["closure_hints"]]
    for t, lst in out["candidates"].items():
        L += ["", f"【{name(t)}】" + (f"（{focus_note([t], fc)}）" if focus_note([t], fc) else "")]
        L += [f"- {c['time']}｜{c['source']}（{c['tier']}）｜{c['title']}｜{'有原文網址' if c['url'] else '無原文網址'}"
              f"｜其他標的 {','.join(name(x) for x in c['other_targets']) or '—'}｜id {c['id']}" for c in lst[:n]] or ["- 無"]
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data", default="data")
    ap.add_argument("--now", help="台北時間 ISO，例如 2026-10-26T08:40+08:00；不給就用現在")
    ap.add_argument("--since", help="時間窗起點（台北 ISO），例如 11:30 那次給 2026-10-30T08:40+08:00；不給就是前一個平日 08:40")
    ap.add_argument("--per-target", type=int, default=8)
    ap.add_argument("--holdings", help="帳本「持倉」分頁 get_values 的回傳 JSON 檔（{\"values\": [[表頭…], …]}）")
    ap.add_argument("--brief", action="store_true", help="印精簡文字（必寫事項與各標的前 5 名），完整 JSON 另存 --out")
    ap.add_argument("--out", help="完整 JSON 寫到這個檔案")
    a = ap.parse_args(argv)
    now = dt.datetime.fromisoformat(a.now).astimezone(TPE) if a.now else dt.datetime.now(TPE)
    since = dt.datetime.fromisoformat(a.since).astimezone(TPE) if a.since else None
    out = select(pathlib.Path(a.data), now, a.per_target, a.holdings, since)
    sys.stdout.reconfigure(encoding="utf-8")
    text = json.dumps(out, ensure_ascii=False)
    if a.out:
        pathlib.Path(a.out).write_text(text, encoding="utf-8")
    print(brief(out) if a.brief else text)


if __name__ == "__main__":
    main()
