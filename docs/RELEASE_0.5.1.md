# 0.5.1 发布记录

日期：2026-10-24（Asia/Tokyo）。用户明确授权恢复白底 logo、更新版本和 README、重新截图、发布并推送。

## 发布结果

**已正式发布，且为 GitHub 最新版本。** 发布时间 `2026-10-24T10:38:33+09:00`。

- 发布页：[知流 0.5.1](https://github.com/melon-bun/SubscribeFlow/releases/tag/v0.5.1)。
- 源码、构建基线与 `v0.5.1` 标签提交一致：`824b5270187ccddf9d3964fa8ac35e589bc75102`。
- `main` 已推送完整第五期、5.1 期、`feature/seg-slide` 和 BUG-102 两轮修复；发布后仅追加本记录与验收证据。
- macOS Intel（x64）安装包、SHA-256 校验文件均已上传，远端状态为 `uploaded`，大小与摘要逐项匹配本地。

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Subscribe-Flow-0.5.1-mac-x64.zip` | 146005747 | `40920f29f6a6c78a4355ed3492eab531fb9d21ec0bc9c9fa271e5cc4c67780e2` |
| `Subscribe-Flow-0.5.1-mac-x64.zip.sha256` | 99 | `afbcc7f26dc3f5fe350400077aee9eaa5a16b45403733bbae4dd534c893840a9` |

## 本版内容

- 版本元数据四处统一为 0.5.1，依赖版本未变。
- BUG-121 续修：样式生成源与 CSS 保留知流白底原图、完整 34px 尺寸和中性阴影，品牌图片资产未修改。
- 汇总笔记／项目判断、独立 AI 服务和总结草稿、纸面视觉与可关闭特效、分段滑块动画，以及 BUG-102 交互稳定性修复。
- README 按当前能力更新，并替换为八张本版正式界面截图：收件箱、深色、笔记、日历、看板、标签、渠道、链接收录。
- 截图使用专用合成样本与正式 Main/Renderer/Core，不使用日常资料、账号或真实模型调用。

## 验收结果

- Node 测试 **142/142** 通过；深浅色品牌计算样式为 `rgb(255, 255, 255)`，原图和底框均 34px。
- 包内 **60 个 Main／Preload／Renderer 文件**与构建源码逐字节一致；原始 logo 与应用图标匹配，打包白名单通过。
- 签名完整性、ZIP 完整性和本地 SHA-256 校验通过。采用本机 ad-hoc 签名，未经过 Apple 公证。
- **最终发布包**移到项目目录外，经 LaunchServices 和最小 PATH 启动；忽略外部 Python 与开发验收标志，使用内置冻结 Core。
- v2→v12 迁移、升级备份、去重与取消、状态互斥、优先级继承和看板、标签、笔记保存、总结设置隔离均通过。
- 真实应用重启后笔记／项目结论、总结设置、优先级与标签保持；Core 自动恢复、缺失运行文件提示和诊断脱敏通过。
- 发布后核对 GitHub 最新版本、公开发布状态、两个远端文件的大小和摘要，以及标签所指源码；全部一致。

正式包证据：[result.json](verification/v0.5.1-release/packaged/result.json)、[包内文件](verification/v0.5.1-release/package-content.json)、[发布收据](verification/v0.5.1-release/release-receipt.json)。
Node 与截图日志、构建日志及 GitHub 原始响应均在 [证据目录](verification/v0.5.1-release/)。

## 验收入口维护与范围

旧库夹具先移除 v12 笔记表再模拟 v2，避免残留新表造成伪迁移失败。新增设置检查使用正式 `getSettings/saveSettings` 与 AppClient 数组参数，不扩大生产白名单。早期两次接口契约错误为新增脚本问题，另一次 CDP 启动连接超时未复现；原始日志保留，修正后预检及最终发布包全段通过。

本轮功能验收使用隔离离线样本；真实平台登录、模型服务和系统通知不在本轮重测范围。详情标为「示例数据」的装饰读数继续保留，内容总览剩余布局差异按用户此前指示暂缓。

公开说明：[RELEASE_NOTES_0.5.1.md](RELEASE_NOTES_0.5.1.md)。
