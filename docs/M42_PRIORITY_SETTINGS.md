# M42–M43 优先级设置统一保存与界面口径

日期：2026-10-24（Asia/Tokyo）
状态：M42、M43 已实现；BUG-122、BUG-123 同批最小修复已并入。
计划依据：[智能优先级、设置整合与页面间距开发计划](DEVELOPMENT_PLAN_PRIORITY_INTELLIGENCE.md)
前批：[M39–M41 判断、调度与统一口径](M39_PRIORITY_INTELLIGENCE.md)

本批把「优先级名称」扩成「优先级设置」：智能判断、来源默认优先级、三个名称合成
一页、一个草稿、一个保存动作；并让界面对最终优先级的说法跟真实来源一致。
**没有改人工优先级与来源默认值的含义**，也没有改最终优先级的判定口径（M41）。

## 落点

| 模块 | 文件 | 性质 |
| --- | --- | --- |
| M42 | `python/src/subscribe_flow/application/settings.py` | 优先级分区接受 `sources`；整份先校验再写；一次事务保存 |
| M42 | `python/src/subscribe_flow/storage/settings.py` | `save()` 支持在同一个事务里执行其它写入 |
| M42 | `python/src/subscribe_flow/storage/repositories.py` | 在给定事务里写来源默认优先级；来源已取消订阅时明确失败 |
| M42 | `python/src/subscribe_flow/bootstrap.py` | 设置服务拿到仓储 |
| M42 | `electron/renderer/scripts/views/settings.js` | 「优先级设置」分区：三块内容、同一草稿、同一保存动作 |
| M42 | `electron/renderer/scripts/views/channels.js` | 移除来源优先级分区与空的切换栏 |
| M42 | `electron/renderer/scripts/views/overview.js` | 「设置来源优先级」入口改指统一设置 |
| M42 | `electron/renderer/scripts/app.js` | 旧路由 `#/channels?tab=priorities` 自动跳统一设置 |
| M43 | `electron/renderer/scripts/views/inbox.js` | 详情「自动判断｜高｜中｜低」；按 origin 显示小字；选中自动时可「重新判断」 |
| M43 | `electron/renderer/scripts/core/catalog.js` | 来源说法的统一文案 |
| M43 | `electron/renderer/scripts/ui/intake-dialog.js` | 自主添加的默认项与详情一致 |

## 几个关键决定

### 1. 一个保存动作 = 一个事务

设置页这一页要同时改三样东西：三级名称（`app_settings`）、智能判断策略
（`app_settings`）、来源默认优先级（`subscriptions.default_priority`）。
前两者本来就在设置存档里，第三者在订阅表里。

做法是：整份 patch **先校验、再写**；写入时让设置存档与来源默认值落在**同一个
SQLite 事务**里（`SettingsStore.save(payload, apply=...)`，`apply` 由仓储提供
SQL）。这样失败时不会留下「名称已保存、只保存了一半来源」的坏状态——那正是用户
最难自己查出来的一种。

逐条写来源（先写第一条成功、第二条失败）不满足这个要求，因此没有采用。

### 2. 来源默认值不进设置存档

它的真身是订阅行。设置存档里只放名称与策略，`sources` 只是这次保存要带上的
一张表。省略 `sources` 就表示不改来源默认值。

### 3. 来源在草稿期间被取消订阅 → 明确失败

用户在设置页编辑期间，另一个入口取消了这个来源的订阅。此时保存要**明确失败**
（`INVALID_INPUT`，scope=`field`，scope_key=`sources.<订阅ID>`），不能静默跳过：
静默跳过会让用户以为保存成功，实际那一行没设上。

检查与写入在同一个事务里完成，避免「检查通过之后、写入之前」被取消的窗口。

### 4. 改名不推进判断语义版本

`priority.smart.revision` 只在开关或所选连接真的变了时前进。改三级显示名
不动它：改名只改显示，不得因此作废在途结果或重跑任务。这一点由
`_smart_fingerprint` 保证，本批补了回归。

### 5. 旧路由留得住

`#/channels?tab=priorities` 是旧书签与旧入口的落点。它现在自动跳到
`#/settings?section=priority`——不删旧路由、不留死链。渠道管理页因此不再有
「优先级设置」分区，也没有那个只剩一个选项的切换栏。

### 6. 界面按真实来源说话，不猜

最终优先级的来源由 Core 算好（`priority_origin`：manual／smart／source／none），
界面照实显示：单独设置／智能判断／跟随来源／未设置。等级相同但来源变了，
小字也要跟着变，因此刷新依据里带上了来源。

### 7. 「自动判断」是兜底语义，不是「每次都调用模型」

详情控件四段：自动判断｜高｜中｜低。选中「自动判断」＝没有单条人工值，
最终优先级按 人工 → 智能判断 → 来源默认值 的顺序兜底。因此文案不承诺总会调用
模型；同时给一个明确的「重新判断」动作（对应 `priority.judge`），让用户想重新
判断时不必去猜。**这个按钮只在智能判断已开启时出现**：没开的时候点了也不会有
结果，与其给一个注定失败的按钮，不如不显示。

批量操作的「恢复自动判断」即清掉单条人工值；自主添加的默认项与详情一致。

## 验证

- Python：`python/tests/test_priority_settings.py`（7 项）覆盖一次保存三块生效、
  来源取消订阅时整体失败且名称不落库、非法来源值先被拒、来源默认值可清空、
  改名不推进 `smart.revision`、来源默认值不进设置存档、重启后仍在。
- Renderer：`scripts/settings-renderer.cjs` 增加「优先级设置」分区的实机断言
  （三块内容都在、取消不写入、保存才生效、没有连接时不能存下开着的智能判断）；
  `scripts/priority-smoke.cjs` 的来源默认值流程改到统一设置页（草稿＋一次保存）。
- 截图与间距测量见 [batch-03 交付说明](verification/priority-minimax/batch-03/DELIVERY.md)。

## 不在��批范围

- 关闭智能判断期间旧版本策略行仍会被写入：SQL 已经拦住生效，这里不再额外做防御重构。
- Jev 的采纳阈值（0.8）不动：那是计划写定的保守值，需要真实用户数据校准。
- 既有总结时序抖动用例不修。
