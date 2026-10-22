# M31 界面样式重构：纸面外壳、主操作橙、颜色收敛

日期：2026-10-22（Asia/Tokyo）
基线：`ed36d50`（M30 令牌）
提交：`347246b` feat(m31): 界面样式按「静流」重构
依据：`zhiliu-visual-style.html` §2–§5、§7
方案：[DEVELOPMENT_PLAN_PHASE51.md](DEVELOPMENT_PLAN_PHASE51.md) §4

## 1. 最重要的一件事：演示类名 ≠ 产品类名

「静流」HTML 是一份**独立演示页**，它的类名与产品真实结构不同。方案「令牌映射」一节写明
「变量名沿用 tokens.css」，这一点成立（令牌可直接替换）；但**组件层必须按产品真实类名重写**，
照抄演示页选择器会得到「看起来改了、实际一条规则都没生效」的假改造。

已核实的映射：

| 方案演示类 | 产品实际类 | 处理 |
| --- | --- | --- |
| `.pf` 平台方块 | `.plat` + `.plat--<平台>` | 改造既有，加 `.plat--sm` 尺寸 |
| `.sig` 三格信号条 | 无（优先级原为彩色文字胶囊） | 新增 `.prio-sig` + `ui.prioSig()` |
| `.seg` 分段控件 | 无（优先级原为三张大卡片） | 改造 `.priority-grid` 为分段控件形态 |
| `.sheet` 圆角纸面 | `.shell__body` / `.workspace` / `.main` | 纸面落在 `.workspace` |
| `.hero` / `.hud` / `.readout` | 产品详情区无对应元素 | 读数条在 M32 新增 |
| `.logo` / `.orbit` | `.brand__mark` + `brand.png` | **logo 本体不动**，轨道在 M32 加在外层 |
| `.dialog-stage` / `.dialog` | `.dialog` / `.dialog__body` | 沿用现有对话框体系 |

## 2. 各文件改了什么

### layout.css —— 外壳纸面化（方案 §2）

- `.app`、`.sidebar`、`.topbar` 背景改 `--c-bg`；去掉侧栏右边线与顶栏下边线；
- `.workspace` 变成一张圆角纸面：`margin: 0 10px 10px 0`、`border-radius: var(--r-xl)`、
  `background: var(--c-sheet)`、`box-shadow: var(--sh-sheet)`、`overflow: hidden`；
- `.main` 与 `.detail` 改用 `--c-sheet`，详情面板用 `--c-divider` 细线分隔；
- 侧栏选中项 `.nav__item.is-active` 改为浮起纸片（`--c-surface` + `--sh-card`），
  图标变 `--c-brand`；
- 搜索框改凹槽底 `--c-surface-3` + `--sh-inset`，聚焦时青色描边 + 4px 光环；
- 窄窗（≤900px）下详情面板脱离纸面成为浮层，补回独立底色；
  `.app` 的第二列由 `1fr` 改为 `minmax(0, 1fr)`，避免加 margin 后横向溢出。

### components.css —— 组件层（方案 §4）

- **按钮**：`.btn` 改「阴影画边框」；`.btn--primary` 改航天国际橙 `--c-action`
  （浅色 `#d63f00` 白字、深色 `#ff5c1a` 黑字）；新增 `.btn--ink` 墨色次级
  （对应方案 `.btn-ink`，用于「打开原文」这类操作）；新增 `:focus-visible` 青色光环。
- **优先级**：`.priority-grid` 由三列大卡片改为分段控件（凹槽 + 浮起滑块）；
  新增 `.prio-sig` 三格信号条（高=3 格、中=2 格、低=1 格，色弱用户靠格数区分）。
- **标签**：`.tag-chip` 改中性底（`--c-surface-2` + 半透明描边）+ 圆角胶囊，
  颜色只由 `.tag-chip__dot` 承载；`tag-controls.js` 相应不再写行内底色与文字色。
- **平台块**：新增 `.plat--sm`（15px）供内容卡片使用。
- **卡片**：`.content-card` 改阴影画边框，悬停换阴影 + 上浮 1px；
  选中态改信号青描边 + 光环。

