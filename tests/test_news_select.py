"""engine/news_select.py：新聞晨報候選清單的固定規則（時間窗、對應、必寫事項、排序）。"""
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
    (tmp_path / "00411A.json").write_text(json.dumps({"holdings": [
        {"code": "SPCX US", "weight": 9.6}, {"code": "NVDA US", "weight": 7.7}, {"code": "8996", "weight": 6.2}]}),
        encoding="utf-8")
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


def test_mapping_rules(data):
    out = ns.select(data, NOW)
    ids = {t: {c["id"] for c in lst} for t, lst in out["candidates"].items()}
    assert "id9" not in set().union(*ids.values())          # 時間窗外
    assert "id8" not in set().union(*ids.values())          # 沒有 symbols 也沒有總經主題
    assert "id3" in ids["009816"] and "id3" in ids["00981A"]  # 2330／TSM → 009816 與 00981A
    assert "id4" in ids["00981A"] and "id4" not in ids["009816"]  # 00981A 前十大成分股
    assert "id1" in ids["NVDA"] and "id1" in ids["00411A"]  # 00411A 前五大（去掉 " US"），Tier 2
    assert "id6" in ids["00411A"] and "id5" not in ids["00411A"]  # Tier 4 不另寫到 00411A
    assert "id7" in ids["總經"] and "id10" in ids["總經"]
    assert out["inputs"]["top5_00411A"] == ["8996", "NVDA", "SPCX"]
    assert out["inputs"]["feeds_ok"] == "1/2" and out["inputs"]["items_in_window"] == 9


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


def test_missing_files_are_reported(data):
    (data / "fed.json").unlink()
    out = ns.select(data, NOW)
    assert "fed.json" in out["missing"]
    assert "macro_DXY.csv" in out["missing"]  # 沒放的檔案也列出


def test_cli_brief_and_out(data, tmp_path):
    out_file = tmp_path / "cand.json"
    p = subprocess.run([sys.executable, str(ENGINE / "news_select.py"), "--data", str(data),
                        "--now", "2026-10-23T08:40+08:00", "--out", str(out_file), "--brief"],
                       capture_output=True)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
    text = p.stdout.decode("utf-8")
    assert "【必寫事項】" in text and "【NVDA】" in text and "big_move" in text
    full = json.loads(out_file.read_text(encoding="utf-8"))
    assert set(full) == {"window", "inputs", "missing", "counts", "candidates", "must_cover", "closure_hints"}
