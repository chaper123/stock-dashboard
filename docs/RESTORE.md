# 還原說明（備份在 Google 雲端硬碟）

這份文件跟著備份一起存到雲端（腳本會把 origin/main 上最新的版本複製成雲端根目錄的 `還原說明.txt`），所以 GitHub 整個打不開時也看得到。
備份規格與設計理由見 [BACKUP.md](BACKUP.md)。以下指令都在 Windows PowerShell 5.1 執行；沒有 `py` 的話改用 `python`。

## 1. 雲端資料夾長什麼樣子

位置：Google 雲端硬碟 →「stock-dashboard 備份」。**這個資料夾不要分享給任何人**：裡面有信託持股（market-data-private）、`private/`（排程提示詞、規劃筆記）與 Claude 記憶，都不是公開資料。

```
stock-dashboard 備份\
  備份根目錄-請勿刪除.txt      腳本靠它確認雲端硬碟真的掛上了；刪掉的話備份會停（結束代碼 11）
  還原說明.txt                 就是這份文件
  最近備份.json                最近一次嘗試與最近一次成功的時間、狀態、警告、三個 repo 各自最後 fetch 成功的時間
  紀錄\2026-11.log             每次一行：時間、狀態、三個 repo 的 7 碼 commit、總大小、警告數、刪了幾份
  每日\2026-11-21\             每天一份（保留最新 14 份，再加每個月最早的一份，最多 12 個月）
    manifest.json              這份備份的清單：狀態、各檔大小與 sha256、三個 repo 的 commit、警告
    stock-dashboard.zip        origin/main 的所有檔案（解壓縮後多一層 stock-dashboard\ 資料夾）
    market-data.zip            同上（多一層 market-data\）
    market-data-private.zip    同上（多一層 market-data-private\）
    private.zip                C:\stock-dashboard\private\ 的全部內容（沒有外層資料夾）
    claude-memory.zip          Claude 記憶資料夾的全部內容（沒有外層資料夾）
    csv\                       網站讀的 7 個已發布 CSV（ledger-gid0／1／2／10／11、dashboard-gid0／5），原樣存檔
  完整歷史\2026-11-21\         每 7 天一份，保留最新 2 份
    stock-dashboard.bundle、market-data.bundle、market-data-private.bundle   完整 git 歷史
    manifest.json
```

