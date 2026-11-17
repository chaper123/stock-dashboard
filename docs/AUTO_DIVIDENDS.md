# 配息自動記帳與預計配息（規格）

> 使用者 2026-11-18：「要加（預計配息與入帳提醒），還有我不想每次都手動填入利息資料」。前一步的決定見 [OTHER_INCOME.md](OTHER_INCOME.md)：
> 配息與手續費折抵算進可用資金，記在帳本新分頁「其他入帳」。
>
> 做法：帳本綁定的 Apps Script 每天自動跑一次，用 market-data 的配息資料 × 除息前一天的持股，算出估算金額，在發放日之後**自動加一列**到「其他入帳」。
> 使用者不用填；想要跟錢包實收一模一樣時，可以改那一列的台幣金額（腳本不會蓋掉）。網站另外列出接下來的預計配息與最近自動記入的配息。
>
> 為什麼不從新聞抓：market-data 已經有官方開放資料（台股：FinMind＋證交所除權除息預告表），比新聞準；新聞晨報寫的是公開分頁，不能用使用者的股數。
>
> **手續費折抵不自動**：錢包紀錄看起來是每筆委託退 1 元、隔月 8～13 日入帳（4 月台 3 美 2 → 5 元、5 月 3 筆 → 3 元、6 月 1 筆 → 1 元、7 月 2 筆 → 2 元），
> 但 9 月有 2 筆委託（9/09 賣 00735、9/29 買 GOOGL），到 11/09 都沒有看到折抵，規則不確定，不自動算。金額是個位數，使用者看到再記或不記都可以。

## 1. market-data：美股配息（`market-data 維護` session）

- 新檔 `data/dividends/us.json`：`config.json` 的 `us` 裡 `role` 是 `buy` 的代號（現在是 VOO、GOOGL、NVDA、TSLA、SPCX、AAPL），
  來源 Yahoo chart API 加 `events=div`（`range=5y`），每次配息 `{ ex_date, cash }`（cash＝每股美元，稅前），依除息日排序；`last`、`ttm_cash`、`ttm_count` 照台股那份的寫法。
  抓不到的代號沿用上一次的檔，不讓事件消失；全部失敗才標 `dividends/us` 失敗。沒有配息的代號 `events` 是空陣列。
- `data/meta.json` 多一個 `dividends/us`；README 補一行；測試照 `tests/test_dividends.py` 的寫法。
- 跟著每天的 fetch 跑（不多開排程）。

## 2. Apps Script：每天自動記配息（`apps_script/ledger_write.gs`）

### 2.1 什麼時候記哪一筆
- 新函式 `autoDividends()`：讀 market-data 的 `dividends/tw_etf.json`、`dividends/us.json`、`fx/usdtwd_mid.csv`
  （網址前綴 `https://raw.githubusercontent.com/chaper123/market-data/main/data/`，`UrlFetchApp`；抓不到就這次不寫，隔天再試）。
- 只處理**除息日在 `AUTO_DIV_START`（2026-11-18）當天或以後**的配息。以前的由使用者手動記（已經在記），避免重複。
- 持股：讀「交易紀錄」（拿掉沖銷的一對，同記帳頁的規則），除息日**前**（日期小於除息日）的買進減賣出＝領得到的股數。股數是 0 就不記。
- 台股：要有 `pay_date` 而且 `pay_date` ≤ 今天（台北）才記；`pay_date` 還是空的就等。
  美股：Yahoo 沒有發放日，用**除息日＋7 天**當入帳日，到了才記。
- 不重複：「其他入帳」已經有同代號、類型「配息」、K 欄「除息日」相同的列就跳過（不管那一列是不是使用者改過）。

### 2.2 寫進去的那一列（只新增，絕不修改或刪除既有的列）
| 欄 | 台股 | 美股 |
|---|---|---|
| A 入帳日 | `pay_date` | 除息日＋7 天 |
| B 市場 | 台股 | 美股 |
| C 代號 | 代號 | 代號 |
| D 類型 | 配息 | 配息 |
| E 原幣金額 | 空白 | 股數 × 每股 × 0.7（扣 30% 預扣稅，留 4 位小數） |
| F 幣別 | 空白 | USD |
| G 台幣金額 | `round(股數 × 每單位)` | `round(E × 入帳日或之前最近的美元兌台幣中間價)` |
| H 計入資金池 | 入帳日 ≥「設定」的基準日 →「是」，否則「否」 | 同左 |
| I 來源 | 自動估算 | 自動估算 |
| J 備註 | `除息 MM/DD，每單位 X 元 × 除息前 N 股；跟錢包實收不同可以直接改 G 欄` | `除息 MM/DD，每股 US$X × N 股，扣 30% 預扣稅，匯率 Y；跟錢包實收不同可以直接改 G 欄` |
| K 除息日 | `ex_date` | `ex_date` |

- 用 `LockService` 跟網站記帳的寫入互斥。每次跑完把結果（時間、新增幾列、錯誤）存進 Script Properties，`ping`／`status` 回應帶上
  `autoDividends: { lastRun, added, error }`，網站拿來顯示。
- 觸發器：`installDividendTrigger()`（使用者在 Apps Script 編輯器手動執行一次）建立每天台北 09:00～10:00 的時間觸發；已經有就不重複建；`removeDividendTrigger()` 拿掉。
- 新的權限（`script.external_request`、`script.scriptapp`）：使用者更新 Apps Script 時要重新授權（教學 session 帶）。
- 測試：`tests/apps_script/ledger_write_test.js` 的模擬環境加 `UrlFetchApp`、`LockService`、`PropertiesService` 的替身，至少測：
  除息前股數（含除息日當天買的不算、賣光的不算）；台股沒有 `pay_date` 不記、`pay_date` 未到不記；美股入帳日＝除息日＋7；
  重複跑不會多記；使用者改過 G 欄的列不會被動到；`AUTO_DIV_START` 以前的不記；基準日前後的 H 欄；抓不到資料時不寫任何列。

