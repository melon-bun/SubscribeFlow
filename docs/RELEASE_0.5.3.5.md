# 0.5.3.5 本地构建

日期：2026-11-04（Asia/Tokyo）

状态：macOS Intel（x64）本地包构建和完整包内验收通过。功能源码提交 `f11dde0`，构建修订 `81606678c185338a5dcc6e63173ece80d16c0cad`；版本由 0.5.3.4 升至 0.5.3.5，旧版 ZIP 与校验文件保留。

本版默认显示「还会再看」「稍后阅读」「看完了」；前后两项可以在设置的「通用」页重命名，「稍后阅读」固定。旧内容的整理状态和提醒统计不变。开发及源码验收见[阅读状态方案](DEVELOPMENT_PLAN_READING_STATUS.md)与[验收记录](verification/reading-state-20261104/REPORT.md)。

## 本地产物

| 项目 | 结果 |
| --- | --- |
| ZIP | `dist/Subscribe-Flow-0.5.3.5-mac-x64.zip` |
| 应用 | `dist/0.5.3.5/Subscribe Flow-darwin-x64/Subscribe Flow.app` |
| ZIP 大小 | 146,162,163 字节 |
| SHA-256 | `f29b32903a8f7c3b57d8e3f1b71a41a99aa6f26bb618b3359a33fd844e055ab7` |
| 运行时 | Electron 44.5.1、Python 3.12.5、macOS x64 |
| 签名 | 本机 ad-hoc；未作 Apple 公证或远端发布 |

包内 62 个 Main／Preload／Renderer 文件与构建源码逐字节匹配；图标、白名单、18 条相对链接、x86_64 Core、签名、ZIP 完整性及 SHA-256 校验均通过。[包体审计](verification/v0.5.3.5-local/audit.json) · [内容匹配](verification/v0.5.3.5-local/package-content.json)。

## 包内验收

将实际应用复制到项目外临时目录，经 LaunchServices 启动，使用隔离数据和最小 PATH。检查默认名称、「通用」页仅两项可编辑、保存后的全局显示、旧归档状态保留、核心服务恢复和应用重启后自定义名称保留，均通过。[通用设置截图](verification/v0.5.3.5-local/packaged-general.png) · [完整结果](verification/v0.5.3.5-local/result.json) · [验收日志](verification/v0.5.3.5-local/smoke.log)。

既有微信 v15→v16 升级、未知扣费阻塞、v2→v16 升级备份、去重／取消、本地封面、优先级、标签、笔记、AI 页滚动、Core 崩溃恢复、144 小时间隔和缺失 Core 提示也通过。没有操作用户日常数据库，也没有真实付费或模型调用。

首次包内验收因旧夹具账本固定在 10 月而跨月失败（BUG-149）；仅修正隔离测试夹具的账本日期后，使用**同一构建产物**完成全部复验。首次记录保留在[构建与首次验收日志](verification/v0.5.3.5-local/build-and-smoke.log)。

收尾脚本核验旧 ZIP 后，将未运行的 0.5.3.4 应用入口移入废纸篓并注销，系统仅索引 0.5.3.5；0.5.3.4 的 ZIP 与 SHA 文件保留且复验通过。[收尾记录](verification/v0.5.3.5-local/app-cleanup.json)。
