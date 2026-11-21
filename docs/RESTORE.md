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

bundle 不需要先驗證，clone 成功就代表可用。clone 回來的 `main` 是備份當天 origin/main 的位置。其他分支在 `origin/*`；一般 clone 之後，備份當時只在這台電腦、還沒推上 GitHub 的分支（例如還沒合併的功能分支）出現在 `origin/local/*`（`git branch -r` 看得到）。

搬到新主機（先在新主機建立空的 repo，下面的網址換成新網址）。**一定要用 mirror**：一般 clone 只會建出 `main` 一個本機分支，`git push --all` 會漏掉其他分支與 `local/*`。三步照順序：

```powershell
git clone --mirror "<雲端路徑>\完整歷史\2026-11-21\market-data.bundle" C:\restore\market-data.git
cd C:\restore\market-data.git
git remote set-url origin https://新主機/帳號/market-data.git
git push --mirror
```

`set-url` 不能省：mirror clone 的 `origin` 指向 bundle 檔本身，不改的話 `push --mirror` 只會推回那個檔案。tags 會一起推過去，不用另外 `git push --tags`。要在這個 repo 上工作的話，另外對 `market-data.git` 做一次一般的 `git clone`。

## 5. GitHub 不能用時，怎麼讓網站活過來

`site/` 是純靜態網站（沒有建置步驟），可以放到任何靜態主機。網站讀的外部資料有兩種：

