# 進度

> 新 session 先讀這份（現況、待辦、注意事項）。舊決定與測試細節在 [HISTORY.md](HISTORY.md)，要查時用搜尋找相關段落，不要整份讀。
> 每次 commit 一起更新。這份保持精簡：做完的事在這裡只留一兩句，細節寫進主題文件（見文件地圖）或接在 HISTORY.md 最後面。程式註解裡的「PROGRESS.md 第 N 項」指 HISTORY.md 的編號。

最後更新：2026-11-11

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 現在在跑的東西
- **新聞晨報 v4.1**（claude.ai 雲端排程，平日 08:40 晨間、11:30 午間）：讀 market-data 的標題清單與資料、共用帳本（只讀）、私人持股 repo（只讀），寫「儀表板資料」試算表的「新聞」分頁並推播。2026-11-10 上線，做法與測試見 [NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 13 節；排程 ID、提示詞、退回 v4 的設定在 `private/routines/v41/README.md`。engine 釘選 stock-dashboard 3a59b67（`engine/news_select.py`、`discipline.py`、`fund_moves.py`）。
- 舊的美股、台股兩個買點晨報 2026-11-03 停用（轉型，見 [PIVOT.md](PIVOT.md)）。
- **market-data**（公開）：GitHub Actions 抓行情、新聞標題、總經、法人、行事曆，cron-job.org 觸發（fetch 06:15、news 08:20、11:10 等），狀態看 `data/meta.json`。台股不再程式抓證交所／櫃買網站（改 FinMind＋OpenAPI）；盤中價由網站在使用者瀏覽器用富果查（金鑰只在使用者裝置）。
- **market-data-private**（私人，本機 `C:\market-data-private`）：00981A、009816 每日持股。投信網站不得轉載，所以不放公開 repo；公開的「新聞」分頁不能寫股數、權重、排名、檔數。
- **網站**（GitHub Pages，純靜態，八頁：總覽、新聞、持倉、K 線、分析、資金、報告、記帳）：記帳透過帳本綁定的 Apps Script 寫入（[LEDGER_WRITE.md](LEDGER_WRITE.md)、[LEDGER_CONSISTENCY.md](LEDGER_CONSISTENCY.md)）。第三方改進報告第 A、B、C 批與 R02 已上線（[IMPROVE.md](IMPROVE.md)）。線上 sw.js 2026-11-08-2。
- **試算表**：「儀表板資料」（排程寫入；正式「新聞」gid 5、「測試_新聞」gid 4）；共用帳本（Claude 只讀，網站記帳寫入）。ID 在提示詞裡。
- **使用者的投資規則**：每月 6 日照帳本「定投金額」投入台股 009816 80%、00981A 20%；4、10 月檢查，偏離超過 5 個百分點才整筆補偏低的一檔；美股 VOO、GOOGL 保留、不加碼。所有輸出都是依規則的訊號，不是投資建議。

## 待辦
1. **v4.1 後續**（11/11 第一次正式執行兩次都成功、網站新聞頁正常，結果見 [NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 13 節）：
   - 晨間 CMoney 同學風向每天卡 5 分鐘網址權限、拿不到資料（網址不在搜尋結果裡）。要改提示詞（先搜尋再開、拿掉這一步，或試 trigger 的 `user_declared_urls`），等使用者決定；改之前照規則先同意、先測試 run。
   - 還沒遇到實際情況的兩條：費半漲跌在 3%～5% 之間（不該用大波動日格式）、時間窗內有 Fed 例行核准（該略過並在摘要註明）。遇到那天再看一次執行紀錄。
   - 下次改提示詞時一起修的小瑕疵：話題列理由的相對時間（「今天」「這兩天」）、總經總結的「外資連 5 天賣超」（資料只有 5 個交易日，實際連 9 天）。
2. **設計改版（IMPROVE 的 R15～R18、D01～D08）**：第一階段方案與首頁示意在分支 `claude/fervent-merkle-1607ac`（cacbefe：docs/DESIGN.md、site/preview-home.html、site/css/v2.css、site/js/pages/home_v2.js），沒有 push、沒有合併。等使用者看過，使用者說要合併才合併。
3. **機會頁**（INSIGHTS 第 4 批，含晨報的「機會觀察」）：預備金與加碼級距由使用者決定，不預設。
4. 較小、不急：
   - PIVOT 寫的「檢查後偏離仍超過 5 個百分點時，之後每月入金繼續補到回到 ±5 內」網站與 `discipline.py` 都還沒做，2027/04 前決定。
   - MoneyDJ 美股日線 11/07 起只回 1 根，market-data 的 `vote_daily` 改用 Yahoo 當歷史主來源，觀察會不會持續。
   - 新聞正式版穩定後，`site/js/config.js` 的 `NEWS_TABS` 拿掉「測試_新聞」（gid 4）。
   - Phase 4（網站）等使用者確認後打 tag。PLAN 的 Phase 3（跨市場配置器）、5、6 尚未開始；2026-10-30 轉型成只管台股後要不要做，還沒決定。

## 注意事項
- 改 claude.ai 排程前先取得同意、先用一次性測試 run 比對。RemoteTrigger update 要送完整 job_config（含 environment_id、events 的 uuid），不給 mcp_connections 就不會動到連接器；改完讀回，用程式比對提示詞（回應很大，存成檔案時直接讀檔，沒存成檔案就從 session 的對話紀錄 jsonl 取出）。
- 排程裡 WebFetch 只開這次 WebSearch 結果裡的網址，直接開檔案或清單裡的網址可能要使用者核准、5 分鐘後被收回；allowed_domains 不放 reuters.com、apnews.com（整次搜尋會被拒）。
- 排程被使用者的每週額度擋下時會中途停止，不是程式問題。
- 本機 Git Bash 沒有時區資料：`TZ=Asia/Taipei date` 會被當成 UTC；台北時間用 `py -3.14` 搭 zoneinfo。
- 投信網站的憑證在 Python 3.13 以上會被擋，抓持股固定用 3.12。
- push 到 main 時，只有 `site/**` 有改才會部署 Pages（docs 不會）；網站改動要使用者確認後才部署，改 site 檔案時一起更新 `site/sw.js` 的 `VERSION`。

## 文件地圖
- [PLAN.md](PLAN.md)：原始規劃（Phase 0～6）。[PIVOT.md](PIVOT.md)：2026-10-30 轉型（只管台股 80／20）。[INSIGHTS.md](INSIGHTS.md)：長期投資人資訊改版（4 批，第 1～3 批已做）。
- [IMPROVE.md](IMPROVE.md)：第三方改進報告 R01～R20、D01～D08 與批次狀態。[NEWS_ROUTINE.md](NEWS_ROUTINE.md)：新聞排程 v1～v4.1。
- [LEDGER_WRITE.md](LEDGER_WRITE.md)、[LEDGER_CONSISTENCY.md](LEDGER_CONSISTENCY.md)：網站記帳。[DATA_SOURCES.md](DATA_SOURCES.md)：資料來源。[BACKTEST.md](BACKTEST.md)：買點規則回測。[ROUTINE_V2.md](ROUTINE_V2.md)：舊晨報 v2（已停用）。
- [HISTORY.md](HISTORY.md)：2026-10-16～11-10 完整進度紀錄（Phase 0～4 的勾選清單也在裡面）。
- 私人（不進 git）：`private/routines/`——各版提示詞、`routines.json`、每版一個資料夾（v3、v4、v41）的 README 記排程 ID、測試與上線紀錄。

## Phase 狀態
- Phase 0 基礎建設（tag v0.1）、Phase 1 強化資料、Phase 2 排程結構化輸出：勾選項目都已完成。
- Phase 4 網站：2026-10-27 上線，持續改版中，還沒打 tag。
- Phase 3、5、6：尚未開始。
