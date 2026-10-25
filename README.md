# stock-dashboard

台美股共用資金池的投資儀表板：集中觀測「美股晨報」與「台股 ETF 晨報」兩個排程的產出，跨市場排序已進買區的標的、重新分配資金並規劃分批買進。網站以 GitHub Pages 發布，手機可看。

- 行情資料：[chaper123/market-data](https://github.com/chaper123/market-data)（GitHub Actions 每個工作日抓取）
- 計畫：[docs/PLAN.md](docs/PLAN.md)
- 進度：[docs/PROGRESS.md](docs/PROGRESS.md)
- 排程提示詞 v2 規劃：[docs/ROUTINE_V2.md](docs/ROUTINE_V2.md)

## 目錄

| 路徑 | 內容 |
|---|---|
| `site/` | 靜態網站（GitHub Pages 發布這個資料夾） |
| `engine/` | 排程用的買點監測程式（從提示詞 v1 逐字搬出）與精簡 JSON 包裝 `run.py`，見 [engine/README.md](engine/README.md) |
| `tests/` | pytest：黃金測試、規則邊界、回放（`py -3.14 -m pytest`；CI 每次 push 執行） |
| `tools/` | 開發用工具（提交前檢查等） |
| `.githooks/` | Git hooks（`git config core.hooksPath .githooks`） |
| `private/` | 本機私密檔案，**不進 git** |

## 注意

所有訊號都是依使用者自訂規則計算的結果，不是投資建議；本專案不下單、不連券商帳戶。
