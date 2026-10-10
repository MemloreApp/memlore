---
sourceHash: 28f82b9c0575
title: Memlore — 隐私政策
description: Memlore 如何对待你的日记：它留在你的设备上，没有 Memlore 服务器，没有遥测，云同步和 AI 都是可选的，并由你掌控。
updated: 2026年10月4日
---

# 隐私政策

Memlore 是一本私人日记。本页面说明本应用和本网站如何处理信息 — 以及它们绝不会做的事。

## 我们是谁

Memlore 由 [Anh-Thi Dinh](https://dinhanhthi.com) 打造，是一款开源日记应用。如有疑问：[contact@memlore.app](mailto:contact@memlore.app)。

## 我们不收集的内容

没有 Memlore 服务器，也没有 Memlore 账户。本应用不会监视你。

- 没有遥测
- 没有分析
- 没有广告
- 没有追踪像素

## 你设备上的日记

你的日记保存在你的设备上，位于一个加密的本地数据库中。我们无法读取它。

## 可选的云同步

在你开启之前，同步始终处于关闭状态。你可以选择一个位置 — 你的 Google Drive 或你的 iCloud Drive。中间没有 Memlore 服务器。

日记、媒体和设置在上传之前都会在你的设备上加密。一份小型同步列表和设备注册表 — 包括 ID、时间戳、删除标记和你的设备名称，不包括日记文字 — 以 JSON 格式存储，以便你的其他设备知道要拉取哪些内容。

## 可选的 Google Drive 同步

如果你选择 Google Drive，你需要连接你自己的 Google 账户。Memlore 只请求 [drive.appdata](https://www.googleapis.com/auth/drive.appdata) 权限范围。同步的文件存放在 Google Drive 隐藏的应用数据文件夹中 — 在 drive.google.com 上不可见 — Memlore 无法读取你 Drive 中的其他文件。

刷新令牌、你的 Google 账户邮箱和你的 Drive 存储配额只保存在本设备的加密数据库中，以便应用显示已连接的账户。它们会一直保留到你断开连接，之后会从本地数据库中删除。访问令牌只保存在内存中，从不写入磁盘，应用关闭后即消失。

在应用中断开连接不会删除已经存放在隐藏应用数据文件夹中的文件。要删除 Google 端的这份副本，请打开 Google Drive → 设置 → 管理应用 → Memlore → 断开与 Drive 的连接。

Google 用户数据仅用于运行你开启的 Drive 同步。Memlore 没有任何人会读取你的 Google 用户数据。也没有任何 Memlore 服务器可供这些数据到达。Memlore 不会：

- 出售这些数据，或将其转让给数据经纪商或信息转售商
- 将其用于广告，包括定向广告、个性化广告或基于兴趣的广告
- 将其用于开发、改进或训练通用或非个性化的 AI 或机器学习模型
- 将其用于信用评估、借贷或任何与应用功能无关的判定
- 将其转让给第三方，除非是在你自己的 Google 账户内运行 Drive 同步所必需，或法律要求

Memlore 对从 Google API 获得的信息的使用以及向任何其他应用的转让，都将遵守 [Google API 服务用户数据政策](https://developers.google.com/terms/api-services-user-data-policy)，包括其中的有限使用要求。

## 可选的 iCloud Drive

如果你选择 iCloud Drive（在 Mac 上），Memlore 会写入你 iCloud Drive 中的一个 Memlore 文件夹 — 也就是你在访达中已经能看到的那个 iCloud Drive。

Memlore 不会替你登录 Apple，也不会存储 Apple 密码或 iCloud 令牌。它使用这台 Mac 上已有的 iCloud Drive 会话。

上文所述的加密数据和 JSON 同步列表会存入该文件夹。Apple 不会收到你日记的明文。Apple 的 iCloud 条款适用。

你可以在应用中断开连接。断开连接不会删除 iCloud Drive 中的 Memlore 文件夹。如果你希望删除云端副本，请自行删除该文件夹。

## 可选的 AI

在你主动开启并接受隐私声明之前，AI 始终处于关闭状态。你可以选择服务商 — 本地运行、设备端运行，或托管服务商。

如果你选择托管服务商，你发送给它的文字会传送到该服务商。Memlore 不运营这些服务，也看不到这些流量。

## 可选的地图、地点和语音

地图、地理编码和语音转文字只有在你开启后才会运行。它们会与你选择的服务商通信 — 例如 Nominatim/OpenStreetMap、Mapbox、MapTiler、Apple MapKit，或你的语音转文字服务商。

## 应用更新

本应用可能会请求 GitHub 发布元数据，以便在有可用更新时通知你。这项检查不属于遥测。

## Memlore Web (web.memlore.app)

Memlore Web 是一个可选的浏览器配套工具，让你可以在网页浏览器中阅读你现有的 Memlore 日记，并在开启编辑功能后进行编辑，这些编辑会由你的桌面应用导入。

- **浏览器本地存储的内容：** Memlore Web 只会在你浏览器的 IndexedDB 中存储一份加密缓存。主加密密钥严格保存在 WebAssembly 内存中，一旦你锁定保险库或关闭标签页就会被清除。你的日记在磁盘上只以 AES-256-GCM 加密的密文形式存储；未加密的文字从不会存储在浏览器存储中。
- **Cloudflare Worker：** 位于 `web.memlore.app/api/*` 的临时 Cloudflare Worker 负责与 Google 进行 OAuth 2.0 PKCE 令牌交换，以保护客户端密钥。该 Worker 从不会看到、解析或记录你的主恢复短语、加密密钥或日记内容，也不保留任何令牌的持久数据库或访问日志。
- **托管基础设施：** Memlore Web 托管在 Cloudflare Pages 上。和任何网页服务器一样，Cloudflare 会处理标准 HTTP 请求头和 IP 地址，仅用于 DDoS 防护和内容分发。
- **Google Drive 权限范围：** Memlore Web 只连接 Google Drive 受限的 `drive.appdata` 权限范围（隐藏的应用数据）。它无法查看、读取或修改你在 Google Drive 中的任何个人文档、照片或电子表格。
- **没有分析：** Memlore Web 不包含任何分析追踪器、广告脚本、追踪 Cookie 或行为遥测。
- **如何删除所有内容：** 你可以随时清除所有网页端痕迹：
  1. 在浏览器设置中，清除 web.memlore.app 的网站数据。这会删除 Memlore Web 在该浏览器中存储的所有内容（加密缓存、未发送的编辑以及经密码封装的密钥）。Memlore Web 设置中的 **Clear cache** 按钮只会删除缓存的照片和视频。
  2. 在 Memlore 桌面应用中，打开 Settings → Security → Security actions → Connected devices，然后移除该网页设备。
  3. 在 [myaccount.google.com/permissions](https://myaccount.google.com/permissions) 撤销 Google Drive 访问权限。

## 本网站

本宣传网站不设置分析 Cookie，也不收集日记数据。交互式演示只使用示例数据。

"下载"按钮是唯一的例外，值得说清楚。它会经过 dl.memlore.app，该服务会统计下载次数，然后将你转到 GitHub 上的文件。记录的内容包括时间、应用版本，以及 Cloudflare 根据连接推断出的国家或地区。不会存储 IP 地址，也不会设置 Cookie。这只发生在你下载应用时，绝不会在你使用应用时发生 — 应用本身始终不会发送任何内容。

## 变更

本政策可能会有变更。页面顶部的日期显示了最后更新的时间。

## 如何联系我们

隐私相关问题：[contact@memlore.app](mailto:contact@memlore.app)。

本页面为译文。如有任何出入，以[英文版本](/privacy)为准。
