# batch-03 交付说明：BUG-122/123 最小修复 + M42 设置整合 + M43 界面口径与页头节奏

日期：2026-10-24（Asia/Tokyo）
范围：`Subscribe_Flow`（main，直接实施；未新建分支、未改其它 worktree）
依据：[开发计划 §4、M42–M43](../DEVELOPMENT_PLAN_PRIORITY_INTELLIGENCE.md)、
[batch-02 独立审查](../priority-minimax/batch-02/CODEX_REVIEW.md)、
[BUG_FIXES](../../BUG_FIXES.md) 的 BUG-122／123。

## 交付提交

| 提交 | 内容 |
| --- | --- |
| `9da3815` | **两项最小修复单独提交**：BUG-122 重试预算耗尽判定、BUG-123 在途请求丢失最新有效请求 |
| `（本批模块提交）` | M42 设置整合 + M43 界面口径与页头节奏（含 BUG_FIXES、API、实施说明） |
| `（本文件所在提交）` | 交付证据：DELIVERY.md、test-output.txt、截图与 spacing.json |

## 一、两项已证实阻断的最小修复（9da3815）

只改必要的地方，没有重构队列。

### BUG-122：重试预算耗尽后普通事件仍发额外请求

- **原因**：`_defer` 的终态路径没有把最终次数落库，`enqueue` 的 `attempts >= MAX_ATTEMPTS`
  判断永远不成立。
- **修复**：`PriorityTaskRepository.finish` 增加可选 `attempts` 参数并落库；`_defer` 在预算
  耗尽时把最终次数（3）一起写回。队列据此拒绝普通事件再次排同一条输入；只有用户明确
  「重新判断」（`force=True`）才把次数清零重开。
- **回归**（`test_priority_service.py`）：隔离 Core＋假传输（网络失败），逐轮手动驱动并
  只改测试时钟让退避到期 → 三次后 `state=failed`、`attempts=3`、实际调用 3 次；随后普通
  `request(reason='event')` 返回 `queued=0` 且不再调用；`request(reason='manual', force=True)`
  返回 `queued=1` 并重新产生一次调用、attempts 归 1。

### BUG-123：在途请求期间恢复自动后，新判断请求丢失

- **原因**：`enqueue` 对 `running` 一律返回 False，不保留新请求；`_execute` 检测到输入
  变化只取消旧任务，没有续排当前仍然有效的输入。
- **修复**：`_execute` 在因指纹或版本不一致取消旧请求后调用新增的 `_recheck`，它复用既有
  的资格检查与排队逻辑（`request(..., reason='event')`）。因此人工最终值仍然不调用模型、
  重试预算耗尽的条目不会被普通事件重开、旧响应仍然不落库。取消与续排的顺序是「先落终态
  再续排」，避免再次撞上 running 去重。
- **回归**（重写 `test_a_manual_change_during_the_request_does_not_get_overwritten`）：用
  `threading.Event` 屏障挂起网络响应，**数据库操作全部在事件循环线程**（网络线程只阻塞与
  应答，不碰 SQLite）；断言旧响应没有落库、最新请求被续排（实际发出 2 次调用）、最终落库
  的是第二次响应（high）、来源为 smart、任务终态 succeeded。测试自己停掉 2 秒轮询的后台
  worker 并逐轮手动驱动，避免与后台 worker 抢任务。

> 上一批提到的后台独立审查代理已被取消、没有产出结论，因此本批以 Codex 的 batch-02 审查
> 为准，并另做了上面的实机复核。

## 二、M42：设置整合（主要交付）

### 一页一件事

设置页左栏「优先级名称」改名「优先级设置」，一个分区里三块内容、一个草稿、**一个保存
动作**：智能判断（开关＋所选 AI 连接）、来源默认优先级（全部来源，顶部一条分布条）、
三个优先级的名称。取消丢弃全部，离开时按既有流程提示保存还是放弃。

### 统一校验与单事务保存

- 名称＋策略＋来源默认值**整份先校验再写**。名称非法、来源优先级非法、开启智能判断却
  没有连接，都直接拒绝，此时**一条都不写**。
- 来源默认值在 `subscriptions.default_priority`，名称与策略在 `app_settings`：两者在
  **同一个 SQLite 事务**里写（`SettingsStore.save(payload, apply=...)`，SQL 由仓储提供）。
  不会出现「名称已保存、只保存了一半来源」。
- `sources` 不进设置存档（真身是订阅行）；省略即表示不改来源默认值。
- 来源在草稿期间被取消订阅（status=cancelled）时，保存**明确失败**
  （`INVALID_INPUT`，scope=`field`，scope_key=`sources.<订阅ID>`），不静默跳过。检查与写入
  在同一事务内完成。

