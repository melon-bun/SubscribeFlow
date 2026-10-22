# 第五点一期开发方案：界面优化（「静流」设计重构）

日期：2026-10-22（Asia/Tokyo）
源码基线：`fb66b94`（codex 已将 `main` 合并进 `feature/phase5-notes`，两者同点；`main` 此前为 `ee4ec25`）。
模块编号：承接第五期 M25–M29，本期 **M30–M32**；真实读数取数与快捷键转 **5.2 期**。
设计依据：`/Users/xor/Documents/Subscribe_Call/zhiliu-visual-style.html`（「静流」视觉风格方案，2120 行）。
状态：**M30–M32 已实现并由 Codex 实机验收通过（2026-10-22）。分支 `feature/phase51-visual`，未合并 main、未打包／推送／发布。真实读数取数与快捷键转 5.2 期。**

## 0. 本文档的定位与当前状态

用户于 2026-10-22 指示：**在第五期完成之后补一个界面优化任务，先建文档，随后提供前端界面相关信息。** 该任务定位为 **5.1 期**，是第五期的后续小期，不是新的一期。随后的前端信息已给出：**整个设计风格和设计原则按「静流」重构，采用轻科幻 design token，知流 logo 保持原样。**

因此本文档承担四件事：

1. 固定这项任务的编号、边界与它和第五期的关系；
2. 记录前端现状盘点——全部经代码核实，作为改造与验收的共同基准；
3. 记录「静流」方案与产品真实代码之间的差异，避免照抄演示页选择器；
4. 给出 M30–M32 的模块划分、实施顺序与可验收的完成门槛。

**已确定**：改造范围（全部界面）、设计依据（「静流」文件）、令牌取值（按方案映射表）、logo 保持原样。
**本期明确不做**：快捷键绑定、详情读数的数据层取数、采集与 Core RPC 改动、打包发布（理由见 §4.1）。

> 说明：仓库根目录 `zhiliu-visual-style.html`（「静流」视觉风格方案）是本期的**唯一设计依据** —— 用户已于 2026-10-22 明确要求整个设计风格与设计原则按该文件重构，并采用其中的轻科幻 design token。此前「该方案尚未完善、本期不作为依据」的指示已被本次指示取代。

## 1. 与第五期的关系

第五期（M25–M29）源码模块已全部由 Codex 验收，`main` 已快进到 `ee4ec25`。第五期的追加界面项另见 [PHASE5_UI_FOLLOWUP.md](PHASE5_UI_FOLLOWUP.md)：其中 ui-followup-01（AI 按钮着色、BUG-115 滚动修复）已验收关闭，ui-followup-02（笔记页美化与紧凑原内容卡片）已提交 `ca29932`。

本期是**第五期的后续小期（5.1 期）**，承接第五期而非重开它：

- 不重开 M25–M29 已验收模块，不改其业务语义与数据契约；
- 若优化过程中发现第五期遗留问题，按项目规范记入 [BUG_FIXES.md](BUG_FIXES.md)，不混入本期范围；
- 本期改动默认只落在 Renderer 层（`electron/renderer/`），不触碰 SQLite schema、Core RPC、采集与 AI 服务。若用户后续信息要求越过这条边界，先在本文件记录理由再实施。

## 2. 前端现状盘点（2026-10-22 代码核实）

以下为经代码核实的客观事实，作为后续需求讨论与验收的共同基准。

### 2.1 目录与规模

| 位置 | 内容 | 行数 |
| --- | --- | --- |
| `electron/renderer/index.html` | 唯一 HTML 入口，仅 49 行，靠 JS 构建 DOM | 49 |
| `electron/renderer/styles/` | `base` / `components` / `intake` / `layout` / `settings` / `tokens` / `views` | — |
| `electron/renderer/scripts/app.js` | 应用状态、路由、外壳、主题、刷新调度 | 约 890 |
| `electron/renderer/scripts/core/` | `app-client` / `catalog` / `dom` / `format` / `icons` / `tag-catalog` | — |
| `electron/renderer/scripts/ui/` | `components` / `intake-dialog` / `note-editor` / `tag-controls` / `tooltip` | — |
| `electron/renderer/scripts/views/` | `inbox` / `overview` / `channels` / `tags` / `notes` / `settings` | — |

