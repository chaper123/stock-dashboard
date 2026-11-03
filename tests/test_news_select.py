"""engine/news_select.py v3：新聞晨報候選清單的固定規則（時間窗、對應、權重、必寫事項、排序、盤中、話題、除息）。"""
import datetime as dt
import json
import subprocess
import sys

import pytest

from helpers import ENGINE, load_module

ns = load_module("news_select.py", "engine_news_select")
TPE = ns.TPE


def item(i, when, title, tier=2, source="Reuters", symbols=(), topics=(), url=None, also=()):
    return {"id": f"id{i}", "published_taipei": when, "source": source, "tier": tier, "title": title,
            "link": f"https://news.google.com/rss/articles/{i}", "url": url, "symbols": list(symbols),
            "topics": list(topics), "also": list(also)}


def bars(rows):
    return "\n".join(f"{d},1000,{c},{c},{c},{c}" for d, c in rows) + "\n"


HOLD_HEAD = ["市場", "代號", "名稱", "股數（券商確認）", "總成本（原幣，含費）", "幣別", "平均成本", "交易紀錄股數",
             "股數差異", "確認日", "來源"]


def holdings_file(path, rows):
    p = path / "holdings.json"
    p.write_text(json.dumps({"range": "'持倉'!A1:K1000", "values": [HOLD_HEAD] + rows}, ensure_ascii=False),
                 encoding="utf-8")
    return p


LEDGER_ROWS = [["台股", "009816", "凱基台灣TOP50", "979", "13,344.00", "TWD", "13.63", "979", "0", "2026-10-15", "x"],
               ["美股", "GOOGL", "Alphabet A", "0.1826", "62.10", "USD", "340.09", "0.1826", "0", "2026-10-13", "x"],
               ["美股", "VOO", "先鋒標普500 ETF", "0.1262", "82.40", "USD", "652.93", "0.1262", "0", "2026-10-13", "x"],
               ["台股", "00981A", "主動統一台股增長", "101", "2,986.00", "TWD", "29.56", "101", "0", "2026-10-29", "x"],
               ["美股", "NVDA", "NVIDIA", "0", "0", "USD", "", "0", "0", "", "已賣出"]]


