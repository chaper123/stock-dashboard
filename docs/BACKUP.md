# 備份到 Google 雲端硬碟（規格）

## 0. 背景與決定

- 使用者 2026-11-21 擔心「哪天 GitHub 不給用，我的網站就全沒了」。查證結果（主 session 的 3 個子代理研究）：用量離 GitHub 上限很遠，真正的風險是所有東西都放在同一個 GitHub 帳號。
- 使用者原話：「不要存在本機改備份在google雲端硬碟」。
- 2026-11-21 再查證一次（還原演練、工作排程器與雲端硬碟、Apps Script 替代做法、挑錯審查），決定：
  - **電腦每天跑一支 Python 腳本，寫進 Google 雲端硬碟電腦版的 `G:`**（串流模式，本機只有 Google 程式自己的暫存）。
  - **不用 Apps Script 備份 repo**：私人 repo 要多管一把會過期的 GitHub token，換來的只有 0.02 MB；公開 repo 的雲端副本只有在電腦和 GitHub 同時壞掉時才用得到。
  - 寫不進雲端硬碟時**不退回寫本機**，失敗就通知。
- 要備份的東西：

  | 東西 | 為什麼 | 怎麼備 |
  |---|---|---|
  | 三個 repo（stock-dashboard、market-data、market-data-private） | 本機 clone 常落後（11/21 時 market-data 差 18 個 commit、private 差 20 個） | 每天：fetch 後打包 origin/main 的檔案（zip）；每 7 天：完整 git 歷史（bundle） |
  | `C:\stock-dashboard\private\` | 只存在這台電腦（排程提示詞、排程 ID、退回用舊版） | 每天 zip |
  | Claude 記憶資料夾 `%USERPROFILE%\.claude\projects\C--stock-dashboard\memory\` | 只存在這台電腦（29 KB） | 每天 zip |
  | 網站讀的 7 個發布 CSV（帳本 gid 0、1、2、10、11；儀表板資料 gid 0、5） | 試算表本身有版本紀錄，這只是多一份 | 每天下載 |

- **沒防到的事**：帳本和備份都在同一個 Google 帳號，Google 帳號出事會一起不見。寫進還原說明。
- **雲端看門狗**：使用者 2026-11-21 回答「要，加上」。另一個獨立的 Apps Script 專案，每天從雲端核對備份真的上傳了、沒有停、沒有被分享，有問題才寄信給自己（第 13 節）。原因：電腦長期沒開、排程被停用、雲端硬碟暫停同步或容量滿時，電腦那邊不會有任何訊息；「真的上傳了」也只有從雲端那一側看得到。
- 實測大小（2026-11-21）：每天約 5 MB；完整歷史約 19 MB（market-data 17.5 MB，因為 `data/news/headlines.json` 每次整檔重寫，每月約多 30 MB）。一年後總量估 1 GB 以內。

## 1. 檔案

| 檔案 | 說明 |
|---|---|
| `tools/backup_to_drive.py` | 新增。**只用標準庫**。本機用 `pyw.exe -3.14` 跑（沒有主控台視窗）；純邏輯要能在 CI 的 Linux 3.12、3.13、3.14 被 import 和測試，所以檔案最上層不能 import Windows 專屬模組，Windows 專屬的東西放在函式裡。 |
| `tests/test_backup_to_drive.py` | 新增。只測純邏輯（見第 10 節）。 |
| `docs/RESTORE.md` | 新增。還原說明（第 9 節）。腳本每次把 origin/main 版複製到雲端的 `還原說明.txt`，內容有變才覆寫。 |
| `apps_script/backup_watchdog.gs`、`apps_script/backup_watchdog.appsscript.json` | 新增。雲端看門狗（第 13 節）與它的權限設定檔。 |
| `docs/BACKUP.md` | 本檔，做完補第 12 節進度。 |

## 2. 參數（檔頭）

```python
P = dict(
    DRIVE_DIR_NAME="stock-dashboard 備份",
    DRIVE_ROOT_NAMES=("我的雲端硬碟", "My Drive"),
    MARKER="備份根目錄-請勿刪除.txt",
    REPOS={"stock-dashboard": r"C:\stock-dashboard",
           "market-data": r"C:\market-data",
           "market-data-private": r"C:\market-data-private"},
    PRIVATE_DIR=r"C:\stock-dashboard\private",
    MEMORY_DIR=r"%USERPROFILE%\.claude\projects\C--stock-dashboard\memory",
    KEEP_DAILY=14, KEEP_MONTHLY=12, MAX_DELETE_PER_RUN=3,
    BUNDLE_EVERY_DAYS=7, KEEP_BUNDLES=2,
    DRIVE_WAIT_SEC=600, FETCH_TIMEOUT_SEC=180, FETCH_TRIES=2,
    MARKET_STALE_DAYS=4, ZIP_WARN_MB=50,
)
```

旗標：`--dry-run`（只列計畫，不寫任何檔）、`--init`（建立雲端資料夾與標記檔，只有這個旗標會建資料夾）、`--force-bundle`、`--allow-delete N`、`--no-notify`、`--root <路徑>`（測試用：跳過找雲端硬碟，直接把這個資料夾當備份根目錄；仍要有標記檔）。

## 3. 雲端資料夾結構

```
G:\我的雲端硬碟\stock-dashboard 備份\
  備份根目錄-請勿刪除.txt      只由 --init 建立
  還原說明.txt                 docs/RESTORE.md（origin/main 版），內容有變才覆寫
  最近備份.json                last_attempt、last_ok、status、warnings、各 repo 的 last_fetch_ok_at
  紀錄\2026-11.log             每月一個檔，每次執行追加一行
  每日\2026-11-21\
     manifest.json
     stock-dashboard.zip  market-data.zip  market-data-private.zip
     private.zip  claude-memory.zip
     csv\<名稱>-gid<N>.csv     共 7 個，不壓縮
  完整歷史\2026-11-21\
     stock-dashboard.bundle  market-data.bundle  market-data-private.bundle  manifest.json