样式文件体量：`views.css` 约 50KB、`components.css` 约 42KB、`settings.css` 约 11KB、`layout.css` 约 12KB、`intake.css` 约 11KB、`tokens.css` 约 6KB、`base.css` 约 5KB。`views.css` 与 `components.css` 合计已超 90KB，是本期最可能涉及的改动面。

### 2.2 视图与路由

侧栏一级导航共 5 项（`scripts/app.js:32`）：

| 路由 id | 名称 | 视图文件 |
| --- | --- | --- |
| `inbox` | 收件箱 | `views/inbox.js` |
| `overview` | 内容总览 | `views/overview.js` |
| `channels` | 渠道管理 | `views/channels.js` |
| `tags` | 标签 | `views/tags.js` |
| `notes` | 笔记 | `views/notes.js` |

设置页不在侧栏导航内，由左下角头像入口进入（`scripts/app.js:298`），是独立路由 `settings`，自身还有分区导航 `settings-nav__item`。

每个视图通过 `SF.views.<id>` 暴露统一接口：`render` / `reset` / `invalidate`，另有 `updateRuns`、`updateTagging`、`updateBackground`、`whenIdle` 等按需增量更新方法。**界面优化应优先走这些既有增量接口，不破坏 `invalidate(reasons)` 的后台刷新语义**（见 [UI_REFRESH_OPTIMIZATION.md](UI_REFRESH_OPTIMIZATION.md) 对无闪烁刷新链路的约定）。

### 2.3 设计令牌与主题

- 全部设计令牌集中在 `electron/renderer/styles/tokens.css`（约 6KB），覆盖品牌色、中性色、优先级语义色、平台色、状态色、标签色板（11 档）、圆角、间距、字号、字体、布局尺寸、阴影、动效、层级。
- 主题为 light / dark 双套，通过 `<html data-theme>` 切换；深色覆盖集中在 `tokens.css:144` 的 `:root[data-theme="dark"]` 块内。
- 切换逻辑在 `scripts/app.js:261`（顶栏按钮）与 `scripts/app.js:634`（启动时从 `localStorage` 读取 `sf.theme` 恢复，默认 `light`）。
- `tokens.css` 注释明确要求：**新增样式必须引用本文件变量**，不得写死颜色与尺寸。
- `components.css` 中仍有零散深色覆盖（如 `:root[data-theme="dark"] .tag--xiaohongshu` 等），说明令牌未完全覆盖平台色，是已知的技术债点。

### 2.4 响应式与无障碍

- 断点散落在各样式文件，当前已用的有 1500 / 1440 / 1360 / 1320 / 1280 / 1240 / 1180 / 1120 / 1080 / 1040 / 900 / 800 / 720px，**同一个文件内多套断点并存，没有统一断点变量**（如 `--bp-*`），是本期可考虑的收敛点。
- `base.css:314` 已有 `@media (prefers-reduced-motion: reduce)`，但仅此一处；其余动效未统一遵循该降级。
- 布局尺寸令牌：`--sidebar-w: 248px`、`--sidebar-w-collapsed: 64px`、`--topbar-h: 60px`、`--detail-w: 400px`。

### 2.5 已有验证手段

`scripts/` 下已有成熟的实机 Renderer 验收脚本，可直接作为本期的验收载体，无需另起炉灶：

- 视图级：`m26-notes-renderer.cjs`、`m27-note-editor-renderer.cjs`、`m28-notes-view-renderer.cjs`、`m29-summary-renderer.cjs`、`settings-renderer.cjs`、`intake-renderer.cjs`、`renderer-smoke.cjs`
- 刷新链路：`refresh-ui-smoke.cjs`、`refresh-inbox-channels-smoke.cjs`、`overview-refresh-ui-smoke.cjs`、`tags-refresh-ui-smoke.cjs`
- 打包后：`packaged-smoke.cjs`、`desktop-smoke.cjs`
- 多页实机截图脚本 `0e0379b` 已覆盖笔记／总览／渠道／标签，可直接用于前后对比取证。

## 3. 已确认需求（2026-10-22 用户给定）