@pytest.fixture
def data(tmp_path):
    items = [
        item(1, "2026-10-22 21:00", "Nvidia shares fall after new chip export curbs", symbols=["NVDA"],
             topics=["export_controls"], url="https://example.com/nvda"),
        item(2, "2026-10-22 10:00", "Is Nvidia a top AI stock to buy?", source="Yahoo Finance", symbols=["NVDA"]),
        item(3, "2026-10-22 12:00", "台積電法說會上修財測", source="經濟日報", symbols=["2330", "TSM"]),
        item(4, "2026-10-22 13:00", "台光電漲停", source="UDN", symbols=["2383"]),
        item(5, "2026-10-22 14:00", "SpaceX launch delayed", tier=4, source="Blog", symbols=["SPCX"]),
        item(6, "2026-10-22 15:00", "SpaceX wins Pentagon contract", symbols=["SPCX"]),
        item(7, "2026-10-22 16:00", "Fed's Powell signals pause", topics=["fed"]),
        item(8, "2026-10-22 17:00", "Celebrity news without topics"),
        item(9, "2026-10-21 08:00", "Too old to be in the window", symbols=["AAPL"]),
        item(10, "2026-10-22 20:26", "薔琵颱風來襲！台股明天休市一天", source="經濟日報", topics=["taiwan"]),
        item(11, "2026-10-22 22:00", "Anthropic files confidentially for IPO", symbols=["ANTHROPIC"]),
        item(12, "2026-10-22 22:30", "OpenAI raises $40 billion in new funding round"),           # 沒有 symbols：關鍵字
        item(13, "2026-10-22 23:00", "Sam Altman says ChatGPT reached 1 billion users", source="CNBC"),
    ]
    (tmp_path / "headlines.json").write_text(json.dumps({
        "generated_at_taipei": "2026-10-23 08:20", "status": "ok",
        "feeds": [{"name": "a", "ok": True}, {"name": "b", "ok": False}], "items": items}), encoding="utf-8")
    (tmp_path / "fed.json").write_text(json.dumps({"items": [
        {"date": "2026-10-22", "title": "FOMC statement", "link": "https://www.federalreserve.gov/x",
         "type": "press", "published_taipei": "2026-10-23 02:00"}]}), encoding="utf-8")
    (tmp_path / "calendar.json").write_text(json.dumps({
        "tw_market": {"closed": ["2026-10-26"]},
        "earnings": {"symbols": {"TSLA": {"dates": ["2026-10-21"], "is_estimate": False},
                                 "GOOGL": {"dates": ["2026-10-28"], "is_estimate": False}}}}), encoding="utf-8")
    (tmp_path / "00981A.json").write_text(json.dumps({"holdings": [
        {"code": "2330", "weight": 11.3}, {"code": "2383", "weight": 8.2}]}), encoding="utf-8")
    (tmp_path / "macro_SOX.csv").write_text(bars([("2026-10-21", 11505.0), ("2026-10-22", 10732.0)]), encoding="utf-8")
    (tmp_path / "macro_SPX.csv").write_text(bars([("2026-10-21", 7757.0), ("2026-10-22", 7663.0)]), encoding="utf-8")
    (tmp_path / "macro_TNX.csv").write_text(bars([("2026-10-21", 5.146), ("2026-10-22", 4.953)]), encoding="utf-8")
    (tmp_path / "us_SPCX.csv").write_text(bars([("2026-10-21", 159.31), ("2026-10-22", 144.75)]), encoding="utf-8")
    (tmp_path / "us_VOO.csv").write_text(bars([("2026-10-21", 710.7), ("2026-10-22", 702.3)]), encoding="utf-8")
    return tmp_path


NOW = dt.datetime(2026, 10, 23, 8, 40, tzinfo=TPE)


def test_window_start_skips_weekend():
    assert ns.window_start(dt.datetime(2026, 10, 26, 8, 40, tzinfo=TPE)).isoformat() == "2026-10-23T08:40:00+08:00"
    assert ns.window_start(dt.datetime(2026, 10, 28, 9, 0, tzinfo=TPE)).isoformat() == "2026-10-27T08:40:00+08:00"
    assert ns.window_start(dt.datetime(2026, 10, 25, 12, 0, tzinfo=TPE)).isoformat() == "2026-10-23T08:40:00+08:00"


def test_targets_without_00411a():
    assert "00411A" not in ns.TARGETS and "00411A" not in ns.STOCK_MOVE and "00411A" not in ns.INTRADAY_MOVE
    assert ns.TARGETS == ("VOO", "GOOGL", "NVDA", "TSLA", "SPCX", "AAPL", "ANTHROPIC", "OPENAI", "009816", "00981A", "總經")


def test_mapping_rules(data):
    out = ns.select(data, NOW)
    ids = {t: {c["id"] for c in lst} for t, lst in out["candidates"].items()}
    assert "00411A" not in ids
    assert "id9" not in set().union(*ids.values())          # 時間窗外
    assert "id8" not in set().union(*ids.values())          # 沒有 symbols 也沒有總經主題
    assert "id3" in ids["009816"] and "id3" in ids["00981A"]  # 2330／TSM → 兩檔台股
    assert "id4" in ids["00981A"] and "id4" not in ids["009816"]  # 00981A 前十大成分股
    assert "id7" in ids["總經"] and "id10" in ids["總經"]
    assert ids["ANTHROPIC"] == {"id11"}                       # symbols
    assert ids["OPENAI"] == {"id12", "id13"}                  # 標題關鍵字：OpenAI、ChatGPT／Sam Altman
    assert out["inputs"]["feeds_ok"] == "1/2" and out["inputs"]["items_in_window"] == 12
    assert "top5_00411A" not in out["inputs"]


