# 0.5.3.4 本地小更新包

2026-10-27，`fix/note-actions-and-144h-interval` 已快进合入本地 `main`。按用户要求沿用四段小更新版本号，桌面与Core同步为0.5.3.4；macOS Intel（x64）包体检查与完整包内验收通过。

## 更新内容

- BUG-144：保存笔记后，时间与删除按钮不再挤压“保存笔记”文字。按钮保持完整宽度、居中；窄编辑区的保存状态自然换行。内容详情与笔记页共用此修复。
- 自动采集间隔最大144小时（518400秒），同步界面、后端和帮助说明。默认24小时、最少5分钟保留，现有间隔不变，无新增数据库迁移。

源码修复 `963952f`，构建修订 `67bdb18dc7053bd4764b5fd85b2b8f5224597e9e`，schema仍为v16。

## 本地产物

| 项目 | 结果 |
|---|---|
| ZIP | `dist/Subscribe-Flow-0.5.3.4-mac-x64.zip` |
| 应用 | `dist/0.5.3.4/Subscribe Flow-darwin-x64/Subscribe Flow.app` |
| ZIP 大小 | 146,157,124 字节，约 139.4 MiB |
| SHA-256 | `82e4441a2f0e4c059d7ff8c79075c690777d3d12c66d814f7e71b9502efbb0d8` |
| 运行时 | Electron44.5.1，Python3.12.5，macOS x64 |
| 签名 | 本机ad-hoc，未作远端公证或发布 |

包内61个Main/Preload/Renderer文件与构建源码逐字节匹配，图标与品牌图正确，白名单无测试、凭据或数据库混入；18条链接均为包内有效相对链接，冻结Core为x86_64。签名、ZIP完整性、SHA及同名校验文件均通过。[包体审计](verification/v0.5.3.4-local/audit.json) / [内容匹配](verification/v0.5.3.4-local/package-content.json)。

## 正式安装包验收

将实际应用复制到项目外临时目录，经LaunchServices前台启动，使用隔离数据和最小PATH；故意无效的外部Python不影响自带Core运行。最终退出码0，`packagedSmoke=passed`。

- BUG-144：在包内笔记页通过真实桥接保存；开启视觉特效，浅/深色×280/360/640px，共6组。按钮文字裁切、居中误差和横向溢出均为0。已核对[界面截图](verification/v0.5.3.4-local/packaged-note-footer.png)。
- 144小时：包内Core接受518400秒，拒绝518401秒；切回手动后保留间隔，真实应用重启后仍为518400秒。
- 既有微信v15→v16归并、正文与笔记保留、有效游标、未知扣费阻塞、无密钥人工添加与重启验证通过；没有真实付费调用。
- 通用旧库升级备份、去重/取消、本地封面、优先级/标签/笔记、设置隔离、AI页面滚轮到底、Core崩溃恢复、真实应用重启与缺失Core提示通过。

[完整结果](verification/v0.5.3.4-local/result.json) / [最终验收日志](verification/v0.5.3.4-local/smoke.log) / [构建日志](verification/v0.5.3.4-local/build.log)。

验收过程中第一次调试启动超时，延长启动等待后应用正常进入；新增笔记夹具由RPC预置时绕过编辑器缓存，第二次等待旧空模板超时。验收脚本清除该夹具的编辑器缓存后完整流程通过，无需修改包内程序。两次记录分别保留于[startup-attempt.log](verification/v0.5.3.4-local/startup-attempt.log)和[fixture-attempt.log](verification/v0.5.3.4-local/fixture-attempt.log)。最终验收脚本修订不改变包内源码或构建产物。

所有验收实例与临时副本已清理。旧版本产物和用户日常数据保持，本轮未用新包打开日常库，未请求真实平台/LLM/付费API，未推送或远端发布。144小时到期由前置可控时钟测试验证，未实际等待六天。
