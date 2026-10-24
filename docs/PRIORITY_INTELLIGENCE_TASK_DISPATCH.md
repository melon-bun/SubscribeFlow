# 智能优先级 MiniMax 分发与验收

日期：2026-10-24（Asia/Tokyo）。用户授权完成 DEVELOPMENT_PLAN_PRIORITY_INTELLIGENCE.md 全部 M36–M44；MiniMax 实现，Codex 分发、独立审查与验收，尽量不写产品代码。

## 固定入口与规则

- Skill：[mcode_use_skill](/Users/xor/Documents/Agent_skill/mcode_use_skill/SKILL.md)。
- Session：`mvs_d536c17e5d0d40b4a465779846432b27`，恢复目录 `/Users/xor/Documents/Subscribe_Call`，`--prompt-mode coding`。
- 产品仓库：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow`，直接在现有 `main` 开发；基线 `b5fc2f5`，本轮任务编号改动已保留。
- 唯一当前状态：[active-run.json](verification/priority-minimax/active-run.json)。批次目录保存 request、control、events、stderr、final、exit-code、run-state 和审查证据。
- 不设置任务时限或步数限制。每 20 分钟定时检查，同一批连续 **两次**定时轮询未完成才要求尽快完成；启动确认不计数，换批／返修归零。运行中不重复启动同一 session；通过本批 control.md 传递催办，要求每个主要步骤之间读取。
- 只派修启动失败、数据／统计错误、配置不生效、提醒／导航完全不可用、退出卡死等实质阻断。计划内主要能力缺失仍需完成；非致命问题只记文档，不单独派修，不因界面细节、测试形式或额外防御重构阻塞交付。
- 必须通过产品公共 AI 网关／优先级服务进行真实 LLM API 测试，不能用普通连通探针或假响应代替。凭据从 `/Users/xor/Documents/Subscribe_Call/test_api_key.md` 本地读取，只在进程内使用，不回显、不放提示词、不提交或写入证据。使用隔离人工偏好样本，记录无密钥的模型标识、样例、实际决策、错误和局限；离线正确性与真实效果分开。
- 不改用户日常数据库、登录态或 AI 配置；不打包、推送、发布。允许 MiniMax 在职责明确、文件互不冲突时使用 subagent，由该 session 汇总交付。
- CLI 成功不等于验收通过。Codex 检查实际差异并执行必要业务验证后才续派下一批。没有变化时静默待机；有交付、失败或需用户处理时才通知。

## 批次安排

| 批次 | 范围 | 状态 |
| --- | --- | --- |
| batch-01 | M36 契约／迁移设计、M37 偏好统计仓储、M38 共用上下文与提示词 | 379c0a4／d30990b 已由 Codex 验收 |
| batch-02 | M39 LLM／Jev、M40 后台调度、M41 统一优先级及传递；真实 LLM 产品调用 | 已分发，待启动确认 |
| batch-03 | M42 统一设置／事务、M43 控件与四页间距 | 待前置验收；可在稳定契约后由 MiniMax 按文件分工并行 |
| batch-04 | M44 联合验收与交接、真实 LLM 端到端复验 | 待依赖交付 |

全部完成并通过必要验收后暂停定时任务；保留真实结果与非致命限制，不提前把模块标记完成。

## 首批启动确认

2026-10-24 19:53 JST：batch-01 的 exec.started、session.resumed、turn.started 已确认，run_id `exec_turn_mvma4r6a_vm1izj`，mcode PID 70473。未设置时限与步数上限；20 分钟跟进 `minimax` 已启用，轮询计数为 0。当前待机，M36–M38 交付后独立审查并续派。

## batch-01 验收与 batch-02 续派

2026-10-24：M36–M38 通过独立审查、54 项聚焦测试与真实仓储组合探针；494 项全量仅既有总结时序用例失败，按非致命记录，不派修。证据 [Codex 验收](verification/priority-minimax/batch-01/CODEX_REVIEW.md)。已续派 M39–M41：两种模型、后台调度、统一优先级及真实 LLM 产品链路验证。首次聚合／旧响应快照／失败兜底列入既定装配条件；无额外重构任务。