### 旧路由与入口

- 渠道管理页移除「优先级设置」分区与那个只剩一个选项的**空切换栏**，只留渠道本身。
- 旧路由 `#/channels?tab=priorities` 自动跳 `#/settings?section=priority`（旧书签、旧入口
  都不失效）。
- 总览页的「设置来源优先级」按钮与看板空列的引导都改指统一设置。
- 改名不推进 `priority.smart.revision`：改名只改显示，不得作废在途结果（回归已覆盖）。
- **没有新增 RPC 方法**：`settings.update` 的 `priority` 分区扩展 `patch`，沿用既有
  Main／preload 白名单 → AppClient → Renderer 链路；`priority.set_source` 仍保留可单独改
  一个来源。

### 验证

- Python：`python/tests/test_priority_settings.py`（7 项）：一次保存三块生效、来源取消订阅
  时整体失败且名称不落库、非法来源值先被拒、来源默认值可清空、改名不推进语义版本、来源
  默认值不进设置存档、重启后仍在。
- Renderer 实机：`scripts/settings-renderer.cjs` 增加「优先级设置」分区断言（三块内容都在、
  取消不写入、保存才生效、没有连接时不能存下开着的智能判断）；`scripts/priority-smoke.cjs`
  的来源默认值流程改到统一设置页（草稿＋一次保存），并继续验证来源继承、人工覆盖、批量与
  完整计数。

## 三、M43：界面口径

- 详情控件改成「自动判断｜高｜中｜低」四段。**「自动」是兜底语义，不承诺每次都调用模型**：
  最终优先级按 人工 → 智能判断 → 来源默认值 的顺序兜底。
- 选中「自动判断」且智能判断已开启时，额外给一个「重新判断」动作（对应 `priority.judge`）。
  没开启时不显示这个按钮：点了也不会有结果，与其给一个注定失败的按钮，不如不显示。
- 小字按内容 DTO 的 `priority_origin` 显示：单独设置／智能判断／跟随来源／未设置。等级
  相同但来源变了也要重画，因此刷新依据里带上了来源（`data-refresh-preserve` 加了 origin）。
- 看板卡片的小字同样按 `priority_origin` 显示，不再由前端按「有没有人工值」猜。
- 批量操作「恢复跟随来源」改「恢复自动判断」；自主添加（收录对话框）的默认项与详情一致。
- 说法集中放在 `SF.catalog.priorityOriginText()`，界面各处不各写一份。

## 四、页头节奏（M43 视觉）

依据现有 `zhiliu-visual-style.html` 与生成源 `scripts/m35-build-zhiliu-css.cjs`。

- 参考页新增一条规则：挂在页面容器下的筛选／分区切换行不再自带外边距（页面容器的 16px
  gap 已经给出这段距离，两处都给会叠成 36px）。类名映射在 `scripts/zhiliu-map.cjs`。
- 生成产物 `styles/zhiliu.css` 重新生成（`fx.css` 重新生成后字节相同，这本身就是确定性
  证据）。
- `styles/views.css`：`.tags-tabbar` 去掉分隔线与已被 `ui.seg` 取代的死规则；`.notes-layout`
  删掉与生成层重复的列宽与列距，只留结构属性。
- `views/tags.js`：分区切换控件（标签列表／AI 自动识别）从单独一行移进**页头右侧动作区**，
  与参考页的位置一致。

**实测间距（正式 Renderer，1440×1000，真实渲染测量，见 [spacing.json](spacing.json)）**：

| 视图 | 第一个工作区 | 实测距离 | 来源 |
| --- | --- | --- | --- |
| 总览 | `.overview__filters` | **16px** | `.view` 的 `gap: 16px`，该行 `margin-top: 0` |
| 渠道 | `.view__body` | **16px** | 同上 |
| 标签 | `.view__body` | **16px** | 同上（切换控件已进页头） |
| 笔记 | `.notes-layout` | **16px** | 同上 |

改前那一处间距有两个来源（`.view` 的 gap 16px ＋ 生成层 `.inbox__toolbar` 的
`margin: 20px 0 16px`），实测叠成 36px／32px；现在只剩一个来源。

浅深主题都成立；紧凑窗口（900×620）下各页仍有可用滚动容器，设置页「保存设置」按钮在视口
内可达（`elementFromPoint` 命中该按钮）。

## 五、另外修掉的一处既有红灯

`npm test` 里 `tests/app-client.test.cjs` 断言「Core 发出的每个事件，主进程都要转发」，
而 M40 新增的 `priority.changed`（重启恢复排队任务时发出）不在主进程转发白名单里，测试
一直失败。补上转发后 148 项全过。这不是本批引入的问题，但它是仓库测试门禁上的红灯，
一行修复就一并做了。

