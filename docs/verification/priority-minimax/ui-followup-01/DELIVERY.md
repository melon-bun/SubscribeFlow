# ui-followup-01 交付说明：优先级设置分区间距 + 渠道工具栏与表格间距

日期：2026-10-25（Asia/Tokyo）
范围：`Subscribe_Flow`（main，直接实施）
依据：用户 2026-10-25 的两项明确界面反馈（优先级设置页三块贴太紧；渠道管理搜索／重新查询行与下方表格贴太紧）。

> 第 2 项「LLM 测试返回不允许调用此方法」由 Codex 自行调查修复（提交 `6a726bc`）。
> 本批**没有**触碰 AI 桥接、Preload 或相关测试，也没有改功能、文案、导航或其他页面。
>
> 本文件只记录本批做了什么、证据在哪。最终验收结论由 Codex 独立复验给出。

## 交付提交

| 提交 | 内容 |
| --- | --- |
| `（本批提交）` | 两处垂直间距修复 ＋ 实机测量脚本 ＋ 前后对照截图与测量数据 |

## 一、问题定位（修改前的实测基线）

在正式 Renderer（Electron 真进程 ＋ 真实 Core）里量真实渲染结果，**不是量样式表**：

| 位置 | 修改前实测 | 间距来源 |
| --- | --- | --- |
| 优先级设置：三块卡片之间 | **0px**（两处都是） | 父容器 `DIV.`（无类名）`display:block`，三块是普通块级兄弟，之间没有任何间距 |
| 渠道管理：工具栏 → 表格 | **0px** | 父容器 `DIV.`（无类名）`display:block`；工具栏与表格同在这个容器里 |

浅色／深色／紧凑窗口三种条件下，两处都是 0px。基线截图见 [before/](before/)。

### 关键发现：改外层 gap 不起作用

渠道页的 `.channels-content` 上写了内联 `gap:20px`，但它同时被 `views.css` 里的
`.channels-content { display: block; }` 覆盖成 **block** 布局——`gap` 对块级容器无效。
真正生效的是 `.channels-content > * + * { margin-top: 20px; }`，而工具栏与表格
**不是** `.channels-content` 的直接子元素（它们同在一个中间容器里），
所以那条 margin 也管不到它们之间。这与用户指出的「不能只改外层 gap 而实际无效」一致。

设置页同理：`.settings__body` 是 flex 列容器、gap 为 16px，但优先级分区把三块
包在一个**没有类名的普通 div** 里，于是 `.settings__body` 的 gap 只作用在
「提示条 ↔ 那个 div」之间，三块之间依然是 0。

## 二、修复（只改这两处）

### 2.1 优先级设置页：三块之间 20px

`electron/renderer/scripts/views/settings.js` —— `buildPriority` 的外层容器从
无类名的 `div` 换成 `div.setting-group`（只改类名，DOM 结构与内容不变）。

`electron/renderer/styles/settings.css` —— 新增一条规则：

```css
/* M44：优先级设置的三块各自是一张白色卡片，卡片之间要留出清晰的垂直间距，
   不能让两张卡片的圆角直接贴住。间距沿用设置页自己的纵向节奏（--s-7＝20px）。 */
.setting-group {
  display: flex;
  flex-direction: column;
  gap: var(--s-7);
}
```

取值依据：`--s-7` = 20px，是既有设计 token，也是**设置页自己的纵向节奏**
（`.settings__body` 的上内边距与 `.setting-block` 的内边距都是 `--s-7`），
落在用户建议的 20–24px 区间内。没有引入新数值，也没有动 `.setting-stack`
（AI 连接页在用，gap 12px）与其它设置页。

### 2.2 渠道管理：工具栏与表格之间 20px

`electron/renderer/scripts/views/channels.js` —— 渠道列表那一组的容器加上类名
`channels__list`（载入态／空态／正常态三处都加，保持一致）。

`electron/renderer/styles/views.css` —— 新增一条规则：

```css
/* M44：渠道列表这一组里，工具栏（搜索／重新查询）与下方表格是同组的两块。
   外层 .channels-content 的间距管不到它们之间——两者同在一个容器内，
   间距得由组内排布给出，否则工具栏会直接贴住表格上沿。
   数值沿用渠道页自己的纵向节奏（20px，与该页分区间距一致）。 */
.channels__list > * + * {
  margin-top: var(--s-7);
}
```