用户已给出本期方向：**整个设计风格和设计原则按 `/Users/xor/Documents/Subscribe_Call/zhiliu-visual-style.html`（「静流」）进行重构，采用其中的轻科幻 design token；知流的 logo 保持原样。**

此前「静流尚未完善、先别管」的指示已被本次指示取代 —— 该 HTML 自此成为本期唯一设计依据。

| 编号 | 用户原意 | 落实 |
| --- | --- | --- |
| P1 | 整个设计风格与设计原则按「静流」重构 | 覆盖外壳、内容卡片、组件、详情面板、对话框、看板、日历等全部界面 |
| P2 | 采用轻科幻 design token | 以该文件 `:root` 与 `:root[data-theme="dark"]` 的取值为准，变量名沿用现有 `tokens.css` |
| P3 | **知流 logo 保持原样** | `electron/renderer/assets/brand.png` 与 `.brand__mark`/`.brand__logo` 样式不改；轻科幻层不得覆盖 logo 图形本体 |
| P4 | 按「静流」的设计原则 | 遵守该文件「色彩」「轻科幻层」两节的原则：每种颜色只有一个含义、信号青只用于状态与容器边缘、一屏持续动画最多两处、无紫色与变色渐变 |
| P5 | 允许调整 `tokens.css` 既有取值 | 该文件「令牌映射」表已明确逐项新值，按表替换 |
| P6 | 交付形态 | 源码改动 + 实机验收证据；本轮不打包、不推送、不发布（沿用第五期约定） |

### 3.1 关键差异：方案演示类名 ≠ 产品真实类名

方案 HTML 是一份**独立演示页**，其类名（`.card` / `.pf` / `.sig` / `.seg` / `.btn-primary` / `.sheet` / `.hero`）是演示用命名，**与产品现有类名不同**。落地时必须映射到产品真实结构，不能照抄方案的选择器。

已核实的差异（产品侧真实写法）：

| 方案演示类 | 产品实际类 | 说明 |
| --- | --- | --- |
| `.pf`（平台方块） | `.plat` + `.plat--xiaohongshu` / `--bilibili` / `--wechat` / `--weibo` / `--zhihu` / `--github` / `--other` | 平台标识已存在，改其形态而非新增 |
| `.sig`（三格信号条） | `.pill--high` / `.pill--mid` / `.pill--low` / `.pill--none` / `.pill--neutral` | 优先级当前是彩色文字胶囊，需改为信号条表达 |
| `.tag`（中性底+圆点） | `.tag--*` 系列（`components.css` 内） | 沿用现有 11 色色板，只改呈现 |
| `.btn-primary` / `.btn-ink` | `.btn` + 现有变体（`.btn--accent` 等） | 主操作橙、次级墨色为新增变体 |
| `.sheet`（圆角纸面） | `.shell__body` / `.workspace` / `.main`（`layout.css`） | 主区域纸面化需按真实外壳结构改造 |
| `.hero` / `.hud` / `.readout` | 产品详情区无对应元素 | 需新增结构，或按方案原则用既有元素等价实现 |
| `.dialog-stage` / `.dialog` | `.dialog` / `.dialog__body`（`app.js` 与 `components.css` 现有） | 沿用现有对话框体系 |
| `.logo` / `.orbit` | `.brand__mark` + `.brand__logo`（`img`，用 `brand.png`） | **logo 本体保持原样**；轨道弧若实现须加在 `.brand__mark` 外层，不改图片 |

方案「令牌映射」表已写明「变量名沿用 `tokens.css`，大部分改动是替换取值」，这一点成立：令牌可直接替换，但**组件层必须按产品真实类名重新实现**，不能把演示页 CSS 直接搬进产品。

### 3.2 「静流」设计原则（落地必须遵守）

1. **每种颜色只有一个含义**：橙＝主操作与品牌（每屏一处）、青＝选中/当前/焦点、红·琥珀·绿＝高/中/低优先级、铝灰/座舱黑＝中性底。
2. **信号青 `--c-signal` 不用于文字和大面积底色**，只用于线条、描边与小圆点；全页无变色渐变、无紫色/靛蓝渐变。
3. **一屏内持续动画最多两处**（logo 轨道、在线呼吸点），其余只在操作时触发一次。
4. **`prefers-reduced-motion: reduce` 时全部动画停用**，静态样式保留。
5. 科幻感来自「仪器感」，不靠霓虹与大面积发光；深色下才允许辉光。

