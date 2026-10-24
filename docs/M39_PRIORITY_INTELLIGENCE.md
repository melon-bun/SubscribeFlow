# M39–M41 智能优先级：判断、调度与统一口径

日期：2026-10-24（Asia/Tokyo）
状态：M39、M40、M41 已实现并通过隔离验证与真实模型验证；M42、M43 尚未开始。
计划依据：[智能优先级、设置整合与页面间距开发计划](DEVELOPMENT_PLAN_PRIORITY_INTELLIGENCE.md)
前批：[M36–M38 契约、偏好统计与统一上下文](M36_PRIORITY_INTELLIGENCE.md)

本批把 M36–M38 准备好的东西接上真实模型，并让最终优先级有一个统一口径。
**没有改人工优先级与来源默认值的任何含义**，也没有改界面（M42／M43 负责）。

## 落点

| 模块 | 文件 | 性质 |
| --- | --- | --- |
| M39 | `python/src/priority_engine/inference.py` | 严格解析 LLM 单字段 JSON；Jev 四问收敛；两条路径的错误映射 |
| M40 | `python/src/subscribe_flow/application/priority_intelligence.py` | 后台服务：资格检查、排队执行、在途核对、落库通知 |
| M40 | `python/src/subscribe_flow/storage/priority_intelligence.py` | 追加：当前策略、任务队列、输入版本 |
| M41 | `python/src/subscribe_flow/storage/repositories.py` | 统一最终优先级表达式与来源标识 |
| M40 | `python/src/subscribe_flow/storage/migrations/014_priority_policy.sql` | 当前策略、任务队列、结果失效触发器 |
| M40 | `python/src/subscribe_flow/application/settings.py` | 优先级分区新增 `smart`（开关与所选连接） |
| M40 | `python/src/subscribe_flow/bootstrap.py` | 独立装配、启动、关闭 |
| M41 | `electron/main/app-client.cjs` | 内容 DTO 传递 `priorityOrigin` |

## 几个关键决定

### 1. 解析严格，失败不冒充「无法判断」

`{"priority":"unknown"}` 是合法的业务结果（状态 `model_unknown`）；
重复键、额外字段、错误类型、非法枚举、非 JSON、截断输出都是 `invalid_response`。
两者都兜底成 unknown，但状态不同——界面与日志要能分清「模型说判不出来」
和「这次协议没给出合法答案」。

Jev 的收敛规则按计划 §3.7 集中在 `inference.py`：unknown 分值不低于 0.5 直接 unknown；
high／medium／low 里的最高分要不低于 0.8，且比其余选项中的最高分至少高 0.2；
同分、最高分不足、多档同时高分都是 unknown。边界比较留了 `1e-9` 的余量，
否则 `0.8 - 0.6` 这种本应差 0.2 的值会被二进制浮点误拒。

**没有借用标签引擎那套「低分也挑一个最像的」逻辑**：优先级宁可判不出来。

### 2. 适配器在事件循环线程组装，网络请求进执行器

SQLite 连接绑定创建它的线程。公共 AI 网关的 `chat`／`classify` 会读设置、
查凭据（都要碰数据库），因此不能整段丢进执行器——这与打标、总结的既有做法一致：
先在事件循环线程拿到适配器，再只把网络调用放进执行器。

### 3. 在途核对比的是真实上下文指纹

模型返回前重新读一遍输入，重建上下文并比较：

- **上下文指纹**：真正发给模型的那份 JSON 的 sha256。内容、标签、标题、
  标签目录任一变化，指纹就变。
- **各个版本**：内容版本、标签版本、单条人工操作版本、策略版本、
  连接调用版本、提示词版本。

计划里提到的时间戳与分组版本不够用：分组重建后版本可能归 1，也可能恰好相同。
指纹与版本一起比，才能覆盖「标签同数换 ID」「历史组清空后同数重建换样本」
「标题改动」「手动改档再恢复自动」「关闭功能」「切换连接」这些场景。

对不上就不写：这一条内容保持人工值／来源值，等下一次触发。

### 4. 有效智能值由「策略 + 连接」版本决定

读取最终优先级时，结果行里的 `policy_version` 与 `provider_version` 要和
`priority_policy` 当前值对得上才算有效。这样：

- 功能关闭 → 立刻回退人工值／来源值，不等下次模型完成；
- 换连接 → 连接调用版本变了，旧结果立刻退出生效范围；
- 改策略 → 策略版本变了，同上。

### 5. 统计重建失败时不请求模型

偏好统计是缓存。重建失败时它可能停在旧值上，此时拿旧分布去问模型等于用错的
证据问模型。`context_snapshot` 因此在重建失败时明确抛错，服务把这一条内容
兜底成人工值／来源值（状态 `stats_unavailable`），不发请求。

### 6. 首次启用或升级后要做一次本地聚合

旧迁移不会给历史数据标脏：已有人工优先级与标签关系的内容如果只靠触发器，
在升级后是没有偏好的。因此服务启动时按 `stats_version` 判断要不要做一次
本地聚合（只读人工优先级与标签关联，不调用模型），聚合过一次就不再来第二次。
不在每次启动时扫历史。

### 7. 偏好统计变化不触发全量重判

「缓存里的结果是否还对得上当前输入」比较内容／标签／人工／策略／连接／提示词
版本，**不比较偏好统计版本**：统计变了只影响之后的判断，不该把历史内容全部
重新问一遍。

例外是本地兜底状态（`no_tags`／`no_evidence`）：它说的其实是「刚才没东西可判」，
统计一变就可能变成有东西可判，因此这两种状态跟着统计走。

## 验证

隔离数据库（临时目录）＋ 假传输，未触碰用户日常数据库、登录态与 AI 配置。

- `python/tests/test_priority_inference.py`（25 项）：严格解析的全部拒绝分支、
  Jev 收敛的阈值／差距／布尔／非有限值、消息形状、错误分类映射。
- `python/tests/test_priority_service.py`（22 项）：判断链路（请求内容、落库、
  最终来源）、本地兜底（无标签、无证据）、去重、unknown 缓存、关闭功能、
  换连接、改标签、请求期间人工改档、标签改名、退避重试、重启恢复、
  批量有界、首次本地聚合、统一口径与四种来源。

真实模型验证见 [batch-02 验证目录](verification/priority-minimax/batch-02/)：
用真实公共 AI 网关 + 真实模型（MiniMax-M3 与 Jev）跑五个用例，证据在
`real-llm-evidence.json`。

## 本批不做

- 不改设置页排布、控件文案与四页视觉（M42／M43）。
- 不把「跟随来源」改成「自动判断」（M43），不改人工字段与来源默认值。
- 不做打包、推送与发布。

## 留给下一批的接口

- M42：`priority.smart` 已在设置分区里，界面直接读写；`priority.status`
  给出开关、所选连接、协议与队列状态。
- M43：内容 DTO 的 `priorityOrigin` 已经从 Core 传到 Renderer；
  「自动判断」入口用 `priority.judge`（单条）与 `priority.judge_bulk`（批量）。
