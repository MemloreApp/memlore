---
title: Memlore — Privacy Policy
description: How Memlore treats your journal: it stays on your device, with no Memlore server, no telemetry, and optional cloud and AI that you control.
updated: 22 October 2026
---

# Privacy Policy

Memlore is a private journal. This page explains what the app and this website do with information — and what they never do.

## Who we are

Memlore is made by [Anh-Thi Dinh](https://dinhanhthi.com). It is an open-source journal app. Questions: [contact@memlore.app](mailto:contact@memlore.app).

## What we do not collect

There is no Memlore server and no Memlore account. The app does not watch you.

- No telemetry
- No analytics
- No advertising
- No tracking pixels

The app does go online for a few things, such as checking for updates or looking up a place. Each one is listed under "When the app goes online" below, with what is sent.

## Your journal on your device

Your journal lives on your device, in an encrypted local database. We cannot read it.

## Optional cloud sync

Sync stays off until you turn it on. You pick one place — your Google Drive or your iCloud Drive. There is no Memlore server in between.

Entries, media, and settings are encrypted on your device before they are uploaded. A small sync list and device registry — IDs, timestamps, deletion flags, and your device name, not journal text — are stored as JSON so your other devices know what to pull.

## Optional Google Drive sync

If you choose Google Drive, you connect your own Google account. Memlore asks only for the [drive.appdata](https://www.googleapis.com/auth/drive.appdata) scope. Synced files sit in Google Drive’s hidden Application Data folder — not visible on drive.google.com — and Memlore cannot read your other Drive files.

The refresh token, your Google account email, and your Drive storage quota stay only in the encrypted database on this device, so the app can show which account is connected. They stay until you disconnect, then they are deleted from the local database. The access token stays in memory, is never written to disk, and is gone when the app closes.

Disconnecting in the app does not delete the files already in your hidden Application Data folder. To remove that Google-side copy, open Google Drive → Settings → Manage apps → Memlore → Disconnect from Drive.

Google user data is used only to run the Drive sync you turned on. No human at Memlore reads your Google user data. There is no Memlore server for it to reach. Memlore does not:

- Sell it, or transfer it to data brokers or information resellers
- Use it for advertising, including targeted, personalized, or interest-based ads
- Use it to develop, improve, or train generalized or non-personalized AI or ML models
- Use it for credit-worthiness, lending, or any other determination unrelated to the app's features
- Transfer it to third parties, except as needed to operate Drive sync inside your own Google account, or where required by law

Memlore's use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Optional iCloud Drive

If you choose iCloud Drive (on a Mac), Memlore writes to a Memlore folder in your iCloud Drive — the same iCloud Drive you already see in Finder.

Memlore does not sign in to Apple for you and does not store an Apple password or iCloud token. It uses the iCloud Drive session already on this Mac.

The same encrypted payloads and JSON sync list described above go into that folder. Apple does not receive your journal in the clear. Apple’s iCloud terms apply.

You can disconnect in the app. Disconnecting does not delete the Memlore folder in iCloud Drive. Remove that folder yourself if you want the cloud copy gone.

## Optional AI (desktop app)

AI stays off until you set up a provider. You choose the provider yourself, and you can use a different one for each AI job (writing, search, images, memory):

- **Local:** a server running on your own computer or on your local network, such as Ollama, LM Studio or llama.cpp `llama-server`. Nothing leaves your local network.
- **On-device:** models that Memlore downloads once and then runs on your computer. Nothing leaves the computer after the download.
- **Hosted, with your own API key:** OpenAI, Anthropic (Claude), Google (Gemini), xAI, OpenRouter, Together, Groq, Voyage AI (search indexing only), or a custom OpenAI-compatible address that you enter.
- **Subscription command-line tool:** the `claude` (Anthropic) or `codex` (OpenAI) tool that you installed and signed in to yourself. Memlore hands it the request, and the tool sends it to Anthropic or OpenAI under your own subscription. Memlore never sees that login.

Before any hosted provider or command-line tool is used, the app shows an AI privacy notice that you must accept. You accept it once, and it then covers every hosted provider and command-line tool. The app shows which address your entries are sent to. Local and on-device providers need no notice, because nothing leaves your computer or your local network.

When you use a hosted provider or a command-line tool, it receives, over an encrypted connection:

- the decrypted text of the entries the AI feature works on: for example the entry you ask it to rewrite or continue, the entries found to answer a Daily Chat question, or the entries in a summary or review;
- what you type to the AI: chat messages, search questions and image prompts;
- for AI search with a hosted search-indexing provider, your entry text in short pieces, so it can be indexed;
- for Memory, only if you allow a hosted provider for it: entries and Daily Chat conversations, so it can find things worth remembering.

AI features that read many entries at once leave out invisible entries. They also leave out locked entries, unless you turn on the setting that includes locked entries in AI search or in Memory. If "Include locked entries in mentions" is on, the title of a locked or invisible entry that you @-mention in another entry is stored in that entry's text, so it is sent to the provider whenever that entry is processed or indexed.

The provider also receives your API key (or, for a command-line tool, that tool's own login) and your IP address. Its own privacy policy and the terms of your account apply, and it may keep logs of your requests. You are the provider's customer. Memlore does not run these services, and nothing passes through a Memlore server.

AI output can be wrong, incomplete or misleading. Check it before you rely on it.

## When the app goes online

The app sends no telemetry, no analytics and no crash reports. It connects to the internet only for the following:

- **Update check (desktop app, on by default):** once each time the app starts. See "App updates".
- **Sync:** only if you turn it on, with the Google Drive or iCloud Drive you choose. See above.
- **AI:** only with a hosted provider or command-line tool that you set up. See "Optional AI".
- **Places and weather (desktop app):** when you search for a place, when the app suggests a location from a photo, and when an entry gets a location. See "Places, maps and weather".
- **Maps:** only from the map source you choose. See "Places, maps and weather".
- **Google Fonts (desktop app):** only when you use the custom Google Font picker. See "Fonts".
- **Downloads you start:** on-device AI models (from Hugging Face), the `llama-server` program for on-device chat (from the llama.cpp project's GitHub releases), the offline world map (from Memlore's Cloudflare storage, or GitHub if that fails), and app updates (from GitHub). Each service receives your IP address and the name of the file.

## Places, maps and weather (desktop app)

- **Place search and location suggestions:** when you type a place name, or when you add a photo that carries GPS coordinates and the app suggests its location, the app sends the text you typed or the coordinates to a geocoding service. The default is Photon, run by Komoot (`photon.komoot.io`). In Settings → Location you can switch to Nominatim (OpenStreetMap), or to Mapbox, MapTiler or Google Places with your own API key. The service receives the text or coordinates and your IP address. The place name, address and coordinates you keep are saved in your entry.
- **Weather:** when an entry gets a location, or its location changes, the app asks Open-Meteo (`open-meteo.com`) for the weather at those coordinates on the entry's date, and saves a short weather summary in the entry. Open-Meteo receives the coordinates, the date and your IP address. No account or key is involved. There is no setting to turn weather off: it is fetched whenever an entry has a location, and the only way to avoid it is not to add a location to the entry.
- **Map tiles:** maps draw only from the source you choose in Settings → Location. The offline world map is downloaded once and then needs no internet. MapTiler (with your own API key) and Apple MapKit load map images for the area you view, so they receive that area and your IP address.

## Fonts (desktop app)

The fonts that come with the app need no download. If you open the custom Google Font picker in Settings, the app downloads the list of Google Fonts from the Google Fonts API (the first time, and when you refresh it), and when you pick a font it downloads that font from Google (`fonts.googleapis.com`, `fonts.gstatic.com`). Google receives your IP address and the name of the font. The font is then kept on your device and works offline.

## App updates

When the desktop app starts, it checks for a newer version by downloading a small file, `latest.json`, from Memlore's GitHub Releases. The request carries no account, no identifier and nothing from your journal. GitHub sees your IP address and the request, as with any download, and GitHub's privacy statement applies. When you choose to install an update, it is downloaded from GitHub too.

GitHub counts how many times each release file is downloaded, including `latest.json`. Memlore's download statistics read that total once a day and use the daily increase as a rough count of app launches. They get only the total number: nothing about who downloaded the file, and nothing about your device.

You can turn the check off in Settings → General → "Automatically check for updates". The app then does not contact GitHub by itself, and your launches are not counted. You can still check by hand from the Memlore menu → Check For Updates….

## Memlore Web (web.memlore.app)

Memlore Web is an optional browser companion that lets you read your existing Memlore journal from a web browser and make edits that your desktop app imports.

- **What is stored locally in the browser:** Memlore Web stores only an encrypted cache in your browser's IndexedDB. The master encryption keys are kept in WebAssembly memory and are wiped as soon as you lock the vault or close the tab. So that refreshing the page does not ask for your password again, the open tab also keeps a sealed copy of the master key, together with the one-time key that opens it, in that tab's session storage. The app uses it only to reload that tab, until you lock or the auto-lock time passes; locking deletes it. The browser may keep a tab's session storage on disk after the tab closes (for tab restore), and the time limit is enforced by the app, not by the encryption, so anyone who copies the browser profile before you lock could open the journal. Lock the vault before you leave a shared computer. Your journal entries are stored on disk only as AES-256-GCM encrypted ciphertexts; unencrypted text is never stored in browser storage.
- **The Cloudflare Worker:** An ephemeral Cloudflare Worker at `web.memlore.app/api/*` handles the OAuth 2.0 PKCE token exchange with Google so client secrets stay protected. The Worker never sees, parses, or logs your master recovery phrase, encryption keys, or journal content, and maintains no persistent database or access logs of tokens.
- **Cookies:** Memlore Web sets two cookies, both needed to connect Google Drive. Both are limited to `web.memlore.app/api/oauth`, marked `HttpOnly` and `Secure`, and never used for tracking. `ml_pkce` holds a one-time sign-in code (PKCE) while you connect Google Drive; it lasts at most 10 minutes and is deleted when the sign-in ends. `ml_rt` holds your Google refresh token, encrypted with a key that only the Worker has, so the Worker can give your browser a new Drive access token; it lasts at most 180 days and is deleted when you disconnect Google Drive in Memlore Web (the Worker then also revokes the token at Google) or when Google no longer accepts the token.
- **Hosting infrastructure:** Memlore Web is hosted on Cloudflare Pages. Like any web server, Cloudflare processes standard HTTP request headers and IP addresses strictly for DDoS mitigation and content delivery.
- **Google Drive scope:** Memlore Web connects exclusively to Google Drive's limited `drive.appdata` scope (hidden application data). It cannot view, read, or modify any of your personal Google Drive documents, photos, or spreadsheets.
- **Map tiles (optional, off by default):** The web map page first lists your places without contacting any map provider. Only after you turn on map tiles with your own MapTiler API key does your browser load tiles from MapTiler, which then receives the map area you view and your IP address. Your API key is stored encrypted in this browser. You can stop using map tiles at any time.
- **No analytics:** Memlore Web contains no analytics trackers, advertising scripts, tracking cookies, or behavioral telemetry.
- **How to delete everything:** You can remove all web traces at any time:
  1. In your browser's settings, clear the site data for web.memlore.app. This deletes everything Memlore Web stored in that browser (the encrypted cache, unsent edits and the password-wrapped key). The **Clear cache** button in Memlore Web settings removes cached photos and videos only.
  2. In the Memlore desktop app, open Settings → Security → Security actions → Connected devices and remove the web device.
  3. Revoke Google Drive access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## This website

This marketing website does not set analytics cookies and does not collect journal data. The interactive demo uses sample data only.

The Download button is the one exception, and it is worth being precise about. It goes through dl.memlore.app, which counts the download and then sends you on to the file on GitHub. What gets recorded is the time, the app version, the platform, and the country Cloudflare infers from the connection. No IP address is stored and no cookie is set. This happens only when you download the app from this site, never while you use it. The connections the app itself makes are listed under "When the app goes online" above.

This website is hosted on GitHub Pages, so GitHub processes visitors' IP addresses and request headers to serve it.

## Service providers

There is no Memlore server for your journal. These are the outside services involved, and what each one gets:

- **Google Drive** (only if you choose it): stores your encrypted sync files in the hidden Application Data folder of your own Google account, through the `drive.appdata` scope.
- **Apple iCloud Drive** (only if you choose it, on a Mac): stores the same encrypted files in a Memlore folder in your own iCloud Drive.
- **Cloudflare:** hosts Memlore Web and runs its `web-auth` Worker, which handles the Google sign-in for Memlore Web and sets the two cookies `ml_pkce` and `ml_rt` described above. The Worker keeps no database and no log of tokens. Cloudflare also runs the download counter below, and stores the offline world map. It processes IP addresses and request headers to deliver and protect these services.
- **GitHub:** hosts Memlore's source code, its releases and this website. The desktop app gets its update check and its updates from GitHub Releases, and GitHub counts the downloads of each release file (see "App updates").
- **Download counter (`dl.memlore.app`):** a small service run by Memlore on Cloudflare. For each click on this site's Download button it stores the time (to the minute), the app version, the platform and the country that Cloudflare infers from the connection. It stores no IP address and sets no cookie. Once a day it also saves a copy of GitHub's download totals for each release file.
- **Other services the app uses or that you pick:** AI providers, place search (Photon by Komoot by default), weather (Open-Meteo), map tiles, Google Fonts and Hugging Face, as described above. Their own privacy policies apply.

## Changes

This policy may change. The date at the top of the page shows when it was last updated.

## How to reach us

Privacy questions: [contact@memlore.app](mailto:contact@memlore.app).
