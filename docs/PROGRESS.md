# 進度

> 新 session 先讀這份；細節看 [PLAN.md](PLAN.md)。每次 commit 一起更新。

最後更新：2026-10-20

## 網址
- repo：https://github.com/chaper123/stock-dashboard
- 網站：https://chaper123.github.io/stock-dashboard/
- 行情資料：https://github.com/chaper123/market-data（本機 `C:\market-data`）

## 下一步
1. **美股晨報已切換 v2（2026-10-20 15:27）**：使用者在 claude.ai 手動貼上（API update 被拒，見 ROUTINE_V2 第 8 節），讀回核對三處提示詞與草稿逐字相同、排程時間與 11 個連接器不變。**10/21 第一次正式執行正常**：報告日期 10/21（沒有被系統提示詞寫死的 10/20 帶偏）、存檔就是完整報告（修正 A 生效）、`報告存檔` 1 列＋`配置計畫` 10 列、engine-v1.1 SHA-256 OK、本機回放精簡 JSON 逐欄相同（細節見 ROUTINE_V2 第 8 節第 6 步）。接下來：第一週每天回放；**10/26（一）**看估值快取寫回與基本面段落。**台股晨報 2026-10-22 16:49 也切換 v2**（使用者同意後手動貼上 `tw_etf_morning_report.v2.prompt.md`，engine-v1.0；讀回核對三處提示詞與草稿逐字相同、排程時間與連接器不變）：**10/23 10:17 第一次**要看報告日期、存檔是不是完整報告、`配置計畫` 3 列、鉅亨網報價時間戳（修正 C）、回放；**10/27（二）**看週一流程（10/26 台股休市：重疊與集中度、009816 台積電權重）。提示詞的小修改（plan_rows 一次寫入、單一來源備註）等 10/26 確認後兩邊一起改。
2. **engine-v1.1 已合併**：PR #1（2026-10-16 晚上雲端 session，口袋美股每筆最低 50 美元、台幣交割圈存多 3%，「不足就不買」）2026-10-20 合併為 f8b8f02（CI 綠燈、本機 184 項通過）；tag `engine-v1.1` 指向 3a40ed6，用 raw 網址下載三個檔案 SHA-256 相符。線上 v1 美股排程內嵌的已是 v1.1；台股維持 v1.0。
3. **market-data 兩個問題已修正（2026-10-20，d0181b4、5bc223c）**：① 美股最後一根只有 MoneyDJ 一票（Yahoo、Nasdaq 都還沒有）時先收，meta 標 `last_bar_single_source=true`、`cross_check_ok=null`、`single_source_days`；後面的排程不算「已完整」、會再完整抓取補核對（一致就清除，不一致請 Nasdaq 裁判、必要時改正；超過 10 天停止追蹤），us/ 與 macro/TSM 都適用。② DXY、黃金、原油不收週末列，只在美東 17:10～18:00 收當天（18:00 晚盤後 Yahoo 的當天 K 棒是未完成資料，過了美東午夜才恢復），其餘時間只到前一天；重新產生後 10/19 WTI＝103.66（+2.2%，與報導一致），最近 30 天 WTI 漲跌方向與 FRED 現貨 29/29 一致、DXY 與鉅亨網最大差 0.075%。測試 26 項（`tests/`）通過；Actions [run 39390278213](https://github.com/chaper123/market-data/actions/runs/39390278213) 43 項全 ok、無錯誤。**待決定**：排程實際延遲 2.5～5 小時（10/20 在台北 08:17～14:37 才跑），很少落在美東 17:10～18:00，所以晨報時期貨三項通常只到前一天（v2 會標「未取得」），台北中午後才補上當天；同一天早上也會因此每次都做完整抓取。**使用者決定（10/20）**：用 cron-job.org 在美東 17:15（週一～五，時區 America/New_York）以 workflow_dispatch 準時觸發 fetch，讓期貨在 17:10～18:00 的時段收到當天收盤，晨報時就是最新一天；不採用「接受期貨晚一天」。帳號與 GitHub fine-grained token（只限 market-data、Actions 讀寫）由使用者自己建立，token 不經過 Claude。**已完成（10/20 16:46）**：測試觸發 [run 39395787753](https://github.com/chaper123/market-data/actions/runs/39395787753) 成功（3 分鐘、43 項全 ok、無核對衝突）；token 2027-10-20 到期，失敗通知寄到使用者的轉寄信箱。第一次正式觸發是 10/21 台北 05:15：10/21 早上要確認 Actions 有那次 workflow_dispatch、macro 的 DXY／黃金／原油到 10/20，以及 09:20 美股晨報讀到當天期貨。**10/21 確認**：05:15:09 workflow_dispatch 成功（4 分鐘）；09:21 晨報讀到的 market-data（75799f1）DXY／黃金／原油最後一列都是 10/20、量完整，v2 報告的總經段落用的就是 10/20（WTI 98.18、−5.29%）。v2 建議：`last_bar_single_source` 為 true 時在資料備註寫出 last_bar_votes（目前 v2 不會提到單一來源）。
4. Phase 1 剩第 7 項（SEC 8-K＋新聞 RSS；使用者要先建立存聯絡信箱的 Actions secret）與第 8 項的加權指數日線正式來源（cron-job.org 外部觸發已於 10/20 完成）。
5. **Phase 3（跨市場配置器）等台股 v2 切換穩定後才開始**（使用者 2026-10-21 決定）。開始時先列預設參數給使用者確認，再寫程式，先用影子模式。
6. **新聞改三層架構（使用者 2026-10-22 決定）**：起因是 10/22 美股晨報新聞只有 9 次搜尋，CNBC 讀不到、多是二手網站，NVDA／AAPL／Fed 幾乎沒查；reuters.com 直接讀回 401，但 Google News RSS 一天有約 100 則 Reuters 標題。
   - ① **已完成（10/22，market-data 1c01101、9c57335、aaa59de、2ff88dc 等）**：`news.py` → `data/news/headlines.json`（約 0.7 MB，格式已對齊 NEWS_ROUTINE 3.1）、`fed.json`、`headlines.md`，meta.json 有 `news/headlines`、`news/fed`。11 個英文、5 個中文查詢，每個查 Google News RSS 兩次（限定白名單網站、不限定）；tier 1 官方（Fed、政府、公司 IR、新聞稿通路）／2 主要媒體（rank A：Reuters、AP、Bloomberg、WSJ、FT、CNBC、中央社；B：Barron's、MarketWatch、Axios、Yahoo Finance、經濟日報、工商時報、聯合）／3 第一手發言（公司部落格）／4 其他；symbols 只看標題（含兩檔主動 ETF 前十大台股名稱），topics 用主題詞；相似標題合併；保留 72 小時。**與約定的差異**（README「新聞標題格式」）：window_hours 72（範例 36）、多出 status／stats／rank／queries／title_match／also 等欄位、tier 3 只認得公司部落格（Truth Social／X 不在 RSS）、Fed 項目保留 7 天。`intraday.py` → `data/tw/intraday.json`：證交所 MIS 三檔 ETF＋加權指數，標盤前／盤中／收盤後／休市日（不寫 meta）。三個 workflow 改用 `publish.py` 推送（每次從最新 main 重新套用自己的檔案與 meta 資料集，news 與 fetch 都改 meta 也不衝突）。測試 42 項通過。Actions 10/22 17:20 三個同時觸發都成功、第一次就推送（news 34/34 來源、894 則；intraday 正確標「收盤後」；fetch 最後推送仍保留 news/*，meta 45 項全 ok）。**待辦**：盤中實測（10/23 09:00～13:30，10:05 的 cron-job.org 觸發就算）；~~使用者在 cron-job.org 新增兩個工作~~ **已完成（10/22）**：`market-data news`（週一～五 08:20、Asia/Taipei，news.yml）與 `market-data intraday`（週一～五 10:05、Asia/Taipei，intraday.yml），沿用同一個 token；測試觸發台北 17:43（news）、17:46（intraday）都成功，三個工作都已啟用。10/23 要確認 08:20、10:05 兩次正式觸發，以及盤中快照的 `is_trading=true`。**原文網址（10/23，market-data 5f06c64）**：`items[].url` 為 Tier 1～2、最近 36 小時新聞解開 Google News 轉址後的原文網址，解不開或範圍外為 null，原本的 `link` 保留。Actions 實跑 558 則全部解開、0 失敗，新聞步驟約 1.5 分鐘，測試 45 項通過。注意：這裡用的是 Google 未公開的內部介面，改版可能失效，失效時只會是 null，不影響標題清單。
   - ② 新排程「新聞與社群晨報」（約台北 08:40）：讀標題清單、查證重點、補社群，按標的寫事實、來源等級、偏多或偏空、建議事件旗標，寫入「儀表板資料」試算表的新聞分頁。先用測試模式。**設計（10/22）**：[NEWS_ROUTINE.md](NEWS_ROUTINE.md)（輸入約定、16 欄輸出、建議旗標規則、失敗退路、測試計畫）；提示詞草稿 `private/routines/news_morning.v1.prompt.md`、`news_morning.v1test.prompt.md`。使用者同日同意第 10 節三項：正式版只在有非 none 旗標或官方重大事件時推播、CMoney 同學風向改由新聞晨報讀（台股晨報的同學風向步驟併入第三層批次）、測試期 3 個平日含一個週一。等第一層 headlines.json 上線並穩定一天後對齊欄位，再問使用者：試算表加「測試_新聞」分頁、建立測試排程。**10/23**：第一層實際格式已對齊（NEWS_ROUTINE 第 3.1 節）；使用者同意測試，「測試_新聞」分頁已建立，測試排程由使用者在 claude.ai 建立（平日 08:40，10/26～10/28 跑三次後停用）。**10/23 手動試跑不通過**（查證 0/4、漏報、一列多件、模型 Sonnet），修正四項：market-data `url`（5f06c64）、`engine/news_select.py`（6be7918）、提示詞 v1b、模型改 Opus 5.5（API 送完整 job_config）。**10/25 手動試跑通過**（Opus、SHA OK、必寫 2 項、查證 6/10、37 列寫入、6 分鐘）；週末標題清單沒更新，走的是退路，主流程要 10/26 測。小問題 4 項記在 NEWS_ROUTINE 第 8 節，測試期後再改。**待使用者決定**：重新啟用測試排程跑 10/26～10/28（自動模式擋下 API 更新）。
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

## Phase 3～6
- [ ] 尚未開始