每日 zip 只含 origin/main 的檔案，不含歷史；完整歷史在 `完整歷史\` 的 bundle 裡（最多比每日備份舊 6 天）。

## 2. 先驗證檔案沒壞

manifest.json 記了每個檔案的 sha256。比對方式：

```powershell
Get-FileHash -Algorithm SHA256 "<雲端路徑>\每日\2026-11-21\market-data.zip"
```

輸出的 Hash（不分大小寫）要等於 manifest.json 裡該檔的 `sha256`。manifest 的 `status` 欄：`OK` 表示當天一切正常；`STALE` 表示有 repo 當天 fetch 失敗、zip 是它最後一次成功 fetch 的內容；`PARTIAL` 表示有檔案失敗或發現歷史被改寫，`warnings` 與 `problems` 寫了原因。

## 3. 只要最新的檔案

選最新、`status` 是 `OK` 的那份每日備份，直接解壓縮（zip 裡已經有 `<repo>\` 這一層）：

```powershell
Expand-Archive "<雲端路徑>\每日\2026-11-21\stock-dashboard.zip" C:\restore
Expand-Archive "<雲端路徑>\每日\2026-11-21\market-data.zip" C:\restore
```

得到 `C:\restore\stock-dashboard\`、`C:\restore\market-data\`。這樣解出來的資料夾不是 git repo（沒有 `.git`）；要歷史請看下一點。

## 4. 要完整歷史（搬到新的 Git 主機、或回到某個舊版本）

```powershell
git clone "<雲端路徑>\完整歷史\2026-11-21\market-data.bundle" C:\restore\market-data
```

bundle 不需要先驗證，clone 成功就代表可用。clone 回來的 `main` 是備份當天 origin/main 的位置。分支 `local/<名稱>` 是備份當時只在這台電腦、還沒推上 GitHub 的分支（例如還沒合併的功能分支）。

搬到新主機（先在新主機建立空的 repo，下面的網址換成新網址）：

```powershell
cd C:\restore\market-data
git remote set-url origin https://新主機/帳號/market-data.git
git push --all
git push --tags
```

## 5. GitHub 不能用時，怎麼讓網站活過來

`site/` 是純靜態網站（沒有建置步驟），可以放到任何靜態主機。網站讀的外部資料有兩種：

- **行情資料**（market-data 的 `data/`）：`site/js/config.js` 裡 `SOURCES.market` 與 `SOURCES.candidates` 目前指向 `raw.githubusercontent.com/chaper123/market-data/main/data/`。還原時把 market-data 解壓縮出來的 `data\` 資料夾複製到 `site\data\`，把這兩個網址改成相對路徑（`"data/"` 與 `"data/candidates/"`）。
- **Google 試算表的已發布 CSV**（帳本、儀表板資料）：不在 GitHub 上，網站直接向 Google 讀，不用改。帳本寫入用的 Apps Script 也在 Google 上，不受影響。
- 改了網站檔案後，把 `site/sw.js` 的 `VERSION` 加一，使用者的瀏覽器才會抓新版。換主機之後網站網址不同，`sw.js` 的 `DATA_HOSTS` 不用動（資料已經變成同源的相對路徑）。

放到哪裡都可以：Cloudflare Pages、Netlify（把 `site` 資料夾拖進去就能發布），或先在本機確認：

```powershell
cd C:\restore\stock-dashboard
py -3.14 -m http.server 8765 --directory site
```

瀏覽器開 `http://localhost:8765`。

## 6. 讓 market-data 繼續更新

資料是 GitHub Actions 抓的，設定都在 zip 裡的 `market-data\.github\workflows\*.yml`：

| workflow | 檔案 | 觸發 |
|---|---|---|
| fetch-market-data | `fetch.yml` | GitHub 排程（台北週一～六 05:13、06:37、07:53、08:41、09:47）＋cron-job.org 美東 17:15（週一～五）以 workflow_dispatch 觸發 |
| news-headlines | `news.yml` | 只由 cron-job.org 觸發：台北 08:20、11:10，2026-11-06 起另加 13:40、16:30、21:00（以 `news.yml` 開頭的註解為準；時間可能又改過，以 cron-job.org 現況為準） |
| longterm-macro | `longterm.yml` | GitHub 排程（景氣燈號每月 27 日～次月 3 日台北 17:40、巴菲特指標每週六台北 09:40） |
| intraday-snapshot | `intraday.yml` | 2026-11-03 停用（只留手動觸發，什麼都不做）；cron-job.org 的 intraday 工作應該已暫停 |
| probe | `probe.yml` | 手動探測用 |
| holdings（market-data-private） | `holdings.yml` | GitHub 排程（台北週一～五 21:30、07:00）；程式在公開的 market-data，資料只放私人 repo |
| deploy-pages（stock-dashboard） | `pages.yml` | push 到 main 且改到 `site/**` 時，把 `site/` 發布到 GitHub Pages |
| test（stock-dashboard） | `test.yml` | 每次 push 跑測試 |

