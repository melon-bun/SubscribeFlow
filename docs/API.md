# 业务 API 与事件（含三期 M11／M13／M12）

Core 是唯一业务状态来源；接口不暴露原始 OpenCLI 参数、SQL 或平台 Cookie。
参数使用 JSON 对象；结果可经 contracts.jsonable 序列化。错误包含 code、operation、scope、
scope_key、retryable、retry_after 和脱敏 message。取消属于控制状态。

| 方法 | 输入 | 输出 |
|---|---|---|
| channel.list | 无 | 描述与能力数组 |
| connection.list | 无 | 连接元数据及最近就绪状态 |
| connection.check | connection_id, operation? | 操作级 Readiness |
| source.resolve | locator, connection_id | Source，confirmed 表示远程证据，不等于用户确认 |
| source.search | query, connection_id, limit? | 候选 SourcePage；不会创建订阅 |
| subscription.list | include_cancelled? | 订阅与来源展示信息 |
| subscription.add | locator, connection_id, confirmed=true, interval_seconds?, sync_mode? | 订阅；默认 manual、86400 秒；用户需先确认 UID/主页 |
| subscription.update | subscription_id, status?/connection_id?/interval_seconds?/sync_mode?/collect_items? | 更新后订阅；使旧任务失效并取消 |
| schedule.list / schedule.status | 无 | 各订阅持久计划 / 调度器状态和有效策略 |
| sync.start | subscription_id, mode?, page_budget?, item_key? | job_id, created, mode；活动扫描合并 |
| sync.cancel | job_id | cancelled, job_id |
| sync.retry | job_id, page_budget? | 新任务或已有活动任务；从头安全重扫 |
| sync.get | job_id | 持久化任务记录 |
| sync.list | limit?, offset? | 分页任务数组 |
| sync.coverage | subscription_id | 已保存刷新/回溯进度及兼容状态 |
| content.list | limit?, offset?, channel?, source_id?, query?, start?, end?, read?, archived?, deferred? | items,total,next_offset |
| content.calendar | month（YYYY-MM）, channel?, source_id?, query?, read?, archived?, deferred?, priority? | month,total,priorities,days；全量月统计及每日最多 3 条预览 |
| content.get | item_id | 内容事实和独立 state |
| content.update | item_id, patch | 更新后内容 |
| content.bulk_update | item_ids, patch | updated 数量，最多 100 条 |

任务模式：initial / refresh / backfill / detail。默认刷新预算 1 页，回溯 10 页，最高 100 页；
窗口读取成功可以是 succeeded + window_only，不等于历史完成。回溯每页让出浏览器资源。
短页、重复页、条目错误和预算用尽都不推进完整 checkpoint。多页终止后复查头部列表，
发现变化记为 possible_gaps，并保存已发现内容。

`collect_items` 为 1–50 的精确采集上限，0 恢复渠道默认。B站按列表顺序处理此范围，
已收录或解析失败的条目也占名额，不向范围外补足。分页预算只限制请求次数，显式
`page_budget` 也不会放宽已保存的条数上限；末页截断不产生完整历史证据。
初次获取、刷新、回溯、自动检查与重试共用此限制。

跨运行页码游标不承诺稳定；retry 从头重扫并幂等保存。持久化 cursor 用于表示已扫描到哪里，
不能把它当成精确无遗漏的恢复点。手动模式由显式 sync.retry 恢复；自动模式按 M6 持久计划与错误作用域恢复，详见 [M6_SCHEDULING.md](M6_SCHEDULING.md)。

sync_mode 仅支持 manual / automatic；interval_seconds 为 300–259200 的整数，默认 86400（24 小时）。
F1 updateChannel/createChannel 分别使用 syncMode/intervalSeconds 映射；listChannels 合入 schedule.list 的状态、next_due（Unix 秒）和 reason。
system.power({suspended:boolean}) 仅由 Main 转发系统事件，未加入业务 Preload 白名单。

事件为 `sync.changed`、`content.changed`、`subscription.changed`、`scheduler.changed`。订阅者应释放监听，
重连后重查列表与任务；事件可能合并/丢失，不是数据库日志。详情失败只影响详情任务。

F1 AppClient 已在 M5 适配到上述方法，新增来源搜索/解析、连接检查、重试与详情任务方法。F1 的规则、分类等接口属于后续范围，优先级已于 M8 接入；
不能为了匹配演示数据而在 Core 中伪造成功。首期的 read/archived/deferred 基础整理状态与 M8 优先级独立。

