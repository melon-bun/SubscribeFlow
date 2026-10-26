# 0.5.3.2 本地修复包

用户于2026-10-26指定版本0.5.3.2，由Codex直接完成macOS Intel（x64）本地打包。**包体审计及完整包内验收均已通过。**

## 本次修复

包含源码提交`baf92ea`：

- BUG-128：优先级滑块按控件内部位置起跑，避免详情滚动恢复或重绘后从控件外飞入。
- BUG-108：移除“不选择这条连接”；停用统一用自动打标开关，保留所选方式与连接；旧空引用可重新选择。
- 保留0.5.3.1的AI自动识别页滚轮修复及此前功能。

[源码验证](verification/priority-recognition-20261026/REPORT.md)包含原失败位置对照、聚焦界面操作和18项分段动画检查。

## 本地产物

- ZIP：`dist/Subscribe-Flow-0.5.3.2-mac-x64.zip`
- 应用：`dist/0.5.3.2/Subscribe Flow-darwin-x64/Subscribe Flow.app`
- 大小：146,141,334字节（约139.4 MiB）。
- SHA-256：`cf674538afa0a344193087be04abfd16fd1e17bb0b89a44cdb6dfc9a15746187`；同名`.zip.sha256`已核对。
- 构建修订：`78cc6c494549fbab04a9f2219c882271bd6f7437`。
- Electron44.5.1、Python3.12.5、schema15，macOS Intel x64、本机ad-hoc签名。

授权后验收使用的仍是上述原包，完成后再次核对SHA-256一致，未重新构建或改变产物。

## 包体验收

61个Renderer/Main/Preload源码文件逐字节一致，图标/版本/构建元数据正确，无测试/凭据/数据库混入，18条相对框架链接有效，Core架构x86_64，签名与ZIP检查通过。[包体审计](verification/v0.5.3.2-local/audit.json) · [原生审计](verification/v0.5.3.2-local/native-audit.json)。

## 完整包内验收

正式包复制到项目外目录，经LaunchServices启动，使用独立临时数据、最小PATH和故意无效的外部Python设置，确认自带Core正常工作。完整入口退出0，`packagedSmoke=passed`：

- 冻结Core版本、去重、取消任务，小红书本地封面及Core重启持久化通过。
- 隔离v2数据库升级到schema15并创建升级前备份。
- 优先级看板/继承、标签、笔记、总结设置隔离与应用重启持久化通过。
- 公众号付费API仍归入微信公众号折叠项，警告存在；未调用真实付费上游。
- 正式包内“不选择这条连接”入口已移除，标签工具栏正常，AI自动识别页真实滚轮可下滑到底。
- 隔离Core崩溃后自动恢复、缺失Core时修复提示、脱敏诊断通过。
- 本轮测试实例及临时副本已正常清理，未改日常数据库、登录或通知偏好，未退出用户正在使用的旧应用。

[完整结果](verification/v0.5.3.2-local/result.json) · [实际运行结果](verification/v0.5.3.2-local/foreground-consent/result.json)。截图与运行日志保留在本地同目录。

## 首次启动等待记录

先前后台隔离启动超时，主线程采样停在`SecItemCopyMatching`/`SecKeychainItemCopyContent`；历史失败日志和部分完成步骤保留，不改写为成功。用户随后明确回复“已允许”。后台补验仍超时，改为前台启动隔离副本后完整验收通过。

验收入口新增可选`SUBSCRIBE_FLOW_PACKAGED_FOREGROUND=1`，便于系统人工授权；配合可选`SUBSCRIBE_FLOW_PACKAGED_STARTUP_WAIT_MS`延长等待，默认行为不变。实际成功命令：

```sh
SUBSCRIBE_FLOW_PACKAGED_FOREGROUND=1 SUBSCRIBE_FLOW_PACKAGED_STARTUP_WAIT_MS=600000 SUBSCRIBE_FLOW_VERIFY_OUTPUT=docs/verification/v0.5.3.2-local/foreground-consent npm run smoke:packaged
```

这些脚本不在安装包内，无需重建产物。当前钥匙串等待已不再阻塞本次验收；不据此承诺其他系统账户免于正常系统授权。

没有重复真实LLM、Jev或公众号付费调用，没有修改系统保护机制，没有推送或远端发布。旧ZIP和用户日常数据仍保留。
