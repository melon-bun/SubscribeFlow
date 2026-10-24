# batch-03 Codex 独立审查

2026-10-24（Asia/Tokyo）。对象 `9da3815`（BUG-122/123）、`b7bfe23`、`eed70e0`。结论：两项原阻断关闭；M39–M42 业务部分通过，M43 的新调用链有一个正式界面实质阻断 BUG-124，随 M44 最小修复后再联合验收。

## 已执行

- 优先级 Python 聚焦 111/111；Node 148/148；正式 Electron 设置验证 settingsSmoke passed（含草稿/保存/取消/缺连接拒绝/重启持久化/紧凑窗口/深色）。日志 codex-node.log、codex-settings.log。
- BUG-122 原失败探针：三次网络失败后 failed/attempts=3/调用3次；普通事件 queued=0且不再发请求；明确 judge 可重置排队。关闭。
- BUG-123 原失败探针：threading.Event 挂起网络、事件循环内走正式 ContentService 改low后恢复None；旧响应不落库且任务pending；第二轮发出第二次请求并落high/smart。关闭。
- 独立设置原子性探针：有效来源先改low、随后已取消来源写入失败，整个设置存档/版本/名称/开关/两来源默认值全部回滚，未发生部分保存。M42事务可用。
- 检查设置页草稿、来源列表、旧路由迁移、实际priorityOrigin及刷新依据、生成样式/测量。四页间距交付证据均16px；非致命视觉/源文件在上级目录等限制只记录，不派修。

## BUG-124：新优先级调用未接 Renderer／Preload，选中内容后界面报错

正式 Electron＋Core，独立临时数据库，非假客户端。Codex 探针 codex-rejudge-probe.cjs 通过 Main 的 Core 调用开启智能判断，再经正式设置→收件箱切换并选择同一内容。输出 codex-rejudge-probe.json：

- Core beforeEnabled=false，afterEnabled=true。
- typeof SF.app.state.client.getPriorityStatus === 'undefined'，judgePriority 同样 undefined。
- SubscribeFlow.request('getPriorityStatus') 返回 FORBIDDEN_METHOD。
- 详情不可见，正式界面出现“读取失败／核心服务／app.client.getPriorityStatus is not a function”；重新判断按钮不存在。

根因：Main app-client.cjs 的 UI_METHODS/callUI 和 Python RPC 虽已添加，但 electron/renderer/scripts/core/app-client.js 的 CONTRACT/客户端工厂与 electron/preload/index.cjs allowed 未接入三项新调用；详情 render 同步调用不存在的方法。属于主要阅读导航／新判断能力实质不可用，须最小补接。只在既有受限桥中增加必要方法，不开放任意RPC。

接通后必须用正式Renderer验证：智能默认关闭时能选内容/读详情；设置开启后立刻返回原内容可重判，已选自动段仍能明确请求；关闭后入口/说明按实际状态更新。当前 judgmentStatus 缓存不失效、priority data-refresh-preserve 不包含 enabled，需在同一完整流程验证中处理真实可见性，不扩展成无关缓存重构。

## 非致命记录

既有总结时序抖动、Jev保守阈值、源参考HTML未在git、收件箱非本期四页间距、关闭期间旧版本结果行被SQL阻止生效均不单派修。未重新大量调用真实模型；Codex上一批实际LLM/Jev各3次证据仍有效，M44按最终产品链路少量复验。

后续：M44 包含BUG-124最小修复、正式链路联合验收和最终文档，不能仅用单元测试/截图宣称新调用接通。
