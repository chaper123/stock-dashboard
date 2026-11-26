# 縮小 market-data 的 headlines.json 成長（規格）

## 0. 背景與決定

- 使用者 2026-11-21 擔心「不可能免費就能這樣一直堆資料」；2026-11-24 主 session 問要不要處理行情資料的成長，使用者回答「要，今天做」。
- 2026-11-24 實測（主 session 的研究：寫入端、讀取端、用 85 個歷史版本模擬、挑錯審查各一個子代理；原始報告在 `private/tmp/headlines_research_2026-11-24.md`）：
  - GitHub 回報 market-data 17 MB（2026-10-14 起）。本機 pack 19.7 MB 裡有 15.95 MB 是 `data/news/headlines.json`：自 10/22 起 85 個版本，每版新增在 git 裡約 136 KB（中位數），整個 repo 每月約 21 MB。
  - **原因不是格式**：重新序列化逐位元組相同；時間戳、key 順序、排序、stats 合計不到 3%。每版大小幾乎等於「新增標題壓縮後的大小」（差 3.5%）。新增量裡 **66% 是 Google News 轉址 `link`**（base64，平均 311 字元，壓縮器看不出裡面的網址）。
  - 試過但沒用的：只改格式省 1～5%；拆成小檔加每日封存檔反而更大；「內容沒變就不 commit」85 版一版都省不到（每版至少 38 則新標題）；時間窗不能低於 72 小時（讀取端要 72 小時）。
  - GitHub 對公開 repo 不收儲存費；1 GB、5 GB 是建議值，不是硬上限，硬上限是單檔 100 MB（headlines.json 2～3 MB）。照現在的速度大約 2030 年底到 1 GB。
- **決定**（主 session 依研究，使用者可以改）：
  1. 做 E1m（第 1 節）：每月成長約少 30%（headlines.json 約 16.9 → 11.8 MB／月），首頁下載的 headlines.json gzip 後約 665 → 354 KB。
  2. **不改寫已經在 git 裡的歷史**（約 16 MB）：好處只有 1 GB 建議值的 1.6%，代價是備份變 PARTIAL 要 `--accept-rewrite`、要先停 cron-job.org、本機 clone 要重設、文件裡約 28 處短 SHA 失效。改成**每年 10 月**（跟比例檢查同月）看一次 `gh api repos/chaper123/market-data --jq .size`，超過 500 MB 再排一次「只留最近 90 天 headlines.json 歷史」的改寫（目前 0 fork、0 PR，改寫有效）。
  3. 不減少 commit 次數（網站下午、晚上的新聞會停）、不停 `headlines.md`（README 說是給人看的）。等 E1m 跑兩週量到實際成長再說。

## 1. 做法 E1m（只改 market-data 的 news.py 與測試）

- **輸出**：只有「link 是 Google News 轉址，而且已經解出 url（非空）」的項目，`link` 寫成 `null`；**`link` 鍵保留**。中央社、Fed 這類 link 等於 url 的不動；解不出 url 的 Google News 項目保留 link。
- **id 沿用**：`load_previous` 讀回上一份時帶上檔案裡存的 `id`，之後一律沿用；只有新抓到的標題才用現在的 `sha1(link or title)[:16]` 算（在把 link 換成 null 之前算）。`time_check_cache`、topics 的 `sample_ids`、url 快取都靠 id，id 不能變。
- **「是不是 Google News」**：上一份的項目用「link 是 Google News 網址，或 link 是 null 而 url 有值」推回；`merge` 的排序（news.py:178 附近）與 `cap` 的 `direct = tier==1 or not gn_article_id(link)`（news.py:201 附近）改用這個判斷。**這是最容易做錯的地方**：只在輸出時拿掉 link、不改這兩處的話，審查者實測連跑 15 次 items 多 18%、標題無關的上限 10 失效（單一查詢最多 71 則）、1,622 個 id 改變。
- `load_previous` 要同時讀得懂舊格式（有 link）與新格式（link 是 null）。
- 不新增公開欄位（想更保險可以加 `"gn": 1`，大小只差 0.2%；不加也可以，實作自己決定並記下）。
- 檔頭說明（news.py:21-23 附近）與 README（:51 的大小、:82-83「link 照舊保留」與 id 的定義）跟著改。