## 4. 模块划分与实施顺序

模块编号承接 M25–M29，本期 **M30–M32**。按方案「落地改动清单」的 8 组，以「先令牌、后组件、最后轻科幻层」的顺序推进，每组单独提交、单独可验收。

| 模块 | 范围 | 对应方案改动 | 交付物 | 完成门槛 |
| --- | --- | --- | --- | --- |
| M30 设计令牌重构 | `tokens.css` 全量替换为「静流」取值（浅色+深色），补 `--c-sheet` `--c-ink` `--c-action` `--c-orange` `--c-brand-ink` `--c-brand-ring` `--c-signal` `--c-signal-ring` `--line-signal` `--c-grid-dot` `--glow-brand` `--glow-action` `--sh-card` `--sh-card-hover` `--sh-sheet` `--sh-pop` `--sh-inset` `--font-mono` 等新变量；圆角整体加大一档；告警三色改红偏玫红／琥珀偏黄／绿 | 清单 §1 | `docs/M30_DESIGN_TOKENS.md`、`tokens.css` | 双主题令牌值与方案映射表逐项一致；不破坏既有 `var(--c-*)` 引用（新增变量不改名、不删旧变量） |
| M31 界面样式重构 | 外壳纸面化（`layout.css`）、内容卡片与信号条表达（`views.css`）、组件层主操作橙/次级墨色/分段控件/标签圆点（`components.css`）、设置页与 intake（`settings.css`/`intake.css`） | 清单 §2–§5 | `docs/M31_UI_REFACTOR.md`、各样式文件 | 产品真实类名全部适配；双主题无不可读/错位/溢出；既有实机 Renderer 脚本全通过 |
| M32 轻科幻层 | 新增 `styles/fx.css`，全部规则挂在 `[data-fx="on"]` 下；点阵坐标纸、极光细线、取景框角标、扫描光、等宽读数（本期用假数据）、在线呼吸点、轨道掠光、深色辉光；设置页「外观」加「界面效果：轻科幻/简洁」开关写 `<html data-fx>` | 清单 §7 | `docs/M32_FX_LAYER.md`、`fx.css` | 效果可整体关闭且关闭后版式不塌；`prefers-reduced-motion` 下动画全停；logo 本体未被改动 |

### 4.1 明确不在本期范围

- **快捷键绑定**（方案清单 §6）：方案已注明「快捷键提示只是视觉，需要另外绑定」。用户已确认**快捷键不做**。方案样式若引入 `.kbd` 提示，必须去掉，避免界面暗示不存在的功能。
- **详情读数的真实数据来源**（方案清单 §8）：采集时间、详情完整度、AI 打标状态涉及 `contents.first_seen_at`、`acquisition_complete`、`tagging_tasks` 的取数，属数据层扩展。本期按用户决定**先用假数据把读数条做出来**，真实取数与接入归入 **5.2 期**（见 §4.2）。
  - 假数据读数条**必须显式标注为示例**，不得让用户误以为是真实采集数据（例如统一加 `示例` 前缀或 `data-demo` 标记），这是本期唯一的例外于「取不到就隐藏」规则的场景。
  - 假数据仅用于确立读数条的版式、等宽排版与信息密度；其字段值固定，不随内容变化。
- 采集、Core RPC、SQLite schema、AI 服务与配置：全部不动。
- 后端能力与打包发布：本期不打包、不推送、不发布。

### 4.2 顺延到 5.2 期的事项

以下已在本期立项但不实施，转入 5.2 期：

| 事项 | 本期状态 | 5.2 期要做 |
| --- | --- | --- |
| 详情读数的真实取数 | M32 用假数据搭出读数条版式 | 接 `contents.first_seen_at`、`acquisition_complete`、`tagging_tasks.state`/`applied_count`；替换假数据；无数据的字段隐藏，不显示占位 |
| 快捷键绑定 | 不做，界面不留 `.kbd` 提示 | 绑定 J/K/E/L/A/O/N 并补上提示样式 |

