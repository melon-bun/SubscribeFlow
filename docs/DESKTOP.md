# M4–M8 桌面运行与正式界面

更新：2026-10-05。当前 macOS Intel 的独立 `.app` 与 ZIP 已构建并通过离线桌面验收；真实平台及长周期边界见 [M7 交付说明](M7_DELIVERY.md)。Electron 44.5.1，内置 Python 3.12.5。

M8 优先级入口、继承规则和当前验收见 [M8_PRIORITIES.md](M8_PRIORITIES.md)。

## 直接运行安装包

打开 `dist/Subscribe Flow-darwin-x64/Subscribe Flow.app`，或将 ZIP 解压到“应用程序”。无需 Python、Node、OpenCLI 或 Chrome。
开发版与打包版共用 `~/Library/Application Support/Subscribe Flow/`，先退出旧版本再打开新版本。
菜单“帮助”提供数据目录、诊断记录和使用/备份说明。安装、迁移回滚、恢复和完整验收见 [M7_DELIVERY.md](M7_DELIVERY.md)。

## 开发启动

```sh
npm install
npm run configure
npm start
```

configure 将当前 Python/Node 的绝对路径保存在本机 `.runtime-paths.json`（已忽略）。
换机器、移动运行时或更新 Python 后重新配置。B站桌面采集不再需要 OpenCLI、扩展或外部 Chrome。
`npm start` 从 `python/src` 直接运行源码 Core（`PYTHONPATH` 指向源码目录），不是打包后的冻结 Core；Python 改动重启即生效。
它与打包版共用同一个 userData，因此启动会对真实数据库执行 schema 迁移并生成 `.before-v*.backup`；只想试代码请设置 `SUBSCRIBE_FLOW_DATA_DIR` 指向临时目录。
应用图标源为 `assets/logo.png`（已纳入版本管理）；`npm run package:mac` 由此裁边生成 `.icns`，改动图标后需重新打包才影响 `.app`。
应用使用 Electron userData 下的 `subscribe-flow.sqlite3`；测试用独立临时目录。
Core 对该数据库加进程锁；Electron 也有单实例保护，避免第二实例错误恢复仍在运行的任务。

默认启动 `electron/renderer/` 中接入真实业务的 F1 界面。
原 F1 工作区未改动；本工程复用其布局、样式和组件，未复制演示入口与占位封面。
M4 联调窗口可用 `SUBSCRIBE_FLOW_DIAGNOSTICS=1 npm start` 单独打开。

直接在普通浏览器中打开联调页面不会启动桌面服务。页面会先检查桌面接口是否完整；
缺失时显示“请通过桌面应用启动”及 `npm start` 的说明，查询、重启、订阅按钮和输入控件均禁用。
本地数据会明确标记为尚未读取，不会回退到演示数据。完整桌面接口存在时才启用控件并发起查询。

## B站应用内登录与采集（2026-10-04 更新）

旧实现确实依赖外部 Chrome；关闭 Chrome 会导致搜索、列表和详情失败。本轮按用户要求替换该路径，
当时暂停 M6；2026-10-05 用户已要求继续并完成本轮实现。桌面默认后端为 `electron-session`；Python 的旧 OpenCLI 独立工具仅用于历史回归，不是桌面回退路径。

1. 打开“渠道管理”中的“应用内登录 B站”。应用创建隔离的 WebContentsView，展示 B站官方登录页。
2. 用户自行扫码或填写登录信息；关闭登录窗口后自动检查会话，也可点“检查连接”。
3. 添加并确认作者 UID/主页，手动刷新；遇到等待状态，完成登录/验证后点“重试任务”。

应用内登录独立于 Chrome，需要首次登录。关闭登录窗口和关闭外部 Chrome 都不会清除应用会话。
重启应用后继续使用该会话，若 B站使会话过期则需重新登录。未登录时可以尝试公开内容；
实际登录要求以具体操作结果为准。连接检查会调用 B站 nav，而不再只检查本地工具版本。
“会话已登录”不承诺每项平台操作都可用，任务记录保存各次实际结果。

```text
F1 业务界面 → 受限 Preload → Electron Main → Python Core / SQLite
                                  ↑                 ↓
                       受限 acquisition 双向 RPC（具名操作）
                                  ↓
                Electron 自有持久 Session：persist:bilibili
                     ├─ 隔离 WebContentsView：官方登录页面
                     └─ Session.fetch：搜索 / 投稿 / 详情 API
```