def test_ranking_prefers_substance_over_listicle(data):
    nvda = ns.select(data, NOW)["candidates"]["NVDA"]
    assert [c["id"] for c in nvda] == ["id1", "id2"]
    assert nvda[0]["score"] > nvda[1]["score"] + 30


def test_must_cover(data):
    out = ns.select(data, NOW)
    moves = {m["symbol"]: m for m in out["must_cover"] if m["type"] == "big_move"}
    assert set(moves) == {"SOX", "TNX", "SPCX"}            # SPX −1.2%、VOO −1.2% 未達門檻
    assert moves["SOX"]["change"] == pytest.approx(-6.719, abs=0.01)
    assert moves["TNX"]["unit"] == "百分點" and moves["TNX"]["change"] == pytest.approx(-0.193, abs=1e-3)
    kinds = [(m["type"], m["target"]) for m in out["must_cover"]]
    assert ("earnings", "TSLA") in kinds and ("earnings", "GOOGL") not in kinds
    assert ("fed", "總經") in kinds
    assert ("possible_closure", "009816") in kinds
    assert not any(m["type"] == "tw_closed" for m in out["must_cover"])
    assert out["closure_hints"][0]["title"].startswith("薔琵颱風")


def test_tw_closed_from_calendar(data):
    out = ns.select(data, dt.datetime(2026, 10, 26, 8, 40, tzinfo=TPE))
    assert any(m["type"] == "tw_closed" for m in out["must_cover"])


def test_missing_and_optional_files(data):
    (data / "fed.json").unlink()
    out = ns.select(data, NOW)
    assert "fed.json" in out["missing"]
    assert "macro_DXY.csv" in out["missing"]  # 沒放的檔案也列出
    assert set(out["optional_missing"]) == {"intraday.json", "topics.json", "tw_etf.json"}
    assert "00411A.json" not in out["missing"]
    assert out["topics"] == {"generated_at_taipei": None, "top": [], "rising_terms": []}


# ---------- 持有（帳本） ----------
def test_parse_holdings_from_ledger(tmp_path):
    obj = json.loads(holdings_file(tmp_path, LEDGER_ROWS).read_text(encoding="utf-8"))
    assert ns.parse_holdings(obj) == {"009816", "GOOGL", "VOO", "00981A"}     # NVDA 股數 0 不算持有


@pytest.mark.parametrize("obj,msg", [({"values": []}, "沒有資料"),
                                     ({"values": [["市場", "名稱", "股數（券商確認）"]]}, "代號"),
                                     ({"values": [["市場", "代號", "名稱"]]}, "股數")])
def test_parse_holdings_errors(obj, msg):
    with pytest.raises(ValueError, match=msg):
        ns.parse_holdings(obj)


def test_weights_from_ledger(data, tmp_path):
    out = ns.select(data, NOW, holdings=holdings_file(tmp_path, LEDGER_ROWS))
    f = out["focus"]
    assert f["loaded"] and f["source"] == "帳本持倉"
    assert f["held"] == ["009816", "00981A", "GOOGL", "VOO"] and f["allocation"] == ["009816", "00981A"]
    w = {t: c["weight"] for t, c in out["counts"].items()}
    assert (w["009816"], w["00981A"], w["GOOGL"], w["VOO"], w["NVDA"], w["ANTHROPIC"], w["總經"]) == (3, 3, 2, 2, 1, 1, 1)


def test_default_holdings_when_not_given(data):
    out = ns.select(data, NOW)
    f = out["focus"]
    assert not f["loaded"] and f["held"] == ["009816", "00981A"] and "預設" in f["source"]
    w = {t: c["weight"] for t, c in out["counts"].items()}
    assert (w["009816"], w["GOOGL"], w["VOO"]) == (3, 1, 1)


