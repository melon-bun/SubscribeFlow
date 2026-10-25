# M2–M11 存储约定

运行时数据库位置由启动层提供绝对路径，不能依赖工作目录。Python 单连接统一写入，
WAL、外键约束和短事务；平台请求不在写事务内。初始 schema 在 migrations/001_initial.sql。

- sources 采用渠道/类型/原生 ID；subscriptions 每来源一个稳定 ID，暂停/取消都保留内容。
- connections 只保存非敏感环境元数据，变更递增 version；不保存 Cookie/API key。
- contents 与 content_sources 分离；content_states 的 read/archived/deferred 只由用户操作更新。
- jobs 保存配置快照、状态、覆盖和错误；fetch_runs 保存每次已提交分页的计数/条目错误。
- sync_progress 按订阅/backend/兼容版本/内容范围/刷新或回溯隔离。
- 每页的内容、来源关联、执行计数、回溯位置原子提交；失败回滚本页，保留前页。
- 完整 checkpoint 仅在已确认结束且无条目错误时随完成状态一同提交。
- 配置版本不匹配、暂停、取消或停用连接时，旧任务不能继续提交。
- 后端变更或进度版本不兼容时从头重扫；历史事实和用户状态继续保留。
- 迁移前使用 SQLite backup API 制作一致性备份。跨版本升级任一迁移失败整体回滚；同名备份已存在时追加唯一后缀，保留首个备份；数据库版本高于程序时拒绝打开。
- M11 起重复收录立即保留整条原记录，不修改内容、来源关联或整理信息；独立详情补全仍可合并平台事实，不降低已有时间精度，并保留首次收录信息。

当前测试覆盖重跑幂等、状态保留、取消保留历史、整页回滚、刷新/回溯隔离、
错误页不推进 checkpoint、配置版本校验、批量更新原子性、WAL 一致性备份及中断标记。

## M5 来源名称保留

作者搜索将已确认来源事实保存至 sources，但不创建 subscriptions。之后 UID-only 解析得到的未确认名称不会覆盖已确认名称。无需新增 schema 或迁移。

## M5 应用内会话

桌面默认 B站后端为 electron-session。启动时将已知旧 opencli 连接改为新后端和资源键，
version 增加一次，旧进度不兼容但不删除历史。重复启动不再次升版。
Cookie 位于 Electron userData/Partitions/bilibili，SQLite、RPC 与业务页面均不保存它。
备份 SQLite 不等于备份登录会话；复制或分享诊断材料时不要打包整个 userData。


## 当前 schema 与 M7 恢复验收（2026-10-05）

