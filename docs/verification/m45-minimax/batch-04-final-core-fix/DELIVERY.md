# M45 公众号付费渠道 · 第四批（最终核心返修）交付说明

- 日期：2026-10-25
- 分支：`feature/m45-wxrank-paid-channel`，父提交 `0556b33`
- 触发：Codex 第三批独立审查（`batch-03/CODEX_REVIEW.md`、`batch-03/CODEX_PROBES.json`）
- 范围：**只修两个已复现的实质阻断**（BUG-132 重开、BUG-137），合并一次交付
- 结论：两个阻断都已修掉并有离线回归与一次正式界面验收；**真实付费上游仍未验证**（本机无授权密钥），
  **不声称 M45 全部验收通过**。

---

## 1. 最小变更

### 1.1 BUG-132（重开）：刷新不得回退更深的有效历史检查点

| | 修前 | 修后 |
| --- | --- | --- |
| 规则 | 任何一次成功提交的页都推进检查点 | **回溯每次推进；刷新只在没有有效检查点时建立起点** |
| 代码位置 | `storage/repositories.py::_write_channel_checkpoint` | 同文件，增加按任务种类分支 |

- 「有效」＝同密钥版本、同解析／进展版本、没过期。已有有效检查点就保留它——
  那说明历史走到了更深处，刷新不该把它退回去。
- **游标是不透明的**：不靠字符串比深浅，只判断「有没有有效检查点」。
- 过期／换密钥的检查点照旧作废：从头重扫，不假称续采。
- 仍然与页数据**同一事务**提交，不影响其它渠道。

复现序列（Codex 采集条数10）：修前请求游标 `None → page-2 → None → page-2`
（page-3 被退回 page-2，重买 page-2 且 0 新增）；修后 `None → page-2 → None → page-3`。

### 1.2 BUG-137：付费页整页保存，不丢已付费条目

选的是**最小且清楚**的产品语义：**付费页按整页保存**。

| | 修前 | 修后 |
| --- | --- | --- |
| 16 条宽页（两次推送各 8 篇）配采集条数 10 | 引擎二次裁剪成 10 条，清空 `next_cursor`／检查点 | **整页 16 条全部落库**，检查点正常推进 |
| 下一轮回溯 | 又从头买，0 新增，余 6 条永远拿不到 | 从检查点续采，**新增 16 条** |
| 采集条数含义 | 硬性条数上限 | **折算扫描页数的窗口**（0／10／30／50 → 3／1／3／5 页） |
| 调用页数／费用 | — | **不越界**（页数仍由同一预算推导函数决定） |

- 代码位置：`application/sync.py::_limit_page_items` 增加 `atomic=descriptor.paid`
  （只对付费渠道跳过裁剪，其它渠道语义不变）。
- 理由：一次付费调用买下的是一整页，裁掉余量等于白花钱，而且余量拿不回来
  （下次只能重买头页，采到的还是那几篇）。严格条数上限需要持久化页余量并能续采，
  代价与复杂度都明显更大；按用户口径取最小方案。
- 必要说明（一句）：渠道卡片限制说明（Core 下发）、刷新／回溯确认框、
  采集条数对话框与 toast、方案 §5.1 与 W45-08/09。

| 文件 | 改动 |
| --- | --- |
| `python/src/subscribe_flow/storage/repositories.py` | 检查点推进规则按任务种类分支 + 有效性判断 |
| `python/src/subscribe_flow/application/sync.py` | 付费渠道不按条数裁剪已购页面 |
| `python/src/subscribe_flow/application/paid_channels.py` | 渠道限制说明加一句整页采集语义 |
| `electron/renderer/scripts/views/channels.js` | 确认框与采集条数对话框的 wxrank 专用文案 |
| `python/tests/test_wxrank.py` | 新增 5 项回归 + 16 条宽页假传输 |
| `docs/M45_WXRANK_PAID_CHANNEL.md` | 方案 §5.1 与 W45-08/09 写清整页语义 |

## 2. 必要测试与真实结果

