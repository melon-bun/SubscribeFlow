# Subscribe Flow · 知流

本地优先订阅聚合桌面应用。F1 正式界面已接入 Electron、Python Core 和 SQLite；首期渠道为 B站。

## 直接运行

**二期开发请使用下方的开发启动方式。二期全部完成后再统一打包；当前 `dist/` 中间产物不代表最新源码，不作为本轮正式交付。**

打开 `dist/Subscribe Flow-darwin-x64/Subscribe Flow.app`，或解压 `dist/Subscribe-Flow-0.1.0-mac-x64.zip` 后把应用移到“应用程序”。
当前交付 macOS Intel 本机版本，内置 Python，无需开发终端、外部 Chrome、OpenCLI 或 Node。
安装、数据备份、恢复和适用范围见 [M7 交付说明](docs/M7_DELIVERY.md)。

在“渠道管理”中完成应用内 B站登录，添加作者 UID/主页并确认后刷新。收件箱支持已读 / 稍后处理 / 归档单选，处理后移出，全部更新保留记录。
每个订阅的操作区可用滑块按钮设定“每次采集条数”（1-50，留空为默认），同时作用于“刷新来源”和“回溯历史”。平台每页约 20 条，条数会向上取整成整页请求，填 35 实际读取 2 页约 40 条；未设定时沿用刷新 1 页、回溯 10 页。
默认手动刷新，可切自动；间隔默认 24 小时、最大 72 小时。自动检查需要应用运行。
优先级支持高／中／低：在“渠道管理 → 优先级设置”设来源默认值，或在详情中单独覆盖；“内容总览 → 优先级模式”按等级浏览，收件箱支持筛选及批量设置。“内容总览 → 日历模式”支持优先级标识、完整月份及每日统计、组合筛选和当日分页，详情修改后与看板同步。旧内容保持“未设置”，可恢复跟随来源。
标签支持独立管理、单条／批量打标，以及任一／全部符合的组合筛选。详情中的挂载对话框支持搜索、回车新建、确认后保存；停用标签保留既有归类。AI 仅有扩展契约，尚未接入模型；规则与完整历史覆盖尚未交付。

M6 实现与隔离验收完成。M7 打包与离线验收已通过，真实平台复验、实机长周期与物理休眠仍须单独记录；不能把打包成功等同于平台始终可采集。
Minimax 增强及 `feature/enhancements` 的新图标、采集条数设置已合入 main。M8、M9 实现与验收记录见 [二期计划](docs/DEVELOPMENT_PLAN_PHASE2.md)、[M8 交付说明](docs/M8_PRIORITIES.md) 和 [M9 标签说明](docs/M9_TAGS.md)。

## 开发启动与构建

```sh
npm ci
npm run configure
npm start
npm run package:mac
```

开发需要 Node >=22.12、Python 3.12+；打包另需 uv。`.runtime-paths.json` 仅供开发，不进入安装包。
`npm start` 用 `.runtime-paths.json` 里的解释器从 `python/src` 直接跑源码，不是打包后的冻结 Core；改动 Python 后重启即可生效。
应用图标源文件是 `assets/logo.png`，`npm run package:mac` 时由 `scripts/package-icon.cjs` 裁边并生成 `.icns`。
数据位于 `~/Library/Application Support/Subscribe Flow/`；打包版和开发版共用默认目录，不应同时运行。开发版启动时会对该目录执行 schema 迁移并留下 `.before-v*.backup`。
独立 F1 工作区 `../Subscribe_Flow_F1/` 未修改。

## 验收

```sh
npm test
npm run smoke:renderer
npm run smoke:session
npm run smoke:packaged
cd python
PYTHONPATH=src python3 -m unittest discover -s tests -t . -q
```

真实平台专项验收使用独立应用会话：`npm run bilibili:login`，完成官方登录/验证并关闭窗口后运行 `npm run smoke:bilibili:live`。
M4 开发诊断页使用 `SUBSCRIBE_FLOW_DIAGNOSTICS=1 npm start`，正式包不启用此开关。

当前入口：[开发计划](docs/reference/DEVELOPMENT_PLAN.md)、[进度](docs/PROGRESS.md)、[交接](docs/HANDOFF.md)、[Bug 修复记录](docs/BUG_FIXES.md)、[桌面说明](docs/DESKTOP.md)、[业务 API](docs/API.md)、[存储](docs/STORAGE.md)。
权威计划仍在同级 `../doc/DEVELOPMENT_PLAN.md`，仓库副本同步维护；旧采集问题保留在 [历史证据](docs/KNOWN_ISSUES.md)。
