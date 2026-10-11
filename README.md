<p align="center">
  <img src="assets/logo.png" alt="知流 Logo" width="180" />
</p>

<h1 align="center">知流 · Subscribe Flow</h1>

<p align="center">聚合你关注的创作者更新，把值得留下的内容收进自己的信息库。</p>

知流是一款本地优先的订阅与信息整理桌面应用。订阅作者、粘贴链接收录内容，在同一个收件箱中阅读与整理，再通过标签、优先级和日历找回需要的信息。

## 应用特点

- **多平台聚合**：把 B站视频、小红书笔记、知乎想法和微信公众号文章放在同一个信息库中，按平台与来源查看。
- **订阅与主动收录**：持续关注作者更新，也能随时粘贴单条链接，把日常遇到的内容保存下来。
- **收件箱整理**：用已读、稍后处理和归档管理阅读进度，支持批量操作；处理后的内容仍可在对应分类和全部更新中找到。
- **灵活的优先级**：为作者设置默认优先级，也可单独调整某条内容，在三栏看板中安排阅读顺序。
- **标签与组合筛选**：自定义标签名称与颜色，支持单条或批量打标、多标签任一或全部匹配，以及关键词、平台、来源、收录方式和处理状态筛选。
- **日历回顾**：订阅采集的内容按原始发布日期展示，手动收录的内容按首次添加时间展示，同时保留原始发布时间。
- **按需更新**：支持手动刷新、历史回溯和自动检查，可为订阅设置采集条数与检查间隔。自动检查需要应用保持运行。
- **本地保存**：订阅、已收录内容与整理记录存储在本机；重复收录保留已有记录，刷新不会覆盖你的标签、优先级和处理状态。已保存的文字信息与整理记录可离线查看。

### 支持的平台与内容

| 平台 | 内容类型 | 作者订阅 | 单条链接收录 |
| --- | --- | :---: | :---: |
| B站 | 视频投稿信息 | ✓ | ✓ |
| 小红书 | 笔记 | ✓ | ✓ |
| 知乎 | 作者发布的想法 | ✓ | ✓ |
| 微信公众号 | 文章 | — | ✓ |

> ⚠️ **小红书登录提醒**：建议使用小号登录。应用内登录也算一次 PC 端登录；如果在本机其他浏览器或客户端再次登录，有可能触发平台风控。

B站收录视频信息与原文链接，观看视频时打开原平台。知乎支持「想法」；微信公众号通过文章链接收录。平台读取需要联网，内容能否获取取决于登录状态与平台访问限制。

## 界面截图

| 收件箱与内容详情 | 日历浏览 |
| :---: | :---: |
| <a href="assets/screenshots/inbox.png"><img src="assets/screenshots/inbox.png" alt="收件箱与内容详情" width="420" /></a> | <a href="assets/screenshots/calendar.png"><img src="assets/screenshots/calendar.png" alt="内容总览的日历模式" width="420" /></a> |
| **优先级看板** | **链接收录** |
| <a href="assets/screenshots/priorities.png"><img src="assets/screenshots/priorities.png" alt="内容总览的优先级模式" width="420" /></a> | <a href="assets/screenshots/add-content.png"><img src="assets/screenshots/add-content.png" alt="添加内容与预览确认" width="420" /></a> |

截图使用示例内容，点击图片可查看大图。

## 如何安装

### 通过安装包

当前安装包为 **v0.3.0 · macOS Intel（x64）**，文件名为 `Subscribe-Flow-0.3.0-mac-x64.zip`。已发布的安装包可在 [GitHub Releases](https://github.com/melon-bun/SubscribeFlow/releases) 中获取。

1. 获取安装包并解压。
2. 将 `Subscribe Flow.app` 拖入「应用程序」文件夹。
3. 打开知流。在「渠道管理」中完成所需平台的应用内登录，再添加作者并刷新；也可点击「添加内容」直接粘贴链接。

安装包已内置运行环境，无需额外安装 Node.js 或 Python。当前包采用本机签名，尚未经过 Apple 公证；首次打开可能出现 macOS 安全提示，可在「系统设置 → 隐私与安全性」中允许打开后重试。

升级时先退出应用，备份 `~/Library/Application Support/Subscribe Flow/`，再用新版替换原来的 `.app`。

### 通过 npm 从源码运行

准备 **Git、Node.js 22.12+ 和 Python 3.12+**，并确保终端中可以使用 `python3`。

```sh
git clone https://github.com/melon-bun/SubscribeFlow.git
cd SubscribeFlow
npm ci
npm run configure
npm start
```

`npm ci` 安装依赖，`npm run configure` 配置本机运行环境，`npm start` 启动应用。后续在项目目录中运行 `npm start` 即可。

源码运行版与安装包默认共用本地数据目录，请退出其中一个后再启动另一个。