Cookie 只存在 Electron `userData/Partitions/bilibili/` 分区目录中，由 Chromium 管理。
不导入 Chrome 配置，不在 Python、业务 Renderer、SQLite、日志或 Git 中保存 Cookie。
登录浏览视图不加载业务 Preload；启用 sandbox/contextIsolation/webSecurity，关闭 Node、webview、
权限请求和下载，仅允许 HTTPS B站域内导航。业务主窗口仍保持原来的导航、资源与 IPC 白名单。
使用 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 承载用户要求的应用内网页，
不向业务 Renderer 开放通用 `<webview>` 控制接口。

搜索/列表签名与固定 URL 在 Main 内构造；Core 只提交 check、search、list、detail 的具名参数，
不能传 URL、Cookie 或脚本。保留 API envelope 的平台状态码、分页总数和日期秒级精度。
列表按 `pubdate` 请求并校验页码、页大小与总数；有效空页需要 count=0 等对应证据。
当前 full_history 仍为 false：页码可变，终页总数证据不代表跨页无缺口。

同一会话串行访问；仅临时网络或 HTTP 5xx 错误最多重试一次（500ms 后），单次操作最多 45 秒。
认证失败、平台访问验证、限流和结构错误不会自动连续重试。取消任务通过私有 RPC 中止 Main 请求；
M6 在此基础上增加持久化调度、有限退避及恢复，使用方式见下节。

旧 `opencli` 连接自动迁移到 `electron-session`，保留连接 ID 并增加版本；旧分页与覆盖记录变为不兼容。
订阅、内容、阅读状态保留；无需修改 SQLite schema。旧 `Navigation rejected` 根因未查明，
本轮通过替换依赖路径移除其对桌面采集的影响，不能把旧问题写成已找到根因。

## 通信与进程

M6 使用：在“渠道管理 → 同步方式”切换手动 / 自动。默认手动；自动间隔默认 24 小时，最多 144 小时，
可自定义。应用运行时才检查；关闭应用或休眠后，重新启动 / 唤醒会错峰补一次到期检查。
计划、错误处理、升级和验证边界见 [M6_SCHEDULING.md](M6_SCHEDULING.md)。

- JSON-RPC 2.0 over UTF-8 JSON Lines/stdin/stdout，协议版本 1.0。
- `core.hello({protocol_version:'1.0'})` 后才能调用业务方法，白名单见 API.md。
- 不支持 batch 数组；参数使用具名对象。普通请求最高 64 KiB，最多 32 个未完成请求。Main 输出的私有采集响应最多 3 MiB；Core 输入总行上限 4 MiB，Main 接收 Core 输出上限 8 MiB。
- stdout 仅协议；日志写 stderr。响应保留 request ID，通知无 ID。
- Main 用异步流读取 Core；pending 请求在超时、退出、协议错误时显式失败。
- 关闭先请求 core.shutdown，Core 取消采集、释放数据库及进程锁；超时后受控终止。
- 正常桌面的 Core 异常退出后最多自动恢复 3 次（5 / 15 / 45 秒）；稳定 60 秒后重置次数。仍保留手动“重启核心服务”。
- 遗留 queued/running 标 interrupted，自动模式的扫描从头安全重扫；waiting 保留等待原因，手动模式不自动恢复采集。
- 通知队列拥塞时可以丢弃提示；业务查询用于恢复真实状态。

## 页面权限

本地页面使用固定 `app://subscribe-flow/` 协议和资源白名单，启用沙箱、上下文隔离、CSP，
关闭 Node、webview、任意新窗口、导航和页面权限。IPC 校验窗口、主 frame、完整本地 URL。
Preload 只暴露 `SubscribeFlow.call(name, params)` 和 `on(name, handler) → unsubscribe`。
无法通过页面执行 SQL、命令或访问任意文件。content.open 只接受已保存内容 ID，由 Main
取回 URL 后验证 http/https，再交给系统浏览器；source.open 同样只接受订阅 ID。UI 不能提交任意系统协议。

## F1 AppClient 对接

`electron/main/app-client.cjs` 接受 F1 的 `call(name, args[])`，统一映射到具名业务 API，
只转换 DTO、不存储状态、不复制采集逻辑；调用错误不会切到演示数据。

