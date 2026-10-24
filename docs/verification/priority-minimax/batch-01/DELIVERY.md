# batch-01 交付说明：M36–M38 智能优先级契约、偏好统计与统一上下文

日期：2026-10-24（Asia/Tokyo）
交付范围：M36、M37、M38。**M39 及以后未开始。**
基线：Codex 已提交的 `f4d9dda`（`docs: record MiniMax priority batch launch and 20-minute follow-up`），
本批在该提交之上直接实施 `main`，未新建分支、未改其他 worktree。

## 交付提交

- 实现提交：`379c0a4` `feat(priority): M36–M38 固定契约、偏好统计仓储与统一上下文`
- 交付证据提交：`（本文件所在提交）` `docs(priority): 记录 batch-01 交付说明与验证证据`

验证证据：[test-output.txt](test-output.txt)、[context-sample.txt](context-sample.txt)、
[make-context-sample.py](make-context-sample.py)。

## 变更摘要

| 文件 | 改动 | 模块 |
| --- | --- | --- |
| `python/src/priority_engine/contracts.py` | 新增。四选一决策、业务决策与执行状态分离、来源标识、解析顺序、上下文形状、版本快照、输入预算常量 | M36 |
| `python/src/priority_engine/prompts.py` | 新增。原样收录 `PRIORITY_RULES_V1`／`LLM_OUTPUT_RULES_V1`／Jev 四问，提示词版本 `priority_prompt_v1` | M38 |
| `python/src/priority_engine/context.py` | 新增。`PriorityContextBuilder`：纯数据变换，三档零组、样本去重、截断、预算、本地兜底、指纹与执行快照 | M38 |
| `python/src/priority_engine/__init__.py` | 新增。包出口 | M36–M38 |
| `python/src/subscribe_flow/storage/migrations/013_priority_intelligence.sql` | 新增。偏好分组、最近样本、失效队列、最新智能结果、`content_states.manual_priority_version` 与五个失效触发器 | M36 |
| `python/src/subscribe_flow/storage/priority_intelligence.py` | 新增。`PriorityIntelligenceRepository`：重建、分布读取、偏好版本、上下文快照、最新结果存取 | M37 |
| `python/src/subscribe_flow/storage/repositories.py` | 改。`Repository.__init__` 持有 `priority_intelligence`；既有写入路径一行未改 | M37 |
| `python/tests/test_priority_intelligence.py` | 新增。28 项 | M36–M37 |
| `python/tests/test_priority_context.py` | 新增。26 项 | M38 |
| `python/tests/test_intake.py` | 改。升级对比补一行「`content_states` 新增了一列」 | 迁移适配 |
| `python/tests/test_notes.py` | 改。备份名与 `user_version` 不再写死 v12；「第二次升级」改用首份备份还原升级前状态 | 迁移适配 |
| `docs/STORAGE.md` | 改。schema v13 约定 | M36–M37 |
| `docs/API.md` | 改。内部契约（不新增 RPC） | M36–M38 |
| `docs/M36_PRIORITY_INTELLIGENCE.md` | 新增。实施说明与关键决定 | M36–M38 |

## 关键设计（供审查）

1. **失效判定放在数据库触发器里**。`priority_stats_*` 五个触发器只做一件事——把受影响的
   「优先级 × 标签」标脏；重建只有一份实现（从原始关系重算，可重复执行而不累加）。
   因此人工改档、批量操作、手动收录、**自动打标写入**与内容删除的级联都自动进入同一条路，
   不会因漏掉某个入口而留下过期统计。既有写入路径一行未改。
2. **统计口径**只认用户明确设置的单条优先级：来源默认值与模型自动结果不计入；
   统计含已归档／已读／稍后处理；无标签的人工优先级不进入任何分组；
   同一内容经多来源收录只计一次。「最近」按 `contents.first_seen_at DESC`、同刻按稳定内容 ID。
3. **业务决策与执行状态分开**：`unknown`（模型说无法判断）与 `invalid_response`／
   `not_configured`／`timeout` 等是两类事实，在 `content_priority_decisions` 里分列两列。
