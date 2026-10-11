---
sourceHash: 320fef71a80d
title: Memlore — 隱私權政策
description: Memlore 如何對待你的日記：它留在你的裝置上，沒有 Memlore 伺服器、沒有遙測，雲端與 AI 皆為選用且由你掌控。
updated: 2026年10月11日
---

# 隱私權政策

Memlore 是一本私人日記。本頁說明 App 與本網站如何處理資訊 — 以及它們絕對不會做的事。

## 我們是誰

Memlore 由 [Anh-Thi Dinh](https://dinhanhthi.com) 打造，是一款開放原始碼的日記 App。如有問題：[contact@memlore.app](mailto:contact@memlore.app)。

## 我們不會收集的資料

沒有 Memlore 伺服器，也沒有 Memlore 帳號。App 不會監看你。

- 沒有遙測
- 沒有分析
- 沒有廣告
- 沒有追蹤像素

## 你裝置上的日記

你的日記存放在你的裝置上，位於加密的本機資料庫中。我們無法讀取。

## 選用的雲端同步

同步在你開啟前都保持關閉。你只需選擇一個位置 — 你的 Google Drive 或你的 iCloud Drive。中間沒有 Memlore 伺服器。

日記、媒體與設定會在上傳前先在你的裝置上加密。一份小型的同步清單與裝置登錄資料 — ID、時間戳記、刪除標記與你的裝置名稱，不含日記文字 — 會以 JSON 格式儲存，讓你的其他裝置知道要同步哪些內容。

## 選用的 Google Drive 同步

如果你選擇 Google Drive，你需要連結自己的 Google 帳號。Memlore 只會要求 [drive.appdata](https://www.googleapis.com/auth/drive.appdata) 權限範圍。同步的檔案存放在 Google Drive 隱藏的應用程式資料資料夾中 — 在 drive.google.com 上看不到 — 而且 Memlore 無法讀取你 Drive 中的其他檔案。

更新權杖、你的 Google 帳號電子郵件地址與你的 Drive 儲存空間配額，只會保存在這台裝置上的加密資料庫中，讓 App 能顯示目前連結的帳號。這些資料會保留到你中斷連結為止，之後便會從本機資料庫中刪除。存取權杖只存在於記憶體中，從不寫入磁碟，並會在 App 關閉時消失。

在 App 中中斷連結，並不會刪除已存放在你隱藏應用程式資料資料夾中的檔案。若要移除 Google 端的這份副本，請開啟 Google Drive → 設定 → 管理應用程式 → Memlore → 中斷與 Drive 的連結。

Google 使用者資料僅用於執行你所開啟的 Drive 同步。Memlore 沒有任何人會閱讀你的 Google 使用者資料。這些資料也沒有可以抵達的 Memlore 伺服器。Memlore 不會：

- 出售這些資料，或將其轉移給資料仲介或資訊轉售商
- 將其用於廣告，包括目標式、個人化或興趣導向的廣告
- 將其用於開發、改善或訓練通用或非個人化的 AI 或 ML 模型
- 將其用於信用評估、借貸或任何與 App 功能無關的判定
- 將其轉移給第三方，除非是為了在你自己的 Google 帳號中運作 Drive 同步所需，或法律要求

Memlore 對於從 Google API 取得之資訊的使用，以及轉移至任何其他 App 的行為，將遵守 [Google API 服務使用者資料政策](https://developers.google.com/terms/api-services-user-data-policy)，包括其中的有限使用規定。

## 選用的 iCloud Drive

如果你選擇 iCloud Drive（在 Mac 上），Memlore 會寫入你 iCloud Drive 中的一個 Memlore 資料夾 — 也就是你在 Finder 中已經看得到的那個 iCloud Drive。

Memlore 不會替你登入 Apple，也不會儲存 Apple 密碼或 iCloud 權杖。它使用的是這台 Mac 上既有的 iCloud Drive 工作階段。

上述相同的加密內容與 JSON 同步清單會存放到該資料夾中。Apple 不會收到你日記的明文內容。Apple 的 iCloud 條款適用。

你可以在 App 中中斷連結。中斷連結並不會刪除 iCloud Drive 中的 Memlore 資料夾。如果你想移除雲端副本，請自行刪除該資料夾。

## 選用的 AI

AI 在你選擇啟用並接受隱私權聲明前都保持關閉。服務供應商由你選擇 — 本機或裝置端，或是雲端服務。

如果你選擇雲端服務供應商，你傳送給它的文字會送到該供應商。Memlore 並不經營這些服務，也看不到這些流量。

## 選用的地圖、地點與語音

地圖、地理編碼與語音轉文字只有在你開啟時才會運作。它們會與你選擇的服務供應商通訊 — 例如 Nominatim/OpenStreetMap、Mapbox、MapTiler、Apple MapKit，或你的語音轉文字服務供應商。

## App 更新

App 可能會向 GitHub 請求版本發布的中繼資料，以便在有可用更新時通知你。這項檢查並非遙測。

## Memlore Web（web.memlore.app）

Memlore Web 是一個選用的瀏覽器輔助工具，讓你能在網頁瀏覽器中閱讀既有的 Memlore 日記並進行編輯，再由你的桌面 App 匯入這些變更。

- **瀏覽器本機儲存的內容：** Memlore Web 只會在你瀏覽器的 IndexedDB 中儲存加密快取。主加密金鑰保存在 WebAssembly 記憶體中，一旦你鎖定保險庫或關閉分頁就會被清除。為了重新整理頁面時不必再次輸入密碼，開啟中的分頁還會在該分頁的工作階段儲存空間（session storage）中保留一份密封的主金鑰副本，以及用來開啟它的一次性金鑰。應用程式只會用它來重新載入該分頁，直到你鎖定或自動鎖定時間到期；鎖定時會將其刪除。瀏覽器可能會在分頁關閉後仍將其工作階段儲存空間保留在磁碟上（用於還原分頁），而且時間限制由應用程式執行，並非由加密保證，因此在你鎖定之前複製了瀏覽器設定檔的人可能開啟日記。離開共用電腦前，請先鎖定保險庫。你的日記內容在磁碟上只以 AES-256-GCM 加密的密文形式儲存；未加密的文字絕不會存放在瀏覽器儲存空間中。
- **Cloudflare Worker：** 位於 `web.memlore.app/api/*` 的短暫性 Cloudflare Worker 負責與 Google 進行 OAuth 2.0 PKCE 權杖交換，以保護用戶端密鑰。Worker 從不檢視、解析或記錄你的主復原短語、加密金鑰或日記內容，也不維護任何持久性資料庫或權杖存取紀錄。
- **託管基礎架構：** Memlore Web 託管於 Cloudflare Pages。如同任何網頁伺服器，Cloudflare 會處理標準的 HTTP 請求標頭與 IP 位址，且僅用於 DDoS 防護與內容傳遞。
- **Google Drive 權限範圍：** Memlore Web 只會連線到 Google Drive 受限的 `drive.appdata` 權限範圍（隱藏的應用程式資料）。它無法檢視、讀取或修改你 Google Drive 中任何個人文件、相片或試算表。
- **地圖圖磚（選用，預設關閉）：** 網頁版地圖頁面會先列出你的地點，不會聯絡任何地圖服務商。只有在你用自己的 MapTiler API 金鑰開啟地圖圖磚後，瀏覽器才會從 MapTiler 載入圖磚，MapTiler 隨之會收到你檢視的地圖區域和你的 IP 位址。你的 API 金鑰以加密形式儲存在此瀏覽器中。你可以隨時停止使用地圖圖磚。
- **沒有分析：** Memlore Web 不包含任何分析追蹤器、廣告指令碼、追蹤 Cookie 或行為遙測。
- **如何刪除所有資料：** 你可以隨時移除所有網頁痕跡：
  1. 在瀏覽器設定中，清除 web.memlore.app 的網站資料。這會刪除 Memlore Web 在該瀏覽器中儲存的所有內容（加密快取、尚未送出的編輯，以及受密碼保護的金鑰）。Memlore Web 設定中的 **Clear cache** 按鈕只會移除快取的相片與影片。
  2. 在 Memlore 桌面 App 中，開啟 Settings → Security → Security actions → Connected devices，並移除網頁裝置。
  3. 在 [myaccount.google.com/permissions](https://myaccount.google.com/permissions) 撤銷 Google Drive 存取權。

## 本網站

這個行銷網站不會設定分析用 Cookie，也不會收集日記資料。互動試玩只使用範例資料。

下載按鈕是唯一的例外，值得精確說明。它會經過 dl.memlore.app，該服務會計算下載次數，然後將你導向 GitHub 上的檔案。被記錄的內容是時間、App 版本，以及 Cloudflare 從連線推斷出的國家。不會儲存 IP 位址，也不會設定 Cookie。這只會在你下載 App 時發生，絕不會在你使用 App 時發生 — App 本身依然從不傳送任何資料。

## 變更

本政策可能會有所變更。頁面頂端的日期顯示最後更新時間。

## 如何聯絡我們

隱私權相關問題：[contact@memlore.app](mailto:contact@memlore.app)。

本頁為翻譯版本。如有任何歧異，以[英文版本](/privacy)為準。
