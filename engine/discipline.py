"""台股配置紀律（docs/PIVOT.md 第 2 節）：本月應投入／已投入、核心：衛星比例與偏離、建議分配、下次檢查日、連續投入月數。

給新聞晨報用（6 日推播當月計畫、當月最後一個交易日還沒投入就提醒、今日一句）。網站（Phase 4）用 JS 算同一件事，
常數要和下面的 CONFIG 一致。只用 Python 標準庫。依自訂規則的提醒，不是投資建議。

用法：
  python3 engine/discipline.py --holdings h.json --trades t.json --data data --today 2026-10-30 --out discipline.json --brief
輸入：
  --holdings：帳本「持倉」'持倉'!A1:K 的 get_values 回傳（{"values": [[表頭…], [列…]]}）；用「市場」「代號」「股數（券商確認）」
  --trades：帳本「交易紀錄」'交易紀錄'!A1:R 的 get_values 回傳（A1:N 也可以；有 R「更正」欄才會拿掉沖銷的一對）；用「日期」「市場」「代號」「買賣」「股數」「成交價」
            「台幣金額」（空白時用「交割金額（原幣，含費）」，再沒有用股數 × 成交價）
  --data：價格與行事曆。價格優先用 intraday.json（今天的盤中快照），否則 tw_<代號>_norm.csv（或 <代號>_norm.csv）最後收盤；
          休市日用 calendar.json 的 tw_market.closed
  --dca（選用）：帳本「定投金額」'定投金額'!A1:F 的 get_values 回傳；用「生效月份」「每月定投」。
          某個月的定投金額＝生效月份不晚於這個月的最後一列（比第一列早用第一列）；沒給或讀不到用 CONFIG 的 3,000
規則（CONFIG）：
  - 只算台股；核心 009816 80%、衛星 00981A 20%；每月 6 日入金（定投金額，預設 3,000）
  - 當月台股「買進」台幣金額合計 ≥ 定投金額的 9 成（3,000 → 2,700）算已投入；超過定投金額的部分是自主加碼
    （2026-11-05 使用者決定，和網站 site/js/discipline.js 相同）
  - 檢查月 4 月與 10 月（各月 6 日）：偏離超過 5 個百分點時，當月入金全部補偏低的一檔；其他月份照 80／20
  - 偏離＝核心市值比例 − 80（百分點；正數表示核心偏高、衛星偏低）
輸出 JSON：見 compute() 的回傳；--brief 印給模型與人看的精簡文字。
"""
import argparse
import calendar as cal_mod
import csv
import datetime as dt
import json
import pathlib
import re
import sys
from zoneinfo import ZoneInfo

TPE = ZoneInfo("Asia/Taipei")
CONFIG = {
    "market": "台股",
    "core": "009816",
    "satellite": "00981A",
    "target_pct": {"009816": 80, "00981A": 20},
    "deposit_day": 6,
    "monthly": 3000,
    "check_months": [4, 10],
    "threshold_pp": 5,
    "invested_min": 2700,
}
CODES = (CONFIG["core"], CONFIG["satellite"])


def num(s):
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def table(obj):
    """get_values 回傳 → [{表頭: 值}]（短列補空字串）。"""
    vals = (obj or {}).get("values") or []
    if not vals:
        return []
    head = [str(h).strip() for h in vals[0]]
    return [{h: (r[i] if i < len(r) else "") for i, h in enumerate(head)} for r in vals[1:]]


def tw_holdings(obj):
    out = {}
    for r in table(obj):
        if str(r.get("市場", "")).strip() == CONFIG["market"]:
            shares = num(r.get("股數（券商確認）", ""))
            if shares is None:
                shares = num(r.get("股數", "")) or 0
            out[str(r.get("代號", "")).strip()] = shares
    return out


REVERSAL = re.compile(r"^沖銷第 (\d+) 列")


