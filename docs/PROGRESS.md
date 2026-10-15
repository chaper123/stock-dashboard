# 進度

> 新 session 先讀這份；細節看 [PLAN.md](PLAN.md)。每次 commit 一起更新。

最後更新：2026-10-16

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 下一步
1. 使用者把共用帳本「發布到網路」（整份文件、CSV），把連結貼給 Claude。
2. Claude 從 Pages 網址實測瀏覽器能否直接讀該 CSV（CORS）；不行就改由 Actions 定時抓。驗收後 Phase 0 打 tag v0.1。
3. 開始 Phase 1：在 market-data 加「來源探測」workflow。

## Phase 0 基礎建設
- [x] 專案移到 `C:\stock-dashboard`（舊的空資料夾被鎖，使用者重開 app 後手動刪）
- [x] winget 安裝 Python 3.12.10、Git 2.55、GitHub CLI 2.102（Python 用 `py -3.12` 呼叫）
- [x] 專案骨架、`.gitignore`、提交前檢查（實測可擋 token 與 private/）
- [x] docs/PLAN.md、docs/PROGRESS.md、CLAUDE.md
- [x] 排程提示詞備份到 private/routines/（不進 git）
- [x] GitHub 登入、建立公開 repo、push（commit 用 noreply 信箱）
- [x] Pages 部署測試頁；線上確認讀得到 market-data meta.json（Actions 已升到最新主版本）
- [x] clone market-data 到 `C:\market-data`
- [ ] 驗證 Google Sheet 發布的 CSV 能被瀏覽器直接讀

## Phase 1 強化資料（market-data）
- [ ] 來源探測 workflow
- [ ] 待探測結果後展開
- 備註：market-data 的 fetch.yml 用 checkout@v4、setup-python@v5，會出現 Node 20 淘汰警告，Phase 1 一起升級。

## Phase 2～6
- [ ] 尚未開始
