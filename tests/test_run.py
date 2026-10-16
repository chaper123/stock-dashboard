"""engine/run.py：不改 monitor 的輸出、精簡 JSON 的欄位與黃金檔、試算表列、命令列用法。"""
import contextlib
import datetime as dt
import hashlib
import json

import pytest

from helpers import CASES, ENGINE, FIX, GOLDEN, compact_case, load_module, run_script


@pytest.fixture(scope="module")
def run():
    return load_module("run.py", "engine_run")


def build(run, name):
    script, config = CASES[name]
    market = "us" if script == "monitor_us.py" else "tw"
    cfg = json.loads((FIX / config).read_text())
    with contextlib.chdir(FIX):
        text = run.run_monitor(market, cfg)
    now = dt.datetime(2026, 10, 16, 9, 21, tzinfo=dt.timezone(dt.timedelta(hours=8)))
    return text, run.compact(market, json.loads(text), cfg, now, "test")


@pytest.mark.parametrize("name", sorted(CASES))
def test_wrapper_keeps_monitor_output(run, name):
    """包裝層呼叫 main(cfg) 印出的內容，和直接執行原程式的黃金檔逐字相同。"""
    assert build(run, name)[0] == (GOLDEN / f"{name}.json").read_text(encoding="utf-8")


@pytest.mark.parametrize("name", sorted(CASES))
def test_compact_golden(name):
    assert compact_case(name) == (GOLDEN / f"compact_{name}.json").read_text(encoding="utf-8")


@pytest.mark.parametrize("name", sorted(CASES))
def test_compact_invariants(run, name):
    text, c = build(run, name)
    script, _ = CASES[name]
    assert c["schema_version"] == 1 and c["generated_at"] == "2026-10-16T09:21:00+08:00"
    assert c["engine"] == {"monitor": script, "ref": "test",
                           "sha256": hashlib.sha256((ENGINE / script).read_bytes()).hexdigest()}
    assert c["data_date"] == "2026-10-15"
    assert sum(t["amount_twd"] for t in c["tickers"]) == c["total_twd"] <= c["cap_twd"]
    assert {t["level"] for t in c["tickers"]} <= set(run.LEVELS.values())
    full = json.loads(text)
    assert [t["code"] for t in c["tickers"]] == list((full.get("tickers") or full.get("etfs")).keys())
    for t in c["tickers"]:
        if t["level"] not in ("starter", "z1", "z2", "z3"):
            assert t["amount_twd"] == 0
        assert set(t["zones"]) <= {"starter", "z1", "z2", "z3"}


def test_levels_cover_every_status(run):
    us = load_module("monitor_us.py")
    statuses = set(us.NAMES.values()) | {"暫停", "等待（趨勢轉弱，不接刀）", "市場指標", "觀察（不給金額）",
                                         "趨勢起始倉", "等待（趨勢轉弱）"}
    assert statuses == set(run.LEVELS)


def test_compact_us_values(run):
    _, c = build(run, "us_20261015_repo_val")
    t = {x["code"]: x for x in c["tickers"]}
    assert (t["GOOGL"]["level"], t["GOOGL"]["amount_twd"], t["GOOGL"]["amount_usd"]) == ("z1", 516, 15.97)
    assert (t["NVDA"]["status"], t["NVDA"]["level"], t["NVDA"]["event"]) == ("暫停", "block", "block")
    assert (t["SPCX"]["level"], t["SPCX"]["event"]) == ("wait", "boost")
    assert (t["IAUM"]["level"], t["ARKK"]["level"]) == ("gauge", "watch")
    assert t["GOOGL"]["zones"]["z1"] == [340.57, 349.27]
    assert c["fx"]["rate"] == 32.315 and (c["pool_twd"], c["cap_twd"], c["total_twd"]) == (2580, 1032, 516)


