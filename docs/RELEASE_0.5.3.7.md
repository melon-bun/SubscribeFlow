# 0.5.3.7 构建与发布

日期：2026-11-09（Asia/Tokyo）。本版修复内容总览快捷筛选跳回收件箱的问题，日历与优先级看板保留当前视图。功能提交 `9ea5be7`，构建源码修订 `780db7eccafab7934d43ec0405b186004f5c4377`。

| 项目 | 结果 |
| --- | --- |
| 安装包 | `dist/Subscribe-Flow-0.5.3.7-mac-x64.zip` |
| 大小 | 146,162,604 字节 |
| SHA-256 | `7454f14ddbf467e771e5f7bbd9d6c9e279681734e33d930383e0e65c3f0a9f85` |
| 运行环境 | macOS Intel，Electron 44.5.1，Python 3.12.5 |
| 签名 | 本机 ad-hoc，未经 Apple 公证 |

包内 62 个应用源码文件与构建源码一致，签名、ZIP、校验和、图标与相对链接通过。[审计](verification/v0.5.3.7-local/audit.json)。

实际安装包使用隔离数据通过完整验收：内容总览日历及看板快捷筛选、日历日期保留、侧栏选中态、标签筛选滚动、阅读状态重命名、微信旧库升级、笔记和重启等均通过。[完整结果](verification/v0.5.3.7-local/result.json) · [构建和验收日志](verification/v0.5.3.7-local/build-and-smoke.log)。

旧版 0.5.3.6 已退出；核对旧 ZIP 后，将项目中的旧应用入口移入废纸篓并注销，旧 ZIP 与校验文件保留。[清理记录](verification/v0.5.3.7-local/app-cleanup.json)。未操作日常数据。

公开更新说明见 [RELEASE_NOTES_0.5.3.7.md](RELEASE_NOTES_0.5.3.7.md)。

## 远端发布

[GitHub 0.5.3.7 发布页](https://github.com/melon-bun/SubscribeFlow/releases/tag/v0.5.3.7)已公开并设为最新版本；`main` 和 `v0.5.3.7` 标签已推送，标签指向上述构建源码。

由于本机上传反复中断，最终公开安装包由 [GitHub Actions 构建](https://github.com/melon-bun/SubscribeFlow/actions/runs/42579330165)，使用同一标签源码独立构建并通过完整包内验收。它与上文已验收的本机包是两次构建，文件不同：公开 ZIP 为 145,669,247 字节，SHA-256 为 `ba33b641fe1eaa912122b3256633870bb39ade49f1a34506cafc1a283939e9fd`。公开 ZIP 及其 SHA-256 文件均已核对 GitHub 的文件摘要、大小与上传状态。[远端构建日志](verification/v0.5.3.7-local/remote-build.log) · [发布收据](verification/v0.5.3.7-local/release-receipt.json)。
