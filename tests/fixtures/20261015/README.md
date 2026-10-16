# 2026-10-15 收盤快照

黃金測試用的固定資料，從 chaper123/market-data commit `8a9a1a15501ff31835710e4e97428a3e1beebeb4`（bot「data 2026-10-16 12:47」，日線已改用 MoneyDJ／官方之後的第一次完整抓取）原樣複製（`git show <commit>:data/...`），不再更新。

| 路徑 | 內容 |
|---|---|
| `us/*.csv` | 美股 10 檔日線，最後一根 2026-10-15（SPCX 從 2026-06-12 開始） |
| `tw/*_norm.csv` | 台股 3 檔日線，最後一根 2026-10-15 |
| `tw/nav_history.csv` | 淨值與折溢價（10/15：009816 +0.50%、00981A +1.00%、00411A +0.20%） |
| `fx/usdtwd_bot_sell.csv` | 台銀美元即期賣出（FinMind），最後一筆 2026-10-15 32.315 |
| `fx/usdtwd_mid.csv` | 美元兌台幣中間價（Yahoo，備援；最後一列 10/16 是盤中值） |
| `valuation/us.json` | 估值（stockanalysis，頁面股價日 10/15） |

config（路徑相對於本資料夾）：

| 檔案 | 用途 |
|---|---|
| `config_us.json` | 美股，比照 10/16 正式執行：可用資金 2,580、GOOGL／VOO 持倉、估值用 10/12 快取（提示詞範例）、event 全 none；匯率改用 repo 的台銀檔（v2 做法） |
| `config_us_repo_val.json` | 美股，估值改用 `valuation/us.json`（v2 做法），NVDA event=block、SPCX event=boost |
| `config_tw.json` | 台股，與 10/16 10:17 正式執行相同：可用資金 2,580、距上次買入 1 天、溢價與 09:46 盤中價 |
| `config_tw_close.json` | 台股，休市寫法（盤中價 null 改用前收）：可用資金 9,600、空手 31 天、溢價缺值／2.00%／4.47%、boost 與 block |
