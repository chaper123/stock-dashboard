"""engine 的薄包裝：執行 monitor（本體不改），把輸出轉成精簡 JSON，給報告存檔、試算表與之後的配置器用。

用法（和直接跑 monitor 一樣在放資料的目錄執行，config 的 csv 路徑相對於目前目錄）：
  python3 engine/run.py us config.json [--full monitor_out.json] [--rows rows.json] [--ref v0.2.0]
  python3 engine/run.py tw config.json [--full monitor_out.json] [--rows rows.json] [--ref v0.2.0]
- stdout：精簡 JSON（一行，UTF-8）。
- --full：另存 monitor 原本印出的內容（逐字），報告的表格照舊用它。
- --rows：另存寫入「儀表板資料」試算表用的列（報告存檔一列、配置計畫每檔一列）。
- --ref：engine 的版本（排程下載時用的 tag），記進輸出；不給就是 null。
欄位說明見 engine/README.md。
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
from zoneinfo import ZoneInfo

SCHEMA_VERSION = 1
HERE = pathlib.Path(__file__).resolve().parent
MONITORS = {"us": "monitor_us.py", "tw": "monitor.py"}
# 狀態名稱 → 等級。台股 monitor 只輸出狀態名稱；美股 monitor 在暫停、不接刀、觀察時 level 都是 none，這裡細分
LEVELS = {"追價區（不買）": "overheat", "等待回檔": "wait", "趨勢起始倉": "starter", "第一買區": "z1",
          "第二買區": "z2", "深度買區": "z3", "暫停": "block", "等待（趨勢轉弱）": "weak",
          "等待（趨勢轉弱，不接刀）": "weak", "市場指標": "gauge", "觀察（不給金額）": "watch"}
ZONE_KEYS = ("starter", "z1", "z2", "z3")
ARCHIVE_HEADER = ["產生時間", "市場", "資料日", "schema", "engine", "可用資金(NT$)", "本次上限(NT$)",
                  "規則參考合計(NT$)", "精簡JSON", "報告全文"]
PLAN_HEADER = ["產生時間", "市場", "資料日", "代號", "角色", "狀態", "等級", "規則參考金額(NT$)", "約當(US$)",
               "判定價", "價格日", "距第一買區上緣%", "起始倉區", "第一買區", "第二買區", "深度買區",
               "估值或溢價", "原因"]


def run_monitor(market, cfg):
    """以模組載入 monitor 並呼叫 main(cfg)，回傳它印出的文字（和 python3 monitor.py config.json 相同）。"""
    path = HERE / MONITORS[market]
    spec = importlib.util.spec_from_file_location(f"engine_{market}_monitor", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        mod.main(cfg)
    return buf.getvalue()


def rnd(o):
    if isinstance(o, dict):
        return {k: rnd(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [rnd(v) for v in o]
    if isinstance(o, float):
        return round(o, 4)
    return o


def level_of(market, code, v):
    lv = LEVELS.get(v["status"])
    if lv is None:
        raise ValueError(f"{code}：未知的狀態「{v['status']}」（monitor 改過？要同步更新 run.py）")
    if market == "us" and v["level"] != "none" and v["level"] != lv:
        raise ValueError(f"{code}：狀態「{v['status']}」與 level {v['level']} 不一致")
    return lv


def compact(market, full, cfg, now, ref=None):
    """monitor 輸出（已 json.loads）→ 精簡 dict。now 是 aware datetime。"""
    us = market == "us"
    items = full["tickers"] if us else full["etfs"]
    conf = cfg["tickers"] if us else cfg["etfs"]
    tickers = []
    for code, v in items.items():
        t = dict(code=code, role=v.get("role", "buy"), status=v["status"], level=level_of(market, code, v),
                 amount_twd=v["amount_twd"] if us else v["amount"],
                 price=v["close"] if us else v["price_used"], close=v["close"], date=v["last"],
                 dist_to_z1_pct=v["dist_to_z1_pct"],
                 zones={k: v["zones"][k] for k in ZONE_KEYS if k in v["zones"]},
                 trend=v["trend"], rsi=v["rsi"], why=v["why"], issues=v["issues"])
        if us:
            t.update(amount_usd=v["amount_usd"], chg1=v["chg1"], bias=v["bias50"],
                     valuation=v["valuation"], val_now=v["val_now"], event=conf[code].get("event", "none"))
        else:
            e = conf[code]
            t.update(bias=v["bias_now"], held=bool(e.get("held")), premium=e.get("premium"),
                     intraday=e.get("intraday"), event=e.get("event", "none"))
        tickers.append(t)
    out = dict(schema_version=SCHEMA_VERSION, generated_at=now.isoformat(timespec="seconds"), market=market,
               engine=dict(monitor=MONITORS[market], sha256=hashlib.sha256((HERE / MONITORS[market]).read_bytes())
                           .hexdigest(), ref=ref),
               data_date=max(t["date"] for t in tickers))
    if us:
        out.update(pool_twd=full["pool_twd"], cap_twd=full["cap_twd"], total_twd=full["total_twd"],
                   fx=full["fx"], gauge=full["gauge"], positions=full["positions"])
    else:
        out.update(pool_twd=full["pool"], cap_twd=round(full["pool"] * full["params"]["run_cap"]),
                   total_twd=full["total_suggest"], idle_reminder=full["idle_reminder"])
    out["tickers"] = tickers
    return rnd(out)


def zone_text(z):
    return f"{z[0]}～{z[1]}" if z else ""


def sheet_rows(c):
    """精簡 dict → 試算表的列。報告全文由排程填入 archive_row 最後一格。"""
    ts, mk, day = c["generated_at"], c["market"], c["data_date"]
    eng = (c["engine"]["ref"] or "") + "@" + c["engine"]["sha256"][:12]
    archive = [ts, mk, day, c["schema_version"], eng, c["pool_twd"], c["cap_twd"], c["total_twd"],
               json.dumps(c, ensure_ascii=False, separators=(",", ":")), ""]
    plan = []
    for t in c["tickers"]:
        if mk == "us":
            gate = t["valuation"] + (f" {json.dumps(t['val_now'], ensure_ascii=False)}" if t["val_now"] else "")
        else:
            gate = "溢價未取得" if t["premium"] is None else f"溢價 {t['premium']}%"
        z = t["zones"]
        plan.append([ts, mk, day, t["code"], t["role"], t["status"], t["level"], t["amount_twd"],
                     t.get("amount_usd", ""), t["price"], t["date"],
                     "" if t["dist_to_z1_pct"] is None else round(t["dist_to_z1_pct"], 2),
                     zone_text(z.get("starter")), zone_text(z.get("z1")), zone_text(z.get("z2")),
                     zone_text(z.get("z3")), gate, "；".join(t["why"])])
    return dict(archive_header=ARCHIVE_HEADER, archive_row=archive, plan_header=PLAN_HEADER, plan_rows=plan)


def main(argv=None):
    ap = argparse.ArgumentParser(description="執行 monitor 並輸出精簡 JSON")
    ap.add_argument("market", choices=sorted(MONITORS))
    ap.add_argument("config")
    ap.add_argument("--full")
    ap.add_argument("--rows")
    ap.add_argument("--ref")
    a = ap.parse_args(argv)
    cfg = json.load(open(a.config))
    text = run_monitor(a.market, cfg)
    c = compact(a.market, json.loads(text), cfg, dt.datetime.now(ZoneInfo("Asia/Taipei")), a.ref)
    if a.full:
        pathlib.Path(a.full).write_text(text, encoding="utf-8", newline="")  # 不轉換換行，和 monitor 印出的一樣
    if a.rows:
        pathlib.Path(a.rows).write_text(json.dumps(sheet_rows(c), ensure_ascii=False), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(c, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
