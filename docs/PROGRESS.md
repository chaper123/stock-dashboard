# 進度

> 新 session 先讀這份；細節看 [PLAN.md](PLAN.md)。每次 commit 一起更新。

最後更新：2026-10-20

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 下一步
1. **美股晨報已切換 v2（2026-10-20 15:27）**：使用者在 claude.ai 手動貼上（API update 被拒，見 ROUTINE_V2 第 8 節），讀回核對三處提示詞與草稿逐字相同、排程時間與 11 個連接器不變。**10/21 第一次正式執行正常**：報告日期 10/21（沒有被系統提示詞寫死的 10/20 帶偏）、存檔就是完整報告（修正 A 生效）、`報告存檔` 1 列＋`配置計畫` 10 列、engine-v1.1 SHA-256 OK、本機回放精簡 JSON 逐欄相同（細節見 ROUTINE_V2 第 8 節第 6 步）。接下來：第一週每天回放；**10/26（一）**看估值快取寫回與基本面段落。**台股晨報 2026-10-22 16:49 也切換 v2**（使用者同意後手動貼上 `tw_etf_morning_report.v2.prompt.md`，engine-v1.0；讀回核對三處提示詞與草稿逐字相同、排程時間與連接器不變）：**10/23 10:17 第一次**要看報告日期、存檔是不是完整報告、`配置計畫` 3 列、鉅亨網報價時間戳（修正 C）、回放；**10/27（二）**看週一流程（10/26 台股休市：重疊與集中度、009816 台積電權重）。提示詞的小修改（plan_rows 一次寫入、單一來源備註）等 10/26 確認後兩邊一起改。**10/26 確認**：美股週一流程正常——`估值快取`!A2:H7 一次寫回 repo 10/23 的六檔數字（讀回 6 列一致、沒有多寫）、報告有「基本面變化（週一）」段落（SPCX、TSLA 第三季）、`配置計畫` 一次寫入 10 列、本機回放精簡 JSON 完全相同（market-data f4ea701）。台股 10/26 休市（光復節補假，calendar.json 有列），v2 照規則不跑引擎、不用盤中價、不寫儀表板，報告標明休市並說明 10/23 颱風休市；台股週一流程順延到 10/27。**10/27 確認**：美股、台股回放精簡 JSON 都完全相同（market-data 8f41fd2、230a732）。台股 v2 第一次週一流程正常（第 6 節：009816 台積電 40.24%、00981A 11.34%、00411A 未持有，重疊前十大、主動 ETF 本週調整），`配置計畫` 一次寫入 3 列；009816、00981A 第一買區各 645、合計 1,290，00411A 溢價 2.06% 禁買。鉅亨網盤中價又回 10/22 的舊報價（切換後兩個交易日都是），修正 C 改用 repo 證交所快照（nav_raw 09:37：009816 16.02）；10:05 MIS 快照 009816 15.95、加權 46,219.29，判定與金額不變。**待決定**：盤中價改以 market-data `intraday.json`（MIS）為主、鉅亨網為備援（等 00981A、00411A 價格為 null 的問題修好，併入提示詞修改批次）。
2. **engine-v1.1 已合併**：PR #1（2026-10-16 晚上雲端 session，口袋美股每筆最低 50 美元、台幣交割圈存多 3%，「不足就不買」）2026-10-20 合併為 f8b8f02（CI 綠燈、本機 184 項通過）；tag `engine-v1.1` 指向 3a40ed6，用 raw 網址下載三個檔案 SHA-256 相符。線上 v1 美股排程內嵌的已是 v1.1；台股維持 v1.0。
3. **market-data 兩個問題已修正（2026-10-20，d0181b4、5bc223c）**：① 美股最後一根只有 MoneyDJ 一票（Yahoo、Nasdaq 都還沒有）時先收，meta 標 `last_bar_single_source=true`、`cross_check_ok=null`、`single_source_days`；後面的排程不算「已完整」、會再完整抓取補核對（一致就清除，不一致請 Nasdaq 裁判、必要時改正；超過 10 天停止追蹤），us/ 與 macro/TSM 都適用。② DXY、黃金、原油不收週末列，只在美東 17:10～18:00 收當天（18:00 晚盤後 Yahoo 的當天 K 棒是未完成資料，過了美東午夜才恢復），其餘時間只到前一天；重新產生後 10/19 WTI＝103.66（+2.2%，與報導一致），最近 30 天 WTI 漲跌方向與 FRED 現貨 29/29 一致、DXY 與鉅亨網最大差 0.075%。測試 26 項（`tests/`）通過；Actions [run 39390278213](https://github.com/chaper123/market-data/actions/runs/39390278213) 43 項全 ok、無錯誤。**待決定**：排程實際延遲 2.5～5 小時（10/20 在台北 08:17～14:37 才跑），很少落在美東 17:10～18:00，所以晨報時期貨三項通常只到前一天（v2 會標「未取得」），台北中午後才補上當天；同一天早上也會因此每次都做完整抓取。**使用者決定（10/20）**：用 cron-job.org 在美東 17:15（週一～五，時區 America/New_York）以 workflow_dispatch 準時觸發 fetch，讓期貨在 17:10～18:00 的時段收到當天收盤，晨報時就是最新一天；不採用「接受期貨晚一天」。帳號與 GitHub fine-grained token（只限 market-data、Actions 讀寫）由使用者自己建立，token 不經過 Claude。**已完成（10/20 16:46）**：測試觸發 [run 39395787753](https://github.com/chaper123/market-data/actions/runs/39395787753) 成功（3 分鐘、43 項全 ok、無核對衝突）；token 2027-10-20 到期，失敗通知寄到使用者的轉寄信箱。第一次正式觸發是 10/21 台北 05:15：10/21 早上要確認 Actions 有那次 workflow_dispatch、macro 的 DXY／黃金／原油到 10/20，以及 09:20 美股晨報讀到當天期貨。**10/21 確認**：05:15:09 workflow_dispatch 成功（4 分鐘）；09:21 晨報讀到的 market-data（75799f1）DXY／黃金／原油最後一列都是 10/20、量完整，v2 報告的總經段落用的就是 10/20（WTI 98.18、−5.29%）。v2 建議：`last_bar_single_source` 為 true 時在資料備註寫出 last_bar_votes（目前 v2 不會提到單一來源）。
4. Phase 1 剩第 7 項（SEC 8-K＋新聞 RSS；使用者要先建立存聯絡信箱的 Actions secret）與第 8 項的加權指數日線正式來源（cron-job.org 外部觸發已於 10/20 完成）。
5. **Phase 3（跨市場配置器）等台股 v2 切換穩定後才開始**（使用者 2026-10-21 決定）。開始時先列預設參數給使用者確認，再寫程式，先用影子模式。
6. **新聞改三層架構（使用者 2026-10-22 決定）**：起因是 10/22 美股晨報新聞只有 9 次搜尋，CNBC 讀不到、多是二手網站，NVDA／AAPL／Fed 幾乎沒查；reuters.com 直接讀回 401，但 Google News RSS 一天有約 100 則 Reuters 標題。
   - ① **已完成（10/22，market-data 1c01101、9c57335、aaa59de、2ff88dc 等）**：`news.py` → `data/news/headlines.json`（約 0.7 MB，格式已對齊 NEWS_ROUTINE 3.1）、`fed.json`、`headlines.md`，meta.json 有 `news/headlines`、`news/fed`。11 個英文、5 個中文查詢，每個查 Google News RSS 兩次（限定白名單網站、不限定）；tier 1 官方（Fed、政府、公司 IR、新聞稿通路）／2 主要媒體（rank A：Reuters、AP、Bloomberg、WSJ、FT、CNBC、中央社；B：Barron's、MarketWatch、Axios、Yahoo Finance、經濟日報、工商時報、聯合）／3 第一手發言（公司部落格）／4 其他；symbols 只看標題（含兩檔主動 ETF 前十大台股名稱），topics 用主題詞；相似標題合併；保留 72 小時。**與約定的差異**（README「新聞標題格式」）：window_hours 72（範例 36）、多出 status／stats／rank／queries／title_match／also 等欄位、tier 3 只認得公司部落格（Truth Social／X 不在 RSS）、Fed 項目保留 7 天。`intraday.py` → `data/tw/intraday.json`：證交所 MIS 三檔 ETF＋加權指數，標盤前／盤中／收盤後／休市日（不寫 meta）。三個 workflow 改用 `publish.py` 推送（每次從最新 main 重新套用自己的檔案與 meta 資料集，news 與 fetch 都改 meta 也不衝突）。測試 42 項通過。Actions 10/22 17:20 三個同時觸發都成功、第一次就推送（news 34/34 來源、894 則；intraday 正確標「收盤後」；fetch 最後推送仍保留 news/*，meta 45 項全 ok）。**待辦**：盤中實測（10/23 09:00～13:30，10:05 的 cron-job.org 觸發就算）；~~使用者在 cron-job.org 新增兩個工作~~ **已完成（10/22）**：`market-data news`（週一～五 08:20、Asia/Taipei，news.yml）與 `market-data intraday`（週一～五 10:05、Asia/Taipei，intraday.yml），沿用同一個 token；測試觸發台北 17:43（news）、17:46（intraday）都成功，三個工作都已啟用。10/23 要確認 08:20、10:05 兩次正式觸發，以及盤中快照的 `is_trading=true`。**原文網址（10/23，market-data 5f06c64）**：`items[].url` 為 Tier 1～2、最近 36 小時新聞解開 Google News 轉址後的原文網址，解不開或範圍外為 null，原本的 `link` 保留。Actions 實跑 558 則全部解開、0 失敗，新聞步驟約 1.5 分鐘，測試 45 項通過。注意：這裡用的是 Google 未公開的內部介面，改版可能失效，失效時只會是 null，不影響標題清單。 **發布時間可疑（10/26，market-data 1feb8b2、aef2018；使用者同意 ①，10/27 08:20 生效）**：同一次抓取（加上上一次留下、還沒改正的項目）同一來源 ≥5 則發布時間完全相同就視為 Google 批次重新索引（tier 1 不檢查），沒原文網址的先解開，讀原文頁 `datePublished` 等欄位（最後看網址日期）找回日期：找得回來就改正並記 `time_fixed_from`，超出 72 小時窗的拿掉；找不回來的移到頂層 `suspect_items`（news_select.py 讀 `items` 讀不到）。meta 的 `news/headlines` 有 `time_suspect_detected`／`time_fixed`／`time_removed`。用 10/26 08:20 那份回放：偵測 70 則（經濟日報 52、Taipei Times 7、工商時報 6、UDN 5）、70 則都找回日期（經濟日報 52 則被改正，其餘是報紙版 00:00 本來就對）、45 則舊文拿掉、移出 0；時間窗 10/23 08:40～10/26 08:41 內不再有 10/13～10/22 的舊文（529／846／594 點那幾則）。Actions 17:09 實跑：偵測 63、找回 63（改正 51）、拿掉 47、移出 0，items 637 則，meta 45 項全 ok；第一次實跑（17:06）發現上一次留下的 50 則舊時間沒被檢查，已修（aef2018）。測試 49 項通過。②③ 等 10/28 測試結束後由比對 session 併入。 **盤中快照沒有成交價（10/27，market-data bd89cca）**：10/27 10:05 第一次盤中執行，00981A、00411A 的 price 是 null（MIS 的 z、pz 那一刻是「-」）；12:3x 實測三檔 ETF 都是「-」，所以不是偶發。改成重抓最多 3 次（約 30 秒），仍沒有就用最佳一檔買賣中間價，單邊報價用那一邊，都沒有才 null；`price_field` 標 z／z_retry／pz／bid_ask_mid／bid1／ask1，另存 `bid1`、`ask1`、`price_note`、`price_retries`，change 用採用的價格算；00411A 的漲停 9999.95（無漲跌幅限制）改 null 並寫 `limit_note`。測試 54 項通過。Actions 盤中 12:40 實跑成功（35 秒）：009816 15.875、00981A 27.465、00411A 9.915 都是 bid_ask_mid，加權指數 z。注意：本機 Python 3.14 連 MIS 會因憑證缺 Subject Key Identifier 被拒（3.13 起的嚴格檢查），Actions 用 3.12 不受影響，之後升級 Python 要先處理（淨值 fetch_nav 也連同一站）。 **中央社官方 RSS（10/27，market-data 6ff12d9 探測、a257f8b 實作）**：官方 RSS 頁列 11 個分類，沒有獨立證券分類（台股新聞在財經 afe）；財經 https://feeds.feedburner.com/rsscna/finance、科技 …/rsscna/technology、國際 …/intworld、兩岸 …/mainland 從 GitHub 機房都讀得到，每個固定 20 則、pubDate 帶 +0800、連結都是 cna.com.tw 原文。使用規範：同意個人、非營利組織之非商業用途，需標示出處「中央通訊社」、不得擅自引用全文、中央社保留隨時要求停止的權利（沒有禁止程式讀取）；所以只存標題與連結，頂層 `attribution` 標出處。先開財經與科技（國際、兩岸列在 config 備用）：source「中央社」、tier 2 rank A、`url` 直接是原文，和 Google News 的同一篇合併時以官方 RSS 為準，meta 加 `news/cna`。72 小時內中央社從 2 則增加到 37 則（官方 RSS 35 則）。測試 58 項通過；Actions 12:59 實跑 feeds 36/36、meta 46 項全 ok；測試排程固定版本（6be7918，SHA 相符）的 news_select.py 讀新檔正常（3.12、3.14 輸出相同），中央社標題出現在 009816／00981A 候選。注意：每個 feed 只有最新 20 則（財經約涵蓋 10 小時），新聞一天只跑 08:20 一次會漏掉白天較早的中央社；要更完整可在 cron-job.org 多排幾次 news（例如 13:00、20:00），由使用者決定。
   - ② 新排程「新聞與社群晨報」（約台北 08:40）：讀標題清單、查證重點、補社群，按標的寫事實、來源等級、偏多或偏空、建議事件旗標，寫入「儀表板資料」試算表的新聞分頁。先用測試模式。**設計（10/22）**：[NEWS_ROUTINE.md](NEWS_ROUTINE.md)（輸入約定、16 欄輸出、建議旗標規則、失敗退路、測試計畫）；提示詞草稿 `private/routines/news_morning.v1.prompt.md`、`news_morning.v1test.prompt.md`。使用者同日同意第 10 節三項：正式版只在有非 none 旗標或官方重大事件時推播、CMoney 同學風向改由新聞晨報讀（台股晨報的同學風向步驟併入第三層批次）、測試期 3 個平日含一個週一。等第一層 headlines.json 上線並穩定一天後對齊欄位，再問使用者：試算表加「測試_新聞」分頁、建立測試排程。**10/23**：第一層實際格式已對齊（NEWS_ROUTINE 第 3.1 節）；使用者同意測試，「測試_新聞」分頁已建立，測試排程由使用者在 claude.ai 建立（平日 08:40，10/26～10/28 跑三次後停用）。**10/23 手動試跑不通過**（查證 0/4、漏報、一列多件、模型 Sonnet），修正四項：market-data `url`（5f06c64）、`engine/news_select.py`（6be7918）、提示詞 v1b、模型改 Opus 5.5（API 送完整 job_config）。**10/25 手動試跑通過**（Opus、SHA OK、必寫 2 項、查證 6/10、37 列寫入、6 分鐘）；週末標題清單沒更新，走的是退路，主流程要 10/26 測。小問題 4 項記在 NEWS_ROUTINE 第 8 節，測試期後再改。~~待使用者決定：重新啟用測試排程~~ **10/25 已啟用**（使用者同意，主 session 用 RemoteTrigger update）：`enabled=true`，cron 改成 `CRON_TZ=Asia/Taipei 40 8 26-28 10 *`，只在 10/26、10/27、10/28 的 08:40 各跑一次；提示詞未動，下次執行 10/26 08:40。**10/28 跑完要停用或換成正式版**（這個 cron 到 2027/10/26 會再觸發）。每次跑完照 NEWS_ROUTINE 測試計畫比對同日兩個晨報。**10/26 第 1 天**：主流程第一次跑到（標題清單 08:20、時間窗 10/23 08:40 起 613 則、原文網址 199/199），Opus、SHA OK、08:40～08:46、31 列一次寫入；查證 11 件成功 6 件、3 篇舊聞正確不採用；必寫事項（台股休市）三檔各一列；美股晨報的重點大多涵蓋，旗標兩邊都是 none；新聞排程另外查證了 SpaceX 400 億美元 GPU 債務（晨報沒寫）。**發現**：Google News 的發布時間不可靠——52 則經濟日報標題都標成 10/24 17:00（實際是 10/13～10/22 的舊文），其中「台股下跌 529 點」以僅標題、偏空寫進 009816／00981A（附的網址還是另一篇）。修正方向見 NEWS_ROUTINE 第 8 節。**使用者決定（10/26）**：① 第一層 news.py 的「時間可疑」偵測（同來源批次相同時間；能從原文找回日期就改正，找不回就移出 items）交給 phase-1-market-data，今天上線、10/27 08:20 生效，不動排程；② news_select.py 降權和 ③ 提示詞修改（僅標題的事件時間不在時間窗內就不寫、網址只放實際讀過的那篇），等 10/28 測試結束後併入新聞晨報正式版。**10/27 第 2 天**：時間可疑修正生效（第一層偵測 47、改正 47，其中 29 則改正後落在時間窗外），事件列沒有再出現批次標錯時間的舊文；08:40～08:45、33 列一次寫入，查證 11 件成功 7 件；必寫事項 TSLA +5.21%（Barclays 升評、合併預期）寫了原因。和兩個晨報比：Anthropic 遞件 IPO、TSLA 升評、Meta 增資、FOMC 都有；漏了川普 10/25 對伊朗的談話與美伊緊張（兩個晨報都有寫）。新聞排程多了 iPhone Duo 螢幕更換、Anthropic 文件的台灣風險、CoWoS 傳漲價、台積電 ADR 溢價 16%。三方旗標都是 none。**10/28 第 3 天（測試結束）**：內容大致正確（643 則、查證 9 件成功 7 件、必寫 2 項），但使用者看不出重點（16 欄攤成文字、照標的排、雜訊與僅標題太多、自己拼網址、Gmail 配額錯誤）。**使用者同意正式版方向（10/28）**，已完成：news_select.py 240524a、e9c6d24（持有與買區加權、今晚／明早、雜訊與 Tier 4 過濾、重點順序；197 項測試通過）、正式版提示詞 `news_morning.v2.prompt.md`（9,681 字：最多 3 條「今天的重點」寫成「重點」列、僅標題只留必寫、網址不可自己拼、新的訊息排版、Gmail 後段重試）；用 10/28 資料回放與範例訊息見 NEWS_ROUTINE 第 8 節，「重點」列格式見第 5.1 節（給 Phase 4）。**待使用者決定**：測試排程直接改成正式版或停用後另建正式排程、建立「新聞」分頁（16 欄、純文字）；建立或更新排程前先問。
   - ③ 兩個晨報改讀新聞分頁、拿掉各自的大範圍搜尋（新聞排程沒跑完時退回 2～3 個精簡搜尋）；要等 ② 測試通過，併入提示詞修改批次，由使用者手動貼上。
   - 永豐金 Shioaji API 暫不採用：要另外在永豐金開戶、只有台灣市場、IP 白名單無法配合 GitHub Actions。需要分鐘 K 或委買委賣時再評估（只開「行情／資料」權限）。
7. GitHub Actions 10/19、10/20 的 runner 仍是 ubuntu-24.04，Ubuntu 26 還沒輪到，之後第一次要再留意。

## Phase 0 基礎建設
- [x] 專案移到 `C:\stock-dashboard`（舊的空資料夾被鎖，使用者重開 app 後手動刪）
- [x] winget 安裝 Python 3.12.10、Git 2.55、GitHub CLI 2.102（Python 用 `py -3.12` 呼叫）
- [x] 專案骨架、`.gitignore`、提交前檢查（實測可擋 token 與 private/）
- [x] docs/PLAN.md、docs/PROGRESS.md、CLAUDE.md
- [x] 排程提示詞備份到 private/routines/（不進 git）
- [x] GitHub 登入、建立公開 repo、push（commit 用 noreply 信箱）
- [x] Pages 部署測試頁；線上確認讀得到 market-data meta.json（Actions 已升到最新主版本）
- [x] clone market-data 到 `C:\market-data`
- [x] 驗證 Google Sheet 發布的 CSV 能被瀏覽器直接讀：四個分頁從 Pages 網址都讀得到（見 [DATA_SOURCES.md](DATA_SOURCES.md)）。Phase 0 完成，tag v0.1

## Phase 1 強化資料（market-data）
- [x] 來源探測：`probe.py`（標準庫）＋`.github/workflows/probe.yml`（只手動觸發、不 commit）。Actions 上 33/36 通過（[run 38784686621](https://github.com/chaper123/market-data/actions/runs/38784686621)，結果在 job summary）
- [x] fetch.yml 升級 checkout、setup-python 至 v7；手動跑成功、meta.json 17 項 ok、無錯誤，Node 20 警告消失（[run 38784691731](https://github.com/chaper123/market-data/actions/runs/38784691731)）
- [x] 修正 fetch.py 略過邏輯（market-data 326e84e）：原本只看 meta 是否今天產生，10/16 02:19 手動執行（美股未收盤）導致當天三次排程都略過、美股晨報用到 10/14 日線。改成核心資料最後日期都到「台北今天的前一個平日」才略過；6 個情境測試通過。11:25 手動重抓後資料已補到 10/15。
- 實作（使用者 2026-10-16 同意第 1～6 項；第 7、8 項之後再做）：
  - [x] 共用工具抽到 `common.py`（market-data ac96705；本機完整執行比對，日線與淨值歷史輸出不變）
  - [x] ① 指數與總經收盤、CNN 恐懼貪婪、台指 VIX：`macro.py` → `data/macro/`、`data/sentiment/`（b9e1a35）。本機測試：SPX、IXIC、SOX、DXY 與鉅亨網收盤一致；TSM 鉅亨網 10/15 還是盤中價（差 2.4%），meta 會標核對衝突
  - [x] ② 台銀美元即期（FinMind），與 usdtwd_mid 核對：`fxbot.py` → `data/fx/usdtwd_bot_sell.csv`（date,rate，可直接當 fx_csv；38943a8）。本機與台銀網頁 6 個月表 125 列逐筆一致；16:30 前不收當天（台銀網頁會列出當天盤中牌告，Phase 2 再決定要不要用）
  - [x] ③ 估值（stockanalysis）＋Yahoo 財報日，檢查與上週差距：`valuation.py` → `data/valuation/us.json`、`us_history.csv`（02ea55b）。頁面股價與 repo 收盤核對（本機 6 檔差 ≤0.06%）；隱含預估 EPS 一週變動超過 ±20% 標記；Yahoo 只取財報日（GOOGL 10/28、TSLA 10/21、SPCX 11/03 估計、AAPL 11/02、NVDA 11/17）
  - [x] ④ 行事曆：證交所休市、FOMC、財報日；CPI 標「未取得」：`calendars.py` → `data/calendar/calendar.json`（2f38ace）。證交所 OpenAPI 與 rwd 版 2026 年 27 筆一致，標出「開始交易日」等其實有交易的日子；FOMC 收今年與已公布的 2027 年；明年台股休市表尚未公布（rwd 回 0 筆），公布後自動收錄。美股休市日不在這次範圍
  - [x] ⑤ 法人與融資：T86（關注代號）、BFI82U、MI_MARGN；00411A 用櫃買：`chips.py` → `data/chips/`（daa477f）。每次補齊最近 9 天內缺的交易日（略過休市日，22:00 前不抓當天）；合計＝分項加總核對通過。首次補 6 天約 2 分鐘，之後每天約 15 秒
  - [x] ⑥ 主動 ETF 每日持股（統一投信），比對前十大變化：`holdings.py` → `data/holdings/`（d971152）。每單位淨值與 nav_history（證交所 mis）同日一致、權重加總＝股票市值／淨資產；前十大新進／退出、權重變動 ≥1 個百分點、新增／出清（用假資料測過）。00411A 持美股，資料日晚一天
  - [x] 台北白天手動觸發 fetch，確認 meta.json 新舊資料集都 ok：10/16 11:57 [run 38848066076](https://github.com/chaper123/market-data/actions/runs/38848066076) 成功，43 項全 ok（原 17＋新 26）、0 stale／fail、無錯誤；新資料已由 bot commit（2c96197）。fetch 步驟首次約 7 分鐘（含法人回補 6 天，原本約 2 分鐘）；`--skip-if-fresh` 只更新淨值（本機 0.8 秒），新資料集保留
- [x] 日線改用 MoneyDJ／官方，最後一根 K 棒多數決（market-data 4a03ee4 探測、f104243 修正）。起因：鉅亨網美股最後一根停在盤中價（ARKX 10/15 30.20、官方 30.53；TSM 412.27、官方 422.25）
  - 探測（Actions [run 38851301997](https://github.com/chaper123/market-data/actions/runs/38851301997)，6/6）：Nasdaq 官方 historical、MoneyDJ 美股日線（約 300 根）、MoneyDJ 台股日線、櫃買個股日成交都連得到
  - 歷史總檢查（對照 Nasdaq 官方；00411A 對照櫃買）：收盤差 >0.5% 的 K 棒，鉅亨網 VOO 5、IAUM 8、ARKK 8、ARKQ 8、ARKX 9、TSM 9 根（最大 3%，近 30 天 ARKX、TSM 的 10/02、10/15 都錯），其餘 0；Yahoo 只有 SPCX 2026-06-16 一根（+4.75%）；MoneyDJ 11 檔各 300 根全部 0；00411A 四個來源 34 根都一致。鉅亨網的美股成交量也偏少（VOO 中位數少約 9%，一成的日子不到官方一半）。明細在共用筆記 `daily-source-audit-2026-10-16.md`
  - 新做法：`us/` 改 MoneyDJ 為主、Yahoo 核對，鉅亨網移除；最後一根兩家一致才採用，不一致或缺一家時問 Nasdaq 官方，至少一家與官方一致才採用（K 棒用官方值），仍無法判定就先不收那一根。meta 新增 `last_bar_source`、`last_bar_referee`、`last_bar_votes`、`history_mismatch`。`tw/00411A` 改櫃買官方為主、MoneyDJ 核對（量的單位維持張）；`macro/TSM` 改 MoneyDJ 核對並同樣多數決。CSV 格式與路徑不變，美股保留最近一年（252 列）
  - 驗證：10/16 12:44 [run 38852198147](https://github.com/chaper123/market-data/actions/runs/38852198147) 成功，43 項全 ok、核對衝突 0、無錯誤，ARKX 10/15＝30.53。修正後 repo 歷史中被改正的 K 棒：VOO 5、IAUM 8、ARKK 8、ARKQ 8、ARKX 9 根（收盤差 >0.5%）；幾乎每根的成交量也改成官方值。裁判流程只用假資料測過，正式環境尚未觸發
  - 注意：成交量全面換成官方值，排程裡用到量能的判斷（例如量比）可能和以前略有不同
- [x] 單一來源先收與補核對、總經 24 小時品項收盤截止（market-data d0181b4、5bc223c；說明見「下一步」第 3 項；README 已補 meta 欄位與測試方法）
- 備註：Actions 提示 `ubuntu-latest` 自 2026-10-19 起改用 Ubuntu 26，之後第一次排程留意是否正常。
- [x] 10/19（週一）第一次正式排程：07:04 完整抓取（194 秒）、43 項 ok、無錯誤，美股十檔 last 10/16（MoneyDJ 多數決）；runner 仍是 ubuntu-24.04。09:20 美股晨報十檔都用 repo 日線，沒有再用到過期資料
- 10/20 裁判流程第一次在正式環境觸發：08:17、09:11 美股 10/19 只有 MoneyDJ 一票、Nasdaq 無資料 → 先不收；10:13 MoneyDJ 與 Yahoo 一致後收錄（和 v2 測試用 MoneyDJ 補的值逐字相同）。見「下一步」3

### 探測結果（GitHub Actions，2026-10-16 02:19 台北）
| 資料 | 來源 | 結果 | 備註 |
|---|---|---|---|
| 美股指數與總經收盤 | Yahoo chart：^GSPC ^IXIC ^SOX ^VIX ^TNX DX-Y.NYB GC=F CL=F TSM | ✅ | 每檔約 3.5 KB、0.2 秒。盤中會含未收盤 K 棒，要沿用 fetch.py 的收盤截止 |
| 加權指數 | Yahoo ^TWII | ⚠️ | 抓得到，但停在 10/14（少 10/15）。repo 目前只有 quotes.json 的 TSE01 盤中快照，建議改用證交所或鉅亨日線（尚未探測） |
| 恐懼貪婪 | CNN dataviz graphdata | ✅ | 要帶 Referer（否則 418）。分數、評等、252 點歷史、7 個分項 |
| 台指 VIX | 期交所月檔 `vix/log2data/YYYYMMnew.txt`（Big5） | ✅ | 第一次逾時、重試才成功（共 23 秒）→ 實作要重試並放寬逾時 |
| 台銀美元即期買賣 | FinMind TaiwanExchangeRate（免 token） | ✅ | 6 個月 131 列，spot_buy／spot_sell 到 10/15 |
| 台銀本站（對照組） | rate.bot.com.tw CSV | ❌ | 「Challenge Validation」驗證頁（本機也一樣），不繞過 |
| 估值 | stockanalysis statistics、`/etf/voo/` | ✅ | Forward PE、PEG、VOO 本益比、頁面股價與時間都解析得到 |
| 估值、財報日 | Yahoo quoteSummary | ✅ | 無 crumb 回 401；cookie＋crumb 可得 Forward PE、PEG、下次財報日。數字與 stockanalysis 差很多（NVDA 13.6 vs 18.0、PEG 0.27 vs 0.37，預估期間不同），不能直接互相核對 |
| 台股休市 | 證交所 OpenAPI 與 rwd holidaySchedule | ✅ | 2026 年 27 筆 |
| FOMC | federalreserve.gov FOMC 行事曆 | ✅ | 2026 年 8 次 |
| CPI 發布日 | BLS 時程頁 | ❌ | 403 Access Denied（本機也一樣），要另找來源 |
| 法人買賣超（個股） | 證交所 rwd T86 | ✅ | 2.7 MB、約 5 秒；OpenAPI 沒有 T86 |
| 法人買賣金額 | 證交所 BFI82U | ✅ | |
| 融資（大盤） | 證交所 rwd MI_MARGN（MS） | ✅ | |
| 融資（個股） | 證交所 OpenAPI MI_MARGN | ✅ | 沒有日期欄位，難判斷資料日，優先用 rwd 版 |
| 00411A 法人 | 櫃買 insti/dailyTrade | ✅ | 額外加測（00411A 是上櫃） |
| 主動 ETF 每日持股 | 統一投信 ezmoney（00981A=49YTW、00411A=64YTW） | ✅ | 頁面內嵌完整持股 JSON（代號、名稱、股數、權重）；要帶 cookie；00411A 資料日晚一天 |
| 8-K 等申報 | SEC EDGAR submissions（NVDA AAPL GOOGL TSLA） | ✅ | 用 fetch.py 的瀏覽器 UA 可通；SEC 規範要求自報 UA＋聯絡信箱，不附信箱的自訂 UA 會 403 |
| 新聞標題 | Google News RSS（英、中） | ✅ | 各 100 則 |

### 建議實作順序（等使用者同意再做）
1. 美股指數與總經收盤（Yahoo chart）＋CNN 恐懼貪婪＋台指 VIX：格式單純，直接取代排程搜尋轉述。
2. 台銀美元即期（FinMind）：取代 AI 轉述 6 個月表，與現有 Yahoo 中間價核對（應高約 0.1～0.2 元）。
3. 估值：stockanalysis 為主（與排程現用來源相同，數字不跳動）；Yahoo 只取財報日，不拿來核對本益比，改檢查與上週差距。
4. 行事曆：證交所休市＋Fed FOMC＋Yahoo 財報日；CPI 另找來源。
5. 法人與融資：T86（只留關注代號）、BFI82U、MI_MARGN；00411A 用櫃買。
6. 主動 ETF 持股：統一投信每日快照，比對前十大變化，取代每週轉述。
7. 新聞預篩：SEC 8-K＋Google News RSS 標題（SEC 的 UA 寫法另請使用者決定）。
8. 加權指數日線改正式來源（另行探測）；cron-job.org 外部觸發可平行處理。

## Phase 2 排程結構化輸出
- [x] ① monitor 程式逐字搬進 [`engine/`](../engine/README.md)（monitor_us.py、monitor.py、norm.py，保留原檔名，邏輯未改）。`tools/extract_engine.py` 與另一個用行號切出的方法（sed＋cmp）都確認和提示詞備份逐字相同；RemoteTrigger get 確認線上兩個排程的提示詞與備份一致（只差結尾換行），從線上提示詞抽出的程式碼也與 engine/ 相同。SHA-256：
  - `monitor_us.py` 75947691c28c4a2ecbf44781243541bdea0062b3eaab899c1bd63106343951e3
  - `monitor.py` 8c12675c1c9e78a668bd4ea941a7466300cfe39cb24244ab32b8d4e0173e0149
  - `norm.py` a74e16b958dff887b37aa72115e301d8d336521232acdc7609faee44dc666fc2
  - 發現：10/16 兩次正式執行，模型都是自己重打程式（run log 顯示開頭 docstring 已被省略），v1 的「照抄」無法保證逐字 → v2 改成從 repo 下載
- [x] ② 黃金測試（`tests/`，本機 157 項通過；Python 3.12.10、pandas 3.0.6、numpy 2.5.4）
  - 快照：`tests/fixtures/20261015/`，從 market-data 8a9a1a1（10/16 12:47，MoneyDJ 修正後）原樣複製美股 10 檔、台股 3 檔、台銀匯率、中間價、淨值、估值
  - 黃金檔 4 組（`tests/golden/`）：美股比照 10/16 正式用法（估值 10/12 快取）、美股改用 repo 估值＋block／boost、台股 10/16 正式 config、台股休市寫法（前收、溢價缺值／禁買、boost、block、空手 31 天）。原程式以子行程執行，輸出逐字比對；另核對 engine 三支的 SHA-256
  - 正式環境回放：台股 10/16 10:17 的 config 跑快照，金額（595／357／595，合計 1,547）、四個買區、MA20、MA60、RSI、ATR、乖離、量比與當天報告完全一致；美股的匯率濾網改讀 repo 台銀檔，算出 32.315／均值 31.877／偏離 1.38%，與 10/16 用 WebFetch 台銀表的結果相同（美股當天 repo 日線過期，其他欄位無法回放）
  - 規則邊界：追價區（乖離、RSI 門檻）、估值分級與換算、估值降級或禁買、匯率濾網（2%／4%、只剩深度買區）、估值＋匯率連降、單次上限縮放（美股 40%、台股 60%）、溢價降級或禁買、趨勢起始倉、空頭不接刀、block／boost、買區由淺到深、量異常、空手提醒、norm.py 收盤截止
  - 既有行為（照實記錄，沒有改）：台股已持有的標的若從第一買區因溢價降一級、或從等待因 boost 升一級，會落在「趨勢起始倉」等級拿 15%（10/16 的 00981A 357 元就是這樣）；價格剛好等於門檻時浮點數會略超過門檻（例如乖離剛好 6% 判成追價區），方向偏保守
- [x] ③ JSON 精簡輸出：`engine/run.py`（薄包裝，monitor 不改；欄位見 [engine/README.md](../engine/README.md)）。`schema_version` 1、台北時區產生時間、engine 的 SHA-256 與版本、統一的等級（台股從狀態名稱對應）、`--full` 存 monitor 原始輸出、`--rows` 產生「儀表板資料」試算表的列。測試 22 項：包裝後 monitor 輸出與黃金檔逐字相同、精簡 JSON 黃金檔 4 組、金額加總＝合計≤上限、不認得的狀態直接失敗、命令列用法（本機共 179 項通過）
  - 快照補記：market-data 的 CSV 是 CRLF，快照原本被 `eol=lf` 轉成 LF；改設 `-text` 後 17 個資料檔的 git blob id 與 market-data 8a9a1a1 相同（ca8e0ee）
- [x] ④ `requirements-dev.txt`（pandas 3.0.6、numpy 2.5.4、pytest 9.1.1、tzdata 2026.5，版本固定讓本機與 CI 數字相同；`py -3.12 -m pip install --user -r requirements-dev.txt`）＋`.github/workflows/test.yml`（每次 push、PR 跑 pytest，Python 3.12）。Actions [run 38878767233](https://github.com/chaper123/stock-dashboard/actions/runs/38878767233) 綠燈：Ubuntu 上 179 項通過，黃金檔與 Windows 本機逐字相同
- [x] ⑤ [docs/ROUTINE_V2.md](ROUTINE_V2.md)：v1 在 10/16 的實際問題、改動總表、engine 版本固定（建議 tag＋SHA-256）、Phase 1 資料對照與新鮮度規則、換掉鉅亨網備援、「儀表板資料」試算表、字數、測試與切換流程、待決定事項
- [x] ⑥ v2 提示詞草稿：`private/routines/us_morning_report.v2.prompt.md`（23,242 → 11,933 字，−49%）、`tw_etf_morning_report.v2.prompt.md`（19,836 → 13,819 字，−30%）。試算表 ID 先留空，SHA-256 以 run.py 2fd51fc4… 為準（打 tag 前若改 run.py 要同步）
- [x] ⑦ 使用者 2026-10-16 同意 ROUTINE_V2 第 9 節的建議（估值每天讀 repo、週一寫回估值快取、保留鉅亨網台股報價為主等）
  - [x] tag `engine-v1.0`（指向 78b0910）已 push；用 raw 網址下載 monitor_us.py、monitor.py、run.py，SHA-256 全部相符；本機照 v2 草稿的下載指令實際抓了 36 個檔案並跑完 run.py
  - [x] Google Sheet「投資儀表板資料（排程寫入）」：報告存檔、配置計畫、測試_報告存檔、測試_配置計畫，表頭＝run.py；日期與代號欄設純文字（寫入讀回驗證過）。ID 在 `private/routines/routines.json`
  - [x] 測試版提示詞 `private/routines/*.v2test.prompt.md`（標題加【v2 測試】、不寫帳本、寫「測試_」分頁、多做 5 項檢查）；兩個一次性測試排程 10/20 09:40、10:30（複製正式排程的環境與連接器，沒有 Cowork 系統提示詞），建立後讀回確認提示詞與檔案逐字相同
  - [x] 10/19 確認 v1 正常 → 10/20 測試執行 → 比對（細節見 [ROUTINE_V2.md](ROUTINE_V2.md) 第 11 節）
    - 10/19：v1 兩次正常（美股十檔用 repo 10/16、週一估值快取已寫；台股鉅亨網報價正常）；10/20 兩個測試排程照常執行
    - 10/20 四次都成功。引擎回放：v2 美股、台股的精簡 JSON 與試算表**逐欄相同**（雲端 Python 3.13.16、pandas 3.0.5、numpy 2.5.3）；v1 兩次用重建的 config 回放，報告上看得到的數字全部相同（run log 會截斷，看不到 v1 config 全文）
    - 差異都有解釋：美股只差日線（v1 用 repo 10/16；v2 用 MoneyDJ 補 10/19）、估值（v1 估值快取；v2 repo 每天）、匯率檔（濾網同為 32.495／均值 31.892／偏離 1.89%）；輸出只有 TSLA 從「不接刀」變「等待回檔」（10/19 +3.76%），兩邊金額都是 0。台股 config 與輸出完全相同（430／688／430，合計 1,548）
    - 寫入：測試_報告存檔 2 列、測試_配置計畫 13 列；正式分頁與帳本都沒寫
  - [x] 修 v2 草稿三處（A、B、C；美股、台股的正式版與測試版），美股正式草稿補上 v1.1 並改用 tag `engine-v1.1`。使用者 2026-10-20 決定不另外重測
  - [ ] 週一流程改在正式環境確認（美股切換後第一個週一：估值快取寫回、基本面段落；台股切換後第一個週一：重疊與集中度、009816 台積電權重），不另建測試排程
  - [x] 美股切換 v2（2026-10-20，使用者同意後手動貼上；線上 v1 原樣備份在 `private/routines/`）
  - [ ] 美股第一週確認（10/21 起每天回放；10/26 週一流程）
    - [x] 10/21：420 秒、WebFetch 5／WebSearch 7、權限拒絕 1（GateGuard）；回放逐欄相同；全部「等待回檔」、金額 0（匯率偏離 2.44% 首次觸發降一級）；帳本估值快取未寫（週三）
    - [x] 10/22：415 秒、權限拒絕 1；回放逐欄相同（market-data 5774cc5）；GOOGL 第二買區、NVDA 第一買區，但規則金額 NT$903／516 不足 50 美元，合計 0。10/21 那根只有 MoneyDJ 一票（market-data 新規則先收），報告置頂有寫出來。**寫入小狀況**：`配置計畫` 第一次 append 多帶一列空白佔位列，模型用 update_values 覆寫成 NVDA 再補 7 列，最後第 12～21 列內容與順序正確、資料備註有寫；但違反「只新增不修改」，下次改提示詞時建議加「plan_rows 用一次 append_values 全部寫入（從 rows.json 產生，不要分批或手打）」
    - [x] 10/23：497 秒、權限拒絕 2（GateGuard）；回放逐欄相同（market-data 71d959a）；`配置計畫` 這次一次寫入 10 列、模型寫完讀回存檔核對；10/22 那根只有 MoneyDJ 一票，置頂有寫。GOOGL 價位在深度買區，但匯率偏離 2.11% 降一級成第二買區，NT$903 不足 50 美元，合計 0
  - [x] 台股切換 v2（2026-10-22，美股穩定兩個交易日後，使用者同意手動貼上；線上 v1 原樣備份在 `private/routines/`）
  - [ ] 台股第一週確認（10/23 起每天回放；10/27 週一流程）
    - [x] 10/23（台股 v2 第一次）：**證交所因薔琵颱風全日休市**（連同光復節連假，10/27 才開盤），repo `calendar.json` 沒有這次臨時休市。v2 照規則判斷：鉅亨網兩次（第二次加 `?t=`）都回 10/22 13:30 的舊報價 → 當作失敗（修正 C 生效）→ repo 證交所快照也是 10/22 → 用新聞確認颱風休市；報告標「今日休市」、不給今日訊號、沒有寫入儀表板（正確）。另附 10/22 收盤的試算（標明不是訊號），本機回放與報告數字逐項相同（430／688／430）。317 秒、權限拒絕 1。台股第一次正式寫入順延到 10/27
- 待辦：兩個晨報排程的「備援：舊方法」仍用鉅亨網（WebFetch），要換掉（鉅亨網美股最後一根 K 棒常停在盤中價，見 Phase 1）。v2 草稿已改成美股只補最後一根（MoneyDJ）、00411A 用櫃買中心；正式排程切換後才算完成。

## Phase 4 網站雛形（第一版 2026-10-27 上線，還沒打 tag）
純靜態 `site/`（原生 JS 模組＋CSS，沒有建置步驟）；手機優先、深淺色（跟系統／手動切換）；台股習慣紅漲綠跌。外部函式庫用 jsDelivr 固定版本＋SRI：DOMPurify 3.4.17、marked 18.1.1、Lightweight Charts 5.2.1（只在 K 線頁載入）。
- [x] 骨架與資料層：`js/config.js`（資料網址與 gid）、`js/csv.js`（RFC 4180，報告欄有換行；數字去千分位與引號）、`js/data.js`（每個來源各自讀、各自失敗，讀不到時該區塊顯示原因與「重試」，其他區塊照常）、`js/portfolio.js`（持倉 × 最新價：台股有今天的盤中快照用盤中價，否則最後收盤；美股最後收盤 × 美元兌台幣中間價）。「設定」分頁用 A 欄項目名稱找值
- [x] 總覽：兩個晨報的一句話（取報告裡的「**一句話**」，沒有就用精簡 JSON 自動產生）、資金池、總資產（持倉市值＋可用資金）、台美比重、恐懼貪婪與台指 VIX（近 60 日走勢）、資料健康（meta 狀態與各類最後日期、晨報產生時間、帳本）
- [x] 改讀已發布的「投資儀表板資料（排程寫入）」（2026-10-27 使用者發布整份文件；網址與 gid 見 DATA_SOURCES 第 2 節）。網站只讀「報告存檔」（精簡 JSON 已含買區、狀態、金額）與新聞分頁（`NEWS_GID`，目前測試_新聞 gid 4）
- [x] 今日計畫：各市場最新一次（資料日最新、同日取產生時間最新）每檔的狀態、規則參考金額、判定價、距第一買區上緣、三個買區（台股未持有另列起始倉區，目前所在的區加框）、降級原因、趨勢／RSI／乖離／估值或溢價；美股另列匯率濾網、最低下單、IAUM 指標；觀察與指標標的收在「觀察與市場指標」
- [x] 持倉：合計（台幣）與台股、美股小計，每檔股數、平均成本、現價（台股今天盤中標時間）、總成本、市值、未實現損益與報酬率；交易紀錄（最近 8 筆，其餘可展開）
- [x] 報告歷史：依產生日期分組、可篩台股／美股，點開才轉換（最新一篇預設打開）。marked（gfm、breaks）→ DOMPurify（`RETURN_DOM_FRAGMENT`；另外擋 img／影音／style／表單元素；連結一律開新分頁、`noopener noreferrer`）；函式庫沒載入時退回純文字。表格可左右捲動；表格下一行沒空行的說明（GFM 會變成只有第一格的列）搬回表格後當段落。XSS 測試（`?dev` 測試檔：img onerror、script、javascript: 連結、onclick）：都沒有執行、沒有發出圖片請求
- [x] K 線買點圖：一次一檔（上方台股／美股代號切換，網址 `#/charts/代號`；預設第一檔在買區的標的）。Lightweight Charts 5.2.1（只在這頁用 SRI 載入）：日 K（紅漲綠跌）、美股 MA50／MA200、台股 MA20／MA60、最新晨報的買區色帶（越深越濃；台股已持有不畫起始倉區；自動縮放把買區算進去）與上緣虛線、交易紀錄成交箭頭、台股今天的盤中價虛線；游標所在日的開高低收、最近 20 日數據表；切換深淺色會重畫。讀不到晨報存檔時仍可畫 K 線（沒有買區）
- [x] 決策鏈（D5 六站，每站一張卡、點開看依據）：偵察（兩市場進買區的標的與規則參考合計）、新聞（新聞分頁最新一組：事件依事件 ID 合併、建議旗標、Tier 1 件數，另列晨報採用的 event 旗標；資料日不是今天會標出）、情緒（恐懼貪婪、台指 VIX、同學風向與社群列）、圖表（可買標的趨勢分布、空頭排列不接刀、RSI／乖離，連到 K 線）；風控與最終計畫是虛線卡「Phase 3 配置器上線後提供」。新聞以純文字放進頁面、網址只接受 http/https（`?dev` 測試：javascript: 網址不會變成連結、`<img onerror>` 只顯示成文字）
- [x] PWA：`manifest.webmanifest`（可加到主畫面，含可遮罩圖示；圖示由 `tools/make_icons.py` 產生）＋`sw.js`：網站本身先連網、失敗用快取；CDN 函式庫先用快取（安裝時預先存）；資料（market-data、Google Sheet）先連網 8 秒，成功就存一份並記時間，失敗回快取並加 `x-sw-offline`，頁面上方顯示「顯示上次成功讀取的資料（時間）」。本機實測：停掉伺服器後重新整理，今日計畫照常顯示；資料網址連不上時 8 秒後回快取內容與時間。**新增或改名 site/ 的檔案時，要更新 `sw.js` 的 `SHELL_FILES` 並把 `VERSION` 改成新日期**。2026-10-28 改成網站檔案每次都向伺服器確認（`cache: no-cache`，沒變就是 304），部署後下一次開啟就是新版（原本會被 GitHub Pages 的 max-age=600 快取最多 10 分鐘）
- [x] 新聞呈現改版（2026-10-28，使用者看了新聞晨報測試版說讀不懂、看不出重點；同意改版方向）：新增「新聞」頁（底部分頁變 7 個），決策鏈的新聞站改成摘要並連到新聞頁。共用邏輯在 `js/news.js`
  - 今天的重點（最多 3 則）：新聞分頁有「重點」列（類別＝重點，格式待 NEWS_ROUTINE 定案）就直接用；沒有就網站挑：非 none 旗標 → 持有（帳本持倉）或在買區（最新晨報 z1～z3／起始倉）且 Tier 1～2 已查證（先挑涵蓋不同代號的）→ 必寫事項（理由欄有「必寫」；保留一格）。每則一句話＋受影響代號（標出持有與所在買區）＋為什麼列入
  - 旗標：非 none 才醒目顯示（紅框）；全部 none 就一行「旗標全部正常」
  - 情緒一行：恐懼貪婪、台指 VIX（market-data）、同學風向四檔（2330、009816、00981A、00411A）
  - 明細卡片依重要性排序（非 none 旗標 ＞ 影響持有或買區 ＞ 必寫 ＞ 等級 ＞ 查證），同一事件 ID 一張卡列出所有受影響標的；none 預設收起、Tier 4 另收在「其他參考」；卡片標題是一句話，標籤顯示代號、Tier 與來源類型、查證（「僅標題」「無法查證」用黃色警示）；展開看全文、理由、影響、時間、來源與原文（只接受 http/https）。摘要列收在「新聞晨報的輸入狀態」
  - 驗證：375px 與桌面寬度截圖、console 沒有錯誤；`?dev` 測試檔加了 block 旗標與兩列「重點」，確認晨報重點優先、紅框旗標與 block 卡片預設展開、javascript: 網址不會變成連結
- [x] 恐懼貪婪半圓儀表（2026-10-28，使用者要求參考口袋晨報的樣式）：`js/gauge.js`，五段色帶照 CNN 分段（0–25 極度恐懼、25–45 恐懼、45–55 中性、55–75 貪婪、75–100 極度貪婪）、指針、分數、評等與「前一日 X 分 → Y 分（±N 分，更害怕／恐懼減輕…）」；放在總覽的市場情緒卡（取代原本的直條刻度）與新聞頁的情緒卡。資料是 market-data 的 CNN 恐懼貪婪（美股），不是口袋晨報自己的指數
- [x] 上線驗證（2026-10-27，9bbb8e5）：push 後 Pages 部署成功；https://chaper123.github.io/stock-dashboard/ 六頁都讀得到資料、沒有錯誤提示、console 沒有錯誤，service worker 已接管；儀表板試算表從 Pages 網址跨網域讀取正常。本機 375px 與桌面寬度、深淺色都檢查過，沒有橫向捲動
- 本機開發：`py -3.14 -m http.server 8765 --directory site`，網址加 `?dev` 改讀 `site/dev-data/`（從儀表板試算表抄的測試資料、含 XSS 測試字串，不進 git；只在 localhost 有效）；`?nosw` 不註冊 service worker。
- 下一步：
  1. 新聞晨報正式版建立「新聞」分頁後，把 `site/js/config.js` 的 `NEWS_GID` 換成新 gid（新聞頁、決策鏈的新聞與情緒站現在讀測試_新聞）；「重點」列格式記進 NEWS_ROUTINE 後，對照 `js/news.js` 的 `pickHighlights` 確認欄位用法一致。
  2. Phase 3 配置器上線後：決策鏈的風控、最終計畫改讀精簡 JSON 的 `risk_review` 與分批計畫；今日計畫加上分配後金額（影子模式時並列）。
  3. 「報告存檔」每列含報告全文，CSV 一年約 5 MB；變慢時改成只讀最近幾列（或報告另存）。
  4. Phase 5 加值：價格階梯、分批掛單線、總資產走勢、恐懼貪婪歷史、匯率與估值走勢。
  5. 使用者確認第一版後，依 CLAUDE.md 規則由主 session 打 Phase 4 的 tag。

## Phase 3、5、6
- [ ] 尚未開始