本节为 M7 历史记录，当时 SQLite v4；当前开发源码为 v8，见文末 M11。v4 为每个订阅增加 `collect_items`（0 表示使用默认，1-50 为条数上限）；升级前同样生成 `.before-v4.backup`。
read / archived / deferred 互斥，选择一项原子清除另两项；旧多重状态升级时按归档 > 稍后处理 > 已读保留一项，升级前保存完整原状态。
M7 将跨多个版本的迁移合并为一个事务；v1 → v3 第三步故障注入验证全部回滚，重试不覆盖首次备份，见 BUG-006。
真实冻结 Core 的 v2 → v3 升级、备份、单选和应用重启验证通过。手动备份与恢复操作见 [M7 交付说明](M7_DELIVERY.md#数据升级与恢复)。


## M8 优先级 · schema v5（2026-10-06）

005_priorities.sql 增加 subscriptions.default_priority 和 content_states.priority_override，均可为 NULL 或 high / medium / low，由 CHECK 约束限制。
旧数据两列均为 NULL，保持未设置。内容事实及采集 upsert 不写这些字段，已读／稍后处理／归档互斥规则保持独立。
生效值在 Core 查询时计算：单条覆盖优先，否则继承关联来源最高非空默认值，均为空则未设置。来源取消后仍保留继承关系；调整默认值立即作用于未覆盖的历史内容。
来源优先级通过专用写入路径修改，不改变同步配置 version；分页内容及总数共用相同筛选表达式。批量处理在一个事务完成。
升级前生成 `.before-v5.backup`，沿用整次迁移回滚及备份不覆盖机制；v4 的 collect_items 设置保留。旧版本应用无法打开 v5 数据，恢复旧版需使用对应升级前备份。


M8 日历补齐（BUG-016）：不新增 schema，仍为 v5。月统计和 content.list 复用同一筛选构造与生效优先级表达式，SQL 按来源日期和等级全量聚合；窗口函数限制每个日期返回 3 条轻量预览。未知日期不归入月份；跨多来源关联不重复计数。Python 验证 125 条有日期记录超过原 100 条上限时，早期日期及全部计数仍正确。


## M9 标签系统 · schema v6（2026-10-06，由 minimax 实现）

006_tags.sql 新增三张表，不改动 v5 既有结构。

- `tags`：标签自身。`name` 建大小写不敏感唯一索引，重名在写入前被拒而不是静默合并；`color` 由 CHECK 限制在 11 档受控色板内，默认 slate；`synonyms` 以 JSON 数组存储；`enabled` 控制是否作为新归类候选出现，停用不影响已有归类。
- `content_tags`：内容与标签的多对多关联，`origin` 取 manual / suggested，主键 `(content_id, tag_id)` 使重复打标幂等。关联挂在稳定 ID 上，因此改名不影响任何内容关联。
- `content_tag_blocks`：人工移除记录。摘掉的标签记入此表，自动识别不得越过它重新加回；人工重新添加时解除。`tag_id` 故意不加外键——标签被删除后用同名重建会得到新 ID，屏蔽关系自然失效。

标签独立于采集事实表：采集 upsert 只写 `contents` / `content_states`，因此重新采集在结构上就无法覆盖人工标签。平台原生话题留在内容载荷里，不进入 `tags` / `content_tags`。

筛选在查询期完成，任一符合用 EXISTS，全部符合用计数相等，两者都保证同一条内容只计数一次；分页总数与列表复用同一筛选表达式，统计不会被多对多放大。

升级前生成 `.before-v6.backup`，沿用整次迁移回滚及备份不覆盖机制；v5 的优先级、处理状态与 collect_items 全部保留。旧版本应用无法打开 v6 数据，恢复旧版需使用对应升级前备份。


## M10 采集统计 · schema v7（2026-10-07）

007_acquisition_metrics.sql 为 jobs 增加 acquisition_metrics JSON，记录 profile_reads／discovered／skipped／detail_requests；commit_page 与内容提交在同一事务累计，旧任务默认空对象。升级沿用备份、整体迁移回滚与不覆盖已有备份机制。

ContentItem.acquisition_complete 在既有 payload 中保存；Core 查询某来源最近最多 2000 条完整 ID，作为统一 FetchRequest.known_ids 提供给 Adapter。失败、占位或未完成记录不能跳过，后端不直接访问数据库。Source 搜索候选可携带头像与简介，稳定存储仍使用渠道／作者 ID；主页临时导航签名只在渠道后端缓存；笔记对外链接保存官方分享流程取得的 discovery/item URL 及必要分享参数，token 不参与去重。PublishedTime.raw_label 保存原始模糊日期，详情合并不降低已保存日期精度。人工状态、优先级和标签独立保留。

get_subscription 同时投影连接当前 backend，使替换后端时界面显示实际能力；来源与内容身份均不含 backend，旧内容保留。

2026-10-07：用户要求不兼容旧笔记；独立验收目录原 4 条小红书内容及关联状态已删除，订阅和登录保留，用户自行重采。新采集 ContentItem.url 保存已验证分享地址，补充详情可通过通用 url patch 更新；无需新增表或迁移。

BUG-042（2026-10-07）：skipped 识别正确，预算计量修正为已收录也占窗口名额。discovered 为窗口内检查的不同 ID 数，skipped 为其中完整收录数，detail_requests 为实际详情请求数。没有新增表／迁移，无需删除既有笔记；人工整理与来源身份保留。

## M11 公共收录 · schema v8（2026-10-08）

008_intake.sql 追加 `contents.intake_method`（NOT NULL，subscription／manual，默认 subscription）及 `manual_added_at`。CHECK 要求自动内容的手动添加时间为 NULL、手动内容非 NULL；首次收录不可变触发器禁止修改 intake_method、manual_added_at、first_seen_at。新增索引 content_intake_timeline，不另存日历时间副本。已发布 0.2.0 安装包仍为 v7，当前仅开发源码升级至 v8。

v7 旧内容全部标记 subscription，原表的全部既有列、来源、订阅、优先级、标签与整理状态不改动；不能把升级当天写成添加时间。升级前使用 SQLite backup 生成 `.before-v8.backup`，失败整次升级回滚，同名备份不覆盖。v8 库不能由旧 v7 程序直接打开，回退应使用对应升级前备份。

`_upsert_item` 现在先按 channel／namespace／external_id 查重，在 BEGIN IMMEDIATE 中仅首次创建。重复身份不更新正文载荷、内容更新时间、来源事实或 content_sources，也不修改状态／标签／优先级。订阅运行计数和进度仍可推进。原先通过重复采集顺带补全内容的行为已取消；明确发起的独立详情任务可通过 apply_detail 合并内容事实，但受不可变触发器保护，不能更改首次收录信息。

`save_manual` 在一个事务内保存内容、真实 Source、关联、初始未处理状态、优先级及手工标签。时间由 Core 保存阶段统一生成，manual_added_at 与 first_seen_at 相同；平台 published 保持原值。不存在订阅时不创建虚构 Subscription 或 Job。重复返回 exists 前不应用临时整理设置。并发订阅和手动入口以第一笔成功提交为准，后者 no-op；故障注入验证不存在半条内容、半个来源或部分整理关系。

统一 CALENDAR_VALUE 为 manual 时取 manual_added_at，否则取 published_at。SQLite 注册的 sf_calendar_key 用于月份、日期筛选和分组，sf_calendar_order 用于真实时间排序及稳定 ID 次排序。内容 DTO 使用同一投影。仅日期精度保持原日，带偏移的时间转展示 IANA 时区；无偏移平台时间使用声明时区，缺省 UTC。未知或不能解析的自动发布时间不伪造日期，手动内容仍使用保存时间。

content.list、tag.contents、日历月／日计数及三条预览共用过滤构造与投影；来源／标签采用 EXISTS，125 条组合筛选及多对多验证没有漏计或重复。source.list 返回有内容或订阅的真实来源，未订阅作者的内容可独立按 source_id 查询。

识别任务／预览只在 IntakeService 内存中，不新增持久任务表。成功内容及首次元信息重启保留；未保存预览重启失效。完整证据见 [M11 交付说明](M11_INTAKE_FOUNDATION.md) 和 verification/m11/。

## M12 知乎存储复用

M12 不增加迁移，继续 schema v8。Source 使用平台稳定作者 ID，url 保存当前确认的官方 token 主页。想法 namespace／kind=pin、external_id 为稳定想法 ID，正文（纯文本及换行）使用现有 summary，出版事实使用 PublishedTime，首图 thumbnail。作者订阅与单条保存复用现有事务、首次收录不可变、状态／标签／优先级及日期投影，不建虚拟订阅。进度 zhihu-page-1 的 scan_bound 表示 possible_gaps，主页窗口不写全历史完成标记。

## M26 笔记 · schema v12（2026-10-22）

012_notes.sql 新增 `content_notes`：`content_id` 主键并外键级联（`ON DELETE CASCADE`），
一条内容最多一条笔记；`template` 为 `general`／`project`，`summary`（≤2000 字）、
`summary_origin`（`manual`／`ai`／`ai_edited`）、`takeaway`（≤20000 字）、
`verdict`（`using`／`watching`／`dropped`，只有 project 模板可有）、`version`（每次写入换新令牌）、
`created_at`／`updated_at`；CHECK 约束通用模板不得带结论。索引 `content_notes_recent`
按 `updated_at DESC, content_id`。

没有笔记时不存在行——「不写笔记」是界面状态，不是 `template='none'` 的空行；空笔记在写入层被删掉。

笔记只写 `content_notes`：不改 `contents.updated_at`、首次收录信息与已读／稍后／归档；采集重复收录与独立详情补全不触碰笔记；内容删除级联删笔记，取消订阅与归档不删。提交后只发 `content.changed`，不发 `content.created`，不触发自动打标、不推进 `tagging.revision`。

升级沿用既有机制：升级前用 SQLite backup 生成 `.before-v12.backup`，同名备份不覆盖（第二份带 UUID 后缀），整次升级在一个事务里做、失败整体回滚，库比程序新时拒开。升级**不为旧内容回填笔记**。

内容筛选谓词仍只有一份（`Repository.content_filter`）：笔记查询在其上挂 `JOIN content_notes`，
关键词列扩为 `c.title / n.summary / n.takeaway`；列表与 facets 共用同一段范围条件，多来源多标签不重计。

本批只在合成旧库与隔离副本上验证升级，**没有在用户真实数据库上执行过升级**。
完整说明见 [M26 笔记存储与查询](M26_NOTES_CORE.md)。


## 0.5.2 小红书封面截图

继续 schema v12。小红书 thumbnail 可保存由 Main 离屏截图生成的有界 `data:image/jpeg;base64,` 字符串；图像为 192×144，原始 JPEG 最大 36KiB。适配器校验类型、Base64、大小和 JPEG 签名后写入既有 ContentItem／ContentPatch，复用标准内容事务与 JSON 字段，不新增图片目录或孤儿文件。

内容列表和详情直接读取该值，重启与离线时均可显示。普通重复采集保留既有记录；主动补充详情可写入新截图，人工状态、标签、优先级与笔记沿用原规则。0.5.2 冻结 Core 入库／重启验证通过；见 [本地构建记录](RELEASE_0.5.2.md)。

## M36–M37 智能优先级 · schema v13（2026-10-24）

013_priority_intelligence.sql 只**新增**表与一列，不改动任何既有列的含义：人工优先级
（`content_states.priority_override`）、来源默认优先级（`subscriptions.default_priority`）、
标签与归档状态原样保留。

**偏好统计**（隐藏数据，只在本地）：

| 表 | 内容 |
| --- | --- |
| `priority_preference_groups` | 唯一键「优先级 × 标签 ID」；`content_count` 是全量去重条数，`revision` 是统计版本 |
| `priority_preference_samples` | 每组最近两条内容引用：内容 ID、首次采集时间、标题缓存；没有正文与链接 |
| `priority_preference_dirty` | 失效队列。短时间内的多次失效合并成一条，按需重建 |

**最新智能结果**：`content_priority_decisions` 每条内容一行，保存业务决策（四选一）、
执行状态（`ok`／`model_unknown`／`invalid_response`／`not_configured`／`timeout`／
`network_failed`／`cancelled`／`input_budget_exceeded`／`no_title`／`no_tags`／
`no_evidence`／`inconsistent`）与版本元数据（上下文指纹、内容／标签版本、人工版本、
偏好版本、策略版本、连接版本、提示词版本）。人工设置、智能结果、来源默认值三者分开保存，
不共用覆盖字段。

**人工改档版本**：`content_states` 新增 `manual_priority_version`（默认 0）。它只随人工
改档递增；已读、归档等状态切换不影响它，因此不会作废与处理状态无关的判断结果。

**失效判定在数据库触发器里**（`priority_stats_*`）：人工改档、标签关联增删、标签停用／恢复、
标题更新都只做一件事——把受影响的「优先级 × 标签」标脏。重建只有一份实现，按真实关系重算，
因此可重复执行而不累加重复计数。人工收录、批量操作与自动打标写入因此走同一条路，
不会因为漏掉某个入口而留下过期统计。

统计口径：学习信号只有用户明确设置的单条优先级；来源默认值与模型自动结果不计入；
统计包含已归档、已读、稍后处理与未处理内容；没有标签的人工优先级保留在原内容上，
但不进入任何分组；计数是全量去重条数，最近两条标题只是语义参考。「最近」按
`contents.first_seen_at DESC`、同刻按稳定内容 ID 排序。

统计更新在独立事务里进行，失败只回滚统计本身；脏标记保留，下次重试——统计更新失败
不能破坏人工优先级、标签、采集与来源兜底。统计可以由原始关系重建
（`PriorityIntelligenceRepository.rebuild_all`），它永远不反过来影响人工值与标签。

升级沿用既有机制：升级前用 SQLite backup 生成 `.before-v13.backup`，同名备份不覆盖，
整次升级在一个事务里做、失败整体回滚。本批只在合成旧库与隔离副本上验证升级，
**没有在用户真实数据库上执行过升级**。
完整说明见 [M36–M38 智能优先级契约、统计与上下文](M36_PRIORITY_INTELLIGENCE.md)。

## M39–M41 智能优先级 · schema v14（2026-10-24）

014_priority_policy.sql 只新增表与触发器，不改动任何既有列的含义。

**当前策略**（`priority_policy`，只有一行）：

| 列 | 含义 |
| --- | --- |
| `enabled` | 智能判断总开关。关闭时读取立即回退人工值／来源值 |
| `provider_id` | 所选连接 ID；LLM 还是 Jev 由它的协议决定 |
| `policy_version` | 策略版本：开关或所选连接变了就前进 |
| `provider_version` | 连接调用版本：连接的调用参数变了就前进 |
| `stats_version` | 偏好统计已按哪一版口径聚合过 |

读取最终优先级时，结果行里的 `policy_version` 与 `provider_version` 要和这里对得上
才算有效：功能关闭、换连接或改策略之后，旧结果立刻退出生效范围，读取马上回退，
不等下次模型完成。

**任务队列**（`priority_tasks`）：一条内容同时只有一个任务（主键即去重），
状态 `pending`／`running`／`succeeded`／`failed`／`cancelled`，
`attempts` 与 `next_attempt_at` 负责有限退避重试。退出时在途任务退回队列，
重启时崩溃残留的 `running` 任务被收回。

**结果失效触发器**（`priority_decision_drop_on_*`）：判断输入一变，旧结果立刻删除——
标签关联增删、人工改档（含恢复自动）、标题修改、标签改名／改描述／别名／停用。
删掉而不是标脏，是因为「有效智能值」要能在一条 SQL 里读出来，读路径没有机会
先做一次复杂的重新判定。

**最终优先级口径**（`Repository.EFFECTIVE_PRIORITY`，只有这一段）：
`COALESCE(人工值, 有效智能值, 来源默认值)`；来源默认值沿用既有的多来源取最高规则。
`Repository.PRIORITY_ORIGIN` 给出同一口径的来源标识 `manual`／`smart`／`source`／`none`。
列表、筛选、看板计数、日历、提醒与托盘都复用它——智能结果不会改写
`priority_override`，也不会改写来源默认值。

**首次启用或升级后的本地聚合**：旧迁移不会给历史数据标脏，因此服务启动时按
`stats_version` 判断要不要做一次本地聚合（只读人工优先级与标签关联，不调用模型）。
聚合过一次就不再来第二次，不在每次启动时扫历史。
完整说明见 [M39–M41 智能优先级判断、调度与统一口径](M39_PRIORITY_INTELLIGENCE.md)。

## M42–M44 优先级设置统一保存与重试预算（2026-10-24）

**没有新增迁移**：本批沿用既有表，只改了写入方式。

**一次保存跨两张表**（`app_settings` 与 `subscriptions`）：

| 内容 | 落点 |
| --- | --- |
| 三级显示名 | `app_settings` 的 `priority` 分区 |
| 智能判断开关与所选连接 | `app_settings` 的 `priority` 分区（`priority.smart.revision`） |
| 来源默认优先级 | `subscriptions.default_priority`（**不进设置存档**） |

- 名称与策略在 `app_settings`，来源默认值在 `subscriptions`，两者在**同一个 SQLite 事务**里写：
  要么都生效，要么都不生效，不会出现「名称已保存、只保存了一半来源」。
- 整份先校验再写：名称非法、来源优先级非法、开启智能判断却没有连接，都直接拒绝，此时**一条都不写**。
- 来源在草稿期间被取消订阅（`status=cancelled`）时，保存**明确失败**，不静默跳过；
  检查与写入在同一事务内完成。
- 改三级显示名**不推进** `priority.smart.revision`：改名只改显示，不得作废在途结果。

**重试预算落库**（BUG-122）：`priority_tasks.attempts` 现在在任务的终态路径上一并写回。
同一输入的自动重试耗尽（`attempts` 达到上限）后，普通内容事件不再排它、不再付费调用；
只有用户明确「重新判断」（`force=True`）才把次数清零重开。耗尽的判断记为
`state=failed`、`attempts=3`，不会产生无限任务记录。

**在途请求的最新输入**（BUG-123）：旧响应因输入指纹或版本变化被取消后，服务会续排**当前仍然有效**
的输入（复用既有的资格检查），因此人工最终值仍不调用模型、重试预算耗尽的条目不会被普通事件重开、
旧响应仍不落库。
完整说明见 [M42 优先级设置](M42_PRIORITY_SETTINGS.md) 与
[batch-04 交付说明](verification/priority-minimax/batch-04/DELIVERY.md)。

## M45 付费渠道 · schema v15（2026-10-25）

迁移编号已核对：原有迁移到 `014_priority_policy.sql`，因此本批用 **015**
（`storage/migrations/015_paid_channels.sql`）。三张表都只存非敏感信息：
**没有密钥、没有请求体、没有响应原文**。

### `paid_channel_attempts`（付费调用账本）

每次付费入口（来源解析／文章列表／显式测试）写一条。**请求发出前先落「开始」**，
进程崩了也留下痕迹，下次启动统一结算为「结果未知」。

| 列 | 说明 |
| --- | --- |
| `charge_state` | `confirmed` 已确认消费／`not_charged` 服务端明确拒绝／`unknown` 结果未知 |
| `confirmed_credits` | 只有 `confirmed` 时非零（本期口径：5 积分／次） |
| `credential_version` | 调用用的密钥版本；换密钥后前进，用于区分不同密钥下的调用 |
| `balance_credits` / `balance_observed_at` | 服务端余额的**观察值**（从业务文案读出），不是本地算出来的数 |
| `operation` / `biz` / `wxid` | 调用用途与目标公众号；`biz` 是规范 biz，不含密钥 |

索引：`paid_attempts_period(started_at)`、`paid_attempts_channel(channel, credential_version)`。

### `paid_channel_sources`（来源解析缓存）

规范 `biz` 为主键，存上游公众号身份（`gh_id`／名称／头像／`source_id`）与
`credential_version`／`parser_version`／`resolved_at`。
**命中缓存不再发付费请求**：因此「解析 → 确认添加」与「重启后再解析」都只付一次解析费。

### `paid_channel_checkpoints`（回溯检查点）

`UNIQUE(source_id, connection_id)`，存服务端游标与 `credential_version`／`parser_version`／
`progress_version`。版本对不上时旧游标不再使用，避免把旧密钥下拿到的游标当成新密钥的位置。
本批只建表，续采逻辑属 M45.4。

完整说明见 [M45 实施说明](M45_WXRANK_IMPLEMENTATION.md)。

### M45 付费渠道的回溯检查点（schema v15，2026-10-25 第二批）

`paid_channel_checkpoints` 在 015 迁移里建好，第二批开始实际使用。

| 列 | 说明 |
| --- | --- |
| `source_id` + `connection_id` | 唯一键：按来源与连接分别记检查点 |
| `cursor` | 服务端游标（JSON 文本） |
| `obtained_at` / `expires_at` | 取得时间与有效期（24 小时，保守取值） |
| `credential_version` | 取得时用的密钥版本；换密钥后旧检查点不再使用 |
| `parser_version` / `progress_version` | 解析与进展版本；不一致即判定不可用 |

**提交边界**：页面数据与检查点在**同一个事务**里落库
（`Repository.commit_page(..., checkpoint=...)`）。
否则崩溃时会出现「页数据已存、检查点没存」，下一次回溯会把同一页再买一遍。

只有「本页没有条目错误」时才推进检查点：有错误说明这一页可能没拿全，跳过就再也补不回来。

四种可用状态：`fresh`（没有检查点）／`resume`（可以继续）／`expired`（过期，从头重扫）／
`version_mismatch`（版本变了，从头重扫）。后两种**不得说成续采**。

页数与条数的口径统一在 `SyncService.page_budget_for`：单页 10 条，
采集条数 0／10／30／50 分别对应 3／1／3／5 页，界面与引擎共用同一个推导。
