# M32 轻科幻层：点阵、极光线、扫描光、读数条与在线呼吸点

日期：2026-10-22（Asia/Tokyo）
基线：`347246b`（M31 界面样式）
提交：`6c6d0bf` feat(m32): 轻科幻层
依据：`zhiliu-visual-style.html` §「轻科幻层」
方案：[DEVELOPMENT_PLAN_PHASE51.md](DEVELOPMENT_PLAN_PHASE51.md) §4

## 1. 结构

新增 `electron/renderer/styles/fx.css`，在 `index.html` 里**最后加载**。
全部规则挂在 `[data-fx="on"]` 下 —— 关闭效果即回到同一套令牌的基础风格，
版式不受影响（需要的新增结构在关闭时都是 `display:none`）。

开关写在 `<html data-fx>`，值 `on` / `off`，持久化在 `localStorage` 的 `sf.fx`。

## 2. 已落地的八项效果

| 效果 | 实现 | 说明 |
| --- | --- | --- |
| 点阵坐标纸 | `.app::before` + `radial-gradient` | 18px 点阵铺在应用底色上，从上往下渐隐；纸面内部不铺，正文背景保持干净 |
| 极光细线 | `.workspace::before` + `--line-signal` | 纸面顶边 1px 信号青细线，两端渐隐 |
| 扫描光 | `.workspace.is-scanning .fx-sweep` | 后台刷新时纸面顶边扫过一道光，代替转圈的加载图标 |
| 取景框角标 | `.content-card.is-selected::after` | 选中卡片四角的 L 形角标，比描边更强的选中提示 |
| 在线呼吸点 | `.fx-online` | 顶栏连接状态点：正常信号青呼吸，异常静止琥珀／玫红（不闪烁，避免焦虑） |
| 轨道弧 | `.brand__mark::after` | logo 外一圈 9 秒一圈的转动弧；**logo 图形本身保持原样** |
| 深色辉光 | `--glow-brand` / `--glow-action` | 仅深色下：优先级信号条与橙色主按钮微弱辉光，浅色不发光 |
| 焦点散光 | `:focus-visible` | 青色描边外再加一层散光 |

## 3. 遵守方案的使用边界

方案原文列的四条边界，逐条落地：

1. **只作用于状态和容器边缘**，不进入标题、摘要、正文 —— 全部规则挂在
   状态类（`.is-selected` / `:focus-visible` / `.is-on`）与容器（`.app` / `.workspace` /
   `.dialog`）上，没有一条改标题或正文的排版。
2. **信号青不用于文字和大面积底色** —— `--c-signal` 只出现在线条、描边、状态点；
   全页没有变色渐变、没有紫／靛蓝渐变。
3. **一屏内持续动画最多两处** —— logo 轨道（`fx-spin`）与在线呼吸点（`fx-ping`）；
   扫描光（`fx-sweep`）只在刷新时触发一次。验收脚本会实测并断言这一点。
4. **`prefers-reduced-motion: reduce` 时全部动画停用**，静态样式保留 ——
   `fx.css` 末尾统一 `animation: none !important; transition: none !important`。

## 4. 设置 → 外观分区

新增分区（纯前端，不进 Core 设置）：

- **界面效果**：轻科幻 / 简洁 开关，切换即时生效并写入 `localStorage`；
- **主题**：浅色 / 深色 切换。

两处与既有机制的区别，都在代码里写明：

- 外观分区**不读 Core、不用草稿**：`buildBody` 里把它提到 `cache.draft` 门控之前，
  否则本地读取慢或失败时这一页会永远卡在「正在读取设置」——而它本来就不依赖本地数据；
- 外观分区**不显示底部保存条**：留一个永远点不动的橙色主按钮会误导用户，
  也违反「每屏至多一处橙色主操作」；
- `isDirty('appearance')` 显式返回 `false`：不排除的话会掉到 AI 分支去比较连接，
  得出错误的脏标记，离开设置页时误报「有未保存的修改」。

## 5. 详情读数条（本期用假数据）

方案 §8 的读数条在本期落地版式与信息密度，但**数据是假的**：

- 三个字段：收录时间、详情完整度、AI 打标结果，用等宽字体排成一行；
- **显式标注「示例数据」**（`.fx-readout__demo` 徽标），不让用户误以为是真实采集数据；
- 字段值固定，不随内容变化。

真实取数（`contents.first_seen_at`、`acquisition_complete`、`tagging_tasks.state` /
`applied_count`）归 **5.2 期**，届时替换假数据，无数据的字段隐藏、不显示占位。

## 6. 验证

新增 `scripts/m32-fx-renderer.cjs`（走正式 Renderer + 正式 Core，不触网、不写业务数据），
逐项断言：

| 断言 | 结果 |
| --- | --- |
| `<html data-fx="on">` 默认开启 | 通过 |
| `fx.css` 确实被页面加载 | 通过 |
| 卡片有平台色方块与信号条 | 通过 |
| 卡片元信息里不再有彩色优先级文字胶囊 | 通过 |
| URL 行默认 `opacity: 0`（悬停才出现） | 通过 |
| 深色主题切换 | 通过 |
| 读数条存在、等宽、**带「示例」标注** | 通过 |
| 外观分区有开关、无保存条 | 通过 |
| 关闭效果后 `<html data-fx="off">`，纸面结构不塌、圆角仍在、仍有宽度 | 通过 |
| 开关状态写入 `localStorage` | 通过 |
| `fx.css` 含 `prefers-reduced-motion` 降级规则 | 通过 |
| 一屏内持续动画 ≤ 2 处 | 通过 |
| logo 仍是 `brand.png`（图形未被替换） | 通过 |

截图证据：[verification/phase51/m32-fx/](verification/phase51/m32-fx/)
（`01-inbox-light-fx` / `02-inbox-dark-fx` / `03-detail-readout-dark` /
`04-settings-appearance` / `05-inbox-fx-off`）

回归：Node 142/142；主 Renderer 验收全段通过；M26–M29 实机脚本、
`v049-batch01`、`settings-renderer` 全部通过。

## 7. 修掉的两个真问题

1. **`parseHash` 的分区白名单漏了 `appearance`**（app.js）—— 设置页路由只认
   ai／reminder／priority／summarization，新分区被静默回落成 ai，
   「切到外观」点不动。静默失败：界面正常、只是不对。
2. **外观分区被 Core 设置的加载门控挡住**（settings.js）—— 见 §4。

两处都是「接线看起来完成了，实际不生效」的类型：不报错、不崩溃，只是少做一件事。