def trades(obj):
    """交易紀錄 → list。有「更正」欄（'交易紀錄'!A1:R）時拿掉沖銷的一對：沖銷列（「沖銷第 N 列」）和它指的第 N 列，
    跟網站 data.js 的 loadTrades 同一套規則。沒有這欄（只讀 A1:N）時沖銷列是負數，合計一樣會抵掉。"""
    rows = table(obj)
    gone = set()
    for i, r in enumerate(rows):
        m = REVERSAL.match(str(r.get("更正", "")).strip())
        if m:
            gone.update((i + 2, int(m.group(1))))  # 試算表列號：表頭是第 1 列
    out = []
    for i, r in enumerate(rows):
        if i + 2 in gone:
            continue
        try:
            d = dt.date.fromisoformat(str(r.get("日期", "")).strip()[:10])
        except ValueError:
            continue
        shares, price = num(r.get("股數", "")), num(r.get("成交價", ""))
        twd, src = num(r.get("台幣金額", "")), "台幣金額"
        if twd is None and str(r.get("幣別", "")).strip() in ("TWD", ""):
            twd, src = num(r.get("交割金額（原幣，含費）", "")), "交割金額"
        if twd is None and shares is not None and price is not None:
            twd, src = round(shares * price), "股數×成交價"
        out.append({"date": d.isoformat(), "market": str(r.get("市場", "")).strip(), "code": str(r.get("代號", "")).strip(),
                    "side": str(r.get("買賣", "")).strip(), "shares": shares, "price": price, "twd": twd, "twd_source": src})
    return out


def by_prefix(row, prefix):
    """表頭以 prefix 開頭的那一欄（帳本實際表頭是「每月定投（NT$）」；和網站 data.js 的 col() 一樣用前綴比對）。"""
    return next((v for h, v in row.items() if h.startswith(prefix)), "")


def dca_list(obj):
    """帳本「定投金額」→ [(YYYY-MM, 金額)]（舊到新）；格式不對的列略過。"""
    out = []
    for r in table(obj):
        m = str(by_prefix(r, "生效月份")).strip().replace("/", "-")
        parts = m.split("-")
        amount = num(by_prefix(r, "每月定投"))
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit() and len(parts[0]) == 4 and amount:
            out.append((f"{parts[0]}-{int(parts[1]):02d}", int(amount) if amount == int(amount) else amount))
    return sorted(out)


def dca_for(dca, ym):
    """某個月的定投金額：生效月份不晚於這個月的最後一列；比第一列早用第一列；沒有資料用 CONFIG。"""
    if not dca:
        return CONFIG["monthly"]
    a = dca[0][1]
    for m, amount in dca:
        if m <= ym:
            a = amount
    return a


def min_for(amount):
    """已投入門檻：定投金額的 9 成（CONFIG 3,000 → 2,700）。"""
    return round(amount * CONFIG["invested_min"] / CONFIG["monthly"])


def month_buys(tr, ym):
    return [t for t in tr if t["market"] == CONFIG["market"] and t["side"] == "買進" and t["date"][:7] == ym
            and t["twd"] is not None]


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def prices(data, today):
    """各檔價格：今天的盤中快照優先，否則日線最後收盤。回傳 {代號: (價格, 來源說明)}，取不到的不列。"""
    out = {}
    intra = read_json(pathlib.Path(data) / "intraday.json") or {}
    for code in CODES:
        q = (intra.get("quotes") or {}).get(code) or {}
        if q.get("is_today") and q.get("data_date") == today.isoformat() and q.get("price"):
            out[code] = (float(q["price"]), f"盤中 {str(q.get('time') or '')[11:16]}（{q.get('price_field')}）")
            continue
        for name in (f"tw_{code}_norm.csv", f"{code}_norm.csv"):
            p = pathlib.Path(data) / name
            try:
                rows = [r for r in csv.reader(p.read_text(encoding="utf-8").splitlines()) if r]
            except OSError:
                continue
            if rows:
                out[code] = (float(rows[-1][5]), f"收盤 {rows[-1][0]}")
                break
    return out


def closed_days(data):
    c = read_json(pathlib.Path(data) / "calendar.json") or {}
    return set((c.get("tw_market") or {}).get("closed") or [])


def last_trading_day(year, month, closed):
    d = dt.date(year, month, cal_mod.monthrange(year, month)[1])
    while d.weekday() >= 5 or d.isoformat() in closed:
        d -= dt.timedelta(days=1)
    return d


def plan_day(year, month):
    """推播當月計畫的日子：6 日；遇週末順延到下一個平日（新聞晨報只在平日執行）。"""
    d = dt.date(year, month, CONFIG["deposit_day"])
    while d.weekday() >= 5:
        d += dt.timedelta(days=1)
    return d


def next_check(today):
    days = [dt.date(y, m, CONFIG["deposit_day"]) for y in (today.year, today.year + 1) for m in CONFIG["check_months"]]
    return min(d for d in days if d >= today)


def prev_month(ym):
    y, m = int(ym[:4]), int(ym[5:])
    return f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"


