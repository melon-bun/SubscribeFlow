# batch-02 Codex 独立审查

2026-10-24（Asia/Tokyo）。审查对象 `d46d65b`／`d88b5a3`。结论：真实模型主链路通过，但有两项已复现的实质任务问题，M40/M41 本批联合验收暂不通过；两项最小修复并入下一批 M42–M43 推进，不另派非致命问题。

## 已执行验证

- 独立运行全部 `test_priority_*.py`：103/103 通过。
- 实际检查 inference、application service、迁移014、统一 SQL、settings 策略版本及 Core→Main 传递。
- Codex 使用交付脚本另存 `codex-real-llm-evidence.json`，亲自通过产品 Core／AiGateway／PriorityService 发出真实请求。LLM MiniMax-M3 和 Jev jev-latest 各 3 次；LLM A=high/ok/smart，B/C=unknown/model_unknown，D=no_tags/0次，E=no_evidence/0次且 medium/source。Jev A/B/C 均按保守阈值收敛 unknown；D/E 同样本地零调用。与原交付方向一致，不声称已证明偏好准确率。
- 用户文件由脚本在进程内读取；实际 API 复验使用隔离数据库与测试配置，原证据未覆盖，未改日常数据库、会话或配置。

## BUG-122：有限重试耗尽后普通事件仍会发出额外调用（实质阻断）

隔离 Core＋FakeTransport(network_failed)，停掉自动 worker 后逐轮手动驱动，以 next_attempt_at='2000' 让退避到期（只改变测试时钟）。三轮后任务 state=failed、attempts=2、实际调用3次；随后一次普通 `request([target], reason='event')` 返回 queued=1，下一轮实际调用增长至4。后续每个普通事件均可重复额外请求。

原因：`_defer` 在局部 attempts 到 MAX_ATTEMPTS 后调用 finish，finish 没把最后一次 attempts 写回；enqueue 的 exhausted guard 只拒绝 failed 且 attempts>=3，因此永远看见2，无法真正耗尽。读状态等普通 content.changed 也会重启同一失败输入。预期：同一输入自动重试预算有限，耗尽后普通事件不再请求；用户明确重新判断仍可重置。只修计数／预算语义，不做其他队列重构。

## BUG-123：在途恢复自动的最新请求被丢弃（实质阻断）

隔离 Core，使用 threading.Event 在网络线程阻塞响应；数据库操作全部在事件循环线程，确保不靠 SQLite 跨线程异常得到假通过。请求开始后执行 Core.content.update(target, {'priority':'low'})，再 update(..., {'priority':None})；两个真实 content.changed 都已发出。释放网络后：旧响应正确没有落库，但任务为 cancelled，pending=0，最终 origin=none；用户明确恢复自动产生的新资格请求已被 running 去重丢失，没有后续判断。

原因：enqueue 对 running 一律返回False，不保留新请求；_execute 检测输入变更只取消旧任务，未续排最新有效输入。预期：旧响应不生效，同时保留/续排恢复自动后的当前请求；去重与并发仍有限，人工最终值不调用模型，无需手工第二次点击。

## 非致命／范围记录（不单独派修）

- 关闭智能功能期间旧响应仍可写成旧策略版本的 high/succeeded 行，但统一 SQL 按新策略阻止其生效，最终 origin=none。记录为内部过期状态一致性限制，本次不以额外防御修正阻塞主功能。
- 现有 `test_a_manual_change_during_the_request_does_not_get_overwritten` 的 SlowTransport 访问未赋值的 self.repo；即使补引用，直接在网络线程写 SQLite 也会报跨线程错误，不能证明竞态正确。只要求在 BUG-123 必要回归中使用事件屏障和正确线程；不另派测试形式整改。
- Jev A 未达到0.8，属于真实阈值效果限制，不调整计划阈值；既有总结时序测试不派修。

后续：batch-03 先按两项原失败场景最小修复并提交，再完成 M42 统一设置事务／草稿及 M43 文案与四页间距，最后交回 Codex。M44 联合验收与最终真实调用仍保留。