## 2. 讀取端不改

- 讀取端只需要最近 72 小時，路徑與欄位都不變：
  - engine `news_select.py`：0876bf0 與 main 相同。用改過的輸出跑，`--brief` 文字相同，只有 `candidates.json` 裡的 link 變成 null。提示詞本來就寫 link「不能拿來查證」。
  - 網站讀 headlines 的地方全都用 `url || link`：headlines.js:63、analysis.js:142、pages/news.js:124、:344、:380。
- 所以**不改** engine、0876bf0 的釘選、提示詞、網站、sw.js、news.yml、publish.py、排程，不需要改排程的同意，也不用一次性測試 run。

## 3. 兩階段部署

`news.yml` 的 checkout 沒指定 ref，排隊中的舊 run 會用舊程式讀新檔案。舊程式讀到 null link 就是第 1 節的錯誤情況。所以分兩階段：

1. **第一階段**：只上「讀得懂 null link」的部分：id 沿用、Google News 推回、merge／cap 用新判斷。輸出還是寫 link，跟現在**逐位元組相同**。push 後等一次排程跑完並檢查。
2. **第二階段**：上「寫成 null」。避開排程前後 10 分鐘（排程是台北 08:20、11:10、13:40、16:30、21:00），建議在 16:30 那次跑完後。
3. **回退**：只退第二階段，第一階段永久保留。

## 4. 測試

market-data 的 workflow 不跑測試，所以在本機用 `py -3.12` 與 `py -3.14` 跑完整 unittest。
- `tests/test_news.py:206`（`deal["link"].startswith(GN_BASE)`）改成第二階段後是 None。
- 新增測試：
  1. 上一份的 link 是 null 時，id、url 都沿用，不重新解碼。
  2. 沒有 link 的舊項目照樣受 cap 限制，例如 12 則標題無關只留 10 則。
  3. merge 的保留順序不變（中央社 RSS 優先於 Google News）。
  4. 舊格式（有 link）的上一份照樣能讀。
  5. time_check_cache 用沿用的 id 命中。
- 中央社、Fed 的 link 等於 url（:213、:499）、link 鍵存在（:149）這幾個既有測試要繼續通過。

## 5. 驗收

1. 兩個版本的 unittest 全過。
2. **寫入端重播**：用改好的 news.py，照審查者的 `review2\replay.py` 做法（從 v69 出發連跑至少 15 版，用下一版的新 id 當新抓到的標題、用下一版解出的 url 代替網路解碼）。輸出把 Google News link 換成 null 後，要跟現行版逐項相同、順序也相同（15/15）。第一階段的輸出要逐位元組相同。
   - 腳本：`C:\Users\user\AppData\Local\Temp\claude\f885b4fa899a18c2\05adbcc8-54c4-4a3b-82c5-ec461663180e\scratchpad\headlines\review2\replay.py`（用法 `py -3.14 -I replay.py 69 15`；scratchpad 可能被清掉，要用就先複製到自己的工作目錄）。
3. 用 0876bf0 的 engine 跑這些輸出：`--brief` 相同，candidates 只有 link 不同。
4. 第二階段上線後頭 3 次執行要看：
   - 標題和 published_utc 都相同的舊項目，id 100% 不變。
   - 標題無關的則數、總則數沒有一次比一次往上漂。
   - `stats.url.cached` 沒有掉到接近 0。
   - topics.json 的 sample_ids 都在 headlines.json 裡找得到。
   - meta 的 news/headlines 是 ok。
   - 隔天晨間、午間排程的「輸入」那行正常，沒有改用搜尋的退路。
5. 兩週後：每版 headlines.json 在 pack 裡的 delta 中位數不超過約 100 KB（現在 136 KB），或 GitHub 大小兩週內增加不超過約 8 MB。

## 6. 不做

- 不改寫 git 歷史。
- 不改讀取端。
- 不減少 commit 次數。
- 不停 headlines.md。
- 不動 `topic_history.json`（每版約 5 KB，影響小）。