def streak(tr, today, invested_now, month_over, dca=None):
    """連續投入月數：本月已投入就從本月往前數；還沒投入但月份還沒結束，從上個月往前數；本月已結束沒投入就是 0。
    每個月用那個月的定投金額算門檻。"""
    ym = today.strftime("%Y-%m")
    if not invested_now:
        if month_over:
            return 0, []
        ym = prev_month(ym)
    months = []
    while sum(t["twd"] for t in month_buys(tr, ym)) >= min_for(dca_for(dca, ym)):
        months.append(ym)
        ym = prev_month(ym)
    return len(months), months


def compute(holdings_obj, trades_obj, today, px, closed, dca_obj=None):
    ym = today.strftime("%Y-%m")
    tr = trades(trades_obj)
    dca = dca_list(dca_obj)
    monthly = dca_for(dca, ym)
    invested_min = min_for(monthly)
    buys = month_buys(tr, ym)
    invested = round(sum(t["twd"] for t in buys))
    is_invested = invested >= invested_min
    hold = tw_holdings(holdings_obj)
    warnings = []
    pos = {}
    for code in CODES:
        sh = hold.get(code, 0) or 0
        p, src = px.get(code, (None, None))
        if p is None:
            warnings.append(f"{code} 沒有價格")
        pos[code] = {"shares": sh, "price": p, "price_source": src, "value": round(sh * p) if p is not None else None}
    values = [pos[c]["value"] for c in CODES]
    total = sum(values) if None not in values else None
    ratio = {c: (round(pos[c]["value"] / total * 100, 2) if total else None) for c in CODES}
    core, sat = CODES
    dev = round(ratio[core] - CONFIG["target_pct"][core], 2) if ratio[core] is not None else None
    needs = dev is not None and abs(dev) > CONFIG["threshold_pp"]
    under = (sat if dev > 0 else core) if dev else None
    check_month = today.month in CONFIG["check_months"]
    normal = {core: round(monthly * CONFIG["target_pct"][core] / 100), sat: round(monthly * CONFIG["target_pct"][sat] / 100)}
    if needs and check_month:
        plan = {"mode": "rebalance", "amounts": {c: (monthly if c == under else 0) for c in CODES},
                "note": f"檢查月：偏離 {dev:+.2f} 個百分點超過 {CONFIG['threshold_pp']}，入金全部補 {under}"}
    else:
        note = "照 80／20"
        if needs:
            note += f"；偏離 {dev:+.2f} 個百分點已超過 {CONFIG['threshold_pp']}，但不在檢查月（下次 {next_check(today)} 再補）"
        plan = {"mode": "normal", "amounts": normal, "note": note}
    bought = {c: round(sum(t["twd"] for t in buys if t["code"] == c)) for c in CODES}
    remaining = {c: max(0, plan["amounts"][c] - bought[c]) for c in CODES}
    last_td = last_trading_day(today.year, today.month, closed)
    pday = plan_day(today.year, today.month)
    month_over = today > last_td
    n, months = streak(tr, today, is_invested, month_over, dca)
    if dca_obj is None:
        dca_source = "CONFIG（沒有給 --dca）"
    elif not dca:
        dca_source = "CONFIG（帳本「定投金額」讀不到有效的列）"
        warnings.append("帳本「定投金額」讀不到有效的列，用預設 3,000")
    else:
        dca_source = "帳本「定投金額」"
    return {
        "today": today.isoformat(), "month": ym, "config": CONFIG,
        "should_invest": monthly, "dca_source": dca_source, "dca_list": [{"month": m, "amount": a} for m, a in dca],
        "next_month_dca": dca_for(dca, f"{today.year + 1}-01" if today.month == 12 else f"{today.year}-{today.month + 1:02d}"),
        "invested": invested, "invested_min": invested_min, "is_invested": is_invested,
        "dca_part": min(invested, monthly), "extra": max(0, invested - monthly),
        "month_buys": [{k: t[k] for k in ("date", "code", "shares", "price", "twd", "twd_source")} for t in buys],
        "bought_by_code": bought,
        "off_plan_buys": [{k: t[k] for k in ("date", "code", "twd")} for t in buys if t["code"] not in CODES],
        "holdings": pos, "total_value": total, "ratio_pct": ratio, "target_pct": CONFIG["target_pct"],
        "deviation_pp": dev, "threshold_pp": CONFIG["threshold_pp"], "needs_rebalance": needs, "underweight": under,
        "is_check_month": check_month, "plan": plan, "remaining_plan": remaining,
        "next_check": next_check(today).isoformat(),
        "streak_months": n, "streak_list": months,
        "deposit_day": dt.date(today.year, today.month, CONFIG["deposit_day"]).isoformat(),
        "is_deposit_day": today.day == CONFIG["deposit_day"],
        "plan_day": pday.isoformat(), "is_plan_day": today == pday,
        "last_trading_day": last_td.isoformat(), "is_last_trading_day": today == last_td,
        "is_trading_day": today.weekday() < 5 and today.isoformat() not in closed,
        "remind_not_invested": today == last_td and not is_invested,
        "warnings": warnings,
    }