| F1 方法 | 业务映射 |
|---|---|
| getSession / getCounts / listPlatforms | 能力、连接和内容计数查询 |
| resolveSource / searchSources | source.resolve / source.search，不创建订阅 |
| listConnections / checkConnection | connection.list / connection.check |
| loginConnection | Main connection.login，仅接受固定的 bilibili:default |
| retryRun / fetchDetail | sync.retry / sync.start(mode=detail) |
| listContents / getContent | content.list / content.get，加展示 DTO |
| updateContent / bulkUpdate | content.update / content.bulk_update，仅 patch.state 的基础状态 |
| listChannels / listCreators | subscription.list + schedule.list |
| createChannel | subscription.add，需稳定 UID/主页及 confirmed=true |
| updateChannel / setChannelEnabled / removeChannel | subscription.update；取消保留历史 |
| startChannelRun / cancelRun / getRuns | sync.start / sync.cancel / sync.list |
| getSyncCoverage | sync.coverage；兼容且带末页证据才允许 complete=true |
| 优先级与规则相关方法 | 返回 UNSUPPORTED_OPERATION，留后续模块 |

M5 已对齐日期精度、空值、分页、能力按钮、事件与受控外链。未知进度只显示提交页数/条数。
正式页面不调用未支持的优先级/规则接口；来源先解析/搜索、核对稳定 UID，再确认添加。
事件合并后重新查询；15 秒轮询只补偿本地状态读取，不会触发采集。页面卸载释放所有监听及定时器。
重启后保留持久化内容与状态；M6 自动模式恢复中断的列表扫描，按原预算从头重扫并幂等保存。

## 验收

- `npm test`：18 项，包括真实 Python sidecar、受限采集 RPC、自动计划触发、有限崩溃恢复、大响应入库、详情、重跑幂等、取消中止 Main 请求。
- Python：55 项，涵盖渠道契约、存储、调度、v1 升级、模式切换、等待与重启/休眠恢复。
- `npm run smoke:renderer`：F1 正式页面离线桌面验收，25 条明确标记的样本，重启、重载、分页与阅读状态通过。
- `npm run smoke:session`：真实 Electron，登录视图安全选项、关闭窗口后请求、串行、有限重试、取消及应用重启后的分区 Cookie 持久化通过。Cookie 使用合成标记，不是平台认证证据。
- 历史匿名会话有投稿 `-352` 证据。本轮已登录的实际打包应用显式重试后读取 10 页、193 条入库，7 条条目解析错误待定位（BUG-011）；此前“登录后仍失败”为脚本复用旧任务导致的误报，见 BUG-010 与 M7_DELIVERY.md。

可复现的真实平台验收使用应用自有的隔离目录 `runtime/bilibili-acceptance/`（Git 忽略），不借用 Chrome：

```sh
npm run bilibili:login
# 在官方页面完成登录并关闭窗口后：
npm run smoke:bilibili:live
```

该脚本验证两页投稿、详情、搜索、连续刷新及 Core 重启；失败会非零退出，不降级为样本。
登录验收目录与日常 userData 分开；日常使用请从正式界面登录。`smoke:renderer:live` 使用全新临时会话，
会受到匿名访问限制，不再意味着复用 Chrome 登录。M4 诊断页可用 `npm run smoke:desktop` 验收。

实现依据：[Electron 官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、
[Session API](https://www.electronjs.org/docs/latest/api/session)、[JSON-RPC 2.0](https://www.jsonrpc.org/specification)。

## M11 源码交付与三期打包安排（2026-10-08）

当前已发布安装包为 0.2.0／schema v7；M11 源码使用 schema v8，只提交公共收录、可选 Adapter 能力、统一日期及桌面业务接口。本轮未制作新安装包，没有改版本号或发布。正式添加入口在 M13，知乎想法在 M12；用户要求三期按 M11 → M13 → M12 全部完成并通过验收后统一打包。

120 项 Python、43 项 Node、完整正式 Renderer 和小红书隔离 Renderer 通过。新手动样本按保存日进入日历，原发布日期保留，截图已查看。所有验证采用独立数据及会话，没有操作日常数据库或登录，没有进行真实平台采集。详细范围见 [M11 交付说明](M11_INTAKE_FOUNDATION.md)。

开发启动仍直接使用源码；隔离体验请指定 SUBSCRIBE_FLOW_DATA_DIR。schema v8 升级生成 before-v8 备份，旧 v7 安装包不能直接打开已升级数据；本轮没有把日常数据升级到 v8。
