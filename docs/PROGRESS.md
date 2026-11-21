# 進度

> 新 session 先讀這份（現況、待辦、注意事項）。舊決定與測試細節在 [HISTORY.md](HISTORY.md)，要查時用搜尋找相關段落，不要整份讀。
> 每次 commit 一起更新。這份保持精簡：做完的事在這裡只留一兩句，細節寫進主題文件（見文件地圖）或接在 HISTORY.md 最後面。程式註解裡的「PROGRESS.md 第 N 項」指 HISTORY.md 的編號。

最後更新：2026-11-21

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 現在在跑的東西
- **新聞晨報 v4.2a**（claude.ai 雲端排程，平日 08:40 晨間、11:30 午間）：讀 market-data 的標題清單與資料、共用帳本（只讀）、私人持股 repo（只讀），寫「儀表板資料」試算表的「新聞」分頁並推播。2026-11-16 換成 v4.2（大波動日重點第 1 條多一句機會觀察），2026-11-21 換成 v4.2a（連 N 天數法、allowed_domains 說明、engine 釘選更新）。規劃、測試與上線結果見 [NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 14、16 節；排程 ID、提示詞、退回上一版的設定在 `private/routines/v42/README.md`、`v42a/`。engine 釘選 stock-dashboard 0876bf0（`engine/news_select.py`、`discipline.py`、`fund_moves.py`、`opportunity.py`）。
- 舊的美股、台股兩個買點晨報 2026-11-03 停用（轉型，見 [PIVOT.md](PIVOT.md)）。
- **market-data**（公開）：GitHub Actions 抓行情、新聞標題、總經、法人、行事曆，cron-job.org 觸發（fetch 06:15、news 08:20、11:10 等），狀態看 `data/meta.json`。台股不再程式抓證交所／櫃買網站（改 FinMind＋OpenAPI）；盤中價由網站在使用者瀏覽器用富果查（金鑰只在使用者裝置）。
- **market-data-private**（私人，本機 `C:\market-data-private`）：00981A、009816 每日持股。投信網站不得轉載，所以不放公開 repo；公開的「新聞」分頁不能寫股數、權重、排名、檔數。
- **網站**（GitHub Pages，純靜態，九頁：總覽、持倉、資產、K 線、記帳、分析、新聞、報告、試算）：記帳透過帳本綁定的 Apps Script 寫入（[LEDGER_WRITE.md](LEDGER_WRITE.md)、[LEDGER_CONSISTENCY.md](LEDGER_CONSISTENCY.md)）。第三方改進報告第 A、B、C 批與 R02 已上線（[IMPROVE.md](IMPROVE.md)）。線上 sw.js 2026-11-21-1（持倉頁與總覽加已實現損益；其他入帳與配息卡已上線；總覽近期除權息卡、不配息標的已上線；網站不再讀「測試_新聞」分頁）。
- **試算表**：「儀表板資料」（排程寫入；正式「新聞」gid 5、「測試_新聞」gid 4）；共用帳本（網站記帳透過 Apps Script 寫入；使用者 2026-11-18 同意 Claude 也可以用連接器直接寫，寫前先說、寫完核對；晨報仍只讀）。ID 在提示詞裡。
- **使用者的投資規則**：每月 6 日照帳本「定投金額」投入台股 009816 80%、00981A 20%；4、10 月檢查，偏離超過 5 個百分點才整筆補偏低的一檔；美股 VOO、GOOGL 保留、不加碼。所有輸出都是依規則的訊號，不是投資建議。

## 待辦
1. **v4.2／v4.2a 後續**（[NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 14、16 節）：11/17 第一次正式執行通過（剛好是大波動日，格式與數字都對）。
   - 還沒遇到費半漲跌在 3%～5% 之間的日子（不該用大波動日格式），遇到那天看一次執行紀錄。
   - v4.2a 的「近 N 個交易日」寫法還沒實際出現過（外資或投信一路同方向到檔案第一列才會用到），遇到時看一次執行紀錄；v4.2a 第一次正式執行是 11/23（週一），也看一次。
2. **已完成**：Sonnet 晨報測試（2026-11-19）維持 Opus（[NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 15 節）；v4.2a 2026-11-21 上線（第 16 節）。
3. **設計改版擱置**（使用者 2026-11-11 決定先功能、後美化；使用者沒提就不要主動提）：IMPROVE 的 D01～D08、R16、R17 跟著擱置。
   - 首頁示意在本機分支 `claude/fervent-merkle-1607ac`（工作目錄 `.claude/worktrees/fervent-merkle-1607ac`，cacbefe）與備份分支 `archive/design-preview-2026-11-10`，沒有 push、沒有合併。要看：在 `.claude/launch.json` 暫時加 `py -3.14 -m http.server 8766 --directory .claude/worktrees/fervent-merkle-1607ac/site`，開 `/preview-home.html`。
   - 使用者 2026-11-17：導覽列的「記帳」放正中間，之後設計改版時改成像 OKX 錢包底部中間那顆凸起的圓形主按鈕（截圖是 OKX Web3 錢包首頁）。
   - 重啟時照使用者的意見改：六個範本都要實際開來看（上次 Ledgely、Zapline、Fundora 沒開），互動當成重點（上次沒有跳數字、沒有背景動畫，使用者覺得只比現在好一點）。
4. **檢查後繼續補足**（PIVOT 第 12 節）與**資金頁「總資產走勢」**（[ASSET_TREND.md](ASSET_TREND.md)）：2026-11-17 上線（`bde1da1`，sw.js `2026-11-17-3`）。補足從 2027-04 的檢查才開始算；晨報的 engine 釘選已隨 v4.2a 換成 0876bf0，會用到這個功能。
5. **「資產」新頁與「試算」頁整頓**：2026-11-17 上線（`f1ff46d` 合併、`08d91d5` 導覽列，sw.js `2026-11-17-4`），規格與紀錄在 [ASSETS_PAGE.md](ASSETS_PAGE.md)。導覽列照使用者指定：總覽、持倉、資產、K 線、記帳、分析、新聞、報告、試算（記帳在正中間）。
6. **帳本補兩組已賣出的買賣與已實現損益**（[REALIZED_PNL.md](REALIZED_PNL.md)）：2026-11-18 上線（sw.js `2026-11-18-1`）。帳本補了 00679B、00735 兩組買賣與 VOO、GOOGL、009816 的實際金額；持倉頁與總覽顯示已實現損益 +175。
7. **配息自動記帳已全部上線**（2026-11-18；[OTHER_INCOME.md](OTHER_INCOME.md)、[AUTO_DIVIDENDS.md](AUTO_DIVIDENDS.md)）：網站（合併 `fa82ff1`，sw.js `2026-11-18-2`）、market-data `us.json`、Apps Script 與每日觸發器都好了。**11/19 確認第一次自動執行**（台北 09:00～10:00；看配息卡「上次自動檢查」或 Apps Script「觸發條件」的上次執行時間）。第一筆真正自動記帳預計是 GOOGL（12 月中）或 00981A。
8. **備份到 Google 雲端硬碟**（[BACKUP.md](BACKUP.md)）：使用者 2026-11-21 要求「不要存在本機改備份在google雲端硬碟」。電腦每天用 Python 腳本把三個 repo、`private/`、Claude 記憶、發布 CSV 寫進 `G:`；腳本 `tools/backup_to_drive.py`、測試、[RESTORE.md](RESTORE.md) 已做好並用假根目錄驗收（備份、還原演練、三種故障都過），在分支 `claude/funds-fire-30y-122524`，**還沒合併；沒寫過 G:、沒 `--init`、沒註冊排程**（細節與跟規格不同處見 BACKUP.md 第 12 節）。下一步：審查合併並推送（RESTORE.md 要先上 origin/main，腳本才會把它複製到雲端）→ 使用者同意後部署 session 做 `--init`、第一次寫入、註冊排程 `StockDashboardBackup`。雲端看門狗等使用者決定。使用者同意加雲端看門狗（Apps Script，有問題才寄信；規格 BACKUP.md 第 13 節），由使用者自己安裝授權。

## 注意事項
- 分工（使用者 2026-11-12、11-13 訂）：主 session 的高階模型只做規劃、規格、審查與較難的製作；部署、例行檢查、照規格實作交給常駐的便宜模型 session（部署與例行檢查、網站實作、market-data 維護、排程維護；教學要用時開新的；id 在記憶 `delegate-routine-work`）。模型（使用者 2026-11-16 訂）：交辦預設 Sonnet，看新聞、讀執行紀錄這類簡單檢查用 Haiku，只有 Sonnet 做不到才用 Opus；主 session 以前開的 Opus session 已全部封存。同類工作用同一個 session，不要每件事開新的；主對話只講結論與要使用者決定的事。會對外生效的動作（push、部署、改排程）要使用者本人在執行的那個 session 裡同意。使用者 2026-11-18 再次強調：主 session 當管理者，部署（合併、改版本號、測試、push、線上確認）與例行檢查一律交給分支 session 做，做完呈交給主 session 核對批改，主 session 不自己動手部署。
- 改 claude.ai 排程前先取得同意、先用一次性測試 run 比對。RemoteTrigger update 要送完整 job_config（含 environment_id、events 的 uuid），不給 mcp_connections 就不會動到連接器；改完讀回，用程式比對提示詞（回應很大，存成檔案時直接讀檔，沒存成檔案就從 session 的對話紀錄 jsonl 取出）。
- 排程裡 WebFetch 只開這次 WebSearch 結果裡的網址，直接開檔案或清單裡的網址可能要使用者核准、5 分鐘後被收回；allowed_domains 不放 reuters.com、apnews.com（整次搜尋會被拒）。
- 排程被使用者的每週額度擋下時會中途停止，不是程式問題。
- 本機 Git Bash 沒有時區資料：`TZ=Asia/Taipei date` 會被當成 UTC；台北時間用 `py -3.14` 搭 zoneinfo。
- 投信網站的憑證在 Python 3.13 以上會被擋，抓持股固定用 3.12。
- 機會頁（`#/opportunity`，第一、二版 2026-11-12、11-13 上線；晨報的機會觀察 11-16 隨 v4.2 上線）只當參考分析：不設預備金、不放 00735，−10% 只提醒、−20%／−30% 才展開，「積極」可以打破 80／20 但只當分析呈現（[INSIGHTS.md](INSIGHTS.md) 5.2、[OPPORTUNITY.md](OPPORTUNITY.md)）。
- 資金頁「未來會有多少」的推估一律用歷史回測、不用固定報酬率；小豬撲滿不改（[FUNDS_BACKTEST.md](FUNDS_BACKTEST.md)）。使用者決定先不做：英文標題翻譯。
- 本機預覽：`.claude/launch.json` 的 `site`（網站，網址加 `?nosw` 不用 service worker）與 `tests`（測試頁，`/tests/web/*.html`，標題顯示「通過 N／N」）。`tests` 的指令寫死 8771 埠，被別的 session 的伺服器占用時，預覽工具換的埠不會真的啟動；先確認占用的伺服器是不是同一份程式再用它。
- push 到 main 時，只有 `site/**` 有改才會部署 Pages（docs 不會）；網站改動要使用者確認後才部署，改 site 檔案時一起更新 `site/sw.js` 的 `VERSION`。

## 文件地圖
- [PLAN.md](PLAN.md)：原始規劃（Phase 0～6）。[PIVOT.md](PIVOT.md)：2026-10-30 轉型（只管台股 80／20）。[INSIGHTS.md](INSIGHTS.md)：長期投資人資訊改版（4 批，第 1～3 批已做）。
- [IMPROVE.md](IMPROVE.md)：第三方改進報告 R01～R20、D01～D08 與批次狀態。[NEWS_ROUTINE.md](NEWS_ROUTINE.md)：新聞排程 v1～v4.2。
- [FUNDS_BACKTEST.md](FUNDS_BACKTEST.md)：資金頁回測試算的規格（N 年後、財富自由、生命週期、本金／獲利）。
- [LEDGER_WRITE.md](LEDGER_WRITE.md)、[LEDGER_CONSISTENCY.md](LEDGER_CONSISTENCY.md)：網站記帳。[DATA_SOURCES.md](DATA_SOURCES.md)：資料來源。[BACKTEST.md](BACKTEST.md)：買點規則回測。[ROUTINE_V2.md](ROUTINE_V2.md)：舊晨報 v2（已停用）。
- [ASSETS_PAGE.md](ASSETS_PAGE.md)：資產新頁與試算頁整頓的規格。
- [ASSET_TREND.md](ASSET_TREND.md)：資金頁總資產走勢的規格。
- [REALIZED_PNL.md](REALIZED_PNL.md)：已實現損益的規格與要補進帳本的兩組買賣。
- [OTHER_INCOME.md](OTHER_INCOME.md)：配息與手續費折抵（「其他入帳」分頁）的規格。
- [BACKUP.md](BACKUP.md)：備份到 Google 雲端硬碟的規格；還原說明見 [RESTORE.md](RESTORE.md)。
- [HISTORY.md](HISTORY.md)：2026-10-16～11-10 完整進度紀錄（Phase 0～4 的勾選清單也在裡面）；最後面是 11/11 起的大事記。
- 私人（不進 git）：`private/routines/`——各版提示詞、`routines.json`、每版一個資料夾（v3、v4、v41、v42）的 README 記排程 ID、測試與上線紀錄；更新與核對的腳本在 `tools/`。

## Phase 狀態
- Phase 0 基礎建設（tag v0.1）、Phase 1 強化資料、Phase 2 排程結構化輸出：勾選項目都已完成。
- Phase 4 網站：2026-10-27 上線，持續改版中；2026-11-17 打 tag `v0.2`（使用者同意；Phase 1、2 當時沒打 tag，一起算在內）。
- Phase 3、5、6：使用者 2026-11-17 決定結案（Phase 3 是轉型前買點晨報用的配置器；Phase 5 只缺總資產走勢，另外做；Phase 6 的 CI 與資料狀態頁已經有了）。