### views.css —— 内容卡片与看板（方案 §3、§7）

- `.content-card__link`（URL 行）默认隐藏，悬停或选中时出现，等宽字体、中性色；
- 新增 `.content-card__method`（收录方式：小图标 + 浅灰文字）；
- 新增 `.prio`（信号条 + 一个字，文字中性）；
- 看板列 `.kanban__col` 改中性底 `--c-surface-2` + 阴影，顶部一层等级色渐隐
  （`color-mix` 取 `--pc`），不再整列染色；
- 列头 `.kanban__head-icon` 改透明底，由信号条表达等级。

### settings.css

- 设置页导航选中项同步改为浮起纸片；`:focus-visible` 改青色光环。

## 3. JS 侧改动

| 文件 | 改动 |
| --- | --- |
| `ui/components.js` | 新增 `ui.prioSig(priorityId)`；`ui.platformTag` 改为平台色方块；`ui.priorityTag` 改为信号条 + 文字；内容卡片元信息行改为「平台方块在来源名前 + 信号条 + 图标式收录方式」 |
| `ui/tag-controls.js` | 标签底色与文字色改由 CSS 中性令牌承担，只保留圆点着色 |
| `views/inbox.js` | 详情页优先级改为四段控件（高/中/低 + 跟随来源），等级用信号条 |
| `views/overview.js` | 看板列头改用信号条 |
| `core/icons.js` | 新增 `hand` 图标（手动收录） |

## 4. 卡片颜色收敛结果

方案要求「一张卡片上的颜色从 5~6 处降到 2 处」。改造后一张内容卡片上：

- 平台色方块 1 处（色块本身）；
- 优先级信号条 1 处（未设置时为中性灰，不算彩色）；
- 标签圆点若干（每个标签一个 6px 圆点，中性底）；
- 文字全部中性。

即彩色元素从「粉色文字胶囊 + 红色文字胶囊 + 灰色胶囊 + 彩色底标签 + 蓝色 URL」
收敛为「平台方块 + 信号条 + 小圆点」。

## 5. 验证

- Node 142/142；
- 主 Renderer 验收全段通过（含 `tagsSmoke.darkContrast` 深色对比度）；
- M26／M27／M28／M29 实机脚本全部通过；
- `v049-batch01-renderer`（M19/M20）通过；
- `settings-renderer` 通过（分区清单加入「外观」并补该分区专项断言）。

### 为适配新设计而更新的断言（4 处，均保留原检验意图）

| 文件 | 原断言 | 现断言 |
| --- | --- | --- |
| `priority-smoke.cjs` | `.priority-opt__icon` 背景非透明 | 信号条存在、3 格、中等级点亮前 2 格且第 3 格保持中性 |
| `v049-batch01-renderer.cjs` | `.tag--github` 黑字浅底 | `.plat--github` 浅底深色图形 + 无障碍标签 |
| `v049-batch01-renderer.cjs` | `.content-card .tag--high` 文字 | `.content-card .prio--high` 文字（按等级精确定位） |
| `settings-renderer.cjs` | 分区清单 4 项 | 分区清单 5 项，并补外观分区专项断言 |

## 6. 修掉的两个真问题

1. **`parseHash` 分区白名单漏了 appearance** —— 设置页路由的白名单只认
   ai／reminder／priority／summarization，新分区被回落成 ai，导致「切到外观」无效。
   这是典型的「接线完成但没人调用」——静默失败、界面正常、只是不对。
2. **外观分区被 Core 设置的加载门控挡住** —— `buildBody` 在 `cache.draft` 未就绪时
   提前返回「正在读取设置」，而外观分区是纯前端设置、不依赖任何本地数据，
   结果这一页会永远卡在加载态。已把它提到草稿门控之前。

## 7. 未做

- 快捷键绑定：用户已确认不做，界面不留 `.kbd` 提示（搜索框的「⌘ K」是真实实现的，保留）；
- 详情读数条：属 M32；
- 断点体系收敛：本期沿用既有断点，不与视觉重构混在一起。
