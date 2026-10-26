# 0.5.3.1 本地滚动修复包

2026-10-26 用户指定版本为 **0.5.3.1**，不使用 0.5.4。

修复 [BUG-142](BUG_FIXES.md)：标签管理 AI 自动识别页的滚动被通用面板隐藏规则覆盖，用户无法滑到下面的配置与任务。产品只改局部滚动样式，0.5.3 其余功能保留。

源码已完成浅／深色 4 档窗口共 8 组真实滚轮测试，底部可达、标签后台刷新／草稿／焦点与滚动保持通过。[源码证据](verification/tags-ai-scroll-20261026/REPORT.md)。

**0.5.3.1 已完成 macOS Intel（x64）本地打包并通过正式安装包验收。** 构建修订 `f0321b118cfbd44313f7ad78f5158f4ef0e197ac`，产品修复提交 `d612b40`；后续仅更新文档与证据。

首轮打包的 Electron 归档下载返回 `fetch failed`。本机已有同版 44.5.1／darwin-x64 ZIP 缓存，使用打包脚本新增的可选 `SUBSCRIBE_FLOW_ELECTRON_ZIP_DIR` 参数指向该目录重建；默认在线构建方式不变，未替换 Electron 版本。首轮日志保留为 `verification/v0.5.3.1-local/build-attempt-1.log`。

## 本地安装包

- ZIP：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/Subscribe-Flow-0.5.3.1-mac-x64.zip`
- 大小：146,141,190 字节（约 139.4 MiB）。
- SHA-256：`117c73167bf06476baaa43255780bcc1a8cf6ddf251f0c4cf6b3b638f0656792`
- 校验文件：同名 `.zip.sha256`。
- `.app`：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/0.5.3.1/Subscribe Flow-darwin-x64/Subscribe Flow.app`
- 内置 Electron 44.5.1、Python 3.12.5，schema 15，本机 ad-hoc 签名；应用／Core／构建元数据版本均为 0.5.3.1。

## 验收结果

- 正式包移到项目外经 LaunchServices 独立启动，内置 Core、最小 PATH、外部 Python 配置忽略、开发测试标志忽略通过。
- 实际包使用真实鼠标输入事件，在 1000×600 紧凑视口验证 AI 页滚轮正位移、下滑到底部历史补打与任务区域；`tagsAiWheelScroll=true`、`tagsAiBottomReachable=true`。[截图](verification/v0.5.3.1-local/packaged/packaged-tags-ai-bottom.png)。
- 旧库 v2→v15 升级及备份、去重、取消、封面、标签／优先级／笔记／总结设置持久化、Core 崩溃恢复、真实应用重启与缺失 Core 提示通过。
- 61 个 Main／Preload／Renderer 文件与源码逐字节一致；版本、logo、打包白名单、签名、ZIP、SHA 校验通过；18 个相对符号链接有效，Core 为 x86_64。
- 未调用真实 LLM／公众号收费 API，不改日常数据库、登录或通知设置，未推送或发布。

延续用户只保留当前应用的要求，确认 0.5.3 未运行后将其 `.app` 移入废纸篓；ZIP 与用户数据保留。Spotlight 当前只识别 0.5.3.1，避免同名应用重复。

证据：[构建收据](verification/v0.5.3.1-local/local-build-receipt.json) · [包内结果](verification/v0.5.3.1-local/packaged/result.json) · [文件核对](verification/v0.5.3.1-local/package-content.json) · [构建日志](verification/v0.5.3.1-local/build.log) · [包内日志](verification/v0.5.3.1-local/packaged.log)。
