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

## 2. 行情資料（chaper123/market-data）

`https://raw.githubusercontent.com/chaper123/market-data/main/data/...`，檔案說明見 market-data 的 README。瀏覽器可直接讀（已由測試頁驗證）；raw 網址有數分鐘快取。
