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
3. Phase 1 第 1～6 項實作中（分支 session，進度見下方勾選）；第 7 項 SEC 之後再做（UA 信箱從 Actions secret 讀）。

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
  - [ ] ⑥ 主動 ETF 每日持股（統一投信），比對前十大變化
  - [ ] 台北白天手動觸發 fetch，確認 meta.json 新舊資料集都 ok
- 備註：Actions 提示 `ubuntu-latest` 自 2026-10-19 起改用 Ubuntu 26，之後第一次排程留意是否正常。

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

## Phase 2～6
- [ ] 尚未開始
