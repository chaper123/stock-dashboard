# 網站資料來源

網站（`site/`）在瀏覽器直接讀下列來源，不需要登入或建置步驟。

## 1. 共用帳本（Google Sheet「發布到網路」）

使用者 2026-10-16 把整份帳本發布成 CSV（有變更時自動重新發布）。只能讀、不能改；要收回時在試算表「檔案 → 共用 → 發布到網路」按「停止發布」。

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vTkKjwqp4RAA2kJ6YPKCHVZCdv8fkUJOS8_S4elsyFQB6nnLs1_oA5S_CHJXbKNc7yJiYlmu0tRcAnH/pub?gid=<gid>&single=true&output=csv
```

| 分頁 | gid | 內容 |
|---|---|---|
| 設定 | 0 | 基準資金、每月入金、單次上限、可用資金、最近一次買入日 |
| 交易紀錄 | 1 | 每筆成交（日期、市場、代號、買賣、股數、成交價、台幣金額、計入資金池…） |
| 持倉 | 2 | 券商確認的股數、總成本、平均成本 |
| 估值快取 | 3 | 美股排程每週更新的 Forward PE、PEG、本益比 |

實測（2026-10-16，從 `https://chaper123.github.io` 發出）：四個分頁都回 200、`text/csv; charset=utf-8`，每頁約 1～1.6 秒，瀏覽器跨網域讀取（CORS）沒有問題。

解析注意：
- 數字是「顯示後的值」，可能帶千分位與引號（例如 `"13,344.00"`），要去掉逗號再轉數字。
- 「設定」分頁前三列是標題與說明，要用 A 欄的項目名稱（例如「可用資金（NT$）」）找值，不要寫死列號。
- Google 重新發布約有 5 分鐘延遲；帳本剛更新時網站可能還是舊值。

## 2. 投資儀表板資料（排程寫入）（Google Sheet「發布到網路」）

使用者 2026-10-27 發布整份文件成 CSV（有變更時自動重新發布）。和帳本一樣只能讀；收回方式相同。

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vRhvnwZeDHTngUJNE92xxFi2cBvrZrBsiCAtrefaDzMfaR268oMF5wmC5b0E77T0yqR6fPEx71PAvlh/pub?gid=<gid>&single=true&output=csv
```

| 分頁 | gid | 內容 | 網站用途 |
|---|---|---|---|
| 報告存檔 | 0 | 每次晨報 1 列：產生時間、市場、資料日、engine、可用資金、上限、合計、精簡 JSON、報告全文 | 總覽的一句話、今日計畫、報告歷史、K 線買區、決策鏈（精簡 JSON 已含買區、狀態、金額，所以網站不另外讀「配置計畫」） |
| 配置計畫 | 1 | 每檔 1 列（同一份精簡 JSON 攤平） | 目前不用 |
| 測試_報告存檔 | 2 | v2 測試期間的存檔 | 不用 |
| 測試_配置計畫 | 3 | 同上 | 不用 |
| 測試_新聞 | 4 | 新聞晨報測試版 16 欄（見 NEWS_ROUTINE 5.1） | 正式分頁沒有較新的資料時退回讀這裡 |
| 新聞 | 5 | 新聞晨報正式版 16 欄（2026-10-28 建立，隨整份文件發布） | 新聞頁、決策鏈的新聞與情緒站、口袋恐懼貪婪儀表。`site/js/config.js` 的 `NEWS_TABS` 同時讀 gid 5 與 4，取資料日較新的、同一天以正式為準；正式版穩定後拿掉 gid 4 |

實測（2026-10-27）：五個分頁都回 200、`text/csv; charset=utf-8`、`Access-Control-Allow-Origin: *`。

解析注意：
- 「報告全文」「精簡JSON」儲存格裡有換行和引號，CSV 解析要支援引號內換行與兩個引號（`site/js/csv.js`）。
- 同一天重跑會多一組列：每個市場取「資料日最新、同資料日產生時間最新」的那列；新聞取最新資料日裡產生時間最新的那組。
- 報告與新聞內容來自網路：報告用 marked 轉換後一律經 DOMPurify 過濾；新聞以純文字放進頁面，網址只接受 http/https。

## 3. 行情資料（chaper123/market-data）

`https://raw.githubusercontent.com/chaper123/market-data/main/data/...`，檔案說明見 market-data 的 README。瀏覽器可直接讀（已由測試頁驗證）；raw 網址有數分鐘快取。
