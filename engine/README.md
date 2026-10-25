# engine

兩個晨報排程用的買點監測程式。檔案從 claude.ai 排程提示詞 v1 **逐字**抽出；檔名保留原名，方便和提示詞比對。

**engine-v1.1（2026-10-16，使用者同意）**：`monitor_us.py` 加上口袋美股的下單限制。每筆最低 50 美元；台幣交割要圈存「委託金額 × 匯率 × 1.03」，所以規則金額換成可下單美元時先扣 3%；不足 50 美元就不下單（使用者選「不足就不買」）。多檔同時有訊號、合計超過 40% 上限時，先照原本等比例縮小，再從優先順序最低的一檔開始拿掉不足 50 美元的（買區越深 → 估值越便宜 → 低於第一買區上緣越多 → config 順序）。買區、估值、匯率濾網與其他規則都沒變；`monitor.py`、`norm.py` 未改。線上 v1 美股排程提示詞同步換成這個版本。

| 檔案 | 來源 | 用途 |
|---|---|---|
| `monitor_us.py` | 美股晨報提示詞「# monitor_us.py（照抄，不要修改）」 | 美股買區與訊號（10 檔，可用資金 40% 上限） |
| `monitor.py` | 台股 ETF 晨報提示詞「# monitor.py（照抄，不要修改）」 | 台股 ETF 買區與訊號（3 檔，60% 上限） |
| `norm.py` | 美股晨報提示詞「norm.py（照抄，不要修改）」 | 鉅亨網日線轉 CSV（只在 v1 的備援舊方法用到） |
| `news_select.py` | 2026-10-23 新寫（不是從提示詞抽出） | 新聞晨報的候選清單：照固定規則篩時間窗、對應標的、排序，標出必寫事項（前一日大幅變動、財報、休市、Fed）。規則見 [docs/NEWS_ROUTINE.md](../docs/NEWS_ROUTINE.md)，測試在 `tests/test_news_select.py`；不影響 monitor 與 engine 的 tag |

## 版本核對

2026-10-16 抽出。提示詞備份（`private/routines/*.v1.prompt.md`）與線上兩個排程的提示詞一致（RemoteTrigger get 比對，只差結尾換行），程式碼區塊與本資料夾逐字相同：

| 檔案 | bytes | 行數 | SHA-256 |
|---|---|---|---|
| `monitor_us.py` | 15877 | 310 | `045d617e4cc19661af7fb4a4104a824370030a25247bd16a4e9556e79d00c84d`（engine-v1.1；v1.0 為 `75947691c28c…`） |
| `monitor.py` | 8579 | 169 | `8c12675c1c9e78a668bd4ea941a7466300cfe39cb24244ab32b8d4e0173e0149` |
| `norm.py` | 1126 | 27 | `a74e16b958dff887b37aa72115e301d8d336521232acdc7609faee44dc666fc2` |

本機重新核對：`py -3.14 tools/extract_engine.py`（需要 private/ 的提示詞備份）。

## 修改規則

- monitor 的規則與可調參數 `P = dict(...)` 只在使用者同意後才改，而且不放寬既有規則。
- 要改時：先取得同意 → 同步改排程提示詞與這裡的檔案 → 更新上表 SHA-256 → 重新產生黃金測試並說明差異。

## 執行

和排程一樣：`python3 engine/monitor_us.py config.json`、`python3 engine/monitor.py config.json`（config 格式見各檔開頭的說明）。需要 pandas、numpy；`norm.py`、`run.py` 在 Windows 需要 tzdata。

## run.py：精簡 JSON

薄包裝，不改 monitor：以模組載入 monitor、呼叫 `main(cfg)`、把印出的 JSON 轉成精簡格式（測試確認包裝後 monitor 的輸出與直接執行逐字相同）。

```bash
python3 engine/run.py us config.json --full monitor_out.json --rows rows.json --ref v0.2.0 > signals.json
python3 engine/run.py tw config.json --full monitor_out.json --rows rows.json --ref v0.2.0 > signals.json
```

- stdout：精簡 JSON 一行（美股約 4.5 千字）。`--full`：monitor 原始輸出（報告表格照舊用它）。`--rows`：試算表的列。`--ref`：排程下載的 engine 版本。
- 遇到不認得的狀態名稱、或美股的 level 與狀態對不上就直接失敗（代表 monitor 被改過，run.py 要同步更新）。

精簡 JSON（`schema_version` 1）：

| 欄位 | 說明 |
|---|---|
| `schema_version` | 1；欄位有不相容的變動才加一 |
| `generated_at` | 產生時間，台北時區 ISO 8601（例如 `2026-10-16T09:21:05+08:00`） |
| `market` | `us`／`tw` |
| `engine` | `monitor`（檔名）、`sha256`（執行時算的）、`ref`（`--ref`，沒給是 null） |
| `data_date` | 各檔最後一根日線日期的最大值 |
| `pool_twd`、`cap_twd`、`total_twd` | 可用資金、本次上限（美股 40%／台股 60%）、規則參考合計 |
| `fx`、`gauge`、`positions` | 只有美股：匯率濾網、IAUM 市場指標、持倉損益（照 monitor） |
| `min_order` | 只有美股（v1.1）：`usd` 最低下單 50、`hold_mult` 1.03、`twd` 今天匯率下 50 美元要圈存的台幣、`pool_needed` 各買區單獨出現時資金池至少要多少才買得到（沒有匯率時後兩個是 null） |
| `idle_reminder` | 只有台股：空手提醒（照 monitor） |
| `tickers[]` | 依 config 順序，每檔一筆，見下表 |

| `tickers[]` 欄位 | 說明 |
|---|---|
| `code`、`role` | 代號；`buy`／`gauge`／`watch`（台股都是 `buy`） |
| `status`、`level` | monitor 的狀態名稱；等級 `overheat` `wait` `starter` `z1` `z2` `z3` `block` `weak` `gauge` `watch` |
| `amount_twd`、`amount_usd`、`hold_twd` | 規則參考金額（已套上限縮放）；美股另有 `amount_usd` 可下單美元（已扣 3% 圈存，無條件捨去到 0.01）、`hold_twd` 預估圈存台幣（v1.1；不足 50 美元時三者都是 0，原因寫在 `why`） |
| `price`、`close`、`date` | 判定用的價格（台股有盤中價就用盤中價）、最近收盤與日期 |
| `dist_to_z1_pct` | 距第一買區上緣 % |
| `zones` | `starter`（只有台股）、`z1`～`z3`：[下緣, 上緣] |
| `trend`、`rsi`、`bias` | 趨勢、RSI14、乖離（美股對 MA50；台股用判定價對 MA20） |
| `why`、`issues` | 降級／禁買原因、資料檢查 |
| `event` | config 的事件旗標 |
| 美股：`chg1`、`valuation`、`val_now` | 前一日漲跌 %、估值分級、換算後的估值 |
| 台股：`held`、`premium`、`intraday` | config 的持有、溢價、盤中價 |

`--rows` 的內容：`archive_header`／`archive_row`（報告存檔一列，最後一格「報告全文」由排程填）、`plan_header`／`plan_rows`（配置計畫每檔一列）。欄位見 `run.py` 的 `ARCHIVE_HEADER`、`PLAN_HEADER`；「儀表板資料」試算表建立前仍可調整。浮點數四捨五入到小數 4 位。
