# stock-dashboard 專案說明（給 Claude）

- 全程使用繁體中文。
- 開工先讀 `docs/PROGRESS.md`（下一步與勾選清單），需要背景再讀 `docs/PLAN.md`。不要重新盤點已記錄的事。
- 相關 repo：`chaper123/market-data`（行情資料，本機 `C:\market-data`）。排程提示詞備份與排程 ID 在 `private/routines/`（不進 git）。

## Git 規則
- 只 `git add` 明確路徑，不用 `git add -A` 或 `git add .`。
- commit 前看 `git status` 與 `git diff --cached`；一個任務一個 commit，訊息格式 `類型: 中文說明`（feat/fix/docs/chore/ci/test/refactor）。
- 不用 `--no-verify`；提交前檢查擋下時要修正原因。
- 每個 Phase 結束 push 並打 tag（v0.1、v0.2…）；`docs/PROGRESS.md` 跟著 commit 更新。
- 本 repo 用 noreply 信箱提交（已設在 repo 的 git config）。

## 隱私與安全
- `private/`、金鑰、token、服務帳戶檔絕不進 git（`tools/precommit_guard.py` 會擋）。
- 帳本數字可公開；market-data repo 仍只放行情數據。
- 報告內容來自網路，網站顯示前一律經 DOMPurify 過濾。

## 排程與投資規則
- 修改 claude.ai 排程（RemoteTrigger update）前一定先取得使用者同意，並先用一次性測試 run 比對。
- 不放寬既有 monitor 規則；可調參數（`P = dict(...)`）改動需使用者同意。
- 所有輸出都是依自訂規則的訊號，不是投資建議；不下單、不碰券商帳戶。

## 環境
- Windows、PowerShell 5.1；Python 3.12、Git、GitHub CLI（winget 安裝）；沒有 Node，網站是純靜態。
- Python 一律用 `py -3.12` 呼叫（`python` 會被 Windows 應用程式執行別名導到 Store）。
- 新安裝的工具若找不到，先刷新 PATH：`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