## 5. 验收标准

验收一律区分两件事：**界面路径有证据**与**仅有后端断言**。后者不得记为界面通过（见 [BUG_FIXES.md](BUG_FIXES.md) 既有条目与本期记录中的同类教训）。

### 5.1 基线要求

- 改动不得破坏既有实机 Renderer 验收脚本（第二节 2.5 所列）；
- light / dark 两套主题下均无不可读文字、错位或溢出；
- 窄窗下不出现横向滚动条、不把整页缩放成不可读的小字；
- 键盘可达：`focus-visible` 焦点可见，modal 焦点限制与关闭后回位不破坏；
- 动画须能在 `prefers-reduced-motion: reduce` 下降级；
- 刷新链路不回退：无闪烁刷新、后台更新保留已显示内容与编辑草稿的既有语义不变；
- **logo 保持原样**：`brand.png` 与其样式未被改动，浅色深色下都正常显示。

### 5.2 本期专项验收

| 场景 | 预期结果 |
| --- | --- |
| 令牌映射逐项核对 | M30 每一行令牌取值与方案「令牌映射」表一致（浅色/深色两列分别核对） |
| 双主题全页面巡检 | 收件箱／内容总览／渠道管理／标签／笔记／设置／添加内容弹窗 在 light 与 dark 下均正常，无缺色、无硬编码色残留 |
| 颜色语义唯一性 | 页面无紫/靛蓝渐变；橙色主按钮每屏至多一处；信号青只出现在状态与容器边缘，不用于正文 |
| 卡片颜色收敛 | 单张内容卡片上的彩色元素由 5~6 处降至 ≤2 处（平台方块 + 优先级信号条），颜色主要落在图形上而非文字胶囊 |
| 主操作识别 | 各视图按「静流」方案 UI 改造后的主操作位置与数量执行（每屏至多一处橙色主操作）；「打开原文」等次级操作为墨色 |
| 轻科幻开关 | 设置 → 外观可切「轻科幻/简洁」，切换即时生效并持久化；关闭后版式不塌陷、无残留发光 |
| 读数条示例标注 | 详情读数条使用假数据时显式标注为示例，界面不得让用户误认为真实采集数据 |
| 动效降级 | 系统开启「减少动态效果」后，持续动画（轨道、呼吸点）与扫描光全部停止，静态样式保留 |
| 动画数量 | 单屏同时持续的动画 ≤2 处 |
| 窄窗与溢出 | 各断点下无横向滚动条，文字不溢出容器 |
| 既有功能回归 | M26–M29 笔记/总结实机脚本、设置页脚本、各视图 smoke 全部通过 |
| Logo | 侧栏 logo 图形与改造前一致（像素级比对 `brand.png` 未被替换，样式未被覆盖） |


## 5.3 M35「静流」完全复刻（2026-10-23 追加）

> 编号：5.2 期已占用 M33／M34，本期为 5.1 期补充，顺延为 M35。

M31/M32 完成后，界面与方案样张仍有两类差距：一是**组件没换**（原生下拉、卡片脚注分三行、
详情面板没有顶图与原文行、分页器没有分隔线），二是**一个真 Bug**（收件箱选中卡片的上边与左边
被滚动容器裁掉）。用户要求的是「完全复刻，不要只改颜色，组件也要替换，对齐」。

本期的判据是**逐条比对方案样张**，不是改几个变量值。范围与结果见
[M35_ZHILIU_REPLICA.md](M35_ZHILIU_REPLICA.md)。

### 交付内容

