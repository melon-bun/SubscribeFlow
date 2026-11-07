# 0.5.3.6 本地构建

日期：2026-11-07（Asia/Tokyo）

macOS Intel（x64）本地包已构建并通过包内验收。修复标签筛选列表无法下滑，以及窗口较窄、右侧详情打开时筛选列表被挤没的问题。功能提交 `e3a795c`、`bd1ed85`；构建修订 `bd1ed85df2cba05ec6fe125643aee712e07fdcce`。

| 项目 | 结果 |
| --- | --- |
| ZIP | `dist/Subscribe-Flow-0.5.3.6-mac-x64.zip` |
| 应用 | `dist/0.5.3.6/Subscribe Flow-darwin-x64/Subscribe Flow.app` |
| ZIP 大小 | 146,162,705 字节 |
| SHA-256 | `642e986e172dc5a0f80b31bd89ad5f0b8ec3fd011c61a58c3eabd6b5a8ccb420` |
| 运行时 | Electron 44.5.1、Python 3.12.5、macOS x64 |
| 签名 | 本机 ad-hoc；未经 Apple 公证、未远端发布 |

62 个包内源码文件与构建源码一致；签名、ZIP、SHA-256、图标、白名单和 18 条相对链接通过。[包体审计](verification/v0.5.3.6-local/audit.json)。

隔离数据的实际安装包验收中，1000×700 窗口、详情展开及 61 个标签下，真实滚轮可以到达标签末尾；选择两个底部标签后位置可见，「全部符合」与清除筛选正常。[标签截图](verification/v0.5.3.6-local/packaged-tag-filter.png) · [完整结果](verification/v0.5.3.6-local/result.json) · [最终验收日志](verification/v0.5.3.6-local/smoke.log)。源码界面另验证 100 个标签、键盘滚动和不同窗口大小。阅读状态重命名、微信旧库升级、标签、笔记、Core 和应用重启等既有包内验收均通过。

首次包内发现窄窗口详情展开时标签池高度为零，补修后重新构建。[首次记录](verification/v0.5.3.6-local/build-and-smoke-initial.log) · [诊断](verification/v0.5.3.6-local/smoke-debug.log)。重新构建后的首次验证中，详情因筛选而收起、列表变宽导致最大滚动位置变化，旧断言错误地要求像素位置完全不变；改为验证原位置或收缩后的底部，并要求所选标签可见，再以同一包完成完整验收。[重新构建与首次验收](verification/v0.5.3.6-local/build-and-smoke.log)。

收尾脚本核验旧 ZIP 后，将未运行的 0.5.3.5 应用移至废纸篓并注销；系统仅索引 0.5.3.6，旧 ZIP 与校验文件保留，日常数据未触碰。[清理记录](verification/v0.5.3.6-local/app-cleanup.json)。