```
cd python && PYTHONPATH=src python3 -m unittest tests.test_wxrank
→ Ran 80 tests … OK        （修前 75 项；新增 5 项）

cd python && PYTHONPATH=src python3 -m unittest tests.test_wxrank tests.test_application tests.test_storage
→ Ran 104 tests … OK

cd Subscribe_Flow && npm run smoke:wxrank:real
→ {"wxrankUi":"passed","upstream":"local-http (真实响应形状，非真实付费上游)",
   "calls":4,"confirmedCredits":20,"contents":30,"checkpointAfterBackfill":"resume"}
```

新增回归（5 项）：

| 回归 | 断言 |
| --- | --- |
| `test_a_refresh_does_not_regress_a_deeper_backfill_checkpoint` | 两页回溯到 page-3 → 刷新后仍是 page-3 → 下一次回溯请求 page-3 且有新条目；请求序列 `None → page-2 → None → page-3` |
| `test_the_first_refresh_may_establish_the_backfill_starting_point` | 没有历史进度时刷新仍建立起点（page-2），随后的回溯接着 page-2 |
| `test_the_whole_paid_page_is_saved_with_its_sub_articles` | 16 条宽页整页保存（头条与第 8 篇副条都在）、只发一次调用、检查点推进到 page-2 |
| `test_the_next_backfill_continues_instead_of_buying_the_head_again` | 续采请求 page-2（不重买头页）、新增 16 条、累计 32 条、检查点 page-3 |
| `test_the_wide_page_progress_survives_a_restart` | 重启后仍从 page-2 续采，新增 16 条 |

**回归有效性对照**：把这 5 项在去掉两处修复后重跑（`git stash` 对照），
`page-3` 退回 `page-2`、宽页只存 10 条、续采又从头买——**修前是红的**，
不是写出来自绿的测试。

**正式界面验收**（一次，Renderer→Preload→Main→Core→真实传输层→本机真实 HTTP 上游）：
4 次调用／20 积分／30 条内容／检查点 `resume`；刷新确认框已显示
「按整页采集：一次调用买下一整页，实际保存条数可能多于设定的采集条数。」
截图与证据在 `batch-04-final-core-fix/screenshots/` 与
`batch-04-final-core-fix/real-wxrank-ui-evidence.json`。

未重复跑整套回归（本轮按要求只跑 wxrank 聚焦套件与引擎／存储定向套件），
也**没有**再次调用真实 LLM、Jev 或任何付费 wxrank 接口。

## 3. 外部阻塞：真实 wxrank 仍未验证

- 本机仍**没有授权的 wxrank 密钥**；该外部阻塞已通知用户，等待凭据文件更新。
- 因此真实 `data.wxrank.com` 的付费流程仍是 **0 次调用、0 真实扣费**。
- 本轮的 local HTTP 验收用的是**响应形状照真实契约复刻**的本机上游，
  **不能**声称真实上游通过。
- 拿到密钥后的补验入口见 `batch-03/DELIVERY.md` 第 8 节（4 次调用 ≈ 20 积分，集中且少量）。

## 4. 非致命问题：仅记录，不派修

- **BUG-134**：公众号来源的「打开主页」按钮已禁用，但视觉上仍像可点。
- **BUG-135**：任务状态条里「新增 N 条」重复出现。
- **BUG-136**：来源的头像与简介不落库（`sources` 表没有这两列，所有渠道通用）。

本轮按用户口径只做实质阻断返修，这三项维持「已记录、未修复」。

## 5. 提交

| 提交 | 内容 |
| --- | --- |
| 本提交 | 产品代码（仓储检查点规则、引擎付费整页、渠道文案、界面文案）、5 项聚焦回归、文档与交付说明 |

**最终 HEAD = 本交付说明所在的提交**，其父提交是 `0556b33`；
`git log --oneline -3` 可直接核对。

未打包、未推送、未发布，版本仍 0.5.2；未改动用户日常数据库、登录态与通知偏好；
未停止其他应用；全部验证都在隔离数据目录与本轮进程里完成。