def test_bad_holdings_file_falls_back(data, tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"values": [["市場", "名稱"]]}), encoding="utf-8")
    out = ns.select(data, NOW, holdings=p)
    assert not out["focus"]["loaded"] and any(m.startswith("bad.json") for m in out["missing"])


# ---------- 時間窗（--since） ----------
def test_since_window_only_after_morning(data):
    h = json.loads((data / "headlines.json").read_text(encoding="utf-8"))
    h["items"].append(item(50, "2026-10-23 10:15", "台股早盤台積電領漲", source="中央社", symbols=["2330"]))
    (data / "headlines.json").write_text(json.dumps(h), encoding="utf-8")
    cal = json.loads((data / "calendar.json").read_text(encoding="utf-8"))
    cal["earnings"]["symbols"]["TSLA"]["dates"] = ["2026-10-22"]      # 台北 10/23 04:00 公布（08:40 前）
    (data / "calendar.json").write_text(json.dumps(cal), encoding="utf-8")
    noon = dt.datetime(2026, 10, 23, 11, 30, tzinfo=TPE)
    morning = ns.select(data, noon)
    assert ("earnings", "TSLA") in [(m["type"], m["target"]) for m in morning["must_cover"]]
    out = ns.select(data, noon, since=dt.datetime(2026, 10, 23, 8, 40, tzinfo=TPE))
    assert out["window"] == {"start": "2026-10-23T08:40+08:00", "end": "2026-10-23T11:30+08:00", "since_given": True}
    assert out["inputs"]["items_in_window"] == 1
    assert {c["id"] for c in out["candidates"]["009816"]} == {"id50"}
    assert not any(m["type"] in ("earnings", "fed") for m in out["must_cover"])   # 08:40 前的財報、Fed 不重複


# ---------- 台股盤中 ----------
def intraday(change_009816=-1.0, change_00981a=-3.2, change_taiex=-2.1, today=True, date="2026-10-23"):
    def q(c):
        return {"data_date": date, "time": f"{date} 11:19:55", "price": 10.0, "price_field": "z",
                "change_pct": c, "is_today": today}
    return {"fetched_at_taipei": f"{date} 11:20:05", "session": "盤中", "is_trading": True,
            "quotes": {"009816": q(change_009816), "00981A": q(change_00981a), "TAIEX": q(change_taiex),
                       "00411A": q(-9.0)}}


def test_intraday_move(data):
    (data / "intraday.json").write_text(json.dumps(intraday()), encoding="utf-8")
    out = ns.select(data, dt.datetime(2026, 10, 23, 11, 30, tzinfo=TPE))
    moves = {m["symbol"]: m for m in out["must_cover"] if m["type"] == "intraday_move"}
    assert set(moves) == {"00981A", "TAIEX"}                         # 009816 −1% 未達 3%；00411A 不看
    assert moves["TAIEX"]["threshold"] == 2.0 and moves["TAIEX"]["target"] == "總經"
    assert moves["00981A"]["change"] == -3.2 and moves["00981A"]["time"] == "2026-10-23 11:19:55"
    slot = next(s for s in out["highlight_slots"] if s["type"] == "intraday_move" and s["ref"]["symbol"] == "TAIEX")
    assert slot["targets"] == ["009816", "00981A"] and slot["priority"] == 1


def test_intraday_stale_snapshot_ignored(data):
    (data / "intraday.json").write_text(json.dumps(intraday(today=False, date="2026-10-22")), encoding="utf-8")
    out = ns.select(data, dt.datetime(2026, 10, 23, 8, 40, tzinfo=TPE))
    assert not any(m["type"] == "intraday_move" for m in out["must_cover"])


