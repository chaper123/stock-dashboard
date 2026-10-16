# engine

兩個晨報排程用的買點監測程式。檔案從 claude.ai 排程提示詞 v1 **逐字**抽出，邏輯一行都沒改；檔名保留原名，方便和提示詞比對。

| 檔案 | 來源 | 用途 |
|---|---|---|
| `monitor_us.py` | 美股晨報提示詞「# monitor_us.py（照抄，不要修改）」 | 美股買區與訊號（10 檔，可用資金 40% 上限） |
| `monitor.py` | 台股 ETF 晨報提示詞「# monitor.py（照抄，不要修改）」 | 台股 ETF 買區與訊號（3 檔，60% 上限） |
| `norm.py` | 美股晨報提示詞「norm.py（照抄，不要修改）」 | 鉅亨網日線轉 CSV（只在 v1 的備援舊方法用到） |

## 版本核對

2026-10-16 抽出。提示詞備份（`private/routines/*.v1.prompt.md`）與線上兩個排程的提示詞一致（RemoteTrigger get 比對，只差結尾換行），程式碼區塊與本資料夾逐字相同：

| 檔案 | bytes | 行數 | SHA-256 |
|---|---|---|---|
| `monitor_us.py` | 12348 | 251 | `75947691c28c4a2ecbf44781243541bdea0062b3eaab899c1bd63106343951e3` |
| `monitor.py` | 8579 | 169 | `8c12675c1c9e78a668bd4ea941a7466300cfe39cb24244ab32b8d4e0173e0149` |
| `norm.py` | 1126 | 27 | `a74e16b958dff887b37aa72115e301d8d336521232acdc7609faee44dc666fc2` |

本機重新核對：`py -3.12 tools/extract_engine.py`（需要 private/ 的提示詞備份）。

## 修改規則

- monitor 的規則與可調參數 `P = dict(...)` 只在使用者同意後才改，而且不放寬既有規則。
- 要改時：先取得同意 → 同步改排程提示詞與這裡的檔案 → 更新上表 SHA-256 → 重新產生黃金測試並說明差異。

## 執行

和排程一樣：`python3 engine/monitor_us.py config.json`、`python3 engine/monitor.py config.json`（config 格式見各檔開頭的說明）。需要 pandas、numpy；`norm.py` 在 Windows 需要 tzdata。
