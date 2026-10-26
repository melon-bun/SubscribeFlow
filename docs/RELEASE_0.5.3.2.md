# 0.5.3.2 本地修复包

用户于2026-10-26指定版本0.5.3.2，由Codex直接构建macOS Intel（x64）本地包。

包含已通过源码界面验收的`baf92ea`：

- BUG-128：优先级滑块按控件内部位置起跑，避免详情滚动恢复或重绘后从控件外飞入。
- BUG-108：移除“不选择这条连接”；停用统一用自动打标开关，保留所选方式与连接；旧空引用可重新选择。
- 保留0.5.3.1的AI自动识别页滚轮修复及此前功能。

[源码验证](verification/priority-recognition-20261026/REPORT.md)：原失败位置场景对照、聚焦界面操作与18项分段动画检查已通过。本次不重复真实模型或公众号付费调用，不修改日常数据，不关闭正在使用的旧应用，不推送或发布。

状态：**安装包已生成，包内基础核验通过；完整界面启动验收被macOS钥匙串访问阻塞，尚未通过。** 首次隔离启动的主线程采样停在系统`SecItemCopyMatching`/`SecKeychainItemCopyContent`调用，调试接口超时；可能在等待系统授权，尚未收到用户确认，也未证实系统弹窗已显示。两次重新启动均未完成钥匙串访问；最后一轮已给予约5分钟等待。未将这些尝试计为完整启动通过。已结束并移除本轮隔离测试进程及应用副本，未改动日常应用或钥匙串。

## 本地产物

- ZIP：`dist/Subscribe-Flow-0.5.3.2-mac-x64.zip`
- 应用：`dist/0.5.3.2/Subscribe Flow-darwin-x64/Subscribe Flow.app`
- 大小：146,141,334字节（约139.4 MiB）。
- SHA-256：`cf674538afa0a344193087be04abfd16fd1e17bb0b89a44cdb6dfc9a15746187`；同名`.zip.sha256`已核对。
- 构建修订：`78cc6c494549fbab04a9f2219c882271bd6f7437`。
- Electron44.5.1、Python3.12.5、schema15，macOS Intel x64、本机ad-hoc签名。

基础审计：61个Renderer/Main/Preload源码文件逐字节一致，图标/版本/构建元数据正确，无测试/凭据/数据库混入，18条相对框架链接有效，Core架构x86_64，签名与ZIP检查通过。证据：`verification/v0.5.3.2-local/audit.json`、`native-audit.json`。首次启动失败日志保留为`smoke-attempt-1.log`。


## 验收结果与待确认项

- 已通过：正式冻结Core版本、重复采集去重、取消任务、小红书本地封面及Core重启持久化；均发生于正式界面启动之前，未访问真实上游。
- 隔离v2数据库由新包升级到schema15，并创建`subscribe-flow.before-v15.backup`，已只读核对。
- 未完成：完整Renderer启动、界面交互、应用重启与故障恢复链路。源码界面测试已在前一修复阶段通过，但不能替代本包未完成的检查。
- 测试入口允许以`SUBSCRIBE_FLOW_PACKAGED_STARTUP_WAIT_MS`为系统人工授权预留更长等待，默认超时不变；该脚本不在安装包内，后续无需因此重建包。
- 证据：[包体审计](verification/v0.5.3.2-local/audit.json)、[原生审计](verification/v0.5.3.2-local/native-audit.json)、[已完成步骤及阻塞](verification/v0.5.3.2-local/partial-smoke.json)、[钥匙串调用栈摘要](verification/v0.5.3.2-local/keychain-wait.json)。原始构建/尝试日志仅保留本机验证目录。

0.5.3.2安装包已可交付；本记录明确保留完整启动验收待确认。未覆盖运行中的0.5.3.1应用，旧ZIP和日常数据仍保留。未推送或发布到远端。