4. **上下文构建器是纯变换**，不导入 SQLite／`subscribe_flow`／网络库（有测试守着）。
   LLM 与 Jev 用同一份 `payload`。
5. **「自动判断」不需要新列**：现有 `priority_override` 的 CHECK 只有三档，`NULL` 即
   「自动判断」，M43 的控件改造不必改约束。

## 实际测试命令与结果

```
$ cd Subscribe_Flow/python
$ .venv/bin/python -m unittest discover -s tests -t . -p "test_priority_*.py"
Ran 54 tests in 2.084s
OK

$ .venv/bin/python -m unittest discover -s tests -t . -p "test_*.py"
Ran 494 tests in 26.576s
FAILED (failures=1)   # test_summary.SummaryDraftTests.test_the_call_runs_off_the_event_loop
```

该唯一失败是**既有的时序抖动用例，与本批无关**：单跑连续 3 次通过；在基线 b5fc2f5
（`git archive HEAD` 取出的干净副本）上跑全量同样是这一条失败、其余 440 项通过。

上下文样本（隔离库，真实会发给模型的 JSON）：见 `context-sample.txt`。

## 本批未做（不在本批范围）

- **没有接入任何模型、没有发过任何真实 API 请求**：M39 才做推理，M40 才做后台调度。
  因此本批不需要读取 `test_api_key.md`。
- 没有把智能结果接进最终优先级（`priority_override`／来源默认值一律未动），这是 M41。
- 没有改设置页、控件文案与四页间距，没有改任何前端或 Electron 代码，这是 M42／M43。
- 没有补历史标签，没有引入向量数据库／Embedding／全文索引。
- 没有打包、推送、发布，也没有动用户日常数据库、登录态与 AI 配置。

## 打包链路核对（未打包，只核对收集规则）

`priority_engine` 是 `python/src/` 下的顶层包（与 `tagging_engine` 同级），被
`subscribe_flow/storage/priority_intelligence.py` 在模块顶层 import。核对既有打包产物
`build/macos/pyinstaller/subscribe-flow-core/PYZ-00.toc`：`tagging_engine`、
`subscribe_flow.storage.tagging`、`subscribe_flow.storage.notes` 都在里面，而这三者都是
「在 `Repository.__init__` 里嵌套 import」的同类结构——说明 PyInstaller 会收集这类嵌套
import，因此 `priority_engine` 不需要额外的 hidden-import，`package-macos.cjs` 不用改。
本批没有执行任何打包。

## 非致命问题与已知限制（只记录，不在本批修）
1. **内容删除的产品入口不存在**。`content_sources` 的外键没有 `ON DELETE CASCADE`，
   所以当前没有删除内容的路径。统计层已经能处理删除（级联删掉标签关联后自动标脏并补位），
   测试按依赖顺序删干净来验证这一点。若将来增加删除内容功能，需要一并处理外键。
2. **移除标签关联时标三档而不是一档**。删除可能来自内容被删除（级联），那时已无从得知档位；
   多标的两档会在重建时被算成空组并清掉，代价是每次标签变动最多重建三个分组。
3. **`priority_stats_state_changed` 触发器里自增 `manual_priority_version`**。依赖
   `recursive_triggers` 为默认关闭（触发器内对同表的自更新不会再触发自身）。当前
   `Database` 不改这个 pragma，测试已覆盖三次改档计数为 3。
4. **既有测试做了最小适配**：`test_intake` 补一行新列、`test_notes` 的版本号不再写死。
   两者都保持原意（升级保留旧列、升级前留一次备份），不是放宽断言。
5. **`preference_version` 只覆盖相关分组的版本与计数**，不含样本标题；标题变化会触发重建
   并让分组 `revision` 递增，因此版本仍会变，但重建前的瞬间可能读到旧标题缓存。
6. **`context_snapshot` 的 `policy_version`／`provider_version` 由调用方传入**，
   因为它们来自设置与连接配置（M40／M42 提供），存储层不反向依赖设置层。