取值依据：`var(--s-7)` = 20px，与该页已有的 `.channels-content > * + * { margin-top: 20px }`
同值，沿用渠道页自己的纵向节奏。

**为什么用 `> * + *` 的 margin 而不是把容器改成 flex**：
`.channels__table-wrap` 上有 `flex: 1`（原本因为父容器是 block 而不生效）。
一旦把容器改成 flex 列，这块表格会拿到 `flex-basis:0`，
在高度由内容决定的容器里可能被压成 0 高。用 margin 不引入这个副作用，
同时与本文件既有的 `> * + *` 写法一致。

### 2.3 生成样式源

本次改的两个文件（`styles/settings.css`、`styles/views.css`）都是**手写源文件**，
不是生成产物：由 `scripts/m35-build-zhiliu-css.cjs` 生成的只有 `styles/zhiliu.css`
与 `styles/fx.css`。已确认生成层里没有任何 `.setting-block`／`.setting-group`／
`.setting-stack`／`.channels__toolbar`／`.channels__list`／`.channels__table` 规则
（`zhiliu.css` 后加载，若有同名规则会覆盖手写层），因此无需改生成源或映射，
也没有只改产物的情况。

参考稿 `zhiliu-visual-style.html`（仓库外）没有设置页样张；其「渠道管理 · 列表」把
工具栏放在 `.panel` 的 `.panel-head` 里，与产品把工具栏放在表格面板**外面**的结构不同，
没有对应的可同步规则。本次未扩大页面设计，参考稿未改动。

## 三、实测结果（正式 Renderer，量真实渲染结果）

| 位置 | 修改前 | 修改后 | 间距来源（修改后） |
| --- | --- | --- | --- |
| 设置页 智能判断 → 来源默认优先级 | 0px | **20px** | 父容器 `DIV.setting-group`，`display:flex`，`gap:20px` |
| 设置页 来源默认优先级 → 三个优先级的名称 | 0px | **20px** | 同上 |
| 渠道 工具栏 → 表格 | 0px | **20px** | `DIV.channels__list` 内 `margin-top:20px` |

浅色／深色／紧凑窗口（900×620）三种条件下的测量值完全一致：

| 上下文 | 设置页两处间距 | 渠道工具栏→表格 |
| --- | --- | --- |
| 浅色 1440×1000 | 20px / 20px | 20px |
| 深色 1440×1000 | 20px / 20px | 20px |
| 紧凑 900×620 | 20px / 20px | 20px |

原始测量数据：[before/spacing.json](before/spacing.json)、[after/spacing.json](after/spacing.json)。

紧凑窗口下另外确认：设置页无横向越界，「保存设置」按钮在视口内可达；
渠道页表格仍在自己的容器里横向滚动，页面本身没有被撑宽。

## 四、证据

### 4.1 截图（修改前 6 张 ＋ 修改后 6 张，同一台机器、同一拍摄条件）

| | 修改前 | 修改后 |
| --- | --- | --- |
| 设置页 · 浅色 | [before/01-settings-priority-light.png](before/01-settings-priority-light.png) | [after/01-settings-priority-light.png](after/01-settings-priority-light.png) |
| 设置页 · 深色 | [before/02-settings-priority-dark.png](before/02-settings-priority-dark.png) | [after/02-settings-priority-dark.png](after/02-settings-priority-dark.png) |
| 设置页 · 紧凑 | [before/03-settings-priority-compact.png](before/03-settings-priority-compact.png) | [after/03-settings-priority-compact.png](after/03-settings-priority-compact.png) |
| 渠道页 · 浅色 | [before/04-channels-toolbar-light.png](before/04-channels-toolbar-light.png) | [after/04-channels-toolbar-light.png](after/04-channels-toolbar-light.png) |
| 渠道页 · 深色 | [before/05-channels-toolbar-dark.png](before/05-channels-toolbar-dark.png) | [after/05-channels-toolbar-dark.png](after/05-channels-toolbar-dark.png) |
| 渠道页 · 紧凑 | [before/06-channels-toolbar-compact.png](before/06-channels-toolbar-compact.png) | [after/06-channels-toolbar-compact.png](after/06-channels-toolbar-compact.png) |

