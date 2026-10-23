# 分段控件滑块动画（seg-glide）

日期：2026-10-23（Asia/Tokyo）
基线：`7a61b95`（M35 细节返修）
分支：`feature/seg-slide`（worktree `.worktrees/seg-slide`）
提交：`d1b8d41` feat(ui): 分段控件选中滑块动画

2026-10-24 集成补记：本分支实现与文档已通过 `8d99120` 合入本地 main。
与当前视觉修整共同复验：专项 21/21、M35 细节 38/38、Node 142/142、
完整离线 Renderer 回归通过，见 [集成记录](verification/phase51/main-integration-20261024/REPORT.md)。

## 1. 做了什么

所有分段控件（`.seg` / `.segment`）切换选中项时，选中底色（浮起滑块）从旧项滑到新项。
时长 260ms，缓动 `cubic-bezier(0.2, 0.8, 0.2, 1)`（与 `tokens.css` 的 `--ease` 一致）。

静止时外观和改动前完全一样：选中项仍由按钮自己的 `.is-active` 样式绘制，
滑块只在动画期间出现。

## 2. 覆盖的控件

不需要逐个接入：只要分组带 `.seg` 或 `.segment`，按钮是分组的**直接子元素**，
选中项带 `.is-active`（或 `.on`），就自动生效。当前产品里的六处：

| 位置 | 来源 | 选择器 | 切换后的重绘方式 |
| --- | --- | --- | --- |
| 收件箱平台筛选 | `ui.seg`（`inbox.js`） | `.inbox__toolbar .seg` | 分组整块替换 |
| 详情优先级 | `inbox.js` 四段 | `.seg.priority-grid` | 刷新边界整块替换 |
| 标签筛选方式（任一 / 全部） | `inbox.js` | `.tag-filter__mode .segment` | 就地改 class |
| 内容总览 日历 / 优先级 | `ui.seg`（`overview.js`） | `.view__actions .seg` | 整页重绘 |
| 渠道管理页签 | `ui.seg`（`channels.js`） | `.seg` | 连续重绘两次（navigate + renderContent） |
| 标签管理页签 | `ui.seg`（`tags.js`） | `.seg` | 连续重绘两次 |

## 3. 文件

| 文件 | 内容 |
| --- | --- |
| `electron/renderer/scripts/ui/seg-glide.js` | 全部动画逻辑，导出 `SF.segGlide = { selector, duration }` |
| `electron/renderer/styles/components.css` | `.seg, .segment { contain: layout }` 与透明的 `::before` 滑块 |
| `electron/renderer/index.html` | 在 `components.js` 之后引入 `seg-glide.js` |
| `scripts/seg-glide-renderer.cjs` | 隔离数据验收脚本 |
| `electron/main/index.cjs` | 验收模式分发里加 `segglide` 一行 |

## 4. 工作原理

1. **点击（捕获阶段）**：`document` 上的捕获阶段 `click` 监听记下旧选中项的位置、
   旧选中项的外观（底色 / 阴影 / 圆角）、新按钮在分组里的序号，以及分组签名。
   此时视图还没重绘。
2. **等新选中项出现**：开一个 `MutationObserver`，等分组里同一序号的按钮变成选中状态。
   上限 1200ms（部分切换要先等一次 RPC 才重绘），超时就放弃，不播放。
3. **起跑**：用 Web Animations 在分组的 `::before` 上做从旧位置到新位置的动画
   （`transform` / `width` / `height` 与外观一起动）。同时把目标按钮的底色和阴影压成透明，
   免得和滑块叠出两块底。如果是就地改 class，旧按钮还在，它的淡出过渡也一起压住。
4. **接力**：动画途中分组又被整块替换，就按签名找到新分组，
   从滑块此刻的位置接着跑完剩余时间（剩余时间下限 90ms，太短看起来像跳）。
5. **中途再切**：新动画从滑块当前位置出发，外观沿用正在跑的那次
   （旧按钮的底此时已被压成透明，不能再从它身上取）。
6. **结束**：取消所有动画，位置交还按钮；没有待处理的切换时断开 `MutationObserver`，平时零开销。

## 5. 必须遵守的约束（改这块前先读）

- **滑块不能是真实节点，也不能用内联样式。** `dom.js` 的 reconciler 重绘时会删掉
  模板里没有的子节点，并抹掉模板里没有的 class / style。所以滑块画在 `::before` 上，
  位置和外观全部由 Web Animations 驱动，reconciler 碰不到。