# ---------- 市場話題 ----------
def test_topics(data):
    (data / "topics.json").write_text(json.dumps({
        "generated_at_taipei": "2026-10-23 08:20",
        "topics": [{"topic": "tariff", "label": "關稅", "count_1d": 12, "count_7d": 30, "count_30d": 60, "rise": 3.1,
                    "sample_ids": ["id1", "idX"]},
                   {"topic": "fed", "label": "Fed", "count_1d": 5, "count_7d": 20, "count_30d": 80, "rise": 1.2,
                    "sample_ids": ["id7"]},
                   {"topic": "oil", "label": "油價", "count_1d": 1, "count_7d": 2, "count_30d": 9, "rise": None}],
        "rising_terms": [{"term": "CoWoS", "count_1d": 6, "count_30d": 8, "sample_ids": ["id3"]}]}), encoding="utf-8")
    out = ns.select(data, NOW)
    t = out["topics"]
    assert [x["topic"] for x in t["top"]] == ["tariff", "fed"]       # rise 由大到小；rise 不是數字的略過
    assert t["top"][0]["samples"] == [{"id": "id1", "title": "Nvidia shares fall after new chip export curbs",
                                       "source": "Reuters", "time": "2026-10-22 21:00"}]   # 找不到的 id 略過
    assert t["rising_terms"][0]["term"] == "CoWoS" and t["rising_terms"][0]["samples"][0]["id"] == "id3"
    text = ns.brief(out)
    assert "【市場話題】（第一層 2026-10-23 08:20）" in text and "上升詞「CoWoS」" in text


# ---------- 接下來：財報、FOMC、除息 ----------
def test_agenda_and_earnings_timing(data, tmp_path):
    cal = json.loads((data / "calendar.json").read_text(encoding="utf-8"))
    cal["earnings"]["symbols"]["GOOGL"]["dates"] = ["2026-10-23"]   # 今晚美股盤後才公布
    cal["earnings"]["symbols"]["AAPL"] = {"dates": ["2026-10-30"], "is_estimate": False}
    cal["fomc"] = [{"start": "2026-10-22", "end": "2026-10-23"}]
    (data / "calendar.json").write_text(json.dumps(cal), encoding="utf-8")
    out = ns.select(data, NOW, holdings=holdings_file(tmp_path, LEDGER_ROWS))
    ag = {a["symbol"]: a for a in out["agenda"]}
    assert set(ag) == {"GOOGL", "FOMC"}                              # AAPL 10/30 不在今晚／明早
    assert ag["GOOGL"]["when_taipei"] == "2026-10-24 04:00" and ag["FOMC"]["when_taipei"] == "2026-10-24 02:00"
    assert ag["GOOGL"]["weight"] == 2 and "持有" in ag["GOOGL"]["focus"]
    assert ag["FOMC"]["weight"] == 2 and ag["FOMC"]["focus"] == "影響所有部位"
    kinds = [(m["type"], m["target"]) for m in out["must_cover"]]
    assert ("earnings", "GOOGL") not in kinds and ("earnings", "TSLA") in kinds  # 還沒公布的不是必寫


@pytest.mark.parametrize("payload", [
    {"items": [{"code": "009816", "ex_date": "2026-10-23", "amount": 0.25, "pay_date": "2026-11-14"},
               {"code": "00981A", "ex_date": "2026-10-30", "amount": 0.4},
               {"code": "00981A", "ex_date": "2026-11-05", "amount": 0.4},
               {"code": "0056", "ex_date": "2026-10-24", "amount": 1.0}]},
    {"etfs": {"009816": {"events": [{"ex_date": "2026-10-23", "amount": 0.25, "pay_date": "2026-11-14"}]},
              "00981A": [{"ex_date": "2026-10-30", "amount": 0.4}, {"ex_date": "2026-11-05", "amount": 0.4}],
              "0056": {"next_ex_date": "2026-10-24"}}},
])
def test_ex_dividend_within_7_days(data, payload):
    (data / "tw_etf.json").write_text(json.dumps(payload), encoding="utf-8")
    out = ns.select(data, dt.datetime(2026, 10, 23, 11, 30, tzinfo=TPE))
    ex = {(a["symbol"], a["when_taipei"][:10]): a for a in out["agenda"] if a["type"] == "ex_dividend"}
    assert set(ex) == {("009816", "2026-10-23"), ("00981A", "2026-10-30")}  # 今天也算；11/05 超過 7 天；0056 不追蹤
    assert "（今天）" in ex[("009816", "2026-10-23")]["note"] and "發放日 2026-11-14" in ex[("009816", "2026-10-23")]["note"]
    assert ex[("00981A", "2026-10-30")]["weight"] == 3


