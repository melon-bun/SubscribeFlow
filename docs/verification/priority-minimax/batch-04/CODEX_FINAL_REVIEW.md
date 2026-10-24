# 智能优先级 M36–M44：Codex 最终验收

日期：2026-10-25（Asia/Tokyo）。结论：**M36–M44 全部源码任务完成并通过本轮必要独立验收；BUG-122／123／124 关闭。** MiniMax 实现，Codex 分发、审查与复验。没有新增实质阻断；非致命问题与真实环境限制只记录，不再派修。不打包、不推送、不发布，版本仍0.5.2。

## 最终交付

- `379c0a4`／`d30990b`：M36–M38 契约、迁移、偏好统计与共用上下文。
- `d46d65b`／`d88b5a3`：M39–M41 LLM／Jev、后台任务、统一优先级与真实模型证据。
- `9da3815`：BUG-122 有限重试预算、BUG-123 在途恢复自动请求续排，Codex 已用原失败场景确认。
- `b7bfe23`／`eed70e0`：M42 统一设置与来源事务、M43 文案／实际来源／四页间距。
- `e2a3381`：BUG-124 Renderer／Preload受限调用桥与开关入口状态，Codex 最终复验通过。
- `d4fb924`／`f545adf`：M44 联合验收用例、逐项矩阵与交付记录。最终产品源为以上提交（后续只有验收文档同步）。

## Codex 独立验证

| 验证 | 实际结果与证据 |
| --- | --- |
| 最终优先级 Python 聚焦 | 113/113，通过；`codex-priority.log`，含新增同数换标签ID、同数替换历史样本的异步屏障用例 |
| 最终 Node | 149/149，通过；`codex-node.log` |
| 最终正式 Renderer／Main／Core | 完整离线Renderer通过；`codex-renderer.log`，含日期、并发刷新、列表/分页/批量、优先级、**priorityBridgeSmoke**、日历、标签、Core崩溃重启与重载持久化 |
| BUG-124 原失败探针 | 实际Electron＋Core隔离数据库复跑：两个AppClient方法均function、Preload受限调用ok、Core开启后无需重载同一内容即出现重新判断按钮、详情保持可见；`codex-rejudge-final.json` |
| 设置保存与回滚 | batch-03 Codex正式settings-renderer通过保存/取消/校验失败/重启/浅深主题/紧凑窗口；真实事务探针在前一来源已写后，因后一来源取消失败时，名称/策略/设置版本/全部来源均回滚 |
| BUG-122／123 | batch-03 Codex原失败探针：三次失败后attempts=3，普通事件不再请求，显式重判可重置；在途手动low再自动后旧响应不写、当前请求续排并最终high/smart |
| 四页间距 | 最终测量spacing.json：总览/渠道/标签/笔记页头至第一工作区均16px；紧凑设置截图已视觉检查，保存操作可达 |
| 凭据检查 | 最终扫描126个变更/证据文件，未发现test_api_key.md中的测试密钥；只在进程内使用，测试使用隔离数据 |

原独立探针最初复跑有测试自身时序/入参问题：未等待列表导航完成就恢复选择，且直接Preload调用未传数组。校正测试导航等待和正式调用形状后得到上述最终结果；没有因此修改产品或再次派修。不要把测试准备错误当成产品失败。

## 真实模型验证

- Codex 在 batch-02 亲自通过产品 Core → 共用上下文 → 公共 AI 网关 → 判断服务发出真实请求，LLM MiniMax-M3 与 Jev jev-latest 各3次，安全结果见 `../batch-02/codex-real-llm-evidence.json`。
- 最终服务Python代码未在M44修改；MiniMax又在最终代码上真实复跑并记录 `real-llm-evidence.json`，Codex已检查脚本路径及逐例结果。LLM A=high/ok/smart，B/C=unknown/model_unknown；D=no_tags、E=no_evidence均0次调用，E最终medium/source。
- Jev最终A/C保守收敛unknown；B一次timeout，任务pending/attempts=1，按有限退避处理。该服务波动如实保留，不冒充所有真实调用均成功；先前真实复验B已正常返回unknown。
- 离线正确性、真实API协议行为和个人偏好判断质量分开：本轮证明链路与既定规则，不宣称已经用用户数据校准阈值或证明偏好准确率。

## 保留的非致命问题与人工范围

1. 全量Python最终553项中1项既有 `test_summary.SummaryDraftTests.test_the_call_runs_off_the_event_loop` 时序失败；Codex前两批独立全量同样复现，相关源码本轮未改，基线证据存在。最终553项为MiniMax全量记录，Codex最终独立113项聚焦全过。不为测试形式单独派修。
2. Jev阈值0.8未用真实用户偏好校准，最后一次调用有超时；未知/失败继续来源兜底，不能强行改阈值凑结果。
3. 功能关闭期间旧策略结果行仍可能写入，但统一SQL拒绝其生效；内部状态限制已记录，未扩大为防御重构。
4. 收件箱不在四页间距范围，既有36px／标签两栏映射差异保留；上级参考HTML与本地HANDOFF沿用既有版本控制约定。
5. 真实个人偏好质量、真实系统通知/托盘/物理休眠长期行为仍需人工/长期环境观察；本次正式Renderer/提醒逻辑检查不能冒充OS人工验证。

完整边界/提示词专项逐项矩阵见 [MiniMax交付记录](DELIVERY.md)。上述范围均已按用户要求分类为非致命记录或真实环境限制，不阻塞本期主要功能交付。

全部授权任务已完成，20分钟跟进停止；不再向MiniMax派发新功能或非致命修饰任务。
