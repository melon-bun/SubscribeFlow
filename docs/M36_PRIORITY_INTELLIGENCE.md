# M36–M38 智能优先级：契约、偏好统计与统一上下文

日期：2026-10-24（Asia/Tokyo）
状态：M36／M37／M38 已实现并通过隔离验证；M39–M44 尚未开始。
计划依据：[智能优先级、设置整合与页面间距开发计划](DEVELOPMENT_PLAN_PRIORITY_INTELLIGENCE.md)

本批只做三件事：把四选一的语义定死、把「用户自己设过的优先级」统计出来、把同一份
上下文与固定提示词准备好。**没有接入任何模型调用**：M39 才做推理，M40 才做后台调度，
M41 才把智能结果接进最终优先级。因此本批没有发过任何真实 API 请求。

## 落点

| 模块 | 文件 | 性质 |
| --- | --- | --- |
| M36 | `python/src/priority_engine/contracts.py` | 纯契约：取值、状态、上下文形状、版本快照、解析顺序 |
| M36 | `python/src/subscribe_flow/storage/migrations/013_priority_intelligence.sql` | 迁移：统计分组、样本、失效队列、最新决策、人工改档版本 |
| M37 | `python/src/subscribe_flow/storage/priority_intelligence.py` | 统计仓储：失效重建、分布读取、快照、最新结果存取 |
| M38 | `python/src/priority_engine/context.py` | 上下文构建器：纯数据变换 |
| M38 | `python/src/priority_engine/prompts.py` | 固定提示词：`priority_prompt_v1` |

`priority_engine` 与既有 `tagging_engine` 同级（`python/src/` 下的独立包），边界一致：
不导入 `subscribe_flow`、SQLite、Electron 或 RPC。存储层反向依赖它，取值与常量只有一份。

## 几个关键决定

### 1. 失效判定放在数据库触发器里

计划要求「接入人工改档、恢复自动、增删标签、标签停启、内容删除与标题变更的失效更新；
同时覆盖手动收录、批量操作和现有自动打标写入路径」。

把这些钩子散落在各个写入路径里，漏一个入口就会留下过期统计——而统计错误是本项目的
返修门槛。因此改为：**触发器只负责标脏，重建只有一份实现**。

- `priority_stats_state_changed`：人工改档（含恢复自动）→ 标脏旧档与新档，
  并把 `manual_priority_version` 加一。
- `priority_stats_tag_linked` / `priority_stats_tag_unlinked`：标签关联增删 → 标脏。
- `priority_stats_tag_enabled`：标签停用／恢复 → 标脏三档。
- `priority_stats_title_changed`：标题更新 → 标脏（样本标题是缓存）。

因此自动打标写入（`TaggingRepository.apply_result` 直接写 `content_tags`）、
手动收录、批量操作与内容删除的级联都会自动进入同一条路，既有写入路径一行没改。

移除标签关联时标三档而不是一档：删除可能来自内容被删除（级联），那时内容本身已经不在，
档位无从得知；标三档是安全的——重建按真实关系重算，多标的两档会被算成空组并清掉。

### 2. 重建是重算，不是增量

每次重建都从原始关系重新算计数与最近两条，因此可重复执行而不累加重复计数，
统计失败也不会破坏原数据。重建在独立事务里进行：失败只回滚统计本身，脏标记保留，
下次再试。

### 3. 「自动判断」不需要新的列

现有 `content_states.priority_override` 的 CHECK 只有 `high`／`medium`／`low`，
`NULL` 就是「跟随来源／自动」。因此 M43 的「自动判断｜高｜中｜低」控件不需要改约束：
`NULL` = 自动判断，解析顺序仍是「人工 → 智能 → 来源 → 未设置」。

### 4. 业务决策与执行状态分开

`unknown` 是合法的业务结果；「调用失败」「协议非法」「根本没发请求」是执行状态。
两者分开存，才能在界面上如实区分「模型说无法判断」和「这次没调成」。

### 5. 上下文构建器是纯函数

读取在存储层（`context_snapshot`），调用在判断层，构建在中间。三者分开之后，
LLM 与 Jev 拿到的是同一份序列化上下文，不会出现「两条路径各查各的、各挑各的样本」。

## 验证

隔离数据库（临时目录）＋ 假数据，未触碰用户日常数据库、登录态与 AI 配置。

- `python/tests/test_priority_intelligence.py`（28 项）：契约与解析顺序、统计口径
  （人工信号／含归档／去重／无标签不入统计／来源默认值与模型结果不计入）、
  最近两条的排序（先首次采集时间、同刻按稳定 ID）、失效与重建（改档、恢复自动、
  增删标签、自动打标、停用恢复、删除标签、删除内容后的补位、标题更新）、
  重建幂等、统计失败不影响原数据、人工版本计数、迁移升级保留人工值／来源默认／
  标签／归档并留下备份。
- `python/tests/test_priority_context.py`（26 项）：上下文形状与计划 §3.5 示例一致、
  零组显式保留、样本去重、同名不同内容不合并、标签排序、来源默认值与正文不入上下文、
  本地兜底（无标题／无标签／无证据／超预算／目标混入历史／引用缺失／计数为负）、
  截断与标记、指纹稳定性、提示词原样收录、构建器不碰数据库。

全量回归：`python -m unittest discover -s tests -t . -p "test_*.py"` → 494 项，
除 `test_summary.SummaryDraftTests.test_the_call_runs_off_the_event_loop` 外全部通过。
该失败在基线 b5fc2f5 上同样存在（单跑通过、全量跑抖动的时序用例），与本批无关。

既有测试的最小适配：`test_intake` 的升级对比补一行「`content_states` 新增了一列」；
`test_notes` 的备份文件名与 `user_version` 断言改为跟随当前最新迁移，不再写死 v12；
`test_notes` 的「第二次升级」改为用首份备份还原升级前状态（真实的中断状态），
不再手工丢表——迁移数量增加后丢表已无法准确模拟。

## 本批不做

- 不接入模型，不发任何真实 API 请求（M39／M40）。
- 不把智能结果接进最终优先级，不改 `priority_override` 与来源默认值（M41）。
- 不改设置页、控件文案与四页间距（M42／M43）。
- 不补历史标签，不引入向量数据库、Embedding 与全文索引。
- 不做打包、推送与发布。

## 留给下一批的接口

- M39：`PriorityContextResult.payload` 直接作为 LLM 的 user 消息与 Jev 的 state；
  提示词用 `llm_system_message()` 与 `jev_questions()`；解析结果写
  `PriorityDecision`，再 `save_decision`。
- M40：调度时用 `context_snapshot` 的 `versions` 做缓存键与在途结果校验；
  `manual_version` 随人工改档递增，`preference_version` 随统计变化。
- M41：最终优先级表达式在 `Repository.EFFECTIVE_PRIORITY` 之前接入有效智能值，
  并把 `priorityOrigin` 透传到界面。
- M42：优先级策略版本写进 `context_snapshot(policy_version=…)` 与
  `save_decision` 的 `policy_version`；开关与所选连接由设置服务提供。
