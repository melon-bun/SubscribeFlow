# 2026-10-24 本地 main 集成记录

用户授权将目前所有产品改动合入 main，并明确包含 worktree 分支 `feature/seg-slide`。
此前讨论的总览布局差异与收件箱切换闪屏暂缓，本轮未继续修改这些问题。

## 集成内容

| 项目 | 提交与结果 |
| --- | --- |
| 原 main | `fb66b94` |
| 原视觉分支 | `feature/phase51-visual`，包含 M30–M35 及已有返修 |
| 当前未提交修整 | `4688862`：总览自定义筛选、当日条目结构、来源文字边界、小红书平台标识、验收等待与文档证据 |
| 滑块动画实现 | `d1b8d41`：分段控件 260ms 选中底色动画，覆盖 DOM 替换、连续切换与减少动态效果设置 |
| 动画说明 | `cc31c32`：工作原理、约束与专项验收 |
| 产品集成版本 | `8d99120`：视觉分支与动画分支无冲突合并，main 随后快进至此 |

其他功能 worktree 的已提交内容均已在原 main 中，无额外遗漏的独立产品提交。
保留所有既有分支和 worktree。
临时对照目录 `/private/tmp/sf-base` 只有 `scripts/renderer-smoke.cjs` 的调试日志改动，
已原样保留并备份，未作为产品代码导入 main。

集成前补丁、临时对照调试差异及新增脚本已另存至本机临时备份目录：
`/var/folders/nl/vj8g716d3_x1tyybjb9hd5fh0000gn/T/subscribe-flow-main-merge-backup-rF8B9A`。

## 合并版本验证

以下均在产品集成版本 `8d99120` 实际执行；本记录之后仅同步文档与保存验收 JSON，产品源码未再变化。

| 检查 | 结果 |
| --- | --- |
| `npm test` | 142/142，通过 |
| `PYTHONPATH=python/src /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 -m unittest discover -s python/tests -p test_notes.py` | 33/33，通过；覆盖本分支笔记列表来源与摘要扩展 |
| `node scripts/m35-details-renderer.cjs` | 38/38，通过，[检查结果](m35-details/checks.json) |
| `node scripts/seg-glide-renderer.cjs` | 21/21，通过，[检查结果](seg-glide/checks.json) |
| `node scripts/renderer-smoke.cjs` | 完整离线回归通过，正式 Main/Renderer/Core 桥接、25 条隔离样本、重启与重载持久化通过 |

Renderer 回归包含内容收录、并发竞态、列表状态、优先级、日历和标签场景。
M35 专项包含筛选行对齐、当日条目来源宽度、长来源截断、平台标识边界、
笔记短窗与窄窗可达性、深浅色及关闭特效。
动画专项包含六处分段控件、中途切换、DOM 替换后继续动画、减少动态效果及静止时布局不变。
所有集成 Renderer 检查使用隔离样本与临时数据，不据此扩大真实平台、真实模型或日常数据库验收结论。

## 保留状态

- 内容总览与参考页仍有布局差异，包括整月首屏可见性及优先级说明位置，按用户要求暂缓。
- 收件箱切换闪屏保持已调查、未修复，沿用 `docs/BUG_FIXES.md` 的 BUG-102 补记及已有调查报告。
- 本轮仅完成本地 main 集成；未打包、推送或发布，版本号仍为 0.4.9。
- 进度、5.1 期计划、开发计划镜像、M35 与动画说明同步最新集成状态；更早的“未合并”描述保留为历史记录。