def money(x):
    return "—" if x is None else f"{x:,.0f}"


def brief(o):
    core, sat = CODES
    h, r = o["holdings"], o["ratio_pct"]
    L = [f"【本月紀律】{o['month']}：應投入 {money(o['should_invest'])}（{o['dca_source']}），已投入 {money(o['invested'])}"
         + (f"（≥ {money(o['invested_min'])}，已完成）" if o["is_invested"] else f"（未達 {money(o['invested_min'])}）")
         + (f"；其中定投 {money(o['dca_part'])}、自主加碼 {money(o['extra'])}" if o["extra"] else "")
         + (f"；下個月定投 {money(o['next_month_dca'])}" if o["next_month_dca"] != o["should_invest"] else ""),
         f"- 本月買進：" + ("、".join(f"{t['date'][5:]} {t['code']} {money(t['twd'])}" for t in o["month_buys"]) or "無")]
    if o["off_plan_buys"]:
        L.append("- ⚠ 計畫外的台股：" + "、".join(f"{t['date'][5:]} {t['code']} {money(t['twd'])}" for t in o["off_plan_buys"]))
    L += [f"【配置】{core} {money(h[core]['value'])}（{r[core]}%）／{sat} {money(h[sat]['value'])}（{r[sat]}%）；"
          f"目標 80／20，偏離 {o['deviation_pp']:+.2f} 個百分點（門檻 {o['threshold_pp']}）" if o["deviation_pp"] is not None
          else "【配置】價格不足，無法計算比例",
          f"- 價格：{core} {h[core]['price']}（{h[core]['price_source']}）、{sat} {h[sat]['price']}（{h[sat]['price_source']}）",
          f"【本月建議分配】{core} {money(o['plan']['amounts'][core])}、{sat} {money(o['plan']['amounts'][sat])}（{o['plan']['note']}）",
          f"- 還沒買的部分：{core} {money(o['remaining_plan'][core])}、{sat} {money(o['remaining_plan'][sat])}",
          f"【下次檢查】{o['next_check']}；連續投入 {o['streak_months']} 個月"
          + (f"（{'、'.join(o['streak_list'])}）" if o["streak_list"] else ""),
          f"【今天】{o['today']}："
          + ("是當月計畫推播日；" if o["is_plan_day"] else f"計畫推播日 {o['plan_day']}；")
          + ("是當月最後一個交易日" if o["is_last_trading_day"] else f"當月最後一個交易日 {o['last_trading_day']}")
          + ("；⚠ 本月還沒投入，提醒使用者" if o["remind_not_invested"] else "")
          + ("" if o["is_trading_day"] else "；今天台股休市")]
    if o["warnings"]:
        L.append("⚠ " + "；".join(o["warnings"]))
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--holdings", required=True, help="帳本「持倉」get_values 回傳 JSON")
    ap.add_argument("--trades", required=True, help="帳本「交易紀錄」get_values 回傳 JSON")
    ap.add_argument("--data", default="data", help="放 intraday.json、tw_<代號>_norm.csv、calendar.json 的目錄")
    ap.add_argument("--dca", help="帳本「定投金額」get_values 回傳 JSON（選用；沒給用 CONFIG 的 3,000）")
    ap.add_argument("--today", help="YYYY-MM-DD（台北）；不給就用今天")
    ap.add_argument("--out", help="完整 JSON 寫到這個檔案")
    ap.add_argument("--brief", action="store_true", help="印精簡文字；不給就印 JSON")
    a = ap.parse_args(argv)
    today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(TPE).date()
    # --dca 給了但檔案讀不到（帳本讀取失敗）時當成空表：用預設金額並在 warnings 註明
    dca_obj = (read_json(a.dca) or {}) if a.dca else None
    o = compute(read_json(a.holdings), read_json(a.trades), today, prices(a.data, today), closed_days(a.data), dca_obj)
    sys.stdout.reconfigure(encoding="utf-8")
    text = json.dumps(o, ensure_ascii=False)
    if a.out:
        pathlib.Path(a.out).write_text(text, encoding="utf-8")
    print(brief(o) if a.brief else text)


if __name__ == "__main__":
    main()
