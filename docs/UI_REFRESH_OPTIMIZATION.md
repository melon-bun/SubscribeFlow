# 采集中页面闪烁：排查与优化方案

2026-10-24 补记：BUG-102 的主动筛选切换范围已在 main `7852826` 修复并验收。
筛选期间保留旧列表／详情快照，来源目录独立缓存，产品侧栏只占根网格第 1 行。
专项 26/26、Node 142/142、M35 38/38、动画 21/21、完整 Renderer 通过；
连续采集仍为 0 次纸面替换、0 骨架帧。当前状态以统一 [BUG-102](BUG_FIXES.md)
和 [修复验收](verification/bug-102-switch/REPORT.md) 为准；以下保留 10 月 20 日历史实施记录。

日期：2026-10-20 JST。基线main：1229b64。优化已完成；已合并main、构建0.4.8，源码与正式包离线验收通过。

## 已确认原因

Core每次提交扫描步骤均发content.changed和sync.changed；即使内容为空也发。Main将其转换为丢弃详情的content/run别名。Renderer将content/run/channels统一合并100ms后调用refreshData(true)，force导致清空所有非settings视图缓存，并替换整个shell__body。缓存清空后出现加载占位，查询返回又整块重画。

关键位置：python/src/subscribe_flow/application/sync.py:159；electron/main/index.cjs:348；electron/renderer/scripts/app.js:390、453、506；electron/renderer/scripts/core/dom.js:83；electron/renderer/scripts/views/inbox.js:185；electron/renderer/scripts/views/channels.js:16。

小红书和知乎各复用默认隐藏的采集窗口，显示／聚焦仅在显式登录路径。知乎详情走session.fetch获取JSON，无逐篇导航。共同闪烁优先来自前述共享Renderer链路。

## 运行时复现

使用正式Renderer与隔离Electron窗口，20条固定内容，人工将列表查询延迟250ms，分别发送纯进度事件和内容＋进度事件；未请求真实平台或访问日常数据库。两种情况下主内容区均被替换3次；事件190ms后20张内容卡片全部消失，变成4张骨架卡片；原卡片节点断开；观察到15个骨架帧，随后20条内容恢复。数字仅代表该离线场景，不能当作真实采集的通用耗时。证据见verification/ui-refresh-audit-2026-10-20/result.json与加载阶段PNG。

## 建议目标与实施顺序

1. 拆分事件：进度只更新状态条、任务区域及来源任务单元格；内容、订阅、标签和打标事件仅令相关数据过期。现有原始事件已转发且多数在Preload白名单，scheduler.changed需补白名单或明确沿用兼容入口。避免原始事件与别名造成双重刷新。
2. 相同查询保留已显示内容，在后台更新：用loaded/stale/refreshing区分首次读取与更新。只有首次加载或真正切换查询条件才用骨架；后台失败保留旧结果并轻量提示。未打开的视图只标记过期，不做无关查询。
3. 保留可操作节点：状态条、数字、列表和详情独立更新；卡片按稳定内容ID复用，不因采集替换整个workspace。保护阅读锚点、选中项、批量选择、焦点、标签编辑草稿和AI补打预览。新内容进入当前窗口时建议先显示“有N条新内容”，由用户合入，避免顶端插入挤走正在阅读的位置；也可实现锚点保护后的自动插入，属于实施前需明确的体验选择。
4. 保留正确性：每个查询有queryKey和请求代次；旧查询、已离开的视图回包不得重画新页面。刷新过程中收到新事件应再补查一轮，不能丢更新或提前结束手动写入后的刷新Promise。完成／失败／取消／重启立即落定最终状态，周期回查继续作为恢复机制。
5. 高频事件可合并300–500ms，但设置最大等待和最终刷新；合并只是降低重复工作，不能替代稳定节点和保留旧内容。

## 分支与边界建议

先确定视图刷新接口，再分两条worktree线：一条负责事件分类、调度、进度局部更新和兼容；另一条负责inbox/overview/channels/tags视图的后台刷新与交互状态保护。共享app.js与DOM工具指定单一owner，联合验收在第三个临时worktree进行。建议先交付公共链路与收件箱／渠道页的无闪烁闭环，再补齐日历、看板、标签及编辑场景；不需要为此改写平台采集或逐条落库。

## 验收要求

- 首次加载完成后，持续采集期间不出现整页骨架、空白或详情消失；纯进度事件不重新查询内容、标签和日历。
- 现有卡片／当前详情节点保持连接，阅读锚点、滚动、焦点、选择、编辑草稿及补打预览稳定。
- 持续事件、突发事件、人为慢请求和乱序回包；采集中切页／切筛选／翻页、打开弹窗、编辑标签说明、手动整理与任务失败／取消均应覆盖。
- 最终列表、计数、标签与任务终态与Core持久状态一致；不因节流或迟到响应丢失新数据。
- 检查中间帧与节点替换次数，而非只看最后截图；已有并发刷新、写入锁、分页与滚动测试需要保留原语义并调整“刷新必出骨架”的过时断言。

## 实施进度与 Handoff（2026-10-20）

