# Subscribe Flow · 知流

本地优先订阅聚合桌面应用。F1 正式界面已接入 Electron、Python Core 和 SQLite；首期渠道为 B站；M10 开发分支已接入小红书作者订阅，真实平台验收单独记录。

## 直接运行

**二期开发请使用下方的开发启动方式。M10 完成后也暂不打包，先体验与处理 Bug／优化；当前 `dist/` 中间产物不代表最新源码，不作为本轮正式交付。**

打开 `dist/Subscribe Flow-darwin-x64/Subscribe Flow.app`，或解压 `dist/Subscribe-Flow-0.1.0-mac-x64.zip` 后把应用移到“应用程序”。
当前交付 macOS Intel 本机版本，内置 Python，无需开发终端、外部 Chrome、OpenCLI 或 Node。
安装、数据备份、恢复和适用范围见 [M7 交付说明](docs/M7_DELIVERY.md)。

在“渠道管理”中完成应用内 B站登录，添加作者 UID/主页并确认后刷新。收件箱支持已读 / 稍后处理 / 归档单选，处理后移出，全部更新保留记录。
当前开发版在同一列表内点击、勾选、整理内容和刷新后保留滚动位置；项目移出后按原顺序选中下一条，末尾回退上一条，全部移出则显示空态。批量移出和分页补位也遵循此规则。
每个订阅的操作区可用滑块按钮设定“每次采集条数”（1-50，留空为默认），同时作用于“刷新来源”和“回溯历史”。B站每页约 20 条，条数向上取整成整页请求，填 35 实际读取 2 页约 40 条；未设定时刷新 1 页、回溯 10 页。小红书按主页顺序检查笔记，默认刷新检查前 8 条、回溯检查前 30 条；设定值限制本轮检查的不同笔记数。已收录的也占一个名额，跳过详情后不向后补足；设为 5 且前 5 条均已收录时，详情访问为 0。手动和自动刷新均采用此设置。
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
# M10 独立数据目录体验（保留日常数据）
npm run dev:m10
# 用户另行要求打包时才运行
# npm run package:mac
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
npm run smoke:xiaohongshu
npm run smoke:xiaohongshu:session
npm run smoke:packaged
cd python
PYTHONPATH=src python3 -m unittest discover -s tests -t . -q
```

真实平台专项验收使用独立应用会话：`npm run bilibili:login`，完成官方登录/验证并关闭窗口后运行 `npm run smoke:bilibili:live`。
M4 开发诊断页使用 `SUBSCRIBE_FLOW_DIAGNOSTICS=1 npm start`，正式包不启用此开关。

小红书使用应用内独立持久会话，正常搜索和采集隐藏网页；首次使用或登录失效时，从渠道管理／添加作者对话框打开「应用内登录」，完成后关闭窗口并检查连接。添加作者通过渠道按钮选择平台，输入昵称，核对候选账号后确认。小红书搜索期间禁用添加对话框所有按钮／输入及关闭路径，最多 60 秒，结束后恢复。笔记外部链接从详情页分享／复制取得，保留官方分享参数；不会使用自行拼接的无签名链接。主页笔记 ID 先与完整入库记录比较，跳过重复详情；窗口内置顶、乱序或首个已知 ID 不会直接结束检查；达到设定条数后停止，不向窗口外补位。模糊发布时间保留待确认状态，采集不覆盖人工标签、优先级或处理状态。

小红书真实平台验收使用 `npm run xiaohongshu:login`，完成官方登录后关闭窗口。用 `npm run smoke:xiaohongshu:live -- --query "作者昵称"` 查看候选；确认作者 ID 后用 `--uid "作者ID" --limit 2` 进行少量采集和重复刷新。验收会话位于 `runtime/xiaohongshu-acceptance/`，开发体验会话位于 `runtime/m10-development/`，均独立于日常数据。只读验证分享取链与打开时可使用 `--uid "作者ID" --share-note "笔记ID"`，不会重新入库。不能将隔离页面测试视为真实平台验收。

渠道通过 Gateway 注册与统一契约连接业务层；平台页面解析、导航和会话放在各自后端内，Adapter 不依赖数据库或界面。更换渠道后端时保留来源和内容稳定身份，通过连接版本使旧进度失效，无需重做订阅或整理页面。

当前入口：[开发计划](docs/reference/DEVELOPMENT_PLAN.md)、[进度](docs/PROGRESS.md)、[交接](docs/HANDOFF.md)、[Bug 修复记录](docs/BUG_FIXES.md)、[桌面说明](docs/DESKTOP.md)、[业务 API](docs/API.md)、[存储](docs/STORAGE.md)。
权威计划仍在同级 `../doc/DEVELOPMENT_PLAN.md`，仓库副本同步维护；旧采集问题保留在 [历史证据](docs/KNOWN_ISSUES.md)。