## 7. 文件

- stock-dashboard：`docs/NEWS_ROUTINE.md` 說明 headlines.json 的段落（約 29-38 行）補「link 可能是 null，用 url」與檔案大小；PROGRESS、HISTORY 加紀錄。
- market-data：README。

## 8. 進度

- 2026-11-24 規格寫好（主 session），交給「market-data 維護」session 實作。
- **第一階段**：只讓程式讀得懂 null link，輸出不變。
  - 2026-11-24 19:01 push，commit `473009c`。改了 `is_google_news`、`item_id` 沿用 id、`load_previous` 帶回 id，merge 與 cap 改用新判斷。
  - 上線後檢查了兩次排程：11/24 21:02、11/25 08:22。topics 的 sample_ids 都找得到；meta 是 ok；url 快取在 70～75%；沒有 null link。
  - 舊項目 id 改變 13、22 個（改動前是 5～12 個）。原因是 Google News 給同一篇文章換了新轉址，合併時新項目勝出；改動前就會這樣。新舊程式吃同一份輸入，輸出逐項相同。
- **第二階段**：寫成 null。
  - 2026-11-25 09:21 push，commit `267e7b8`，已經 rebase 到最新的 origin/main。
  - 測試：`py -3.12`、`py -3.14` 各 176 個全過，`:206` 改成 None，新增讀回自己輸出的往返測試。
  - 重播：從 v1 起 84 版 84/84 相同，另外補了上線後的 2 版。最後一版 1.96 MB 變 1.48 MB，2,160 則裡有 1,464 則 link 是 null。
  - engine（0876bf0）：`--brief` 相同。
  - 上線後頭 3 次排程（11:12 `0c407b2`、13:42 `454f01a`、16:32 `fd79eb1`）都通過，market-data 維護檢查。
    - Google News 項目的 link 都是 null，url 都有值。每則平均小約 23%。
    - url 快取、topics、meta 都正常。
    - 舊項目 id 改變 22、16、15 個，比改動前的 5～12 個高，原因沒有完全查清，但沒有一次比一次往上漂。
  - 主 session 抽查 16:32 那版：2,863 則裡有 2,052 則 link 是 null，全部都有 url；沒有「有 url 但還留著 Google News link」的項目。每則平均 734 位元組，改動前約 907。
- **11/26 隔天排程檢查通過**：Haiku 先查，主 session 再用 Sonnet 子代理分路重核。原始報告在 `private/tmp/headlines_check_2026-11-26_*.json`，不進 git。
  - 晨間摘要寫「headlines 11/26 08:20 產生、時間窗內 1,223 則」，午間寫「11:10 產生、254 則」。
    - meta 是 ok，50/50 個 feed 成功，兩次都沒有走退路。
    - 四支 engine 程式都有產出：機會觀察那句、經理人方向、午間紀律列都在。
  - 晨間 NVDA 從 161 則降到 90 則，原因是新聞量自然變少（財報後第二週、感恩節前夕）。
    - 用 0876bf0 的 news_select.py 實跑 11/26 08:22 版，再把 link 換回 url 重跑一次，counts 和候選排序完全相同。
  - 舊項目在時間窗內消失，每版約 200～430 則，幾乎全是 cap 擠掉的。
    - 每個查詢的 tier 4 留 20 則、標題無關留 10 則，新的進來就把舊的擠掉。
    - 改動前後比例一樣，例如 NVDA 時間窗每天都擠掉約 19～21 則。
  - 「id 改變」每版中位數：改動前約 9～12 個，改動後約 15～20 個。
    - 機制和舊程式相同：合併只看標題，平手時新抓的勝出，id 用新的 Google News 轉址算，常常是同一標題換了來源。
    - 用 6 種合成情境、真實資料連跑三代比對，新舊程式的 id、url、標題、時間都完全相同。
    - 增加大致跟總則數成長（約 2,300 → 3,000 則）同步。這是推論，改動後的樣本還少。
- **之後要看**：
  - **12/09（兩週後）** 照第 5 節第 5 點量 GitHub 大小與每版 delta。11/25 的基準是 GitHub 17.2 MB。