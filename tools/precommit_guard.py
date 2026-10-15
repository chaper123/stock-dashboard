"""提交前檢查：擋下私密檔案與金鑰，避免推上公開 repo。

由 .githooks/pre-commit 呼叫（git config core.hooksPath .githooks）。只用 Python 標準庫。
檢查這次要提交的檔案：
  1. 路徑：private/、.env、憑證或服務帳戶檔、金鑰檔
  2. 內容：GitHub token、Google API 金鑰與 OAuth token、Anthropic 金鑰、私鑰、服務帳戶 JSON
發現問題就列出並以代碼 1 結束（提交被擋下）。
"""
import re
import subprocess
import sys

SELF = "tools/precommit_guard.py"

BLOCKED_PATHS = [
    (re.compile(r"(^|/)private/"), "private/ 只放本機私密檔案"),
    (re.compile(r"(^|/)\.env($|\.)"), "環境變數檔"),
    (re.compile(r"credentials.*\.json$|service[-_]?account.*\.json$", re.I), "憑證或服務帳戶檔"),
    (re.compile(r"\.(pem|key|p12|pfx)$", re.I), "金鑰檔"),
]

SECRETS = [
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"), "GitHub token"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{22,}"), "GitHub fine-grained token"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{35}"), "Google API 金鑰"),
    (re.compile(r"ya29\.[0-9A-Za-z_\-]{20,}"), "Google OAuth token"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "Anthropic API 金鑰"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "私鑰"),
    (re.compile(r'"type"\s*:\s*"service_account"'), "Google 服務帳戶 JSON"),
]


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, check=True).stdout


def staged_files():
    out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    return [p for p in out.decode("utf-8").split("\0") if p]


def main():
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    problems = []
    for path in staged_files():
        for rx, why in BLOCKED_PATHS:
            if rx.search(path):
                problems.append(f"{path}：{why}")
        if path == SELF:
            continue
        blob = git("show", f":{path}")
        if b"\0" in blob[:8000]:
            continue  # 二進位檔不檢查內容
        text = blob.decode("utf-8", errors="replace")
        for rx, why in SECRETS:
            if rx.search(text):
                problems.append(f"{path}：疑似含 {why}")
    if problems:
        print("提交被擋下（tools/precommit_guard.py）：", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print("請取消暫存這些檔案（git reset -- <檔案>），或拿掉金鑰後再提交。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