F1 的收件箱与“未处理”使用 `listContents({state:"unread"})`，映射为
`content.list({read:false, archived:false, deferred:false})`；`getCounts().unread` 使用相同条件。
这是界面的待处理范围，Core 单独传 `read:false` 仍只代表未读。
三项状态互斥，最多一项为真。content.update / content.bulk_update 传入一个 true 时，原子清除另外两项；
一次传入多个 true 返回 INVALID_INPUT。仅传 false 时取消指定状态；全部为 false 即回到未处理。
“全部更新”不限制处理状态，已读、稍后处理、已归档三个筛选不再重叠。
此规则按 2026-10-05 用户确认调整，见 [BUG-005](BUG_FIXES.md#bug-005整理内容状态未互斥)。

source.search 仅缓存渠道返回的已确认来源事实，不创建订阅；后续 subscription.add 仍必须 confirmed=true。
content.open / source.open 是 Main 的桌面方法，分别只接受 item_id / subscription_id，从已保存记录读取和验证 URL。

## M5 应用内 B站会话

Main 新增 connection.login({connection_id:"bilibili:default"})，打开官方应用内登录页面。
该方法不走 Python Dispatcher，也不接收 URL、脚本或 Cookie。

私有 Core→Main acquisition.request 使用 browser:N 请求 ID，只支持 check、search(query,limit)、
list(uid,page,limit)、detail(bvid)。只读固定端点，返回脱敏状态或最大 2 MiB 原始内容响应；
acquisition.cancel({id}) 传播取消。两者均不在业务 Preload 白名单内。
普通业务请求仍限制 64 KiB；采集响应通道单独允许大数据行，不能用于绕过业务参数校验。


## M8 优先级（2026-10-06）

- `priority.set_source({subscription_id, priority})`：priority 为 high / medium / low / null；返回更新后的订阅。仅修改整理默认值，不递增采集配置版本、不取消任务、不重新调度。发送 subscription.changed 与 content.changed。
- `content.update` / `content.bulk_update` 的 patch 增加 `priority`，取上述三个等级或 null；null 清除单条覆盖，恢复继承。可与处理状态同事务更新，批量任一内容无效则整体回滚。
- `content.list` 增加 priority 筛选：high / medium / low / none；none 仅匹配未设置，省略则不限制优先级。继续支持平台、来源、关键词、日期和处理状态组合筛选；total 是所有匹配记录数。
- 内容返回 `priority`（生效值）、`priority_override`（单条覆盖）、`source_priority`（来源继承值）；缺省为 null。订阅返回 `default_priority`。
- AppClient 的 `updateContent` / `bulkUpdate` 使用 `{priority, state?}`；DTO 使用 priority / priorityOverride / sourcePriority；渠道 DTO 使用 defaultPriority。
- `getPrioritySettings()` 返回来源配置；`savePrioritySettings({id,priority})` 每次保存一个来源，避免多来源部分成功；`listPriorities(query?)` 返回当前条件下 high / medium / low / none 的完整计数。
- `getCounts()` 增加 high / medium / low / none；会话能力 canManagePriorities=true。标签、规则等仍未启用。
- Renderer 只调用业务 API；Core 负责优先级继承及筛选。若同一内容关联多个来源，继承其中最高的非空默认值；内容单独设置始终优先，查询保持每条内容只计数一次。


## M8 日历补齐（2026-10-06，BUG-016）

`getCalendar({month,platform?,channelId?,state?,keyword?,priority?})` 映射到 `content.calendar`，沿用 listContents 的平台、订阅来源、处理状态、标题关键词、优先级语义，不接受 limit/offset。月份格式和范围由 Core 校验。
返回 `{month,total,priorities:{high,medium,low,none},days:[{date,total,priorities,items:[{id,title,priority}]}]}`。仅返回有匹配内容的日期，日期升序；每个日期最多三条轻量预览，计数包含所有匹配记录，不受预览或分页限制。
M11 已统一为收录方式决定日期依据，按展示时区归类并按实际时间及稳定 ID 倒序，详见下文。自动内容未知发布时间不归入月份，手动内容仍按添加时间归类。月末整秒及小数秒均纳入。当日详情通过 listContents 的 from/to 和相同筛选独立分页，每页 20 条。来源及内容修改事件使月汇总、当日列表和看板缓存失效；过期响应不能覆盖新查询。

## M9 标签系统与识别扩展接口（2026-10-06，由 minimax 实现）

### 标签管理

- `tag.list({query?, enabled?, sort?})` → `{items: Tag[], total}`；`query` 同时匹配名称与别名。
  - `sort` 是可选的显示层参数（M23），取值只有三个：`name`（默认，按名称）、`usage_desc`（使用次数从多到少）、`usage_asc`（从少到多）。不传就是按名称排，旧调用不受影响；传其它值报 `INVALID_INPUT`。
  - 排序是白名单映射，存储层不接受任意 `ORDER BY`；同次数按名称再按稳定 ID 打破平局，零次标签照常参与排序。
  - 使用次数沿用 `contentCount`：当前挂载该标签的内容条数。人工打标与自动打标都写进 `content_tags`，同一内容同一标签只有一条关联（主键约束），因此一条内容只计一次；已读、已归档、稍后处理都不影响这个数。
- `tag.get({tag_id})` → `Tag`。
- `tag.create({name, description?, color?, enabled?, synonyms?})` → `Tag`。颜色限 11 档枚举，未提供时取 slate。名称大小写不敏感唯一，重名抛 `CONFLICT`。
- `tag.update({tag_id, name?, description?, color?, synonyms?})` → `Tag`。改名只改显示名，稳定 ID 与内容关联不变。
- `tag.set_enabled({tag_id, enabled})` → `Tag`。停用不影响已有归类，也不再作为新归类候选出现。
- `tag.remove({tag_id})` → `{removed, id, detachedContents}`。`detachedContents` 是本次删除会摘掉多少条内容上的标签，供界面如实告知；关联随标签一并删除。
- `tag.contents({tag_id, limit?, offset?, read?, archived?, deferred?, priority?})` → `{items, total, next_offset}`，与 `content.list` 共用内容筛选。

`Tag = {id, name, description, color, enabled, synonyms, contentCount, createdAt, updatedAt}`。DTO 为扁平对象，不做嵌套关联。

### 内容打标

- `content.set_tags({item_id, tag_ids})` → 内容。`tag_ids` 即最终结果：传空列表是明确的清空；重复调用同一列表幂等。
- `content.bulk_set_tags({item_ids, tag_ids})` → `{updated}`。单次上限 100 条，任一内容不存在则整体回滚。
- 人工写入的关联 `origin` 恒为 `manual`；后续自动识别不会移除，也不会降级为建议。

### 标签筛选

- `content.list` 与 `content.calendar` 增加 `tags?: string[]` 与 `tag_mode?: 'any' | 'all'`。`tags` 省略或空数组表示不按标签筛选；`tag_mode` 省略即任一符合。
- 任一符合用 EXISTS，全部符合用计数相等，两者都保证同一条内容只出现一次，total 不会被多对多放大。
- 可与平台、来源、优先级、关键词、处理状态、日期任意组合。
- 内容返回 `tags: [{id,name,color,origin}]`。

### AppClient

`listTags(query?)` `getTag(id)` `createTag(draft)` `updateTag(id,patch)` `setTagEnabled(id,on)` `removeTag(id)` `listTagContents(id,q)` `setContentTags(id,ids)` `bulkSetTags(ids,ids)`。`listContents` / `getCalendar` 的 query 接受 `tags` 与 `tagMode`；非法 `tagMode` 在桥接层即报错，不静默降级为任一符合。

### 识别扩展接口

识别提供者经 `Core(recognition_provider=...)` 注入，默认不配置。契约在 `contracts/tags.py`：

- **输入** `RecognitionInput`：稳定内容 ID 加标准化字段（channel / source_id / title / summary / published_at / content_updated_at）。正文等字段缺失即 `None`，不以空串或猜测值代替；不携带任何平台原始响应。
- **输出** `TagSuggestion` + `TagCandidate`：候选区分「已有标签 ID」与「建议新标签」；`reason`、`confidence`、`origin` 均可缺省。**提供者未给置信度就保持 `None`，系统绝不代填。**
- **应用边界** `TagService.apply_suggestion()`：先比对 `content_updated_at`，内容已变化的旧建议标记为 `stale` 并拒绝应用；应用只调用 `add_suggested_tags`，该路径没有任何 DELETE，也不越过人工屏蔽记录，因此旧建议无法静默撤销人工修改。建议的新标签只回报不自动创建。
- **替换与验证入口**：本期未接入任何模型。`recognize()` 在未配置提供者时抛 `NOT_CONFIGURED`，人工标签与采集不受影响；结构化建议经统一服务应用的边界由测试替身覆盖，不出现伪造的识别结果。
- 新增事件 `tags.changed`，由主进程转发、preload 开放订阅：标签的增删改启停与内容打标都会发出，收件箱据此重取标签目录、标签视图据此刷新使用次数。

### 平台话题

标签库只存用户标签。平台原生话题留在内容自身载荷里，采集流程不会把话题写进 `tags` 或 `content_tags`。


2026-10-07 审查修复：tag.create / tag.update 的 description 接受空串，名称与 ID 仍拒绝空串；tag.contents 的状态筛选使用 Core 布尔字段（AppClient 的 state 负责映射）。RecognitionInput.source_id 来自标准化来源稳定键，published_at 来自 published.value，缺失才为 None。完整验证见 M9_REVIEW.md，提交 ad4ee9e。


## M10 渠道接入与统一契约扩展（2026-10-07）

小红书 connection 为 xiaohongshu:default，backend 为 electron-session。source.search 支持昵称并返回 SourcePage 候选（可选 avatar／description），确认后 subscription.add 保存作者；connection.login 沿用桌面入口。刷新／回溯／取消／重试／详情复用既有 API，不新增第二套订阅或整理接口。

ChannelDescriptor 新增 page_size、default_refresh_budget、default_backfill_budget、scan_overhead_budget、budget_unit（pages／details／items），Gateway 验证取值。Context.source 是详情任务的标准来源上下文；FetchRequest.known_ids／item_budget 为通用去重身份及本轮内容预算。FetchPage.scan_advanced 允许有界发现／跳过步骤不产生新内容仍继续；metrics 使用标准的主页读取、发现、跳过与详情访问计数。ContentItem.acquisition_complete 和 PublishedTime.raw_label 为可选扩展，旧数据有安全默认值。

BrowserBridge 私有请求的 channel 从当前连接生成，ChannelSessions 路由到注册后端；界面不能调用 acquisition.request 或传入脚本、任意导航地址和临时凭据。小红书作者／笔记的稳定 URL 不含访问凭据，页面返回的完整临时链接保留在该后端内部。

sync.get／sync.list 增加 acquisition_metrics；前端任务投影显示实际访问与跳过情况。来源能力匹配当前 channel + backend，平台投影按 channel 去重，使替换后端不要求修改页面。自动采集默认与手动采集统一采用来源和渠道预算，显式测试策略仍可覆盖。

## M10 分享链接与搜索调整（2026-10-07）

小红书 ContentItem.url 来自详情页“分享／复制链接”，保留已验证官方 discovery/item 分享地址的参数与 token。ContentPatch 可携带标准 url，由 Repository 合并；平台主机、身份和分享参数校验限制在 Adapter／后端。私有请求只携带稳定身份，不携带 Cookie 或可执行脚本；响应可包含有效内容分享 URL。页面提取独立于 Core。进度版本 xhs-page-2，Adapter／parser 版本 2。

小红书昵称搜索上限 60 秒，添加对话框所有控件锁定并防止关闭，超时恢复且忽略迟到响应；其他私有请求沿用 45 秒上限。平台选择为具名渠道按钮。

## BUG-042 检查窗口预算（2026-10-07）

ChannelDescriptor.budget_unit=items 表示本轮检查名额：skip 已完整内容和返回成功／失败详情都消耗名额。Core 根据标准描述计量 len(items)+len(item_errors)+metrics.skipped；不识别平台。条数配置以 items／details 为单位时直接作为 item_budget，pages 则继续整页换算。小红书限制主页前 N 个不同笔记 ID，不把跳过后剩余详情队列向后补满；进度 xhs-page-3、Adapter 3、parser 2。AppClient.checkedItems 用于说明这一预算，不改变 B站整页行为。

## M11 公共收录与日期基础（2026-10-08）

渠道契约版本为 1.1，RPC 协议仍为兼容追加的 1.0。`ContentReference = {channel, namespace, external_id, url}`，稳定键为前三项连接成的 ID。`ItemLinkAdapter` 是独立可选协议，不要求旧 Adapter 实现；仅完整声明并实现 `match_item_url`、`resolve_item`、`read_item` 的渠道连接参与链接路由。Gateway 校验 HTTP(S)、标准身份及内容／作者归属，平台规则由对应 Adapter 处理。M11 的真实 B站／小红书连接未声明这些能力，返回 `UNSUPPORTED_OPERATION`，不会执行平台采集或创建空壳记录。

| Core 方法 | 参数 | 结果 |
|---|---|---|
| intake.start | url，connection_id? | 异步任务；不创建 Job 或 Subscription |
| intake.get | task_id | 最新任务状态，preview 时带权威 ContentItem，exists／saved 时带已保存 content |
| intake.cancel | task_id | {cancelled, task_id}；取消识别和未保存预览 |
| intake.save | preview_id，priority?，tag_ids? | {status: created 或 exists, item_id, content} |
| source.list | channel?，query? | {items: Source 存储记录数组}；每项含 content_count，只包含已收录或已订阅的来源 |

任务结果字段为 `task_id, state, connection_id, channel, preview_id, item_id, error, created_at, updated_at`，state 取 queued／running／preview／exists／saved／cancelled／failed／expired。新预览字段为 `preview: {id, ...ContentItem}`，没有前端伪造的收录时间。识别上限 60 秒含资源等待，预览 300 秒失效；最多 8 个识别任务、100 个任务记录，终态记录可回收。Core 重启后任务及未保存预览消失，成功内容保留。

保存只接收权威预览 ID 和初始标签／优先级，不接受任意 payload、发布时间或收录元信息。首次保存原子创建内容、真实来源关联、未处理状态与整理设置；无真实订阅也能收录来源。优先级为空时依照已存在的来源订阅继承，无订阅则未设置。同 ID 已存在时返回原记录，不应用临时标签／优先级、不创建关联、不改时间。预览后其他入口抢先收录也遵循此规则。

取消、连接配置变化、休眠、超时、预览过期及应用关闭都会阻止未保存结果入库。标准错误含 `INVALID_INPUT`、`UNSUPPORTED_OPERATION`、`AMBIGUOUS_CONNECTION`、`AUTH_REQUIRED`／`AUTH_EXPIRED`、`RATE_LIMITED`、`SCHEMA_CHANGED`、`TIMEOUT`、`CANCELLED`、`STALE_CONFIG`、`PREVIEW_EXPIRED`、`BUSY`。渠道认证等读取失败同步到连接 readiness；已有恢复入口仍可使用。

`intake.changed` 发布任务结果。仅成功创建内容时发布 `content.changed` 和 `tags.changed`，已有记录分支不报告新增。同步、收录共用 Core 的 ResourceCoordinator 及调度策略间隔。

### 日期查询与 DTO

- `content.list`、`content.calendar`、`tag.contents` 追加 `intake_method?: subscription | manual` 和 `timezone?: IANA 时区`。`content.get` 可指定 timezone。Core 默认 UTC，桌面 AppClient 默认传入系统 IANA 时区。
- `tag.contents` 同步支持 channel、source_id、query、start、end、tags、tag_mode 等组合条件。source_id 表达真实来源稳定键，无需对应订阅。
- Core 内容追加 `first_seen_at, intake_method, manual_added_at, calendar_at, calendar_date, calendar_timezone, calendar_basis`；calendar_basis 为 published_at 或 manual_added_at。calendar_at 保留选中事实的原值，calendar_date 是用于归组的展示日期。
- `content.calendar` 追加 timezone；日期格预览追加 intake_method、calendar_at。完整计数、每天最多三条预览、当天分页及列表排序采用统一规则。
- start／end 支持 YYYY-MM-DD（展示时区下完整一天，含月末微秒）或时间戳；有偏移时间戳转到展示时区，无偏移值按展示时区解释。仅日期精度保持字面日期，自动未知日期仍可列出但不计入日历；手动未知发布时间按保存时间计入日历。
- 排序按日期投影的实际时间倒序及稳定 ID 倒序，夏令时回拨的重复小时按时间先后排列；日期精度的午夜仅为内部排序键，不生成新的发布时间事实。

### 桌面业务接口

`startIntake({url, connectionId?})`、`getIntake(taskId)`、`cancelIntake(taskId)`、`saveIntake(previewId, {priority?, tagIds?})`、`listContentSources({platform?, keyword?})` 均经过 Main／Preload 白名单；Renderer 统一通过 AppClient 使用。

前四项暂返回 Core 的原始任务／保存结构，preview 和 content 为标准 Core 结构，并非普通内容页面的 camelCase DTO。M13 保存后使用 item_id 调用 getContent 取得页面 DTO。listContentSources 返回 `{items,total}`，来源 DTO 为 id／platform／kind／externalId／name／link／confirmed／contentCount。getSession.capabilities.canIntake 仅在某渠道声明完整能力且有同 backend 的启用连接时为 true。

普通页面内容 DTO 增加 sourceId、intakeMethod、firstSeenAt、manualAddedAt、calendarAt、calendarDate、calendarTimezone、calendarBasis。listContents／getCalendar／listTagContents 的 query 增加 sourceId、intakeMethod、timezone，from／to 使用上述日期语义。原 channelId 继续指 Subscription，sourceId 是真实 Source；两者冲突时报错。sourceId 可用于无订阅来源。

`SubscribeFlow.request(name, params)` 返回普通 `{ok,value}` 或 `{ok:false,error}` 信封。正式 AppClient 据此在 Renderer 内构造 Error，保留 code／scope／retry_after 等字段。原 `SubscribeFlow.call` 保留兼容，但跨 contextBridge 抛出的 Error 自定义字段可能丢失；新业务使用 AppClient 或 request。任意不在白名单的方法仍被拒绝。


## M13 正式单条读取与内容界面

B站与小红书 Electron Adapter 已注册可选 match_item_url／resolve_item／read_item。链接类型和边界见 M13_MANUAL_INTAKE.md；Core 接口形状沿用 M11，不新增平台专属公开方法。

内容 DTO 增加 canFetchDetail，仅表示该来源存在 active Subscription；详情入口还需对应渠道支持 get_item_detail。无订阅的单条识别已经取得完整内容，不生成虚拟订阅来启动详情同步任务。sourceId 与 intakeMethod 在收件箱、日历和看板中分别筛选，原 channelId 兼容保留。

## M12 知乎接入

知乎使用同一公共 source.*、subscription.*、sync.*、intake.*、content.* 接口，不新增平台专属 RPC。作者稳定 external_id 为平台 ID，官方主页 token 仅用于定位；内容 namespace／kind 为 pin，唯一键 zhihu:pin:<ID>。单条仅官方 /pin/ 链接，resolve_item 本地就绪、read_item 要求真实登录会话。完整范围与真实验证跳过项见 M12_ZHIHU_PINS.md。

content DTO 新增 kind（平台内容类型），供详情将想法显示为正文并保留段落；原字段兼容。channel DTO 新增 contentNoun，从 descriptor.content_types 推导想法／笔记／内容，用于条数与回溯说明。任务指标统一用“内容”。

知乎私有 Main 操作限制为 check／author／search／scan／read／detail，参数经固定白名单和稳定 ID／官方地址验证；不向 Renderer 暴露 Cookie、通用请求或脚本。Adapter／parser 1，进度 zhihu-page-1，items 预算、默认 8／30、扫描 overhead 13，full_history=false。运行测试假数据通过不等于实际账号 Readiness ready，真实连接仍检查当前平台会话。


## M21 AI API 与识别策略分离（0.4.9）

连接参数与识别策略是两个分区，保存互不覆盖。存档结构（`app_settings.payload`）：

```
{
  "ai":      {"providers": {"jev": {endpoint, model, credentialRef}, "llm": {...}}},
  "tagging": {"enabled": bool, "mode": "jev"|"llm", "enabledSince": ISO8601|null},
  "reminder": {...},
  "priority": {"names": {...}}
}
```

- `ai.providers` 只放“怎么连”：接口地址、模型标识、凭据引用。两类 API 各自独立，允许保存尚未补齐的参数；缺项在快照里如实标成 `missing`。
- `tagging` 只放“用不用、怎么识别”：开关、识别方式、原启用时间。三个等级与顺序固定，没有新增或删除等级的入口。
- 策略保存不得携带任何 API 字段；API 保存不得携带任何策略字段。Core 遇到分区以外的字段直接拒绝。

### settings.get 快照

```
{version, updatedAt, savedVersion,
 ai: {providers: {jev|llm: {endpoint, model, credentialRef, configured, missing[], officialDefaults}}},
 tagging: {enabled, mode, enabledSince},
 reminder: {enabled, intervalMinutes, preset},
 priority: {names: {high, medium, low}}}
```

`credentialRef` 只在 Core 内部流转：Main 的设置桥接在交给界面前剥掉引用，只给出“配没配／能不能解开／最近何时更新”。界面永远拿不到密钥明文。

### settings.update

按分区提交：`{section, patch, credential_refs?}`。`section` 取 `ai`／`tagging`／`reminder`／`priority`。

- `ai` 的 patch 为 `{providers: {jev|llm: {endpoint?, model?}}}`；密钥只能经 `credential_refs` 提交（值为引用或 null 表示清除），不接受明文。
- `tagging` 的 patch 为 `{enabled?, mode?}`，不接受凭据引用。启用或切换方式时，目标方式的 API 必须完整（接口地址、模型标识、凭据引用齐备），否则拒绝并说清缺哪几项。
- `reminder`／`priority` 的 patch 见各自分区，不接受凭据引用。

### 旧结构兼容

M21 之前连接参数放在 `tagging.providers`。读取时两个位置都认，`ai.providers` 优先、`tagging.providers` 只补新结构没有的字段；转换幂等，读一次再存一次与原来等价。升级不重置开关、识别方式、原启用时间，也不丢凭据引用，不触发任何历史补打。

### 配置版本与在途结果

`version` 是**识别配置版本**：只在当前生效的识别配置真的变了时前进——改动当前方式所用的 API、切换识别方式、启停识别。改另一种暂未使用的 API、改优先级别名、改提醒参数都不动它。因此：

- 在途识别结果不会被无关保存作废（`tagging_tasks.config_version` 与当前版本不一致才会重排）。
- 提醒计时与自动打标的启用时间不受别名或提醒保存影响。

### tagging.test

可带可选参数 `mode`（`jev`／`llm`），只测指定的那一类 API：走与后台打标完全相同的组装路径，只发一次探测请求，不改当前打标方式、不启停识别、不产生标签。不带 `mode` 时测当前方式。目标方式未配置完整时如实返回缺项。

## M26 笔记存储与查询（2026-10-22）

一条内容最多一条笔记。写入是**全量替换**；每次真正写入换一个版本令牌，旧令牌盖不住新版本。
详见 [M26 笔记存储与查询](M26_NOTES_CORE.md)。

### note.get

`{item_id}` → `Note` 或 `null`。内容不存在（`NOT_FOUND`）与「内容没有笔记」（`null`）是两回事。

### note.save

`{item_id, expected_version, template, summary, summary_origin, takeaway, verdict}` → 保存后的 `Note`，或 `null`。

- `template`：`general`／`project`；`summary_origin`：`manual`／`ai`／`ai_edited`／null；`verdict`：`using`／`watching`／`dropped`／null。
- `summary` ≤ 2000 字、`takeaway` ≤ 20000 字，两者都可清空；`expected_version`／`summary_origin`／`verdict` 可为 null。
- **新建**传 `expected_version: null`；**更新**提交读到的令牌。令牌对不上即冲突（`CONFLICT`）：不写入，`details.current` 带回当前这一份。
- 总结清空时 `summary_origin` 一并清空；通用模板不能带项目结论（`INVALID_INPUT`）。
- 总结与心得都空、也没有结论 = 没有笔记：删掉那一行并返回 `null`，不留 `none` 空行。

### note.delete

`{item_id, expected_version}` → `{ok: true}`。只删笔记，不删内容；令牌对不上即冲突。

### note.list

`{query?, channel?, source_id?, tags?, tag_mode?, verdict?, limit?, offset?, sort?, timezone?}` → `{items, total, limit, offset, next_offset}`。

- `items` 每项只有 `id`（内容 ID）、`title`（原标题）、`note_updated_at`（笔记最近更新时间）；目录不返回笔记正文。
- `query` 同时搜原标题、总结与个人心得；`tag_mode` 为 `any`／`all`，与内容查询同一套写法。
- `sort` 白名单：`updated`（默认）／`created`／`title`；同刻再按稳定 ID 排。
- 列表与 `total`／`next_offset` 共用同一段筛选；多来源、多标签不重计。

### note.facets

与 `note.list` 一致的范围条件 → `{channels, sources, tags}`，每项带使用量。
只统计**有笔记的内容**：不是笔记的标签不当作笔记标签，数量按内容去重。

### 内容 DTO 的 has_note

`content.list`／`content.get` 的 DTO 增加 `has_note`（Core 字段名），Main 的 `contentDTO` 透传为 `hasNote`。

### 事件

保存或删除笔记提交后只发 `content.changed(ids)`：不发 `content.created`，不触发自动打标，
不推进 `tagging.revision`；标签全库使用次数口径不变。

### AppClient（M26）

`getNote(itemId)`、`saveNote(itemId, note)`、`deleteNote(itemId, expectedVersion)`、
`listNotes(query)`、`noteFacets(query)`；参数用驼峰，主进程转成 Core 字段名。

## M29 AI 总结（2026-10-22）

设置分区 `summarization`（`settings.get`／`settings.update`）：`enabled`（默认 true）、
`providerId`（默认 null；必须是协议支持文本生成的连接）、`length`
（`brief` 简略·一句话／`detailed` 复杂·300 字，默认 brief）、`language`
（`zh-CN` 中文／`original` 原文语言，默认 zh-CN）。
分区有自己的 `revision`：策略变了才前进，与打标的 `tagging.revision` 互不相干。
解除引用是明确的 `null`，不会被默认连接复活；密钥明文仍只经 Main 的凭据桥按连接 ID 提交。

### note.draft

`{item_id, request_id}` → 总结草稿。**受限接口**：不接受任意 prompt，不接受自定义模型，
不返回密钥。

成功返回：

```json
{"ok": true, "item_id": "…", "request_id": "…", "summary": "…",
 "scope": "正文", "input_chars": 420, "input_total_chars": 420, "input_truncated": false,
 "content_version": "…", "config_version": 3,
 "provider": {"id": "provider-llm", "name": "…", "model": "…"},
 "length": "detailed", "language": "zh-CN", "model": "…"}
```

失败也返回结果（不是异常），`ok: false` 且 `code` 说明原因：
`disabled`／`not_configured`／`incompatible`／`insufficient_text`／`timeout`／
`auth_failed`／`rate_limited`／`network_failed`／`empty_response`／**`stale`**，
`message` 是人话。

- `config_version` 是**有效总结配置版本**：「策略版本 . 所选连接的调用版本 . 提示词版本」。
  改无关连接、改连接展示名、改打标／提醒／笔记设置都不影响它；改那条所用连接的
  地址、模型、密钥或启停才会。
- 结果里还带 `config`（请求时的策略快照）与 `provider.revision`（请求时那条连接的调用版本），
  供界面在真正应用前核对。
- **`stale`**：等 AI 回来的这段时间里，策略、那条连接或原文变了。`draft` 里仍保留
  那段草稿，界面可以把它留成「采用这段总结」由用户显式决定——但它**不会**被当成
  当前配置下的新结果自动填入。

- **只生成草稿**：绝不写 `content_notes`，不改心得、结论、标签、处理状态与优先级，
  不触发自动打标，也不新增持久 AI 任务表。
- 输入只用本地已保存的标题、来源与正文／简介；按内容类型区分「正文」与「简介」；
  文本不足明确拒绝；输入超长会截断并在 `input_truncated` 里说明。
- 一次生成有业务预算（30 秒），与后台打标共用同一把 Provider 级并发闸门。

### 事件

生成不发任何事件。保存或删除笔记仍只发 `content.changed(ids)`。

## M36–M38 智能优先级契约（2026-10-24）

本批**不新增任何 RPC 方法**，不改变界面与主进程之间的接口。这一节记录的是 Core 内部
的固定契约：后续 M39–M43 都在它之上工作，接口形状变了就等于语义变了。

### 四选一决策

`priority_engine.contracts`：

- 业务决策 `PriorityDecision.priority` 只有四个值：`high`／`medium`／`low`／`unknown`。
  `unknown` 是合法结果，表示「证据无法可靠区分三档」，不是错误、也不是第四个等级。
- 执行状态 `PriorityDecision.status` 与业务决策**分开保存**：`ok`（模型给出档位）、
  `model_unknown`（模型明确说无法判断）、`invalid_response`（协议没给出合法答案）、
  `not_configured`／`timeout`／`network_failed`／`cancelled`（调用层失败）、
  `input_budget_exceeded`／`no_title`／`no_tags`／`no_evidence`／`inconsistent`
  （本地就没有发请求，或本地数据不一致）。
  「模型说无法判断」与「调用失败」因此不会混成同一件事。
- 最终来源 `ResolvedPriority.origin` 只有四个值：`manual`／`smart`／`source`／`none`。
  解析顺序固定：人工值 → 智能结果 → 来源默认值 → 未设置（`level` 为 `null`）。
  `resolve_priority()` 是纯函数：不查库、不发请求、不回写任何一处取值。

### 统一上下文 `PriorityContextV1`

`priority_engine.context.PriorityContextBuilder` 是纯数据变换：输入一份统计快照，
输出统一上下文。它不查库、不读环境、不发请求。

```json
{
  "schema_version": "priority_context_v1",
  "target": {"title": "…", "tag_ids": ["tag-db"]},
  "tag_catalog": [{"id": "tag-db", "name": "…", "description": "…", "synonyms": ["…"]}],
  "history": {
    "high":   [{"tag_id": "tag-db", "content_count": 12, "recent_sample_ids": ["s1", "s2"]}],
    "medium": [{"tag_id": "tag-db", "content_count": 5,  "recent_sample_ids": ["s3", "s4"]}],
    "low":    [{"tag_id": "tag-db", "content_count": 3,  "recent_sample_ids": ["s5", "s6"]}]
  },
  "samples": [{"id": "s1", "title": "…"}],
  "input_limits": {"titles_truncated": false}
}
```

- 三档必须齐全；缺失的分组显式填 `content_count: 0` 与空样本，空组只表示没有证据。
- 样本按内容 ID 去重（`s1`、`s2`…），同一内容出现在多个标签下仍是同一份证据。
- 当前待判内容不能成为自己的样本。
- 标题按 Unicode 字符边界截断（当前 240、历史 160），发生截断如实标记。
- 来源默认优先级、正文与链接都不进上下文。
- 预算：当前有效标签最多 12 个；序列化后最多 24000 字符。超限直接返回本地结论，
  不截坏 JSON、不删掉某一档的反例。
- 结果对象带 `payload`（序列化后的 JSON）、`fingerprint`（上下文指纹）与
  `snapshot`（本地执行快照：内容／标签版本、人工版本、偏好版本、策略版本、连接版本、
  提示词版本）。快照不发给模型，用于缓存键与返回后的过期校验。

### 固定提示词

`priority_engine.prompts`，版本 `priority_prompt_v1`：

- `PRIORITY_RULES_V1`：共用规则全文，LLM 与 Jev 四问都以它开头。
- `LLM_OUTPUT_RULES_V1`：LLM 的输出约束，追加在共用规则之后（同一条 system 消息）。
- `JEV_QUESTION_SUFFIXES_V1`：Jev 四问的问题文本；Jev **不**附加 LLM 的「只输出 JSON」约束。
- LLM 与 Jev 使用**同一份** `payload`（LLM 作 user 消息，Jev 作 state）。

### 存储侧接口（Core 内部）

`subscribe_flow.storage.priority_intelligence.PriorityIntelligenceRepository`，
由 `Repository.priority_intelligence` 持有：

| 方法 | 用途 |
| --- | --- |
| `groups_for_tags(tag_ids)` | 读这些标签在三档下的分布（读前先重建待处理分组） |
| `group(priority, tag_id)` | 读单个分组；不存在返回 `None` |
| `preference_version(tag_ids)` | 相关偏好版本：由分组版本与计数决定 |
| `context_snapshot(content_id, …)` | 读出判断输入快照（内容、标签、三档分布、样本标题、版本） |
| `flush_dirty()` / `rebuild_all()` | 重建待处理分组／从原始关系全量重算 |
| `save_decision` / `get_decision` / `clear_decision` / `decisions_for` | 最新智能结果的存取 |
| `summary()` | 分组数、样本数、待重建数、已存结果数 |

写路径不变：人工改档、批量操作、标签增删停启与标题更新由数据库触发器标脏，
统计仓储只负责重建，因此既有写入路径不需要改动。

## M39–M41 智能优先级判断、调度与统一口径（2026-10-24）

本批新增三条 RPC 方法与一个设置分区，其余接口不变。

### 设置分区：优先级 · 智能判断

`settings.update` 的 `section` 仍是 `priority`，`patch` 现在多认一个 `smart`：

```json
{"section": "priority", "patch": {"smart": {"enabled": true, "providerId": "provider-llm"}}}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 智能判断总开关。关闭时读取立即回退人工值／来源值 |
| `providerId` | 所选 AI 连接 ID。LLM 还是 Jev 由它的协议决定，不需要另选 |

约束：开启时必须有所选连接；引用不存在的连接会被拒绝。
`priority.smart.revision` 是智能判断的有效策略版本：只在开关或所选连接真的变了时
前进。**改三级显示名称不动它**，因此改名不会作废在途结果，也不会重跑任务。
旧存档没有 `smart` 时按关闭处理，坏值不拖垮整个设置。

### RPC 方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `priority.status` | — | `{enabled, providerId, mode, policyVersion, providerVersion, promptVersion, tasks, decisions, requested, decided}` |
| `priority.judge` | `item_id` | `{queued, reason}` |
| `priority.judge_bulk` | `item_ids`（1–100） | `{queued, reason}` |

三条都不返回凭据，也不返回模型原文。判断是后台任务：接口只排队，不等模型返回。
`priority.judge` 与 `priority.judge_bulk` 是**用户明确要求**：它们忽略已有结果与
重试预算，重新排一次。

### 内容 DTO 的新字段

内容列表、详情、筛选、日历、看板计数、提醒与托盘用的都是同一个内容 DTO，
现在多一个字段：

| 字段 | 含义 |
| --- | --- |
| `priority_origin` | 最终优先级是从哪来的：`manual`／`smart`／`source`／`none` |

`priority` 仍是最终等级（`high`／`medium`／`low`／`null`）。
界面照着 `priority_origin` 显示来源，**不由前端按是否开启 AI 猜测**。

### 内部契约

- `priority_engine.inference`：严格解析 LLM 的单字段 JSON（重复键、额外字段、
  错误类型、非法枚举、非 JSON、截断输出一律 `invalid_response`），
  以及 Jev 四问的收敛（阈值 0.7、差距 0.2、`unknown` 底线 0.5，
  布尔值不算合法数值，边界留浮点余量）。常量集中在这里。
- `subscribe_flow.application.priority_intelligence`：后台服务。资格检查、
  排队执行、在途核对与结果落库。适配器在事件循环线程里组装，网络请求进执行器。
- 在途核对比对的是**真实上下文指纹**与各个版本（内容／标签／人工操作／策略／
  连接调用／提示词），不是可能相同的时间戳。用户改过优先级、改过标签、
  关闭功能或换过连接之后，旧结果不写。
- 偏好统计重建失败时不拿旧分布去请求模型：这一条内容回退人工值／来源值。

## M42–M43 优先级设置统一保存与界面口径（2026-10-24）

本批不新增 RPC 方法，沿用 `settings.update` 的 `priority` 分区并扩展它的 `patch`。

### 设置分区：优先级设置

`section` 仍是 `priority`（设置页左栏显示为「优先级设置」），`patch` 现在认三块：

```json
{"section": "priority", "patch": {
  "names": {"high": "今天看", "medium": "有空看", "low": "以后再说"},
  "smart": {"enabled": true, "providerId": "provider-llm"},
  "sources": {"sub-xxx": "medium", "sub-yyy": null}
}}
```

| 字段 | 说明 |
| --- | --- |
| `names` | 三级显示名。与 M20 规则相同：去首尾空格后 1–12 字符、三级不重名、不占用「未设置」 |
| `smart` | 智能判断开关与所选连接。语义见 M39–M41 |
| `sources` | 来源默认优先级。键是订阅 ID，值是 `high`／`medium`／`low`／`null`（null 表示不设置） |

约束与行为：

- **一次保存，三块一起生效**。名称与策略进设置存档（`app_settings`），来源默认值进
  `subscriptions.default_priority`，两者在**同一个 SQLite 事务**里写：要么都生效，
  要么都不生效。不会出现「名称已保存、只保存了一半来源」。
- 整份先校验再写：名称非法、来源优先级非法、开启智能判断却没有连接，都直接拒绝，
  此时**一条都不写**。
- `sources` 里的来源在草稿期间被取消订阅（status=cancelled）时，保存**明确失败**
  （`INVALID_INPUT`，scope=`field`，scope_key=`sources.<订阅ID>`），不静默跳过。
- `sources` 不进设置存档：它的真身是订阅行。省略 `sources` 即表示不改来源默认值。
- 改三级显示名**不推进** `priority.smart.revision`：改名只改显示，不得作废在途结果。
- 旧的 `priority.set_source({subscription_id, priority})` 仍然保留，可单独改一个来源；
  设置页不再用它（改一条存一条不是这里要的语义）。

### 界面口径

- 设置页「优先级设置」是一个草稿、一个保存动作：智能判断、来源默认优先级、三个
  名称共用同一份草稿。取消丢弃全部，离开时按既有流程提示保存还是放弃。
- 渠道管理页不再有「优先级设置」分区，也没有空的切换栏；旧路由
  `#/channels?tab=priorities` 自动跳到 `#/settings?section=priority`。
- 内容详情里的优先级控件是「自动判断｜高｜中｜低」四段：
  - 「自动判断」= 没有单条人工值，最终优先级按 人工 → 智能判断 → 来源默认值 的顺序兜底；
  - 小字按内容 DTO 的 `priority_origin` 显示：单独设置／智能判断／跟随来源／未设置；
  - 选中「自动判断」时，如果智能判断已开启，额外给一个「重新判断」动作
    （对应 `priority.judge`）。**「自动」是兜底语义，不承诺每次都调用模型。**
- 批量操作的「恢复自动判断」即清掉单条人工值（`priority: null`）。
- 自主添加（收录对话框）的默认项与详情一致，显示「自动判断」。

## M44 桌面受限桥接：智能判断的三个调用（BUG-124，2026-10-24）

Python 侧的 `priority.status`／`priority.judge`／`priority.judge_bulk` 三条 RPC 早就在，
主进程的 `UI_METHODS` 与 `callUI` 也在；**桌面端只开放三个受限业务调用**，
渲染进程不能直通 Core 的任意 RPC。

| AppClient 方法 | 落到 RPC | 参数 | 说明 |
| --- | --- | --- | --- |
| `getPriorityStatus()` | `priority.status` | 无 | 开关、所选连接、策略／提示词版本、在途任务与计数 |
| `judgePriority(itemId)` | `priority.judge` | `item_id` | 用户明确要求判断一条内容；忽略已有结果与重试预算，重新排一次 |
| `judgePriorityBulk(itemIds)` | `priority.judge_bulk` | `item_ids`（1–100） | 同上，批量 |

受限链路（缺任何一段，正式界面选中内容就会整块报错）：

```
Renderer AppClient → preload 白名单 → 主进程 UI_METHODS / callUI → Python RPC
```

- `electron/renderer/scripts/core/app-client.js` 的 `CONTRACT` 列出这三个方法；
- `electron/preload/index.cjs` 的 `allowed` 白名单收录同样三个名字；
- 主进程 `UI_METHODS` 已覆盖它们，**原始 RPC 名不得出现在渲染进程白名单里**；
- `CORE_METHODS` 不因这三个调用而新增任何原始 RPC 名。

三条都不返回凭据，也不返回模型原文。判断是后台任务：接口只排队，不等模型返回。

界面对应的状态失效规则：详情里的「重新判断」入口只在**自动选中且智能判断已开启**时出现
（手动档优先，不给入口）。智能判断的开关状态按「路由对象换过就重读一次」处理，
并纳入优先级分段的刷新依据——**等级没变、来源变了、或开关刚改过，这一段都会重画**。
状态读取失败按「没开」处理，不让详情面板消失。
