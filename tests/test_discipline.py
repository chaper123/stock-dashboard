"""engine/discipline.py：台股配置紀律（已投入判定、比例與偏離、建議分配、檢查月、月底、休市、連續投入月數）。"""
import datetime as dt
import json
import subprocess
import sys

import pytest

from helpers import ENGINE, load_module

dp = load_module("discipline.py", "engine_discipline")

HOLD_HEAD = ["市場", "代號", "名稱", "股數（券商確認）", "總成本（原幣，含費）", "幣別", "平均成本", "交易紀錄股數",
             "股數差異", "確認日", "來源"]
TRADE_HEAD = ["日期", "市場", "代號", "買賣", "股數", "成交價", "幣別", "手續費", "交割金額（原幣，含費）",
              "匯率（USD/TWD）", "台幣金額", "計入資金池", "台幣金額來源", "備註"]


def hold(*rows):
    return {"values": [HOLD_HEAD] + [["台股" if c[0].isdigit() else "美股", c, "", f"{s:,}", "", "", "", "", "", "", ""]
                                     for c, s in rows]}


def trade(date, code, shares, price, twd="", market="台股", side="買進", settle=""):
    return [date, market, code, side, str(shares), str(price), "TWD" if market == "台股" else "USD", "", settle, "", twd,
            "是", "", ""]


# 帳本 2026-10-30 的實際格式（數字照抄）
LEDGER_HOLD = {"values": [HOLD_HEAD,
                          ["台股", "009816", "凱基台灣TOP50", "979", "13,344.00", "TWD", "13.63", "979", "0", "2026-10-15", "x"],
                          ["美股", "GOOGL", "Alphabet A", "0.1826", "62.10", "USD", "340.09", "0.1826", "0", "2026-10-13", "x"],
                          ["美股", "VOO", "先鋒標普500 ETF", "0.1262", "82.40", "USD", "652.93", "0.1262", "0", "2026-10-13", "x"],
                          ["台股", "00981A", "主動統一台股增長", "101", "2,986.00", "TWD", "29.56", "101", "0", "2026-10-29", "x"]]}
