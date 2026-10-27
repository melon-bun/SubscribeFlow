# 笔记按钮与144小时采集间隔验收

日期：2026-10-27。源码提交：`963952f`。分支：`fix/note-actions-and-144h-interval`。仅使用隔离临时数据，未访问真实平台或用户日常库。本次为源码验收，现有0.5.3.3安装包未更新。

## BUG-144

真实Electron加载生产CSS和共享note-editor，调用保存后获取按钮内文字Range及按钮边界，比较文字+内边距所需宽度与居中误差。保存API为固定响应，正文保存流程另由正式笔记页验收覆盖。

- 开启视觉特效，浅/深色×编辑区280、320、360、420、640px，共10组。
- 修复前（基线25aea7c）6组文字裁切和偏移；修复后10组均无裁切、偏移或横向溢出。
- [修复前测量](before.json) / [修复后测量](after.json)。
- 浅色：[修复前](before-light.png) / [修复后](after-light.png)；深色：[修复前](before-dark.png) / [修复后](after-dark.png)。
- [笔记页正式Renderer验收](notes.log)：Main/Core真实保存、更新、删除、草稿和导航流程通过。

## 自动采集144小时

- Python调度13项通过：[日志](scheduler.log)。覆盖默认手动与24小时，最少300秒，72/73/144小时创建，144小时到期，切回手动保留，299/518401秒及布尔值拒绝。
- 真实Python RPC 11项通过：[日志](rpc.log)。144小时保存、过期派发与重启保留通过。
- 正式Renderer离线流程通过：[日志](renderer.log)。输入max=144，拒绝145，保存144小时（518400秒），切回手动保留间隔。
- [自动设置界面](renderer/m6-sync-settings.png) / [144小时保存结果](renderer/m6-automatic-schedule.png)。

未等待真实144小时；到期采用可控时钟与已到期计划注入验证。历史002迁移保持原样，现有合法间隔无需迁移。

布局复核（从仓库根目录运行）：`node_modules/.bin/electron docs/verification/note-footer-144h-20261027/layout-preview.cjs before`，再以`after`参数运行。`before`固定读取基线25aea7c的编辑器与组件样式。
