# M30 设计令牌重构：「静流」轻科幻体系

日期：2026-10-22（Asia/Tokyo）
基线：`fb66b94`（codex 已将 main 合并进 feature/phase5-notes）
提交：`ed36d50` feat(m30): 设计令牌重构为「静流」轻科幻体系（双主题）
依据：`/Users/xor/Documents/Subscribe_Call/zhiliu-visual-style.html`（「静流」视觉风格方案）
方案：[DEVELOPMENT_PLAN_PHASE51.md](DEVELOPMENT_PLAN_PHASE51.md) §4

## 1. 做了什么

`electron/renderer/styles/tokens.css` 全量替换为「静流」的取值，变量名保持不变。
按方案的「令牌映射」表逐项对照，浅色与深色两列**全部一致**。

### 颜色语义（方案的核心原则：每种颜色只有一个含义）

| 角色 | 变量 | 浅色 | 深色 |
| --- | --- | --- | --- |
| 主操作 / 品牌 | `--c-action` / `--c-orange` | `#d63f00` / `#ff4f00` | `#ff5c1a` / `#ff4f00` |
| 选中·当前·焦点 | `--c-brand` | `#007fa8` | `#2ad0f2` |
| 青色文字 | `--c-brand-ink`（新增） | `#00698b` | `#7fe4fa` |
| 信号青（仅线条与圆点） | `--c-signal`（新增） | `#00b2dc` | `#3fe0ff` |
| 次级重要操作 | `--c-ink`（新增） | `#18181b` | `#ededf0` |
| 中性底 | `--c-bg` | `#eceef0` | `#0a0b0c` |
| 主区域纸面 | `--c-sheet`（新增） | `#fafbfb` | `#101214` |
| 高优先级 | `--c-high` | `#d81f45` | `#ff4d6d` |
| 中优先级 | `--c-mid` | `#c98a00` | `#ffc53d` |
| 低优先级 | `--c-low` | `#13945f` | `#3fd68f` |

要点：

- 品牌色由蓝 `#2563eb` 改为青 `#007fa8` —— 青色留给「选中 / 当前 / 焦点」；
- 告警三色改红偏玫红、琥珀偏黄，与主操作橙拉开色相，不会混；
- 中性底改铝灰／座舱黑，不带蓝紫偏色，让信号色更跳；
- 边框统一改为半透明（`rgba(20,24,32,.08)` / `rgba(255,255,255,.08)`）。

### 新增变量（21 个）

`--c-brand-ink`、`--c-brand-ring`、`--c-action`、`--c-action-hover`、`--c-on-action`、
`--c-orange`、`--c-ink`、`--c-ink-hover`、`--c-on-ink`、`--c-sheet`、
`--c-signal`、`--c-signal-ring`、`--line-signal`、`--c-grid-dot`、
`--glow-brand`、`--glow-action`、`--sh-card`、`--sh-card-hover`、`--sh-sheet`、
`--sh-pop`、`--sh-inset`、`--font-mono`

### 圆角与阴影

- 圆角整体加大一档：`4/6/8/12/16` → `6/8/10/14/18`（同心圆角体系）。
- 阴影改「用阴影画边框」：新增 `--sh-card` / `--sh-card-hover` / `--sh-sheet` /
  `--sh-pop` / `--sh-inset`，悬停时只换阴影，不换边框。

## 2. 兼容处理

- **不删任何既有变量名**：旧变量 `--sh-2/3/4`、`--c-*-bg-2`、`--c-text-inverse` 等全部保留，
  新语义用新变量承载，避免打断现有 `var(--c-*)` 引用。
- 全量核对 91 处令牌引用，无缺失定义。唯四 4 个「未定义」是运行时由 JS 注入的局部变量
  （`--banner-color`、`--row-color`、`--tags-editor-w`、`--tip-shift`），均带 fallback 值，
  与本次改造无关。
- 旧色值残留核查：全库仅 `views.css` 的 `.preview-bar select option` 一处（原生 option
  不继承主题），已改为浅色主题正文色 `#15171a`。

## 3. 验证

- 令牌映射逐项比对：浅色 20 项、深色 32 项**全部一致**（脚本核对，非人工目测）；
- 新增变量在浅色与深色下均存在；
- 令牌引用完整性：91 处引用无缺失；
- 语法与既有验收全部通过（Node 142 项、主 Renderer 验收、M26–M29 实机脚本）。

## 4. 未做

- 组件层的类名适配不在本模块，属 [M31_UI_REFACTOR.md](M31_UI_REFACTOR.md)；
- 轻科幻效果本身属 [M32_FX_LAYER.md](M32_FX_LAYER.md)；
- 标签色板 11 档按方案要求保持不变。