# ---------- 重點順序、CLI ----------
def test_highlight_slots_order(data, tmp_path):
    cal = json.loads((data / "calendar.json").read_text(encoding="utf-8"))
    cal["earnings"]["symbols"]["GOOGL"]["dates"] = ["2026-10-23"]
    cal["fomc"] = [{"start": "2026-10-22", "end": "2026-10-23"}]
    (data / "calendar.json").write_text(json.dumps(cal), encoding="utf-8")
    slots = ns.select(data, NOW, holdings=holdings_file(tmp_path, LEDGER_ROWS))["highlight_slots"]
    assert slots[0]["weight"] == 3 and set(slots[0]["targets"]) >= {"009816", "00981A"}  # 配置內台股（台積電）最前
    order = [(s["priority"], s["kind"], s.get("id") or s["type"]) for s in slots]
    fomc = next(s for s in slots if s["type"] == "fomc")
    googl = next(s for s in slots if s["type"] == "earnings")
    assert fomc["priority"] == googl["priority"] == 1 and fomc["weight"] == googl["weight"] == 2
    assert slots.index(fomc) < order.index((3, "must_cover", "big_move"))  # 在總經大幅變動之前
    tsmc = [s for s in slots if s.get("id") == "id3"]
    assert len(tsmc) == 1 and set(tsmc[0]["targets"]) == {"009816", "00981A"}  # 同一件事只出現一次
    assert all("recompute" not in s for s in slots)                    # 買區重算已拿掉
    assert any("配置內" in s["focus"] for s in slots)


def test_no_zone_leftovers():
    src = (ENGINE / "news_select.py").read_text(encoding="utf-8")
    for word in ("ZONE_LEVELS", "recompute", "買區", "00411A", "--compact"):
        assert word not in src


def test_cli_brief_and_out(data, tmp_path):
    out_file = tmp_path / "cand.json"
    hold = holdings_file(tmp_path, LEDGER_ROWS)
    p = subprocess.run([sys.executable, str(ENGINE / "news_select.py"), "--data", str(data), "--holdings", str(hold),
                        "--now", "2026-10-23T11:30+08:00", "--since", "2026-10-23T08:40+08:00",
                        "--out", str(out_file), "--brief"], capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    text = p.stdout.decode("utf-8").replace(chr(13) + chr(10), chr(10))  # Windows 的 print 是 CRLF
    assert "（--since）" in text and "【持有】（帳本持倉）" in text and "【市場話題】" in text
    assert "【Anthropic】" in text and "【OpenAI】" in text and "00411A" not in text and "買區" not in text
    full = json.loads(out_file.read_text(encoding="utf-8"))
    assert set(full) == {"window", "inputs", "missing", "optional_missing", "focus", "counts", "filtered", "candidates",
                         "must_cover", "agenda", "highlight_slots", "closure_hints", "topics"}


def test_cli_default_window_without_holdings(data):
    p = subprocess.run([sys.executable, str(ENGINE / "news_select.py"), "--data", str(data),
                        "--now", "2026-10-23T08:40+08:00", "--brief"], capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    text = p.stdout.decode("utf-8").replace(chr(13) + chr(10), chr(10))  # Windows 的 print 是 CRLF
    assert text.startswith("時間窗 2026-10-22T08:40+08:00 ～ 2026-10-23T08:40+08:00\n")
    assert "【必寫事項】" in text and "【NVDA】" in text and "big_move" in text and "預設（未提供帳本持倉" in text