状态：正在实现。目标是完整优化进度、后台数据刷新和全部业务视图，不以仅延长刷新间隔代替。

主实施分支 feature/refresh-optimization，worktree /Users/xor/Documents/Subscribe_Call/.worktrees/refresh-core；子分支 fix/refresh-inbox-channels、fix/refresh-overview、fix/refresh-tags。主agent负责 app.js、core/dom.js、Preload事件与联合验收；子agent分别负责收件箱/渠道、日历/看板、标签/AI视图。若使用限制到达，在此继续补充：实际提交、未提交差异、运行中的工具句柄、验证结果、已知问题和下一步命令。

统一接口约定：各视图新增 invalidate(reasons)（保留当前查询已显示的数据，仅标记stale，不能清编辑草稿），保留 reset() 作为明确硬重置；异步回包调用 SF.app.renderView(viewName)，该接口检查当前路由后进行后台局部更新；渠道与标签页可新增 updateRuns(app)、updateTagging(app) 局部刷新任务。app.refreshData(true) 仍保证写后刷新队列排空；后台事件按原因分类，不使用全视图 reset。主agent提供 SF.dom.reconcileWithScroll(parent, children, positions) 保留相同与带键节点；视图可用 data-refresh-key 指定稳定键，data-refresh-boundary 标记整体交互子树，data-refresh-preserve 标记背景刷新期间需保持的编辑/预览子树。交互子树的事件闭包不能指向被丢弃的临时节点，因此有复杂局部闭包的区域应作为边界整体更新或由视图自身原位更新，不能盲目递归替换。

### 续接进度（2026-10-20）

- 主分支已合入：overview的98a9f88／c5b1c08，tags的fabfe2a，inbox/channels的12f4375。main仍1229b64，未改版本／未打包。
- root未提交：app.js原因化事件队列与renderView、core/dom.js稳定ID协调与焦点／滚动保护、Preload单一IPC分发；收件箱目录读回同步标签计数；原list-state/tags-smoke改为等待SWR后的真实结果；新增refresh-ui-smoke/stub和preload-events测试、BUG-102记录。
- 已通过：Node原138项、新preload用例；三个视图专项Electron；连续事件正式Renderer＋离线桥smoke（0 workspace替换、0骨架帧，total76，纯进度0内容查询）。正式Core Renderer第一轮通过前5大块，tags-smoke第290行旧立即断言过早，已改为until等待已删除标签出现，当前整套复跑中。
- 实际审查补漏：标签徽章旧值已清失效，收件箱目录返回补准确数；正式Preload11订阅超限已改成1IPC监听；聚焦渠道开关提交后旧状态冻结已改为仅输入控件延迟，按钮边界更新并按位置恢复焦点，子agent正在补回归。
- 子agent标签分支正在补离页停止未开始的目录／关联／AI补查；补丁提交后合入。渠道agent正在补聚焦开关暂停／恢复验收。overview只读审查完毕。
- 验证输出：/tmp/subscribe-flow-refresh-core/result.json及content-arrived.png；/tmp/subscribe-flow-refresh-tags-integrated；/tmp/subscribe-flow-refresh-overview.log；/tmp/subscribe-flow-refresh-node.log；/tmp/subscribe-flow-refresh-renderer.log。
- 当前运行工具：正式Renderer会话6307；无平台或模型调用。下一步：收取两个子分支补丁，核对正式Renderer退出结果，必要时修复；最后npm test＋针对有改动的smoke，提交产品修复及BUG-102，升0.4.8，合并main／推送并package:mac、smoke:packaged；证据和交付状态在这里更新。

### 最终实施与交付状态（2026-10-20）

- 产品修复76b6a7a、版本28360c6，主分支合并和构建3b3fd55。全部三个视图分支追加补丁已合并，worktree保留；主实施worktree无未提交产品代码。
- 最终通过：Node139项；正式Core/Preload/SQLite完整Renderer；三个视图专项；新旧标签AI界面；源与正式app.asar连续采集（workspace替换0、骨架0，最终76条）；聚焦开关的键盘暂停/恢复与旧规则负对照；离页停止tags目录/关联/AI补查和负对照。
- main正式包0.4.8打包、严格签名/zip/SHA检查、项目外独立启动/v2升v11备份/重启恢复/持久化均通过，55个正式资源与源码相同。实际站点和模型调用0，日常数据未访问；不将离线采集当作真实站点重采验收。
- 安装包：Subscribe_Flow/dist/Subscribe-Flow-0.4.8-mac-x64.zip；证据：docs/verification/v0.4.8/REPORT.md、result.json、refresh-ui/result.json、packaged-assets.json。BUG-102已关闭。
- 当前无运行中工具或必需未完成产品工作。下一步仅提交验收记录并推送main；实际远端确认写在下一条。

### 远端确认

已提交验收记录4704d123bc6dbf4d25aa5a77926e6cfb606d0e02，并成功推送origin/main；本地main与origin/main相同、工作区干净。正式构建仍对应3b3fd55，后续提交只改验收测试的截图等待和BUG-102文档，包内55个产品文件与当前源码相同。目标全部完成，无运行中工具或必需后续工作。