基线截图是把源文件改动**临时 stash 掉**后用同一个脚本重拍的，
两组因此可以直接对比，不是不同条件下的两批图。

> 拍摄脚本里换主题后会强制 invalidate 并多等一拍：直接切 `data-theme` 后立刻截图，
> `capturePage` 可能抓到只刷了一层的中间帧（按钮仍是浅色、标题发灰）——
> 那是采集残留，不是真实深色样式。前后两组都用了修正后的拍摄条件。

### 4.2 测量脚本

`scripts/ui-followup-spacing.cjs`（新增，仓库内）：
走正式 Renderer ＋ 正式 Core，只导航、测量、截图，不保存设置、不改业务数据、不触网。

- 数据目录：把真实库的 `sqlite3` **复制**到临时目录再启动（只读来源），
  日常数据库、凭据与登录态都不碰；跑完删除临时目录。
- 量的是 `getBoundingClientRect()` 的真实渲染结果，同时记录间距的来源
  （父容器 display／gap、相邻元素的 margin），以便确认「这个间距是谁给的」。
- npm 脚本：`npm run smoke:spacing`（输出目录用 `SUBSCRIBE_FLOW_VERIFY_OUTPUT` 指定）。

### 4.3 回归

| 命令 | 结果 |
| --- | --- |
| `npm test` | `tests 150 / pass 150 / fail 0` |
| `npm run smoke:renderer` | 全部 passed：`intakeDateRenderer`／`rendererRaces`／`listStateSmoke`／`prioritySmoke`／`priorityBridgeSmoke`／`calendarSmoke`／`tagsSmoke`／`rendererSmoke` |
| `npm run smoke:settings` | `settingsSmoke: passed`（分区含「优先级设置」，三块断言仍成立） |
| `npm run smoke:reminder` | `reminderPersistence: passed` |
| `npm run smoke:refresh:views` | `refreshViews`／`overviewRefresh`／标签刷新 均 passed |

原始输出见 [node-tests.log](node-tests.log)、[smoke-renderer.log](smoke-renderer.log)、
[smoke-settings.log](smoke-settings.log)、[smoke-reminder.log](smoke-reminder.log)。

> Node 是 150 项（原 149 项 ＋ Codex 本轮新增的 1 项 AI 桥接回归），本批未改任何 Node 测试。

## 五、未做范围与已知事项

- **没有改功能、文案、导航或其它页面**。AI 连接页的 `.setting-stack`（gap 12px）、
  提醒设置页、AI 总结页、外观页一概未动。
- **没有为这次低风险布局改动新增镜像单元测试**（按要求）；改动的正确性由上面的实机测量与截图承担。
- **没有改生成源／映射**：本次改的两个样式文件不是生成产物（见 §2.3）。
- **没有调用真实 API**（第 2 项由 Codex 负责）。
- **一条既有的噪音（不是本批引入，也没有修）**：
  `npm run smoke:refresh:views` 会打印一行
  `Uncaught (in promise) TypeError: app.client.getPriorityStatus is not a function`。
  原因是该刷新冒烟用的是**桩 client**（`scripts/refresh-inbox-channels-smoke.cjs` 的
  `client` 对象只实现了 8 个方法），而收件箱视图在 batch-03 的 `b7bfe23` 起就会调用
  `app.client.getPriorityStatus()`；桩 client 当时没有跟着补。该冒烟本身仍然 passed。
  已核实：`git log -S` 显示该调用由 `b7bfe23` 引入，本批改动**没有触碰**
  `views/inbox.js` 与该冒烟脚本（相关路径 0 个文件变动）。
  属既有测试桩落后于产品契约，不阻塞本批，也不在本批范围内，留给 Codex 判断。
- 未打包、未推送、未发布；未改动用户日常数据库、配置、凭据与登录态。

## 六、待 Codex 验收

本批已交付：两处垂直间距的最小修复、前后对照的实机测量数据与 12 张截图、
以及相关回归结果。**最终验收结论由 Codex 独立复验给出**，本文件不代替该结论。
