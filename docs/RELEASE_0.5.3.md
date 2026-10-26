# 0.5.3 本地构建与验收

后续（2026-10-26）：用户报告 AI 自动识别页不能下滑，BUG-142 已由 **[0.5.3.1 修复包](RELEASE_0.5.3.1.md)** 解决并通过包内真实滚轮验收。0.5.3 的 `.app` 已移入废纸篓，只保留 ZIP 归档；以下路径和结果为当时构建的历史记录。

2026-10-26 用户授权「打个版本包」。由 Codex 直接制作 macOS Intel（x64）0.5.3，保留旧安装包，不推送或上传 Release。

范围：既有 0.5.2 小红书封面优化，智能优先级／AI 配置与操作反馈，公众号付费 API 渠道与费用保护、微信公众号内折叠配置、标签窄窗工具栏修正。产品实现基线 `66d996f`。

构建前已完成 Python 643 项、Node 155 项全局回归；后续两项界面修正分别通过公众号正式界面、标签 8 档窗口及后台刷新验证。本轮不重复真实收费 API。

## 已交付

**0.5.3 已完成本地构建与正式安装包验收。** 构建修订 `5ae1dfda54d425ff30669ea740dd0fcbdd906746`；后续仅验收脚本与交接文档更新，包内产品文件未改变。

- ZIP：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/Subscribe-Flow-0.5.3-mac-x64.zip`
- 大小：146,140,526 字节（约 139.4 MiB）。
- SHA-256：`58f0573c0ab0dc025f92491789b3d2f6191a559861fc564e4c2397a8e07975ea`
- 校验文件：同名 `.zip.sha256`。
- 应用：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/0.5.3/Subscribe Flow-darwin-x64/Subscribe Flow.app`
- macOS Intel／x64，内置 Electron 44.5.1、Python 3.12.5，数据库 schema 15，本机 ad-hoc 签名。

## 安装包验收

- 61 个 Main／Preload／Renderer 文件与构建源码逐字节一致，logo 与版本元数据一致；显式打包白名单没有凭据文件、测试脚本、文档或业务数据库。
- 本机签名严格校验、ZIP 完整性、SHA-256 通过；18 个包内符号链接均有效且为相对路径，Core 为 x86_64。
- 应用移动到项目外，LaunchServices 用最小 PATH、错误外部 Python 配置独立启动，确认只运行内置 Core，正式包忽略开发测试标志。
- 冻结 Core 去重、取消、小红书封面入库与重启保持通过。
- 原始 v2 schema 升级到 v15、升级前备份、处理状态单选、自动／手动切换、Core 崩溃恢复和真实应用重启通过。
- 笔记、总结设置隔离、优先级、标签与数据持久化通过；缺失 Core 提示正常。
- 最新微信公众号内付费配置默认收起，展开能看到在线付费 API 警告；标签工具栏 grid 与横向边界通过。当前验收只读付费状态，没有真实收费调用。
- 启动的隔离应用与 Core 已正常收束；日常数据库、登录与运行中的旧版未改动，旧安装包保留。

验收脚本沿 [BUG-012](BUG_FIXES.md#bug-012打包升级验收的旧库样本与版本号不一致) 维护历史库样本，直接使用原始 001／002 迁移创建 v2，避免遗留 v13～15 的新表冒充旧库。该脚本不进入包。

证据：[构建收据](verification/v0.5.3-local/local-build-receipt.json) · [包内结果](verification/v0.5.3-local/packaged/result.json) · [文件核对](verification/v0.5.3-local/package-content.json) · [构建日志](verification/v0.5.3-local/build.log) · [包内验收日志](verification/v0.5.3-local/packaged.log)。

解压 ZIP，退出旧版后打开新版 `.app`；本次未安装替换旧版，未推送远端、创建发布标签或上传 Release。
