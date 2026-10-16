"""從排程提示詞備份逐字抽出 monitor 程式到 engine/，或核對兩者是否逐字相同。

用法：
  py -3.12 tools/extract_engine.py          核對（預設）：engine/*.py 與提示詞裡的程式碼區塊逐字比對，印出 SHA-256
  py -3.12 tools/extract_engine.py --write  抽出：把提示詞裡的程式碼區塊原樣寫進 engine/

提示詞備份在 private/routines/*.v1.prompt.md（不進 git），所以這支只在本機執行。
程式碼區塊的認法：```python 開頭的區塊，前一個非空白行寫著「<檔名>.py（照抄，不要修改）」。
只用 Python 標準庫。
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROMPTS = {
    "us_morning_report.v1.prompt.md": ["monitor_us.py", "norm.py"],
    "tw_etf_morning_report.v1.prompt.md": ["monitor.py"],
}
TITLE = re.compile(r"([\w.]+\.py)（照抄，不要修改）")


def blocks(text):
    """回傳 {檔名: 區塊內容}；內容是 ```python 與 ``` 之間的每一行（含最後一行的換行）。"""
    lines = text.split("\n")
    out, i = {}, 0
    while i < len(lines):
        if lines[i] == "```python":
            j = i - 1
            while j >= 0 and not lines[j].strip():
                j -= 1
            m = TITLE.search(lines[j]) if j >= 0 else None
            # 結尾的 ``` 可能帶 CR（備份檔最後一行是 CRLF），只在找結尾時忽略行尾空白
            k = next(n for n in range(i + 1, len(lines)) if lines[n].rstrip() == "```")
            if m:
                name = m.group(1)
                if name in out:
                    raise SystemExit(f"{name} 出現兩次")
                out[name] = "\n".join(lines[i + 1:k]) + "\n"
            i = k + 1
        else:
            i += 1
    return out


def sha(b):
    return hashlib.sha256(b).hexdigest()


def main(write):
    sys.stdout.reconfigure(encoding="utf-8")
    ok = True
    for prompt, names in PROMPTS.items():
        src = ROOT / "private" / "routines" / prompt
        if not src.exists():
            print(f"找不到 {src.relative_to(ROOT)}（提示詞備份只在本機）")
            return 2
        found = blocks(src.read_bytes().decode("utf-8-sig"))
        if sorted(found) != sorted(names):
            print(f"{prompt}：預期 {names}，找到 {sorted(found)}")
            return 1
        for name in names:
            want = found[name].encode("utf-8")
            dst = ROOT / "engine" / name
            if write:
                dst.parent.mkdir(exist_ok=True)
                dst.write_bytes(want)
            have = dst.read_bytes() if dst.exists() else b""
            same = have == want
            ok &= same
            rows = want.count(b"\n")
            print(f"{'一致' if same else '不一致'}  engine/{name}  {len(want)} bytes  "
                  f"{rows} 行  sha256 {sha(have)}  ← {prompt}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main("--write" in sys.argv[1:]))