| 类别 | 内容 |
| --- | --- |
| Bug 修复 | BUG-119：收件箱选中卡片边缘被遮挡（滚动容器裁掉外发光环与取景框角标） |
| 组件替换 | 卡片重排（grid 96px 缩略图列 / 标题 14.5px / 脚注合并成一行 / 复选框移到右上角）、无框下拉（`ui.dropdown`）、详情顶图 + 取景框 + 等宽读数、原文链接行、四段优先级控件、`.pager`、`.filters__sep`、侧栏 34px 导航度量、顶栏同步状态胶囊、页头 26px 标题 |
| 新增验收 | `scripts/m33-zhiliu-renderer.cjs`（**用几何量断言选中态不被裁**，不靠肉眼） |
| 顺带修掉 | 渠道表格创作者名被「打开主页」按钮压住（平台列并入名称列后列宽没跟着改） |
| 测试维护 | BUG-120：设置页导航分区断言已过时（在干净基线 `a2505fe` 上可复现，与本期无关）；`tags-smoke` / `intake-renderer` / `v049-batch01` / `v049-batch02` / `m27` / `github-ui-smoke` 的断言按新组件形态改写，检验意图不变 |

### 与方案的有意偏差（逐条记明，不留误导性元素）

- 「按日历时间排列」在方案里是 ghost 按钮，但产品没有排序能力——保留为一行弱化文字，不做能点的假按钮；
- 方案里的快捷键提示（`J / K`、`N`、`⌘S`）本期未实现，按方案 §6 的要求不出现；
- 详情读数条仍是假数据并带「示例数据」标记，真实取数归 5.2 期；
- 卡片脚注只放得下一个标签，其余收成「首标签 +N」（方案 `.tag.more` 的做法），完整标签在详情里看。

### 方法：不再是「按感觉改样式」

M31/M32 只做到七成像，根因是**没有可比对的基准**。本期换成可核对的三步：

1. 把参考页的 CSS **整条**移植进产品（`styles/zhiliu.css` 由 `scripts/m35-build-zhiliu-css.cjs`
   从 `zhiliu-visual-style.html` 生成，只把演示类名换成产品真实类名，规则与取值不动）；
2. `scripts/m35-strip-conflicts.cjs` 按参考页**实际声明了哪些属性**，
   清掉产品旧规则里多出来的视觉声明，让它们重新继承；
3. `scripts/m35-style-probe.cjs` + `scripts/m35-style-parity.cjs`：
   参考页与产品实机逐选择器逐属性对拍，差多少报多少。

当前对拍结果：**13334 个属性，1032 处差异**；收件箱 108，其余五页 147～195。
剩余差异集中在**产品 DOM 与参考页组件骨架不同**（笔记／总览／渠道／标签四个页面的
面板、看板列、统计卡、表格单元格还是产品自己的结构），
已逐条列在 [M35_ZHILIU_REPLICA.md](M35_ZHILIU_REPLICA.md) §5.5，是可逐条消除的清单。

### 验证

Node 142/142；Python 439/439；`renderer-smoke` 全段通过；`m35-zhiliu-renderer` 专项断言全通过；
`m26`～`m29`、`m32-fx`、`settings-renderer`、`v049-batch01/02/03` 实机脚本通过。
截图证据：[verification/phase51/m35/](verification/phase51/m35/)。

## 6. 风险与提醒

1. **不要把演示页 CSS 直接搬进产品**：「静流」HTML 是一份独立演示页，其类名（`.card`/`.pf`/`.sig`/`.sheet`/`.hero`）与产品真实类名不同（`.plat`/`.pill--high`/`.shell__body`/无 hero）。照抄选择器会得到「看起来改了、实际没生效」的假改造。令牌可直接替换，组件必须按产品真实类名重写。
2. **logo 是硬约束**：`brand.png` 与 `.brand__logo` 不得被替换或覆盖。轻科幻的轨道弧若实现，只能加在 `.brand__mark` 的外层容器，不改图片本体。
3. **样式体量已大**：`views.css` 与 `components.css` 合计超 90KB，继续堆叠会加剧维护成本。M31 应优先替换既有规则，而不是追加覆盖层。
4. **深色覆盖分散**：令牌未完全覆盖平台色等场景，`components.css` 内仍有零散深色规则。统一主题时需逐处核查，避免只改亮色。
5. **断点不统一**：多套断点值散落各文件，改动布局时容易顾此失彼。本期沿用现有断点，不做断点体系收敛（避免与视觉重构混在一起）。
6. **刷新语义易被破坏**：界面层重排容易顺手改到 `invalidate`／`renderView` 链路，造成内容闪烁或草稿丢失。改动应与刷新链路解耦。
7. **颜色语义不可偷懒**：「每种颜色只有一个含义」是本方案的核心原则。若某处仍显示旧的粉色文字胶囊、蓝色主按钮，说明改造没做透，不能记为完成。
8. **不能只凭预览验收**：方案 HTML 里好看不等于应用内正确。验收须走正式 Renderer 实机脚本并留截图证据。
9. **快捷键与读数是陷阱**：方案清单里的 `.kbd` 快捷键提示与详情读数条都依赖尚未实现的功能。本期不做快捷键，也不能留有暗示它们可用的界面元素。详情读数条按用户决定先用**假数据**搭出版式并显式标注「示例数据」，真实取数归 5.2 期。