- **行情資料**（market-data 的 `data/`）：`site/js/config.js` 裡 `SOURCES.market` 與 `SOURCES.candidates` 目前指向 `raw.githubusercontent.com/chaper123/market-data/main/data/`。還原時把 market-data 解壓縮出來的 `data\` 資料夾複製到 `site\data\`，把這兩個網址改成相對路徑（`"data/"` 與 `"data/candidates/"`）。
- **私人持股頁**（`site/js/private.js`）：在瀏覽器裡用 GitHub token 經 `api.github.com` 讀私人 repo（market-data-private）。GitHub 不能用的時候這個頁面會停住（token 失效、讀不到）；這是故意的：持股資料只能還原到私人的位置（私人 Git repo 或本機資料夾），**絕對不要放進 `site/data/` 或任何公開的主機**，要看持股就改在本機打開還原出來的私人資料夾。
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

| workflow | 檔案 | 觸發 | cron-job.org 的工作名稱 |
|---|---|---|---|
| fetch-market-data | `fetch.yml` | GitHub 排程（台北週一～六 05:13、06:37、07:53、08:41、09:47）＋cron-job.org 美東 17:15（週一～五，台北隔天 06:15）以 workflow_dispatch 觸發 | `fetch`（06:15） |
| news-headlines | `news.yml` | 只由 cron-job.org 觸發：台北 08:20、11:10，2026-11-06 起另加 13:40、16:30、21:00（以 `news.yml` 開頭的註解為準；時間可能又改過，以 cron-job.org 現況為準） | `market-data news`（08:20）、`news 1110`（11:10）；13:40、16:30、21:00 三個名稱沿用「news 1110」的格式（HISTORY 沒記完整名稱，看 cron-job.org） |
| longterm-macro | `longterm.yml` | GitHub 排程（景氣燈號每月 27 日～次月 3 日台北 17:40、巴菲特指標每週六台北 09:40） | 無（不由 cron-job.org 觸發） |
| intraday-snapshot | `intraday.yml` | 2026-11-03 停用（只留手動觸發，什麼都不做） | `market-data intraday`、`intraday 1120`、`intraday 1200` 三個已於 2026-11-04 停用，不用重建 |
| probe-sources | `probe.yml` | 手動探測用 | 無 |
| holdings（market-data-private） | `holdings.yml` | GitHub 排程（台北週一～五 21:30、07:00）；程式在公開的 market-data，資料只放私人 repo | 無 |
| deploy-pages（stock-dashboard） | `pages.yml` | push 到 main 且改到 `site/**` 時，把 `site/` 發布到 GitHub Pages | 無 |
| test（stock-dashboard） | `test.yml` | 每次 push 跑測試 | 無 |

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
- **私人 repo 的瀏覽器 token**：私人持股頁（`site/js/private.js`）用的 GitHub token 只存在使用者各個裝置的瀏覽器裡，沒有備份；要重建：GitHub → Settings → Developer settings → fine-grained token，只選 market-data-private、Contents 唯讀，貼到網站的持股頁設定欄。
- **備份看門狗專案**：Google Apps Script 上的獨立專案；原始碼備份在 repo 的 `apps_script/backup_watchdog.gs` 與 `apps_script/backup_watchdog.appsscript.json`。要重建：script.google.com 新增專案、貼上這兩個檔（先在專案設定打開「顯示 appsscript.json」）、重新授權（執行 `selfTest` 或 `dryRun` 時按提示授權）、再執行一次 `installTrigger` 建立每天 9 點的觸發器。觸發器與 Script Properties（提醒紀錄）不在備份裡，要重建；提醒紀錄沒了的結果只是第一天可能多寄一封信。
- **Apps Script 線上版本**：備份的是 repo 裡的 `apps_script/ledger_write.gs`，線上正在跑的版本可能比它新；用到的時候以 Apps Script 編輯器裡的為準。
- **富果（Fugle）金鑰**：只存在使用者自己的瀏覽器裡，沒有備份，要重新申請。
- **同一個 Google 帳號的風險**：備份、帳本試算表、Apps Script 都在同一個 Google 帳號底下。帳號被停權或被盜用時，這些會一起出問題；腳本無法防這個。

## 11. 怎麼確認備份還活著

- 雲端看門狗（Apps Script，每天早上 9～10 點檢查；有問題才寄信給自己，**沒信就是正常**）；它沒裝或沒寄信時，用下面兩項自己看。
- 雲端根目錄的 `最近備份.json`：`last_attempt`／`last_attempt_status` 是最近一次嘗試與結果，`last_ok`／`last_ok_folder` 是最近一次完全成功的時間與資料夾，`last_bundle_folder` 是最新一份完整歷史；`last_ok` 超過 3 天沒更新就有問題（看門狗也是用 3 天；備份每天跑，週末電腦關著時可能晚一兩天，所以不用兩天）。
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

代碼 1、10、11、20 會跳出 Windows 通知；12（另一個備份正在執行）不跳；被工作排程器的時間上限中止（`LastTaskResult` 常是 0x41306 或 267014）也不會跳，要靠看門狗的信發現。

**歷史被改寫（代碼 1、`problems` 寫「歷史被改寫」或「非快轉檢查失敗」）怎麼處理**：

1. 先確認是不是自己做的：是否剛好對那個 repo 做過 force-push、rebase 後強制推送、或 `git filter-repo`。看 `最近備份.json` 的 `problems` 是哪個 repo，到 GitHub 看那個 repo 的 commit 時間線與帳號活動紀錄。**不是自己做的就不要往下做**：當成帳號被盜的事件處理（先換密碼與 token，舊的備份都還在、備份不會因此被刪）。
2. 確定是自己做的：在 PowerShell 執行（repo 名稱是 `stock-dashboard`、`market-data`、`market-data-private` 其中一個，可以重複寫多個）：

```powershell
py -3.14 tools\backup_to_drive.py --accept-rewrite market-data
```

3. 那次備份會記下 `最近備份.json` 的 `rewrite_accepted.<repo>`（確認當下的 commit 與時間），之後以它當「非快轉」比較的起點；那次若其他都正常會變成 OK（`rewrite_accepted` 只在那次 fetch 成功時記錄；fetch 也失敗的話要等網路好了再跑一次）。之後正常的 push 不受影響，下次 force-push 才會再被擋一次。
4. `非快轉檢查失敗` 不是歷史被改寫，是檢查本身出錯（例如本機的 git 物件缺漏）：先對那個 repo 手動 `git fetch origin`，再重跑備份；跑兩次都一樣才需要看 `problems` 裡寫的細節。

## 12. 注意：Google 雲端硬碟桌面版的本機快取不是備份

桌面版在本機的暫存是 Google 自己管的快取，不是一份獨立的本機備份，雲端那份壞了它也跟著壞。備份資料夾**不要設成「鏡像」模式**（鏡像會把檔案完整存在本機，但刪除也會同步，反而更容易一起被刪）。