- **静止样式不能变。** `scripts/m35-style-probe.cjs` 会把 `.seg`、`.seg button.is-active`、
  `.priority-grid` 等的计算样式与参考页 `zhiliu-visual-style.html` 对拍。
  所以不改分组的 `position` / `z-index`，只加 `contain: layout`：它让分组成为 `::before`
  的包含块和层叠上下文，`z-index: -1` 把滑块压在凹槽底色之上、按钮文字之下，且不影响布局
  （验收脚本会去掉 `contain` 再量一遍，确认一像素不差）。
- **规则放在 `components.css`，不放 `zhiliu.css`。** `zhiliu.css` 由
  `scripts/m35-build-zhiliu-css.cjs` 从参考页重新生成，手改会被覆盖。
  但 `zhiliu.css` 在 `components.css` 之后加载：如果参考页以后给 `.seg` 加了 `::before`、
  `contain`、`overflow: hidden` 或 `position`，会覆盖或影响这里，需要重跑验收。
- **签名只取按钮名称，不取计数。** 计数会随重绘变化（「全部 12」→「全部 11」），
  签名 = `aria-label` + 各按钮去掉 `.n` 后的文字。同签名的分组有多个时取离旧位置最近的。
- **按钮必须是分组的直接子元素。** 序号按 `group.children` 里的 `BUTTON` 计算；
  包一层 wrapper 会让控件失去动画（不会报错）。
- **减少动态效果**：系统开启 `prefers-reduced-motion: reduce` 时直接不播放。
  这和 `fx.css` 的降级规则是两条独立的路径（Web Animations 不受 CSS `animation: none` 影响）。

## 6. 新增分段控件时

用 `ui.seg(...)`，或手写 `.seg` / `.segment` + 直接子按钮 + `.is-active`，不需要额外代码。
如果新控件的切换要等 RPC 超过 1.2 秒才重绘，动画会被放弃（静默降级为直接切换）；
必要时调大 `seg-glide.js` 里的 `WAIT`。

## 7. 验证

```bash
# 隔离数据，不触网、不写业务数据；截图默认写到 docs/verification/phase51/seg-glide/
node scripts/seg-glide-renderer.cjs
# 临时输出到别处
SUBSCRIBE_FLOW_VERIFY_OUTPUT=/tmp/seg-glide-out node scripts/seg-glide-renderer.cjs
```

脚本用 `scripts/seed-m35-details.py` 造数据，逐个控件断言：

| 断言 | 含义 |
| --- | --- |
| `resting-*` | 静止时滑块透明、选中项自己有底；去掉 `contain` 后布局不变 |
| `glide-mid-*` | 暂停在动画中点：滑块可见且位于两项之间，目标按钮的底被压住；同时截图 |
| `glide-end-*` | 动画全部清理，目标按钮恢复静止样式，滑块回到透明 |
| `interrupt` | 动画途中再切，第二段从滑块当时的位置出发 |
| `reduced-motion` | 模拟减少动态效果时不播放 |

2026-10-23 结果：21/21 通过（含深色主题一组）。回归：Node 142/142、`smoke:renderer` 通过。

静止样式回归：在基线 `7a61b95` 和本分支上，用同一份隔离数据各跑一次
`m35-style-probe.cjs`，导出的 14174 项计算样式逐项相同，差异为 0。做法：

```bash
# m35-style-probe 必须指定隔离数据目录，否则会撞上正在运行的真实应用，Electron 直接退出且没有任何输出
data=$(mktemp -d /tmp/subscribe-flow-m35-details-probe-XXXX)
python scripts/seed-m35-details.py "$data"   # 用 .runtime-paths.json 里的 python
SUBSCRIBE_FLOW_DATA_DIR="$data" SUBSCRIBE_FLOW_STYLE_OUT=/tmp/styles-head.json node scripts/m35-style-probe.cjs
# 基线侧：git worktree add --detach /tmp/base 7a61b95，软链 node_modules、复制 .runtime-paths.json 后同样导出，再逐键比较两份 JSON
```

截图证据：[verification/phase51/seg-glide/](verification/phase51/seg-glide/)
（`mid-*.png` 为动画中点截图，`checks.json` 为逐项结果）。

### 写验收时的坑

点击后分组可能已被整块替换，之前拿到的按钮引用会失效：在已脱离文档的旧按钮上调用
`click()` 不会触发任何东西。连续点击时要按序号在**当前**分组里重新取按钮
（见脚本里 `interrupt` 一项）。

## 8. 调试

- `SF.segGlide` 存在即模块已加载。
- 正在跑的动画：`document.getAnimations().filter(a => a.effect.pseudoElement === '::before')`。
- 想放慢观察：在控制台把动画 `pause()`，再设置 `currentTime`。