## 7. 交付记录

> 本节随实施追加，按实际提交与验收结果填写，未验证的一律如实注明。

### 2026-10-22：5.1 期三项模块全部完成

分支 `feature/phase51-visual`，基线 `fb66b94`（codex 已将 main 合并进 `feature/phase5-notes`）。
**未合并 main、未打包、未推送、未发布**；版本号仍为 0.4.9。

| 模块 | 提交 | 说明 |
| --- | --- | --- |
| M30 设计令牌重构 | `ed36d50` | `tokens.css` 按方案映射表全量替换（浅色+深色），新增 21 个变量 |
| M31 界面样式重构 | `347246b` | 外壳纸面化、主操作橙、卡片颜色收敛、优先级信号条、分段控件 |
| M32 轻科幻层 | `6c6d0bf` | `fx.css` 八项效果 + 设置 → 外观分区 + 详情读数条（假数据） |
| 验收脚本适配 | `61b102e` | 4 处断言按新设计重写，检验意图不变 |
| Bug 记录 | `63cbfa0` | BUG-118：标签 AI 页签两条 M9 旧断言已过时 |

模块说明：[M30_DESIGN_TOKENS.md](M30_DESIGN_TOKENS.md) ·
[M31_UI_REFACTOR.md](M31_UI_REFACTOR.md) · [M32_FX_LAYER.md](M32_FX_LAYER.md)

**验证（均为实际执行）**：Node 142/142；主 Renderer 验收全段通过（含 `tagsSmoke.darkContrast`
深色对比度）；M26／M27／M28／M29 实机脚本全部通过；`v049-batch01-renderer`、
`settings-renderer` 通过；新增 `m32-fx-renderer` 专项验收 13 项断言全部通过。
截图证据：[verification/phase51/m32-fx/](verification/phase51/m32-fx/)。

**修掉的两个真问题**（都属于「静默失败：界面正常、只是不对」）：

1. `app.js` 的 `parseHash` 分区白名单漏了 `appearance`，设置页切不到外观分区；
2. `settings.js` 的 `buildBody` 把外观分区放在 Core 设置的草稿门控之后，
   该分区不依赖本地数据，结果永远卡在「正在读取设置」。

**本期未做**（见 §4.1 与 §4.2）：快捷键绑定、详情读数的真实取数（归 5.2 期）、
断点体系收敛、采集与 Core RPC 改动、打包与发布。

### 2026-10-23：M35「静流」完全复刻

**未合并 main、未打包、未推送、未发布**；版本号仍为 0.4.9。

| 模块 | 说明 |
| --- | --- |
| M35 组件替换与收件箱选中态修复 | 见 [M35_ZHILIU_REPLICA.md](M35_ZHILIU_REPLICA.md)；BUG-119 为真 Bug（几何断言复现并验证） |
| 验收脚本 | 新增 `scripts/m33-zhiliu-renderer.cjs`；`tags-smoke` / `intake-renderer` / `v049-batch01` / `v049-batch02` / `m27` / `github-ui-smoke` 断言按新组件形态改写 |
| Bug 记录 | BUG-119（收件箱选中卡片边缘被遮挡）、BUG-120（设置页分区断言已过时，在 `a2505fe` 上即可复现） |

**验证**：Node 142/142；`renderer-smoke` 全段通过；`m35-zhiliu-renderer` 专项断言全通过；
`m26`～`m29`、`m32-fx`、`settings-renderer`、`v049-batch01/02/03` 实机脚本通过。
截图证据：[verification/phase51/m35/](verification/phase51/m35/)。
