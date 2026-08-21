雙發付款管理系統 V8.3 Build 0323

本版修正：
1. 已綁定裝置若遺失本機授權快取，會用裝置識別碼向雲端恢復，不必再次輸入授權碼。
2. 網路暫時驗證失敗時，在最近一次有效授權的離線寬限期內可繼續使用。
3. 已驗證的授權狀態另外保存到本機系統資料庫，隔夜讀不到瀏覽器快取時仍可自動恢復。
4. 授權碼裝置欄留白時，客戶端顯示測試版並限制最多 10 筆付款資料。
5. 更新 GitHub Pages 的版本號、Service Worker 快取版本與載入查詢參數。
6. 上線前必須在 Supabase SQL Editor 執行 `supabase/license-recovery.sql`。

上傳方式：
1. 解壓縮本資料夾內的所有檔案。
2. 開啟 GitHub：hsujeff802-web/shuangfa-payment。
3. 點 Add file → Upload files。
4. 將解壓縮後的檔案全部選取並拖入（要放在 repository 根目錄，不要再包一層資料夾）。
5. Commit changes 直接提交到 main。
6. 等 GitHub Pages 部署完成後，用一般 Safari 開啟：
   https://hsujeff802-web.github.io/shuangfa-payment/?v=83423
7. 第一次開啟要保持網路；若使用主畫面 App，先用 Safari 開一次新版網址，再回到主畫面 App。

注意：cloud-config.js 內的 Supabase 公開設定已保留；不要把資料庫密碼或 service_role key 上傳到 GitHub。