## 3. 網站：預計配息（資產頁）

- 資產頁「現金與投入」卡下面加一張「配息」卡：
  - **接下來**：每檔現在持有的標的。台股用 `tw_etf.json` 的 `next`（除息日、每單位、發放日）；美股沒有未來的除息日，寫「上次除息 MM/DD，每股 US$X（約每季一次）」。
    預估金額＝現在股數 × 每單位（美股再 × 0.7 × 最新匯率），寫明是估算。60 天內沒有除息的寫「最近沒有除息」。
  - **最近入帳**：「其他入帳」類型是配息的最近 5 列（日期、代號、台幣金額、來源）。來源是「自動估算」的標「估算」，小字說明「Apps Script 每天自動記；跟錢包實收不同可以改帳本的 G 欄」。
  - **自動記帳狀態**：讀得到 Apps Script 的 `autoDividends` 狀態就寫「上次自動檢查：MM/DD HH:mm」，有錯誤寫錯誤；讀不到（沒設定記帳連線）就不顯示這行。
- 「其他入帳」的 K 欄「除息日」讀成 `exDate`（OTHER_INCOME 的 `loadIncome` 補這個欄位）。組合績效照 OTHER_INCOME 第 2.5 節：台股配息列不算（已經用除息資料算過），美股配息列算。

## 4. 帳本（教學 session 帶使用者）

- 「其他入帳」表頭多一欄 **K「除息日」**（OTHER_INCOME 第 1 節的十欄之後）。手動記的配息知道除息日就填，不知道可以空白。
- Apps Script 更新後：貼上新程式、部署新版本、重新授權、在編輯器執行一次 `installDividendTrigger`，再執行一次 `autoDividends` 確認沒有錯誤（這時應該不會新增任何列）。

## 5. 驗收

- market-data：`us.json` 有 VOO、GOOGL 最近幾次配息，VOO 2026 年 6 月底、9 月底那兩次存在（錢包 7/06、10/05 入帳的那兩筆）；pytest 全過。
- Apps Script：測試全過。用 2026 年的資料試算（測試裡），VOO 0.1262 股的季配估算約 5 元（跟錢包一致）、00981A 141 股 × 0.63＝89 元。
- 網站：測試頁補「配息」卡的純函式（預估金額、60 天內篩選、最近入帳排序）；既有測試頁、pytest 全過；本機預覽資產頁桌面與 375 寬、console 沒有錯誤。

## 6. 順序與分工

1. 帳本 K 欄：跟 OTHER_INCOME 的分頁一起建（教學 session，現在）。
2. market-data 美股配息（market-data 維護 session，跟 3 平行）。
3. 網站實作：OTHER_INCOME 做完後接著做第 2、3 節（Apps Script＋配息卡），分支上做、不 push。
4. 主 session 審查 → 使用者說「部署」→ 部署 session 合併上線；Apps Script 由教學 session 帶使用者更新與裝觸發器。
5. 第一筆自動記帳預計是 GOOGL（12 月中）或 00981A（12 月中除息、1 月上旬發放）。

## 7. 進度

- 2026-11-18 market-data 維護做完第 1 節（market-data `48a22e1`，還沒 push）；主 session 審查通過，VOO 6/26、9/28 兩次配息都在。
- 2026-11-18 網站實作做完第 2、3 節（分支 `claude/funds-fire-30y-122524`：`94c0bf2` Apps Script、`1a39613` 配息卡、`8c81f14` 試算頁文字）。
  主 session 審查通過：只新增不改列、代號＋除息日去重、除息日前持股（沖銷互抵）、`AUTO_DIV_START`、美股除息＋7 天、LockService、觸發器不重複建都符合規格；
  Apps Script 測試 59 項（含 VOO 0.1262 股約 5 元、00981A 141 × 0.63＝89）、網頁測試 15 頁、pytest 301 全過；資產頁桌面與 375 寬正常。
- 上線順序：market-data push（us.json 產出）→ 網站部署 → 教學 session 帶使用者更新 Apps Script、裝觸發器（us.json 還沒有時 `autoDividends` 會記錯誤、不寫列）。
- 已知限制（不擋上線）：使用者在 11/18 以後手動記的配息沒填 K 欄除息日的話，腳本認不出來、會再記一列估算；美股成交日若用台灣日期，除息日前一晚的成交可能差一天。
- 2026-11-18 網站上線（2026-11-18-2）。
- 2026-11-18（凌晨）正式帳本的 Apps Script 更新完成（教學 session 帶使用者）：貼上 main 的 `apps_script/ledger_write.gs`，用「管理部署作業→編輯→新版本」（說明「自動記配息」）發布，網址不變；重新授權多了「連線至外部服務」「在未受監控狀態下自動執行」兩項；`installDividendTrigger` 建了 1 個每天台北 09:00～10:00 的 `autoDividends` 觸發器；手動執行 `autoDividends`（02:03）沒有錯誤，「其他入帳」仍是 6 列；網站「測試連線」成功、「對帳」7 條 ✓，配息卡顯示「上次自動檢查：11/18 02:03，沒有新增」。
- 第一次自動執行在 11/19 台北 09:00～10:00：請使用者在有設定記帳連線的裝置看配息卡「上次自動檢查」是 11/19 09～10 點、沒有錯誤，或看 Apps Script「觸發條件」的上次執行時間。