新的環境要重現：把 yml 裡的指令（安裝套件、`python fetch.py` 之類）在本機或新的 CI 照樣執行，產出放回 `data\`；程式碼的細節看 market-data 的 `README.md`。cron-job.org 的工作（名稱、觸發的 workflow、時間如上表）要改成呼叫新的觸發方式，工作的 token 要重新建立，備份裡沒有 token。

## 7. 私人 repo（market-data-private）

裡面是 00981A、009816 的每日持股（投信網站不允許轉載）。只能還原到私人的地方：私人 Git repo 或本機資料夾，**絕對不要放到公開的 repo 或公開網站**。

## 8. private 資料夾與 Claude 記憶

這兩個 zip 沒有外層資料夾，解壓縮時直接指定目的地（**不要放進 git**）：

```powershell
Expand-Archive "<雲端路徑>\每日\2026-11-21\private.zip" C:\stock-dashboard\private
Expand-Archive "<雲端路徑>\每日\2026-11-21\claude-memory.zip" "$env:USERPROFILE\.claude\projects\C--stock-dashboard\memory"
```

`private\routines\` 裡有排程提示詞與 claude.ai 排程 ID。

## 9. 試算表（CSV）

`csv\` 裡的檔案是網站讀的 7 個已發布分頁：帳本的「設定」（gid 0）、交易（1）、持股（2）、定投金額（10）、其他入帳（11），儀表板資料的 archive（0）、新聞（5）。要重建：在 Google 試算表新增空白分頁，「檔案 → 匯入 → 上傳」，選對應的 CSV、「取代目前的工作表」。**第一道保護是試算表自己的版本記錄**（檔案 → 版本記錄），CSV 是最後一道。重建後要重新「發布到網路」，gid 會變，網站 `site/js/config.js` 要跟著改。

## 10. 備份裡沒有的東西

- **GitHub Secrets 與 Variables**：2026-11-21 用 `gh secret list`、`gh variable list` 查過，三個 repo（stock-dashboard、market-data、market-data-private）都沒有任何 Secret 或 Variable，workflow 只用內建的 `GITHUB_TOKEN`。之後如果新增，就要另外記下名稱（值本來就無法讀出來）。
- **GitHub Pages 設定**：目前是「來源 = GitHub Actions」（`pages.yml` 發布）。新建時在 repo 的 Settings → Pages 選同樣設定。
- **cron-job.org 帳號與工作的 token**：要重建（見第 6 點的工作清單）；token 是 fine-grained，只限 market-data 的 Actions 讀寫，2027-10-20 到期。
- **Apps Script 線上版本**：備份的是 repo 裡的 `apps_script/ledger_write.gs`，線上正在跑的版本可能比它新；用到的時候以 Apps Script 編輯器裡的為準。
- **富果（Fugle）金鑰**：只存在使用者自己的瀏覽器裡，沒有備份，要重新申請。
- **同一個 Google 帳號的風險**：備份、帳本試算表、Apps Script 都在同一個 Google 帳號底下。帳號被停權或被盜用時，這些會一起出問題；腳本無法防這個。

## 11. 怎麼確認備份還活著

- 雲端根目錄的 `最近備份.json`：`last_attempt` 是最近一次嘗試，`last_ok` 是最近一次完全成功；`last_ok` 超過兩天沒更新就有問題。
- 本機排程：

```powershell
Get-ScheduledTaskInfo StockDashboardBackup | Select-Object LastRunTime, LastTaskResult
```

`LastTaskResult` 就是腳本的結束代碼：

| 代碼 | 意思 |
|---|---|
| 0 | 正常（OK） |
| 1 | STALE 或 PARTIAL（有 repo fetch 失敗，或有檔案失敗／發現歷史被改寫），舊備份不會被清掉；看 `最近備份.json` 的 `problems` |
| 10 | 雲端硬碟沒有掛上（等了 10 分鐘） |
| 11 | 找到備份資料夾但沒有「備份根目錄-請勿刪除.txt」（被刪了？） |
| 12 | 另一個備份正在執行 |
| 20 | 腳本發生未預期的錯誤 |

不是 0 時，會跳出 Windows 通知。

## 12. 注意：Google 雲端硬碟桌面版的本機快取不是備份

桌面版在本機的暫存是 Google 自己管的快取，不是一份獨立的本機備份，雲端那份壞了它也跟著壞。備份資料夾**不要設成「鏡像」模式**（鏡像會把檔案完整存在本機，但刪除也會同步，反而更容易一起被刪）。