```

## 4. 每次執行的流程

**時間一律用固定的台北時間 `timezone(timedelta(hours=8))`，不要用 `zoneinfo`**：Windows 的 zoneinfo 要另外裝 tzdata，而在 Claude 裡 `pip install --user` 的套件，排程（Claude 以外）看不到。日期與資料夾名稱都用台北日期。

0. **鎖**：`%TEMP%\sdbackup.lock`（O_EXCL 建立；超過 2 小時視為殘留，可以取代）。拿不到鎖 → 結束碼 12。
1. **找雲端硬碟**：掃 D～Z 磁碟機，找 `<DRIVE_ROOT_NAMES 其一>\<DRIVE_DIR_NAME>\<MARKER>`，同時確認 `GoogleDriveFS.exe` 在跑（`tasklist` 加 CREATE_NO_WINDOW）。找不到就每 30 秒重試，最多 `DRIVE_WAIT_SEC`（開機補跑時雲端硬碟可能還沒掛上）。還是失敗：通知，結束碼 10（找到資料夾但沒有標記檔：11）。**不建任何東西、不寫本機。** 標記檔可以擋下 G: 掛的是別的 Google 帳號、或資料夾被移走的情況。
2. **暫存區**：`tempfile.mkdtemp(prefix="sdbackup-")`，`finally` 一定刪掉（git 物件檔是唯讀，刪除前先清唯讀屬性，用 `shutil.rmtree(..., onexc=...)`，3.12 沒有 onexc 就用 onerror）。
3. **每個 repo**（所有子程序：環境變數 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`，設逾時，Windows 上加 `creationflags=CREATE_NO_WINDOW`；不然在 pyw 底下每個 git 都會跳黑窗、或跳登入視窗卡住）：
   - `git -C <repo> fetch --no-prune --quiet origin`，失敗等 60 秒再試一次（`FETCH_TRIES`）。第一個 repo 兩次都失敗時，其他 repo 只試一次。只動 origin/* 與 FETCH_HEAD，**不 pull、不 checkout、不碰工作目錄與 worktree**。
   - 記錄：origin/main 的 commit 與 commit 時間、本機 main 落後幾個 commit（只記錄）。
   - 非快轉檢查：上一份 OK 的 manifest 記的 commit 不是新 origin/main 的祖先（`git merge-base --is-ancestor`）→ 警告（可能被 force-push 或帳號被盜）。
   - 打包：`git -C <repo> -c core.autocrlf=false archive --format=zip --prefix=<repo>/ -o <tmp>\<repo>.zip origin/main`。**一定要 `-c core.autocrlf=false`**：這台電腦系統層是 autocrlf=true，不加的話 market-data 有 68 個檔的換行會被改掉（還原演練實測）。
   - 只在本機的分支（`git for-each-ref refs/heads`，`git rev-list --count <分支> --not --remotes=origin` > 0）與有未提交修改的 worktree（`git worktree list --porcelain` 後逐一 `git status --porcelain`）記進 warnings。
4. **private 與記憶資料夾**：用 `zipfile`（ZIP_DEFLATED）走訪整個資料夾，空資料夾也要寫成資料夾項目，檔名用 UTF-8（zipfile 預設會設 UTF-8 旗標）。超過 `ZIP_WARN_MB` 警告。記憶資料夾不存在就警告、不算失敗。
5. **CSV**：從 `git show origin/main:site/js/config.js` 解析 `LEDGER_PUB`、`DASH_PUB` 與網站實際讀的 gid（目前 7 個，對照第 0 節）；`urllib` 下載，逾時 60 秒，失敗重試一次。驗證：HTTP 200、開頭不是 `<`（取消發布時會回 HTML）、能用 UTF-8 解碼。
6. **完整歷史**：條件是「最新一份完整歷史距今超過 `BUNDLE_EVERY_DAYS` 天，或沒有任何一份，或 `--force-bundle`」，而且這次三個 fetch 都成功。**不能直接 `git bundle --all`**：本機 main 落後時，clone 出來的 main 是舊的（還原演練實測）。每個 repo：
   ```
   git init --bare <tmp>\b\<repo>.git
   git -C <tmp>\b\<repo>.git fetch <repo路徑> "+refs/remotes/origin/*:refs/heads/*" "+refs/tags/*:refs/tags/*" [每個只在本機的分支 "+refs/heads/<名>:refs/heads/local/<名>"]
   git -C <tmp>\b\<repo>.git update-ref -d refs/heads/HEAD
   git -C <tmp>\b\<repo>.git symbolic-ref HEAD refs/heads/main
   git -C <tmp>\b\<repo>.git bundle create <tmp>\<repo>.bundle --all
   git -C <tmp>\b\<repo>.git bundle verify <tmp>\<repo>.bundle      （verify 一定要在 repo 裡執行）
   git clone --bare <tmp>\<repo>.bundle <tmp>\v\<repo>.git，rev-parse main 必須等於 origin/main
   ```
7. **manifest.json**：每個檔的大小與 sha256，加上狀態與警告（欄位見第 5 節）。
8. **寫進雲端**：先建 `每日\_未完成-<日期>-<PID>\`，逐檔複製，每檔複製後比對大小與 sha256（這只證明寫進了雲端硬碟的本機暫存，是否真的上傳要從雲端那一側看）；最後寫 manifest，再改名成 `<日期>`。同一天已經有資料夾：新結果的狀態不比舊的差（OK > PARTIAL > STALE）就取代（舊的刪除），否則丟掉新的並記進紀錄。完整歷史用同樣做法。
9. **狀態檔**：`最近備份.json` 每次更新 `last_attempt`、`last_attempt_status`，`last_ok` 與 `last_ok_folder`（那份每日資料夾的名稱）只在 OK 時更新，另有 `last_bundle_folder`（最新一份完整歷史的資料夾名稱）與 `schema: 1`；時間都是 `+08:00` 的 ISO 格式（先寫暫存名稱再 `os.replace`）；`紀錄\YYYY-MM.log` 追加一行（時間、狀態、各 repo commit 前 7 碼、總大小、警告數）；`還原說明.txt` 內容有變才覆寫。
10. **保留**：只在本次 OK 時執行（第 6 節）。
11. **通知與結束碼**（第 7 節）。

## 5. manifest 與狀態

```json
{"schema":1,"started":"2026-11-21T22:00:03+08:00","finished":"…","status":"OK|STALE|PARTIAL",
 "script_commit":"<stock-dashboard origin/main>",
 "repos":{"market-data":{"fetch_ok":true,"fetch_error":null,"last_fetch_ok_at":"…",
   "commit":"…","commit_time":"…","local_main_behind":18,"non_fast_forward":false,
   "unpushed_local_branches":[],"dirty_worktrees":0,
   "archive":{"file":"market-data.zip","bytes":0,"sha256":"…"}}},
 "folders":{"private":{"files":157,"bytes":0,"zip":{"file":"private.zip","bytes":0,"sha256":"…"}},
            "claude-memory":{…}},
 "csv":[{"name":"ledger","gid":0,"ok":true,"http":200,"bytes":1624,"sha256":"…"}],
 "warnings":["market-data 已 5 天沒有新 commit"]}
```

| 狀態 | 條件 | 影響 |
|---|---|---|
| OK | 三個 fetch 都成功、所有檔案寫入並比對一致、沒有非快轉 | 唯一會更新 last_ok、會刪舊備份的狀態 |
| STALE | 有 repo 的 fetch 失敗 | 該 repo 的 zip 是最後一次成功 fetch 的內容，manifest 標 `fetch_ok:false` 與 `last_fetch_ok_at`；不刪任何東西；通知 |
| PARTIAL | fetch 都成功，但有 CSV、zip 失敗，或偵測到非快轉 | 不刪任何東西；通知 |

另外：market-data 的 origin/main 超過 `MARKET_STALE_DAYS` 天沒有新 commit → 警告（順便發現 Actions 或 cron-job.org 停了），不改狀態。

GitHub 長期掛掉時刪除會一直凍結、每天多約 5 MB，這是故意的：出事前的備份最重要。

## 6. 保留規則

**每日**
- 只看 `每日\` 的直接子資料夾。名稱完全符合 `^\d{4}-\d{2}-\d{2}$`、能用固定格式解析成日期、裡面有 manifest.json，才算備份。其他資料夾一律不碰；唯一例外是自己產生的 `_未完成-*` 超過 2 天才清掉。
- **按份數保留，不按日曆**（電腦關三週後第一次跑，不能把舊的全刪掉）。保留以下的聯集：最新 `KEEP_DAILY` 份；最近 `KEEP_MONTHLY` 個月每月最早一份 status=OK 的（那個月沒有 OK 就留最早一份）；最新一份 OK；日期在未來的（同時警告：時鐘可能不對）。
- 刪除條件：本次 OK；一次最多刪 `MAX_DELETE_PER_RUN` 個，超過就整批不刪並警告（`--allow-delete N` 解除）；刪除前確認絕對路徑的上一層就是備份根目錄底下的 `每日`。

**完整歷史**：同樣的名稱與 manifest 規則，保留最近 `KEEP_BUNDLES` 份；有 STALE、PARTIAL 或非快轉時不刪。

## 7. 通知與結束碼

- 狀態不是 OK、或發生例外時跳 Windows 通知（toast），不裝第三方模組：用 `powershell.exe -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>`（加 CREATE_NO_WINDOW）呼叫 `Windows.UI.Notifications`，AppId 用 PowerShell 的 `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`。通知文字用繁體中文，寫狀態與第一個原因。`--no-notify` 不跳。
- 結束碼：0＝OK；1＝STALE 或 PARTIAL；10＝雲端硬碟沒掛上；11＝找不到標記檔；12＝另一個在跑；20＝未預期的例外（最外層一定 try/except，先嘗試寫 last_attempt 再通知）。
- 輸出不靠 print（pyw 沒有主控台）；`--dry-run` 與手動執行時可以印到 stdout。

## 8. 排程（使用者同意後才註冊，由部署 session 做）

```powershell
$pyw = "$env:LOCALAPPDATA\Programs\Python\Launcher\pyw.exe"
$act = New-ScheduledTaskAction -Execute $pyw -Argument '-3.14 C:\stock-dashboard\tools\backup_to_drive.py' -WorkingDirectory 'C:\stock-dashboard'
$trg = New-ScheduledTaskTrigger -Daily -At 22:00
$prn = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'StockDashboardBackup' -Action $act -Trigger $trg -Principal $prn -Settings $set
```

- 只在使用者登入時跑（Interactive；S4U 看不到 G:），錯過就在下次登入後補跑，不叫醒電腦，不用 VBS 或 conhost。
- 22:00 排在私人 repo 的持股抓取（21:30）之後。

## 9. 還原說明（docs/RESTORE.md 要寫的內容）

1. 雲端資料夾結構與每個檔案是什麼；**這個資料夾不可分享**（裡面有投信持股與排程提示詞）。
2. 核對：`Get-FileHash -Algorithm SHA256 <檔>` 跟 manifest 比。
3. 只要最新檔案：解壓每日資料夾的 zip（裡面已經有 `<repo>/` 這層資料夾）。
4. 要完整歷史：`git clone <repo>.bundle <資料夾>`（不用先 verify）；換到新主機：`git remote set-url origin <新網址>`、`git push --all`、`git push --tags`；`local/*` 是當時只在本機的分支。
5. GitHub 不能用時讓網站復活：`site/` 是純靜態；把 `config.js` 讀 raw.githubusercontent.com 的行情與候選資料改到新位置（例如把 market-data 的 `data/` 放進 `site/data/` 改相對路徑），更新 `sw.js` 版本；託管可用 Cloudflare Pages、Netlify，或本機 `py -3.14 -m http.server --directory site`；帳本寫入的 Apps Script 在 Google 上不受影響。
6. market-data 怎麼繼續更新：看 zip 裡 `.github/workflows/*.yml` 的指令，在本機或新的 CI 執行；cron-job.org 的工作改指向新的觸發方式。列出工作清單（名稱、時間、觸發哪個 workflow），不列 token。
7. 私人 repo（投信持股）只能還原到私人位置，不可公開轉載。
8. `private.zip` 解壓回 `C:\stock-dashboard\private\`，永遠不進 git；`claude-memory.zip` 解壓回記憶資料夾。
9. CSV：要重建試算表時用「檔案 → 匯入」。試算表本身的版本紀錄才是主要的保護。
10. 沒備份到的東西：GitHub Secrets 與 Variables（寫的時候用 `gh secret list`、`gh variable list` 再查一次並寫結果）、Pages 設定、cron-job.org 帳號、Apps Script 線上版（可能比 repo 的 `apps_script/` 新）、富果金鑰（只在使用者裝置）；同一個 Google 帳號的風險沒防到。
11. 怎麼確認備份還活著：看門狗的信（第 13 節；沒信就是正常）；雲端上的 `最近備份.json`；`Get-ScheduledTaskInfo StockDashboardBackup` 的 LastRunTime、LastTaskResult；結束碼意義（第 7 節）。
12. 雲端硬碟電腦版的本機暫存是 Google 程式自己的，不算備份存在本機；不要把備份資料夾設成「鏡像」。

## 10. 驗收

1. `py -3.14 -m pytest` 全過（CI 的 3.12、3.13 也要能跑：不用 3.13 以後才有的語法與 API，或有替代）。新測試涵蓋：
   - 保留規則：第一次跑、中間斷三週、跨月、名稱不合格式、沒有 manifest、日期在未來、要刪超過 3 個、STALE／PARTIAL 時不刪、永遠留最新一份 OK。
   - 狀態計算、同一天重跑的取捨。
   - 從 config.js 解析出 7 個 CSV（用 repo 裡真的 `site/js/config.js`）。
   - 路徑護欄拒絕 `每日`、`完整歷史` 以外的刪除路徑。
2. `--dry-run` 只列計畫，不寫任何檔（包括鎖以外的暫存）。
3. 用 `--root <scratchpad 裡的假根目錄>`（先放標記檔）跑一次真的備份：status=OK，有 3 個 repo zip、private.zip、claude-memory.zip、7 個 CSV、完整歷史 3 個 bundle；sha256 全部一致；`%TEMP%` 沒有 `sdbackup-*` 殘留；三個 repo 的 HEAD、分支、工作目錄、`git status` 都沒變（只有 origin/* 前進）。
4. 還原演練：從假根目錄的 bundle 在乾淨資料夾 clone，main 等於 manifest 的 commit，`git fsck --full` 乾淨；zip 解開後的檔案跟 `git ls-tree -r origin/main` 一致。
5. 模擬故障（都用 `--root` 或改參數，不動真正的 remote 設定）：根目錄沒有標記檔 → 結束碼 11；fetch 失敗（例如用一個測試用的假 repo 路徑或錯誤的 remote 名稱）→ STALE、不刪舊備份；CSV 回 HTML → PARTIAL。
6. 看門狗：見第 13 節的驗收。
7. **不在這次做**（審查通過、使用者同意後才做）：`--init` 建立真正的雲端資料夾、第一次寫進 G:、註冊排程（部署 session）；看門狗的安裝與授權（使用者自己在 script.google.com 做，教學 session 帶）；隔天從雲端那一側核對檔案。

## 11. 建議的 commit 切法

1. `tools/backup_to_drive.py` 與 `tests/test_backup_to_drive.py`。
2. `docs/RESTORE.md`。
3. `apps_script/backup_watchdog.gs` 與 `apps_script/backup_watchdog.appsscript.json`。
4. 本檔第 12 節與 `docs/PROGRESS.md`。

## 12. 進度

- 2026-11-21 規格寫好（主 session），交給「網站實作」session 實作；同一天使用者同意加看門狗（第 13 節），接著交辦。
- 2026-11-21 腳本、測試、還原說明做好（網站實作 session，分支 `claude/funds-fire-30y-122524`，**還沒合併、沒 push、沒寫過 G:、沒跑 `--init`、沒註冊排程**）：`tools/backup_to_drive.py`、`tests/test_backup_to_drive.py`（54 項，含用暫存迷你 repo 跑完整流程；3.12、3.14 都過）、`docs/RESTORE.md`。第 10 節 1～5 項用 scratchpad 的假根目錄驗收：
  - 真的備份一次：OK、22 秒、4.8 MB（stock-dashboard.zip 0.75 MB、market-data.zip 1.9 MB、market-data-private.zip 23 KB、private.zip 1.6 MB〔157 檔〕、claude-memory.zip 20 KB〔11 檔〕、7 個 CSV 共 0.55 MB 全部 HTTP 200）；完整歷史 3 個 bundle（17 MB＋1.2 MB＋68 KB，stock-dashboard 帶 4 個 `local/*` 分支）；sha256 全部一致；`%TEMP%` 沒有 `sdbackup-*`；三個 repo 的 HEAD、分支、`git status`、本機設定、工作目錄檔案前後完全一致。
  - 還原演練：三個 bundle clone 後 main＝manifest 的 commit、`git fsck --full` 乾淨；zip 解開的檔案（166／145／10 個）與 `git ls-tree -r` 的 blob 完全一致（market-data 的 CRLF 沒被改，`-c core.autocrlf=false` 有效）；private、claude-memory 解開後與原資料夾逐檔相同。
  - 故障：沒標記檔 → 11（什麼都沒寫）；market-data 的 remote 網址壞掉、repo 路徑不存在 → STALE（結束碼 1）、17 份舊備份一份沒刪、不做完整歷史；CSV 回 HTML → PARTIAL（1）、沒刪舊備份；17 份舊備份＋一次 OK → 刪 3 份（上限）、留下每月最早的 OK；雲端硬碟不存在（不加 `--root`）→ 10；通知用 PowerShell 發出一次，結束碼 0。
  - 跟規格不同或實作時自己決定的地方：
    1. 「保留最近 12 個月」解讀成**最近 12 個「有備份的月份」**（按份數，備份中斷時比日曆算法多留）。
    2. `private.zip`、`claude-memory.zip` **沒有外層資料夾**（RESTORE.md 的解壓指令直接指到目的地）；三個 repo 的 zip 有 `<repo>\` 外層，跟規格一致。
    3. `--dry-run` 不拿鎖、不 fetch（只讀 repo 與雲端清單）；結束代碼 12（另一個在跑）不跳通知，10、11、20 與 STALE／PARTIAL 才跳。
    4. 同日重跑、bundle 到期用「距上次 ≥ 7 天」；manifest 多了 `problems`（所有非 OK 的原因）與 `archive_error`；最近備份.json 多了 `problems`、`backup_folder`、`script_commit`。
    5. fetch 失敗時完整歷史延到下次（寫警告），不另算問題；bundle 做不起來算 PARTIAL。
    6. 規格只提到 `--init`、沒寫細節：做成「建立根目錄、標記檔與 `每日`、`完整歷史`、`紀錄` 三個子資料夾」，不加 `--root` 時用第一個有「我的雲端硬碟」或「My Drive」的磁碟機；沒實際對 G: 跑過。
    7. `還原說明.txt` 讀 origin/main 的 `docs/RESTORE.md`——**這個檔還沒推上 GitHub，所以在合併並推送之前，腳本只會警告、不會寫進雲端**（假根目錄那次就是這樣）。
    8. `gh secret list`、`gh variable list` 查到三個 repo 都是空的（RESTORE.md 第 10 點已寫）；HISTORY 提過的「存聯絡信箱的 Actions secret」目前不存在，workflow 也沒有用 `secrets.*`。
  - 沒驗到的：真正的 G: 與 `GoogleDriveFS.exe` 這個處理程序名稱（`tasklist` 判斷）、串流模式下改名資料夾與逐檔比對的實際行為、排程器環境（PATH 找得到 git、憑證管理員不跳視窗）。這些要部署 session 在 `--init` 與第一次真的寫入時確認。

## 13. 雲端看門狗（Apps Script）

**專案**：獨立的 Apps Script 專案「stock-dashboard 備份看門狗」，**不要放進帳本綁定的 ledger_write 專案**（避免動到記帳與配息觸發器）。`appsscript.json` 設 `"timeZone": "Asia/Taipei"`，`oauthScopes` 只列：
`https://www.googleapis.com/auth/drive.readonly`、`https://www.googleapis.com/auth/script.send_mail`、`https://www.googleapis.com/auth/script.scriptapp`、`https://www.googleapis.com/auth/userinfo.email`（只用來取得自己的信箱當收件人）。不用 UrlFetch、不用 GitHub token。**repo 裡不寫任何信箱、資料夾 ID、帳號名稱。**

**找資料夾**：`DriveApp.getFoldersByName("stock-dashboard 備份")`，只留「擁有者是自己」而且裡面有 `備份根目錄-請勿刪除.txt` 的；剛好一個才繼續，零個或多個都算問題（寄信）。不需要使用者填資料夾 ID。

**觸發**：`installTrigger()` 讓使用者手動跑一次：先刪掉這個專案裡呼叫 `dailyCheck` 的舊觸發器，再建一個每天 9 點（台北，Apps Script 會落在 9～10 點之間）的觸發器。

**`dailyCheck()` 檢查的事**（門檻放在檔頭的 `W = {...}`）：

| 問題代號 | 條件 | 說明 |
|---|---|---|
| `NO_FOLDER` | 找不到或找到多個備份資料夾 | |
| `NO_STATE` | `最近備份.json` 不存在或讀不懂 | |
| `STALE_OK` | `last_ok` 距今超過 `W.MAX_OK_AGE_DAYS`（3）天 | 電腦沒開、排程停了、雲端硬碟沒同步、或一直不是 OK |
| `NOT_UPLOADED` | `last_ok_folder` 那個每日資料夾在雲端找不到 `manifest.json`，或 manifest 列的任何一個檔在雲端不存在、大小不同 | 這是唯一能證明「真的上傳了」的檢查 |
| `OLD_BUNDLE` | `last_bundle_folder` 距今超過 `W.MAX_BUNDLE_AGE_DAYS`（10）天，或那份完整歷史的 bundle 在雲端缺檔或大小不同 | |
| `MARKET_STALE` | 最新 OK 的 manifest 裡 market-data 的 `commit_time` 距今超過 `W.MARKET_STALE_DAYS`（4）天 | 順便發現 market-data 的 Actions 或 cron-job.org 停了 |
| `SHARED` | 備份根目錄、最新每日資料夾或裡面任何檔案的 `getSharingAccess()` 不是 `PRIVATE`，或 `getEditors()`、`getViewers()` 有自己以外的人 | 裡面有投信持股與排程提示詞，不可分享 |
| `QUOTA` | `DriveApp.getStorageUsed() / getStorageLimit()` 超過 `W.QUOTA_WARN`（0.8） | 上限是 0 或讀不到就跳過這項，不算問題 |

**寄信**：有問題才寄，收件人是 `Session.getEffectiveUser().getEmail()`。主旨 `【備份看門狗】<問題代號…>`，內文繁體中文，每個問題寫：發生什麼事、可能原因、要檢查什麼（例如開電腦後看 `Get-ScheduledTaskInfo StockDashboardBackup`、雲端硬碟電腦版的同步狀態、還原說明第 11 項）。同一個問題代號最多每 `W.REMIND_EVERY_DAYS`（3）天寄一次（上次寄送時間存在 Script Properties）；之前有問題、這次全部正常時，寄一封「恢復正常」並清掉紀錄。看門狗自己發生例外時也要寄信（主旨 `【備份看門狗】執行錯誤`），不要靜默失敗。

**測試**：Apps Script 不能在 CI 跑，所以把判斷寫成純函式 `evaluate_(state, latestManifest, bundleManifest, listing, sharing, quota, now)` → 問題清單，讀雲端硬碟的部分另外包起來。提供：
- `selfTest()`：用寫在程式裡的假資料跑 `evaluate_`，涵蓋每個問題代號各一個、全部正常一個、邊界（剛好 3 天）各一個，在執行紀錄印「通過 N／N」。
- `testMail()`：門檻當成 0，實際寄一封測試信給自己，確認收得到。
- `dryRun()`：跑一次真的檢查但不寄信，只把結果印到執行紀錄。

**驗收**（實作 session 能做的部分）：`selfTest` 的假資料跟 Python 腳本真的寫出的 `最近備份.json`、`manifest.json` 欄位一致（用假根目錄那次的輸出對照）；權限設定檔只有上面 4 個範圍；程式裡沒有信箱、ID、帳號。**安裝與授權由使用者自己在 script.google.com 做**（Claude 不能代為授權），教學 session 帶：建立專案、貼程式與 appsscript.json（要先在專案設定打開「顯示 appsscript.json」）、跑 `selfTest`、授權、跑 `dryRun`、跑 `testMail`、跑 `installTrigger`。第一次真的備份寫進雲端之後才裝，不然 `dryRun` 會回報 `NO_FOLDER`。