def test_compact_tw_values(run):
    _, c = build(run, "tw_20261016")
    t = {x["code"]: x for x in c["tickers"]}
    assert (t["00981A"]["status"], t["00981A"]["level"], t["00981A"]["amount_twd"]) == ("趨勢起始倉", "starter", 357)
    assert (t["00981A"]["held"], t["00981A"]["premium"], t["00981A"]["price"], t["00981A"]["close"]) == (
        True, 1.0, 29.75, 29.4)
    assert (c["pool_twd"], c["cap_twd"], c["total_twd"]) == (2580, 1548, 1547)
    assert c["idle_reminder"] == {"days": 1, "pool": 2580, "alert": False}
    assert t["00411A"]["zones"] == {"starter": [10.52, 10.94], "z1": [10.41, 10.64], "z2": [9.35, 9.57]}


def test_unknown_status_raises(run):
    text, _ = build(run, "tw_20261016")
    full = json.loads(text)
    full["etfs"]["009816"]["status"] = "新狀態"
    cfg = json.loads((FIX / "config_tw.json").read_text())
    with pytest.raises(ValueError, match="未知的狀態"):
        run.compact("tw", full, cfg, dt.datetime.now(dt.timezone.utc))


def test_us_level_mismatch_raises(run):
    text, _ = build(run, "us_20261015")
    full = json.loads(text)
    full["tickers"]["GOOGL"]["level"] = "z3"
    cfg = json.loads((FIX / "config_us.json").read_text())
    with pytest.raises(ValueError, match="不一致"):
        run.compact("us", full, cfg, dt.datetime.now(dt.timezone.utc))


@pytest.mark.parametrize("name", ["us_20261015", "tw_20261016"])
def test_sheet_rows(run, name):
    _, c = build(run, name)
    rows = run.sheet_rows(c)
    assert len(rows["archive_row"]) == len(rows["archive_header"])
    assert json.loads(rows["archive_row"][8]) == c
    assert rows["archive_row"][4] == "test@" + c["engine"]["sha256"][:12]
    assert len(rows["plan_rows"]) == len(c["tickers"])
    assert all(len(r) == len(rows["plan_header"]) for r in rows["plan_rows"])
    first = rows["plan_rows"][0]
    assert first[:4] == ["2026-10-16T09:21:00+08:00", c["market"], "2026-10-15", c["tickers"][0]["code"]]


def test_sheet_rows_formats(run):
    _, c = build(run, "tw_20261016")
    r = {x[3]: x for x in run.sheet_rows(c)["plan_rows"]}
    h = run.PLAN_HEADER
    assert r["00981A"][h.index("第一買區")] == "30.22～31.04"
    assert r["00981A"][h.index("估值或溢價")] == "溢價 1.0%"
    assert r["00981A"][h.index("原因")] == "最近溢價1.00% ≥ 1.0%：降一級"
    assert r["00411A"][h.index("深度買區")] == ""


def test_cli(tmp_path):
    full, rows = tmp_path / "full.json", tmp_path / "rows.json"
    out = run_script([ENGINE / "run.py", "us", FIX / "config_us.json", "--full", full, "--rows", rows,
                      "--ref", "v-test"])
    assert out.count("\n") == 1
    c = json.loads(out)
    ts = dt.datetime.fromisoformat(c["generated_at"])
    assert ts.utcoffset() == dt.timedelta(hours=8)
    assert abs((dt.datetime.now(dt.timezone.utc) - ts).total_seconds()) < 120
    assert c["engine"]["ref"] == "v-test" and c["market"] == "us"
    assert full.read_bytes() == (GOLDEN / "us_20261015.json").read_bytes()
    r = json.loads(rows.read_text(encoding="utf-8"))
    assert json.loads(r["archive_row"][8]) == c and len(r["plan_rows"]) == 10


def test_cli_tw_without_options():
    c = json.loads(run_script([ENGINE / "run.py", "tw", FIX / "config_tw.json"]))
    assert c["engine"]["ref"] is None and c["total_twd"] == 1547
