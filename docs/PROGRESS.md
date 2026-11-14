# 進度

> 新 session 先讀這份（現況、待辦、注意事項）。舊決定與測試細節在 [HISTORY.md](HISTORY.md)，要查時用搜尋找相關段落，不要整份讀。
> 每次 commit 一起更新。這份保持精簡：做完的事在這裡只留一兩句，細節寫進主題文件（見文件地圖）或接在 HISTORY.md 最後面。程式註解裡的「PROGRESS.md 第 N 項」指 HISTORY.md 的編號。

最後更新：2026-11-12

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 現在在跑的東西
- **新聞晨報 v4.1**（claude.ai 雲端排程，平日 08:40 晨間、11:30 午間）：讀 market-data 的標題清單與資料、共用帳本（只讀）、私人持股 repo（只讀），寫「儀表板資料」試算表的「新聞」分頁並推播。2026-11-10 上線，做法與測試見 [NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 13 節；排程 ID、提示詞、退回 v4 的設定在 `private/routines/v41/README.md`。晨間 2026-11-11 16:34 改成 **v4.1a**（CMoney 同學風向先搜尋再開；午間沒改）。engine 釘選 stock-dashboard 3a59b67（`engine/news_select.py`、`discipline.py`、`fund_moves.py`）。
- 舊的美股、台股兩個買點晨報 2026-11-03 停用（轉型，見 [PIVOT.md](PIVOT.md)）。
- **market-data**（公開）：GitHub Actions 抓行情、新聞標題、總經、法人、行事曆，cron-job.org 觸發（fetch 06:15、news 08:20、11:10 等），狀態看 `data/meta.json`。台股不再程式抓證交所／櫃買網站（改 FinMind＋OpenAPI）；盤中價由網站在使用者瀏覽器用富果查（金鑰只在使用者裝置）。
- **market-data-private**（私人，本機 `C:\market-data-private`）：00981A、009816 每日持股。投信網站不得轉載，所以不放公開 repo；公開的「新聞」分頁不能寫股數、權重、排名、檔數。
- **網站**（GitHub Pages，純靜態，八頁：總覽、新聞、持倉、K 線、分析、資金、報告、記帳）：記帳透過帳本綁定的 Apps Script 寫入（[LEDGER_WRITE.md](LEDGER_WRITE.md)、[LEDGER_CONSISTENCY.md](LEDGER_CONSISTENCY.md)）。第三方改進報告第 A、B、C 批與 R02 已上線（[IMPROVE.md](IMPROVE.md)）。線上 sw.js 2026-11-14-2（財富自由試算回測推算）。
- **試算表**：「儀表板資料」（排程寫入；正式「新聞」gid 5、「測試_新聞」gid 4）；共用帳本（Claude 只讀，網站記帳寫入）。ID 在提示詞裡。
- **使用者的投資規則**：每月 6 日照帳本「定投金額」投入台股 009816 80%、00981A 20%；4、10 月檢查，偏離超過 5 個百分點才整筆補偏低的一檔；美股 VOO、GOOGL 保留、不加碼。所有輸出都是依規則的訊號，不是投資建議。

## 待辦
1. **v4.1 後續**（11/11 第一次正式執行兩次都成功、網站新聞頁正常，結果見 [NEWS_ROUTINE.md](NEWS_ROUTINE.md) 第 13 節）：
   - v4.1a 第一次正式執行（11/12 08:40）已確認：CMoney 三檔都先搜尋再開、都拿到分數（2330 61 分、009816 61 分、00981A 69 分），log 裡沒有網址權限問題；2330 與 00981A 分數的對應 log 無法證實。
   - 還沒遇到實際情況：費半漲跌在 3%～5% 之間（不該用大波動日格式）。遇到那天再看一次執行紀錄。（Fed 例行核准略過在 v4.1a 測試已用到。）
   - 下次改提示詞時一起修的小瑕疵：話題列理由的相對時間（「今天」「這兩天」）、總經總結的「外資連 5 天賣超」（資料只有 5 個交易日，實際連 9 天）、009816／00981A 的列偶爾類別寫成「總經」、偶爾把 apnews.com 放進 allowed_domains 被拒。
2. **機會頁**（INSIGHTS 第 4 批）：2026-11-11 討論完方向，記在 [INSIGHTS.md](INSIGHTS.md) 5.2——只當參考分析、不設預備金、不放 00735、−10% 只提醒、−20%／−30% 才展開；「積極」可以打破 80／20 但只當分析呈現。**第一版 2026-11-12 部署上線（sw.js 2026-11-12-1）**：`#/opportunity`，從分析頁與首頁市場狀態卡連過去；本機用預覽設定 `site` 開 `http://localhost:8765/?nosw#/opportunity`。**第二版「積極」的新標的候選篩選**：規格寫在 [OPPORTUNITY.md](OPPORTUNITY.md)（2026-11-12，使用者已決定候選範圍與排序條件）；使用者決定候選日線放公開的 market-data。進度見 OPPORTUNITY.md 7.1：market-data 已 push、第一批資料 2026-11-13 06:15 產生；網站部分 2026-11-12 使用者看過後合併進本機 main（`42faeb2`），**第二版 2026-11-13 部署上線（sw.js 2026-11-13-1）**，候選資料由 market-data 每月重排、每天更新。晨報的「機會觀察」等網站做好再談。
3. **設計改版先擱置（使用者 2026-11-11 決定：先功能、後美化）**：等網頁的功能、版面、互動大致定案再做美化，免得之後改功能又要重調。IMPROVE 的 D01～D08 與 R16、R17（版面）跟著擱置；R15（新聞去噪）、R18（資金頁先講現金）是功能，使用者 2026-11-13 說照計劃繼續：規格在 [R15_R18.md](R15_R18.md)。**兩項 2026-11-13 做完、審過，合併進本機 main（`1f3e79f`、`be86a82`），2026-11-14 部署上線（sw.js 2026-11-14-1）**：新聞頁 VOO 預設清單 57 → 31 則（別的標的、理財與預測文收合）；資金頁最上面加「現金與投入」並跟帳本對帳。R18 不動帳本結構。部署交給「部署與例行檢查」session。資金頁「N 年後」改用歷史回測推算（使用者 2026-11-13 要求，規格與結果在 [FUNDS_BACKTEST.md](FUNDS_BACKTEST.md)）：2026-11-14 使用者看過後合併進本機 main（`d29769e`），跟 R15、R18 一起 2026-11-14 部署上線。使用者 2026-11-14：財富自由試算也改用回測（規格與結果在 FUNDS_BACKTEST.md 第二部分），同一天使用者看過後合併進本機 main（`64d2349`），**2026-11-14 部署上線（sw.js 2026-11-14-2）**；小豬撲滿不改（主要看存了多少錢）。同一天使用者同意部署 R15、R18 與「N 年後」回測，交給「部署與例行檢查」。使用者問過英文標題翻譯，決定先不做。
   - 首頁示意留在本機分支 `claude/fervent-merkle-1607ac`（工作目錄 `.claude/worktrees/fervent-merkle-1607ac`，cacbefe：docs/DESIGN.md、site/preview-home.html、site/css/v2.css、site/js/pages/home_v2.js），沒有 push、沒有合併。要看：在 `.claude/launch.json` 暫時加一組 `py -3.14 -m http.server 8766 --directory .claude/worktrees/fervent-merkle-1607ac/site`，開 `/preview-home.html`。
   - 使用者看過示意的意見（重啟時要照這個改）：只比現在好一點、沒有互動感、只用了一小部分參考。原因：六個範本只實際開了三個（Ledgely、Zapline、Fundora 沒開）、照報告只拿兩個當主參考、動態刻意做得很少（沒有跳數字、沒有背景動畫）。重啟時六個範本都要實際開來看，互動當成重點。
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