## 六、实际测试命令与结果

```
$ cd Subscribe_Flow/python
$ .venv/bin/python -m unittest discover -s tests -t . -p "test_priority_*.py"   → Ran 111 tests … OK
$ .venv/bin/python -m unittest discover -s tests -t . -p "test_*.py"            → Ran 551 tests … FAILED (failures=1)

$ cd Subscribe_Flow
$ npm test                       → tests 148 / pass 148 / fail 0
$ node scripts/renderer-smoke.cjs        → 全部 passed（intakeDateRenderer / rendererRaces / listStateSmoke /
                                          prioritySmoke / calendarSmoke / tagsSmoke / rendererSmoke）
$ node scripts/settings-renderer.cjs     → settingsSmoke passed（含新增的「优先级设置」断言）
$ SUBSCRIBE_FLOW_VERIFY_OUTPUT=docs/verification/priority-minimax/batch-03 \
  node scripts/ui-shot-renderer.cjs      → 截图 10 张 + spacing.json
```

Python 全量唯一失败是既有的 `test_summary.SummaryDraftTests.test_the_call_runs_off_the_event_loop`
（事件循环时序抖动，基线 `b5fc2f5` 同样失败），与本批无关，不返修。

完整输出见 [test-output.txt](test-output.txt)。

## 七、证据

| 文件 | 内容 |
| --- | --- |
| [test-output.txt](test-output.txt) | Python 聚焦／全量、Node、Renderer 实机的命令与结果 |
| [spacing.json](spacing.json) | 四页页头到第一个工作区的实测间距与来源规则 |
| [05-settings-priority.png](05-settings-priority.png) | 新的「优先级设置」页（智能判断／来源默认优先级／名称，一个保存动作） |
| [00-inbox.png](00-inbox.png) | 详情里的「自动判断｜高｜中｜低」与按来源显示的小字 |
| [03-overview-priority.png](03-overview-priority.png) | 看板：卡片小字按来源显示；「设置来源优先级」入口 |
| [06-tags-list.png](06-tags-list.png) | 标签页：分区切换控件与页头动作对齐 |
| [04-channels-list.png](04-channels-list.png) | 渠道页：空切换栏已移除 |
| [02-overview-calendar.png](02-overview-calendar.png) / [01-notes.png](01-notes.png) | 总览与笔记的页头节奏 |

## 八、未完成范围与非致命限制

- 本批**没有重跑真实模型调用**：本轮真实 API 已由 Codex 双重跑通并留证
  （`batch-02/codex-real-llm-evidence.json`），本批改的是设置与界面口径，没有动推理链
  路；`real-llm-check.py` 仍可复跑。
- 关闭智能判断期间旧版本策略行仍会被写入：SQL 已经拦住生效，这里不再额外做防御重构。
- Jev 采纳阈值（0.8）不改：计划写定的保守值，需要真实用户数据校准。
- 既有总结时序抖动用例不修。
- 收件箱的筛选条仍在 `.view__body` 内，页头到筛选条是 36px（参考页收件箱为 20px）。
  收件箱不在本次四页范围；它的网格用 -10px 负外边距与页头对齐，改全局 margin 会压到
  筛选条上，故未动。
- 发现一处既有映射错误未修：参考页 `.tags-wrap` 映射到产品 `.tags-wrap`，而产品 DOM 用的是
  `.tags-layout`，参考页的标签页两栏规格没有落到产品上（标签编辑列仍是手写的 440px）。
  修它会明显改动标签页布局，超出本次间距范围，只记录不动手。
- 笔记页观感有变化：去重后目录列 244px→300px、列距 20px→12px（参考页取值）。
- **规格源不在版本控制内**：`zhiliu-visual-style.html` 位于工作区根目录
  （`/Users/xor/Documents/Subscribe_Call/`），不在 `Subscribe_Flow` 仓库里，因此本批新增的
  `.filters.page-row { margin: 0; }` 规则（`:683`）无法随仓库提交审阅。仓库内能审到的是
  类名映射（`scripts/zhiliu-map.cjs`）与生成产物（`styles/zhiliu.css`）。这是既有安排
  （M30／M35 同样如此），本批未改变它，但复核者需要直接看那一份 HTML。
- 设置页的来源默认值不在设置存档里，因此这一页每次进入要单独读一次来源列表；草稿与基线
  的对齐已处理（来源先于设置读回时也不会被误判成「有未保存的修改」）。
- 未打包、未推送、未发布；未改动用户日常数据库、配置与登录态。