LEDGER_TRADES = {"values": [TRADE_HEAD,
                            ["2026-04-08", "台股", "009816", "買進", "89", "11.19", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-04-13", "台股", "009816", "買進", "123", "11.39", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-04-17", "美股", "VOO", "買進", "0.1262", "652.35", "USD", "0.07", "82.40", "", "", "否", "", ""],
                            ["2026-05-07", "台股", "009816", "買進", "213", "14.13", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-05-18", "台股", "009816", "買進", "49", "13.58", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-06-08", "台股", "009816", "買進", "207", "14.48", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-07-29", "台股", "009816", "買進", "220", "13.65", "TWD", "", "", "", "", "否", "未提供", ""],
                            ["2026-09-29", "美股", "GOOGL", "買進", "0.1826", "339.81", "USD", "0.05", "62.10", "", "", "否", "", ""],
                            ["2026-10-13", "台股", "00981A", "買進", "28", "31.12", "TWD", "1.00", "872.00", "", "872", "是", "", ""],
                            ["2026-10-15", "台股", "009816", "買進", "78", "16.26", "TWD", "1.00", "1,269.00", "", "1,269", "是", "", ""],
                            ["2026-10-15", "台股", "00981A", "買進", "43", "29.73", "TWD", "1.00", "1,279.00", "", "1,279", "是", "", ""],
                            ["2026-10-29", "台股", "00981A", "買進", "30", "27.83", "TWD", "1.00", "835.00", "", "835", "是", "", ""]]}


@pytest.fixture
def data(tmp_path):
    (tmp_path / "tw_009816_norm.csv").write_text("2026-10-28,1,16.1,16.2,16.0,16.17\n2026-10-29,1,16.1,16.2,16.0,16.02\n",
                                                 encoding="utf-8")
    (tmp_path / "tw_00981A_norm.csv").write_text("2026-10-28,1,28.6,28.7,28.5,28.65\n2026-10-29,1,28,28,27.8,27.87\n",
                                                 encoding="utf-8")
    (tmp_path / "calendar.json").write_text(json.dumps({"tw_market": {"closed": ["2026-10-26", "2026-12-25"]}}),
                                            encoding="utf-8")
    return tmp_path


def run(data, holdings, trades_rows, today):
    t = trades_rows if isinstance(trades_rows, dict) else {"values": [TRADE_HEAD] + trades_rows}
    d = dt.date.fromisoformat(today)
    return dp.compute(holdings, t, d, dp.prices(data, d), dp.closed_days(data))


def test_ledger_october(data):
    o = run(data, LEDGER_HOLD, LEDGER_TRADES, "2026-10-30")
    assert (o["month"], o["should_invest"], o["invested"], o["is_invested"]) == ("2026-10", 3000, 4255, True)
    assert o["holdings"]["009816"] == {"shares": 979.0, "price": 16.02, "price_source": "收盤 2026-10-29", "value": 15684}
    assert o["holdings"]["00981A"]["value"] == round(101 * 27.87)
    assert o["ratio_pct"] == {"009816": 84.78, "00981A": 15.22} and o["deviation_pp"] == 4.78
    assert not o["needs_rebalance"] and o["underweight"] == "00981A" and o["is_check_month"]
    assert o["plan"] == {"mode": "normal", "amounts": {"009816": 2400, "00981A": 600}, "note": "照 80／20"}
    assert o["bought_by_code"] == {"009816": 1269, "00981A": 2986}
    assert o["remaining_plan"] == {"009816": 1131, "00981A": 0}
    assert o["next_check"] == "2027-04-06" and o["streak_months"] == 1 and o["streak_list"] == ["2026-10"]
    assert o["is_last_trading_day"] and o["last_trading_day"] == "2026-10-30" and not o["remind_not_invested"]
    assert o["off_plan_buys"] == [] and o["warnings"] == []


def test_twd_amount_fallbacks():
    tr = dp.trades({"values": [TRADE_HEAD,
                               trade("2026-11-07", "009816", 100, 16.2, twd="1,621"),
                               trade("2026-11-08", "009816", 50, 16.0, settle="801.00"),
                               trade("2026-11-09", "00981A", 20, 28.0)]})
    assert [(t["twd"], t["twd_source"]) for t in tr] == [(1621.0, "台幣金額"), (801.0, "交割金額"), (560, "股數×成交價")]


def test_not_invested_mid_month(data):
    o = run(data, LEDGER_HOLD, LEDGER_TRADES["values"][1:] + [trade("2026-11-07", "009816", 60, 16.5, twd="991")],
            "2026-11-20")
    assert (o["invested"], o["is_invested"], o["remind_not_invested"]) == (991, False, False)
    assert o["remaining_plan"] == {"009816": 1409, "00981A": 600}
    assert o["streak_months"] == 1 and o["streak_list"] == ["2026-10"]   # 本月還沒結束：從上個月往前數


def test_last_trading_day_reminder_and_holiday(data):
    cal = {"tw_market": {"closed": ["2026-11-30"]}}                       # 11/30（一）休市 → 最後交易日 11/27（五）
    (data / "calendar.json").write_text(json.dumps(cal), encoding="utf-8")
    o = run(data, LEDGER_HOLD, [trade("2026-11-07", "009816", 60, 16.5, twd="991")], "2026-11-27")
    assert o["last_trading_day"] == "2026-11-27" and o["is_last_trading_day"] and o["remind_not_invested"]
    o = run(data, LEDGER_HOLD, [trade("2026-11-07", "009816", 60, 16.5, twd="991")], "2026-11-30")
    assert not o["is_trading_day"] and not o["is_last_trading_day"] and not o["remind_not_invested"]
    assert o["streak_months"] == 0                                        # 本月已結束、沒有投入


def test_month_end_on_weekend():
    assert dp.last_trading_day(2026, 10, set()) == dt.date(2026, 10, 30)  # 10/31 是週六
    assert dp.last_trading_day(2026, 5, set()) == dt.date(2026, 5, 29)    # 5/30、31 週末
    assert dp.last_trading_day(2026, 12, {"2026-12-31"}) == dt.date(2026, 12, 30)


def test_plan_day_and_deposit_day(data):
    assert dp.plan_day(2026, 12) == dt.date(2026, 12, 7)                  # 12/6 是週日
    assert dp.plan_day(2026, 11) == dt.date(2026, 11, 6)
    o = run(data, LEDGER_HOLD, LEDGER_TRADES, "2026-12-07")
    assert o["is_plan_day"] and not o["is_deposit_day"] and o["deposit_day"] == "2026-12-06"
    o = run(data, LEDGER_HOLD, LEDGER_TRADES, "2026-11-06")
    assert o["is_plan_day"] and o["is_deposit_day"]


@pytest.mark.parametrize("today,want", [("2026-04-06", "2026-04-06"), ("2026-07-01", "2026-10-06"),
                                        ("2026-10-07", "2027-04-06"), ("2026-01-02", "2026-04-06")])
def test_next_check(today, want):
    assert dp.next_check(dt.date.fromisoformat(today)).isoformat() == want


def test_check_month_over_threshold_rebalances(data):
    h = hold(("009816", 1000), ("00981A", 50))       # 16,020 對 1,394：核心 92%
    o = run(data, h, [], "2027-04-06")
    assert o["needs_rebalance"] and o["underweight"] == "00981A" and o["is_check_month"]
    assert o["plan"]["mode"] == "rebalance" and o["plan"]["amounts"] == {"009816": 0, "00981A": 3000}
    assert "全部補 00981A" in o["plan"]["note"]


def test_check_month_core_underweight(data):
    h = hold(("009816", 500), ("00981A", 200))       # 8,010 對 5,574：核心 59%
    o = run(data, h, [], "2026-10-12")
    assert o["deviation_pp"] < -5 and o["underweight"] == "009816"
    assert o["plan"]["amounts"] == {"009816": 3000, "00981A": 0}


def test_over_threshold_outside_check_month_keeps_80_20(data):
    h = hold(("009816", 1000), ("00981A", 50))
    o = run(data, h, [], "2026-11-10")
    assert o["needs_rebalance"] and not o["is_check_month"]
    assert o["plan"]["mode"] == "normal" and o["plan"]["amounts"] == {"009816": 2400, "00981A": 600}
    assert "不在檢查月" in o["plan"]["note"] and "2027-04-06" in o["plan"]["note"]


def test_exactly_threshold_is_not_over(data):
    h = hold(("009816", 1000), ("00981A", 1))
    o = dp.compute(h, {"values": [TRADE_HEAD]}, dt.date(2026, 10, 12), {"009816": (85.0, "x"), "00981A": (1500.0, "x")},
                   set())                            # 85,000 對 1,500 → 98.27%（超過）
    assert o["needs_rebalance"]
    o = dp.compute(hold(("009816", 85), ("00981A", 15)), {"values": [TRADE_HEAD]}, dt.date(2026, 10, 12),
                   {"009816": (10.0, "x"), "00981A": (10.0, "x")}, set())   # 85% → 偏離 5.00，不算超過
    assert o["deviation_pp"] == 5.0 and not o["needs_rebalance"] and o["plan"]["mode"] == "normal"


def test_intraday_price_preferred_when_today(data):
    (data / "intraday.json").write_text(json.dumps({"quotes": {
        "009816": {"data_date": "2026-10-30", "time": "2026-10-30 11:19:40", "price": 16.3, "price_field": "z",
                   "is_today": True},
        "00981A": {"data_date": "2026-10-29", "time": "2026-10-29 13:30:00", "price": 27.0, "price_field": "z",
                   "is_today": False}}}), encoding="utf-8")
    px = dp.prices(data, dt.date(2026, 10, 30))
    assert px["009816"] == (16.3, "盤中 11:19（z）") and px["00981A"] == (27.87, "收盤 2026-10-29")


def test_off_plan_buys_and_us_ignored(data):
    rows = [trade("2026-11-07", "0050", 10, 60.0, twd="601"), trade("2026-11-08", "009816", 100, 16.0, twd="1,601"),
            trade("2026-11-09", "VOO", 0.1, 700, market="美股", settle="70.00")]
    o = run(data, LEDGER_HOLD, rows, "2026-11-20")
    assert o["invested"] == 2202 and o["off_plan_buys"] == [{"date": "2026-11-07", "code": "0050", "twd": 601.0}]


def test_missing_price_warns(data):
    (data / "tw_00981A_norm.csv").unlink()
    o = run(data, LEDGER_HOLD, LEDGER_TRADES, "2026-10-30")
    assert o["ratio_pct"] == {"009816": None, "00981A": None} and o["deviation_pp"] is None
    assert o["warnings"] == ["00981A 沒有價格"] and "價格不足" in dp.brief(o)


def test_cli(data, tmp_path):
    hf, tf, out = tmp_path / "h.json", tmp_path / "t.json", tmp_path / "d.json"
    hf.write_text(json.dumps(LEDGER_HOLD, ensure_ascii=False), encoding="utf-8")
    tf.write_text(json.dumps(LEDGER_TRADES, ensure_ascii=False), encoding="utf-8")
    p = subprocess.run([sys.executable, str(ENGINE / "discipline.py"), "--holdings", str(hf), "--trades", str(tf),
                        "--data", str(data), "--today", "2026-10-30", "--out", str(out), "--brief"], capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    text = p.stdout.decode("utf-8")
    assert "【本月紀律】2026-10：應投入 3,000，已投入 4,255（≥ 2,700，已完成）" in text
    assert "偏離 +4.78 個百分點" in text and "【下次檢查】2027-04-06；連續投入 1 個月" in text
    assert "是當月最後一個交易日" in text
    o = json.loads(out.read_text(encoding="utf-8"))
    assert o["config"]["target_pct"] == {"009816": 80, "00981A": 20} and o["invested"] == 4255


def test_config_constants():
    c = dp.CONFIG
    assert (c["core"], c["satellite"], c["deposit_day"], c["monthly"], c["check_months"], c["threshold_pp"],
            c["invested_min"], c["market"]) == ("009816", "00981A", 6, 3000, [4, 10], 5, 2700, "台股")
