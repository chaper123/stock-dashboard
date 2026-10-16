"""黃金測試：用 10/15 收盤快照執行原程式，輸出必須和 tests/golden/ 逐字相同。

失敗代表 engine 的行為變了（程式被改、或 pandas／numpy 版本不同導致數字不同）。
engine 經使用者同意修改後，才用 tests/make_golden.py 重新產生。
"""
import hashlib
import json

import pytest

from helpers import CASES, ENGINE, GOLDEN, run_case

# 從排程提示詞 v1 逐字抽出時的 SHA-256（見 engine/README.md、docs/PROGRESS.md）
ENGINE_SHA256 = {
    "monitor_us.py": "75947691c28c4a2ecbf44781243541bdea0062b3eaab899c1bd63106343951e3",
    "monitor.py": "8c12675c1c9e78a668bd4ea941a7466300cfe39cb24244ab32b8d4e0173e0149",
    "norm.py": "a74e16b958dff887b37aa72115e301d8d336521232acdc7609faee44dc666fc2",
}


@pytest.mark.parametrize("name", sorted(ENGINE_SHA256))
def test_engine_unchanged(name):
    """engine 必須和提示詞 v1 逐字相同；要改規則先取得使用者同意，並同步更新這裡與提示詞。"""
    assert hashlib.sha256((ENGINE / name).read_bytes()).hexdigest() == ENGINE_SHA256[name]


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden(name):
    want = (GOLDEN / f"{name}.json").read_bytes().decode("utf-8")
    assert run_case(name) == want


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden_is_valid_json(name):
    """黃金檔本身要是 JSON（避免存到錯誤訊息）。"""
    json.loads((GOLDEN / f"{name}.json").read_text(encoding="utf-8"))
