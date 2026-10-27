# M45 公众号付费渠道（wxrank）实施说明

2026-10-27 BUG-143 更新：下文保留 M45 历史交付事实；当前修复分支统一为一个公开 `WechatAdapter`、`wechat/electron-session/wechat:default`，付费列表与页面收录为内部实现。供应商配置／账本仍用 wxrank，业务来源／文章键不再使用 wxrank。v16 升级与单渠道联合验收以 [BUG-143](BUG_FIXES.md#bug-143微信自动采集与人工添加被拆为两个渠道采集架构与其他渠道不一致) 为准。

本文件记录 **M45 第一批（M45.1～M45.3）** 的实际实现。方案与审查见
[M45 方案](M45_WXRANK_PAID_CHANNEL.md) 与 [审查记录](M45_WXRANK_PAID_CHANNEL_REVIEW.md)；
本文件只写「实际做成了什么、与方案的偏差、以及下一批要接什么」。

- 分支：`feature/m45-wxrank-paid-channel`
- 基线：`e47f661`
- 本批范围：M45.1 契约冻结、M45.2 账本／缓存／凭据、M45.3 传输／服务／Adapter／受控 RPC
- 本批**不做**任何真实收费调用。真实 LLM API 测试与少量真实 wxrank 产品流程属 M45.6。

---

## 1. M45.1 冻结的契约

契约的唯一来源是 `python/src/subscribe_flow/channels/wxrank/protocol.py`；
transport、service、adapter 与测试都只引用它，不各自抄一份。

### 1.1 协议

| 项目 | 冻结值 |
|---|---|
| 上游入口 | `https://data.wxrank.com`，只允许 `POST /weixin/getinfo`、`POST /weixin/getps` |
| 密钥位置 | 只在请求体 `key` 字段。不进 URL、不进日志、不进账本 |
| 业务码 | `code` 必须是**整数**：`0` 成功、`1000` 密钥无效或积分不足、`1005` 上游超时 |
| 一次成功调用 | 5 积分（2026-10-25 样本观察值，作为本期适配口径） |

`code` 为字符串 `"0"` 或布尔值一律判为协议异常（`SCHEMA_CHANGED`），
不当作成功，也不断言扣费。

### 1.2 身份

- **biz 归一**：去首尾空白 → 只允许 base64 字母表与结尾 `=` → 去掉已有填充后按长度补齐
  （可能补 0／1／2 个）→ 长度 % 4 == 1 判无效 → 严格解码并重新编码。
  归一结果是**标准字母表 + 正确填充**；url-safe 变体（`-_`）先转成标准再归一。
- **一份 biz，三处使用**：来源缓存键、来源内部定位地址、内容身份用同一份规范 biz。
- **来源键**：`wxrank:account:{gh_id}`（gh_id 取上游返回的稳定 ID）。
- **来源内部定位地址**：`https://mp.weixin.qq.com/s?__biz={规范biz}`。
  它是内部定位用的地址，**不是官方主页**，界面不得当成官方主页展示。
- **内容键**：`wxrank:article:{biz}_{mid}_{idx}`，`(biz, mid, idx)` 从经校验的文章地址提取。
- **文章地址**：只接受 `mp.weixin.qq.com`，统一 `https`，去掉片段，**保留查询参数**
  （`sn` 是官方文章地址的一部分，去掉链接会失效）。

### 1.3 计费口径

账本只有三种扣费判定，不引入第四种「大概没扣」：

| 情形 | 判定 | 说明 |
|---|---|---|
| 拿到 `code=0` | `confirmed` | **已确认消费 5 积分**。即使 data 是坏的，这一次调用也已经产生费用 |
| 拿到非 0 业务码 | `not_charged` | 服务端明确答复失败，未产生消费。业务失败不重试 |
| 网络未决（超时／断连／取消／读不到响应） | `unknown` | **可能已扣费**，绝不写成零消费 |
| 进程崩溃遗留的未完成调用 | `unknown` | 启动时统一结算为「结果未知」 |

请求**未发出**（取消、闸门等待中失败）时记 `not_charged`；**已发出**但没拿到业务答复时记 `unknown`。
业务失败与网络未决都不自动重试：再打一次只会再花钱。

### 1.4 脱敏样本

`channels/wxrank/fixtures.py` 提供六组结构样本（成功、业务失败、超时、坏 data、空列表、余额文案），
字段值全部是构造出来的假数据，不含真实密钥、真实公众号身份或真实文章地址。

> **待确认项**：上游真实字段名（公众号名称／头像、列表项的时间与封面字段）按「几种可能写法」
> 依次尝试，取到第一个非空值，取不到稳定身份即判结构变化。**M45.6 必须用真实样本再确认一次**，
> 确认后把多写法兼容收敛成单一写法并升 `PARSER_VERSION`。

---

## 2. M45.2 账本、缓存与凭据

### 2.1 迁移 015

迁移编号已核对：仓库原有迁移到 `014_priority_policy.sql`，因此本批用 **015**。
`python/src/subscribe_flow/storage/migrations/015_paid_channels.sql` 建三张表：

- `paid_channel_attempts`：付费调用账本。每次付费入口（解析／列表／显式测试）写一条。
  请求发出前先落「开始」，崩溃后仍有痕迹。字段白名单，**没有密钥、没有请求体、没有响应原文**。
- `paid_channel_sources`：来源解析缓存。规范 biz 为主键，命中缓存不再发付费请求。
- `paid_channel_checkpoints`：回溯检查点（服务端游标 + 凭据／解析／进展版本）。
  表在 M45.1 建好，M45.4 的历史续采逻辑使用。

仓储实现：`python/src/subscribe_flow/storage/paid_channels.py`（`PaidChannelRepository`），
由 `Repository` 持有为 `repository.paid_channels`。

### 2.2 设置分区

普通设置新增 `channels` 分区，只保存**凭据引用与非敏感版本元数据**：

```json
{"channels": {"wxrank": {"credentialRef": "channel-wxrank-…", "revision": 3, "enabled": true}}}
```

- 刻意**没有余额预算之类的字段**：本期不做本地余额拦截。
- 换密钥时 `revision` 前进；付费账本按这个版本区分「哪一次调用用的是哪一把密钥」，
  旧密钥的余额快照不会冒充新密钥的余额。
- 未知渠道、预算类字段、非法启用状态一律拒绝（`INVALID_INPUT`）。
- `snapshot()` 只暴露 `id / credentialRef / revision / enabled / configured`，界面拿不到密钥材料。

### 2.3 渠道凭据生命周期（Main 侧）

`electron/main/settings-bridge.cjs` 把渠道密钥接进既有凭据编排，**不另起一条通道**：

| 环节 | 行为 |
|---|---|
| 保存 | 先把密钥加密落盘，再把引用提交 Core（`channels` 分区 + `credential_refs`） |
| 引用前缀 | 渠道用 `channel-{channelId}-{hex}`，AI 仍用 `provider-{hex}`，两者不会互相覆盖 |
| 推送 | `_sync` 把 AI 连接与渠道的密钥一起推给 Core；不再被引用的版本一律撤销推送 |
| 撤销 | 明确清除（`credentials: {wxrank: null}`）→ 撤销推送 → 磁盘上不留旧版本 |
| 裁剪 | 换密钥后旧版本被裁掉；**AI 密钥不会被渠道密钥的保存裁掉** |
| 重启 | Core 重启后按当前设置重新推送渠道密钥 |
| 隔离 | 改 AI 设置、换渠道凭据、Core 重启三者互不破坏对方 |

渠道密钥与 AI 密钥都走同一条推送通道，但引用与分区互相独立。

---

## 3. M45.3 传输、服务、Adapter 与受控 RPC

### 3.1 传输（`channels/wxrank/transport.py`）

- 标准库 `urllib` + `asyncio.to_thread`：非阻塞、可取消、带超时（取传输上限与任务剩余时间的较小值）。
- **拒绝一切重定向**：请求体里带着运行时密钥，允许重定向就可能把它送到别的主机；
  3xx 一律按「结果未知」记账。
- 只有「HTTP 2xx + 可解析 JSON + 整数业务码」才算业务答复；其余全部抛错交给上层记「未知」。
- 传输层不写账本、不认识业务语义、不碰密钥。

### 3.2 服务（`channels/wxrank/service.py`）

1. **计费记账**：先落「开始」再发请求；按上表结算。
2. **来源解析缓存**：同一个规范 biz 只付一次解析费。「解析 → 确认添加」与「重启后再解析」都命中缓存。
3. **单飞合并**：并发解析同一个 biz 只发一次请求（`asyncio.shield`，
   等待方被取消不牵连已经付过钱的在途请求）。
4. **资源互斥与限流**：所有付费入口（解析／列表／显式测试）共用同一把闸门
   （`ResourceCoordinator`），同一时刻至多一个请求，并按 QPS 做起始时间节流。
   闸门是**独立实例**，不与采集调度共用同一把锁，因此不构成「持有同一不可重入锁再嵌套获取」的死锁。

### 3.3 Adapter（`channels/wxrank/adapter.py`）

- 与其它渠道同一层级：实现同一个 `ChannelAdapter` 协议、注册进同一个 `ChannelGateway`。
- 能力：`resolve_source`、`list_items`。**不提供**搜索、正文、单条文章接入
  （`get_item_detail` / `match_item_url` / `resolve_item` / `read_item` 均为不支持），
  因此不会与 M14 公众号文章接入争抢单条链接路由。
- **「检查配置」不发网络请求**：付费渠道的连通性检查本身就要花钱，
  因此只检查本地是否已配置可用密钥；可用性交给真正的调用去证明。

### 3.4 资源与接线

- `RESOURCE_KEYS` 新增 `paid-http`：每条付费渠道一个资源键（`http:wxrank`），
  不同渠道互不阻塞，同一渠道的所有付费入口共用一把闸门。
- `Core` 装配顺序调整：设置与凭据容器**先于**网关创建（适配器要读设置里的凭据引用）。
- `Core` 启动时把上次崩溃遗留的未完成付费调用结算为「结果未知」。

### 3.5 受控 RPC

| 路由 | 是否花钱 | 说明 |
|---|---|---|
| `wxrank.usage` | 否 | 自然月汇总：已确认用量、结果未知次数、调用次数、最近一次观察到的余额、最近记录 |
| `wxrank.cache_clear` | 否 | 清理来源解析缓存（下次解析会重新付费，属明确用户动作） |
| `wxrank.test` | **是** | 显式付费测试，绕过缓存，必定产生一次付费调用 |

Electron 侧三层同步接线（避免「只补一层」的历史问题）：

- `electron/main/methods.cjs`：三个名字进入 `CORE_METHODS` 白名单
- `electron/preload/index.cjs`：三个名字进入 preload 白名单
- `electron/renderer/scripts/core/app-client.js`：`getWxrankUsage` / `clearWxrankCache` / `testWxrankChannel`

`wxrank.*` 刻意**不放进** `UI_METHODS` 的密钥编排路径：这三个接口不接受也不返回任何密钥。

---

## 4. 本批验证结果

全部离线（传输层换成假传输），因此「没有发请求」是可证明的，本批不产生任何真实费用。

```
cd python && PYTHONPATH=src python3 -m unittest discover -s tests -t .
→ Ran 606 tests … OK      （新增 test_wxrank.py 47 项）

cd Subscribe_Flow && node --test tests/*.test.cjs
→ tests 155 / pass 155 / fail 0   （新增 M45 渠道凭据生命周期 4 项）
```

关键行为（均在 `python/tests/test_wxrank.py`，47 项）：

- 解析 → 确认添加只付一次费；确认添加时界面传回来源地址，命中缓存。
- 单页采集入库：一次解析 + 一页列表 = 两次付费调用，内容按 `wxrank:article:*` 入库。
- Core 重启后复用缓存：重启再解析**不再付费**。
- 同一 biz 的 4 路并发解析只发一次请求。
- `code=0` + 坏 data → 仍记 `confirmed` 5 积分；网络未决 → 记 `unknown`，不是零消费。
- 换渠道密钥推进调用版本，AI 设置与 AI 密钥不受影响；Core 重启双方都还在。
- 付费调用按同一资源键串行，间隔不小于 QPS 节流。
- 未配置密钥时付费入口在**发请求前**拒绝，账本不出现「已消费」记录。

---

## 5. 已知限制

1. **上游字段名待真实样本确认**（见 §1.4）。M45.6 用真实响应校正后再收敛解析器。
2. **积分 5 分／次是观察值**，不是上游承诺。界面展示的「预计 5 积分」要保留这一措辞。
3. **余额只是服务端观察值**，从业务文案「剩余 N 积分」里读出，读不到就没有；
   它不是本地账本算出来的数，也不参与任何拦截。
4. 本批只有 Core 侧与受控 RPC，**没有正式界面**（M45.5）。当前无法在界面上配置渠道密钥、
   看到用量或触发付费测试。
5. 本批只验证到**单页**采集。多页付费分页、任务化与历史续采是 M45.4。
6. 本批没有真实收费调用，因此**真实上游的时延、限流与错误形状未经实测**。

---

## 6. 下一批接口（M45.4～M45.5）

给下一批的现成接口：

- `WxrankService._paid_request(...)`：统一记账入口。新增付费入口一律走它，不要另写记账。
- `WxrankService.resolve_source / fetch_page / paid_test`：业务入口。
- `PaidChannelRepository.checkpoint / save_checkpoint / clear_checkpoint`：M45.4 的游标续采用。
- `paid_channel_attempts.charge_state` 三值口径：M45.4／M45.5 的界面展示按它取值，不要另造状态。
- `WxrankService.usage_summary(since, until)`：M45.5 的用量卡片直接用。
- `paid-http` 资源键与 `WxrankService.resources` 闸门：M45.4 的多页任务会被同一把闸门串行化，
  这是预期行为，不要在别处再加第二把锁。

M45.4 需要新增的：分页游标传递（`FetchRequest.cursor` → `getps` 的 `cursor`）、
每页一次的付费记账、任务化采集与持久检查点的续采与失效策略。

M45.5 需要新增的：渠道卡片（密钥输入、用量展示、缓存清理、显式付费测试入口）、
设置页的渠道分区、以及「打开主页」按钮的内部定位措辞。

---

# 第二批（M45.4～M45.5）

第一批的交付见上文。本批补齐三件事：**有界分页与持久检查点**、**调度策略对付费请求的保护**、
**正式界面**；同时修掉第一批审查发现的两个实质问题（BUG-129／BUG-130）。

## 5. M45.4 有界分页与持久检查点

### 5.1 页数、条数与费用

口径统一到一处，界面与采集引擎共用同一个推导函数（`SyncService.page_budget_for`）：

| 订阅上的采集条数 | 回溯页数 | 回溯调用次数 | 回溯费用 |
| --- | --- | --- | --- |
| 0（默认） | 3 | 3 | 15 积分 |
| 10 | 1 | 1 | 5 积分 |
| 30 | 3 | 3 | 15 积分 |
| 50 | 5 | 5 | 25 积分 |

- 单页条数 `page_size = 10`：上游样本每页约 9～10 条，按 10 条推导页数与费用；
  上游真的返回更多时按 `limit` 截断，**不因此多算页数或多报费用**。
- 第一批的毛病（`page_size=20`、默认回溯 3 页算出 `item_budget=60`，收费后才以 >50 拒绝）已修：
  适配器不再拿「任务总条数」当单页上限，也**不在收费之后才拒绝本地参数**；
  非法本地参数（采集条数不在 0～50）在订阅保存时就被拒，早于任何付费调用。

### 5.2 检查点

- 表：`paid_channel_checkpoints`（第一批随 015 建好，本批开始使用）。
- **页数据与检查点在同一个事务里提交**：`Repository.commit_page(..., checkpoint=...)`
  在提交页面数据的那个事务内写检查点。崩溃时不会出现「页数据已存、检查点没存」，
  下一次回溯不会把同一页再买一遍。
- 只有「本页没有条目错误」时才推进检查点：有错误说明这一页可能没拿全，跳过就再也补不回来。
- **刷新从头部开始，回溯从上次已提交成功的页继续**（按任务模式判断，不看有没有检查点）。
- 检查点带版本：凭据版本、解析版本、进展版本。任一不一致即判定不可用。
- 有效期 24 小时（上游观察值，未复验）。**过期按保守方向处理**：宁可当成过期后从头重扫
  （多花一次钱），也不要用一个可能失效的游标把中间的历史整段跳过。
- 四种状态，界面照此显示：
  `fresh`（没有检查点）／`resume`（可以继续）／`expired`（过期，从头重扫）／
  `version_mismatch`（版本变了，从头重扫）。**后两种不得说成「续采」。**
- **终止后不再额外重查头部**：第一批沿用的「回溯走到末页后再回头查一次头部」对付费渠道是一次额外消费，
  因此对声明了检查点能力的渠道关闭这一步（既有渠道语义不变）。

### 5.3 终止证据

只有「服务端返回空列表」才标 `history_end`（终止证据 = `empty_list`）。
这**只说明服务端当前这份数据集扫完了**，不代表公众号的全部历史，界面文案照此写。

### 5.4 调度策略：付费请求不自动重放

- 付费渠道（描述符 `paid=True`）遇到 `TIMEOUT`／`TRANSIENT`／`retryable`／中断时，
  **不按通用重试策略自动重放**：那一次调用的扣费结果未知，重放等于再花一次钱。
  改为等下一次**用户明确启用**的周期检查，或由用户手动重试——两者在实现上是分开的。
- 密钥无效／积分不足：连接阻塞，用户处理后可经连接检查恢复。
- 服务不可用（`DEPENDENCY_UNAVAILABLE`）：保留阻塞，由用户明确重试任务；
  **本地配置检查不会清除该阻塞，也不会自动重试付费请求**（BUG-139）。
  调度器不对付费渠道自动探测此类故障。本地检查不发网络请求，不能证明上游恢复。
- 默认仍是手动：不开启自动检查就不会有自动消费。

### 5.5 身份核对（BUG-129）

列表页入库前做两道核对，任一不符就**整页拒绝**（`INVALID_RESULT`），一条都不入库：

1. 响应里的 `wxid` 必须等于当前来源的 `external_id`（gh_id）；
2. 每篇文章的 `biz` 必须等于当前来源的**规范 biz**（从来源的内部定位地址推导，与解析缓存同一份）。

已经发生的 `code=0` 费用照记为已确认消费：调用确实发生了，不能因为拒绝入库就抹掉。

### 5.6 生命周期（BUG-130）

- 渠道业务层持有在途任务集合；`close()` 先标记关闭，再取消并**等待**这些任务收束（有界）。
- `Core.close()` 的顺序改为「先收束付费任务，再关数据库」：晚到的响应不会写到已关的库上。
- 关库之后不再写账本：那条「开始」记录留在账本里，下次启动按「结果未知」结算，费用可追溯。
- 关闭后拒绝新的付费调用。

## 6. M45.5 正式界面

渠道卡片（公众号 · 付费API）在「渠道与连接」面板里，与通用连接行分开：
通用连接行会把「可用」写在状态上，而付费渠道的可用性只能靠真实调用证明。

| 能力 | 行为 |
| --- | --- |
| 密钥配置 | 密码输入 + 保存；加密落盘，界面只显示是否已配置，永不回显；可二次确认清除 |
| 启用／停用 | 真实生效：停用后 Core 拒绝付费调用，本地检查显示已停用 |
| 免费本地配置检查 | 只查本地是否已配置，结果写「已配置，未联网验证」；**不联网、不产生费用** |
| 显式付费测试 | 需人输入 biz；按钮写明「预计 5 积分」；先确认再发请求；绕过解析缓存；成功后显示名称与 ID |
| 本地用量 | 本月已确认用量、扣费结果未知次数、最近服务端余额（含观察时间）；余额读不到写「未知」，**绝不写 0** |
| 清理解析缓存 | 明确动作，提示清理条数 |
| 刷新／回溯费用 | 确认框显示「本次最多 N 次调用 · 约 M 积分」、页数与检查点起点；并说明**采到 0 条新内容也可能已经产生费用** |
| 自动检查提示 | 启用自动检查时额外提示：每次检查都会调用付费接口并产生费用，默认仍是手动 |
| 来源地址 | 「打开主页」**禁用**：那是内部定位用的公众号地址，不是可浏览主页；文章原文仍可在内容详情打开 |
| 正文语义 | 详情显示「仅列表信息（未获取正文）」，不宣称取得正文；合法副条（idx>1）照常保留 |

界面不替 Core 算钱：页数、调用次数、积分、余额全部照渠道状态接口给的显示，读不到就写「未知」。

## 7. 第二批验证结果

```
cd python && PYTHONPATH=src python3 -m unittest discover -s tests -t .
→ Ran 625 tests … OK      （test_wxrank.py 66 项）

cd Subscribe_Flow && node --test tests/*.test.cjs
→ 155 / 155 / 0 fail

cd Subscribe_Flow && npm run smoke:wxrank
→ {"wxrankUi":"passed","confirmedCredits":15,"calls":3,"contents":10}
```

正式 Renderer 验收（`scripts/wxrank-ui-smoke.cjs`，连续三次通过）覆盖：卡片渲染、密钥加密落盘、
本地配置检查零调用零费用、付费测试产生一次 5 积分调用、添加来源只解析一次（确认添加命中缓存）、
刷新按实际配置显示费用并入库 10 条、回溯对话框显示调用次数与费用、「打开主页」禁用、
详情显示「仅列表信息」。

上游换成脱敏样本（`SUBSCRIBE_FLOW_WXRANK_FIXTURE`），**本批没有任何真实收费调用**。

---

# 第三批（M45.6 联合真实验收）

## 8. 真实上游契约核对（本批最重要的产出）

第一批的协议是按推测写的，真实样本核对推迟到本批。核对结果有四类实质差距，
不改就会在真实数据上直接失败：

| 真实契约 | 旧实现 | 后果 |
| --- | --- | --- |
| 文章地址是 **http**，参数之间用 `&amp;` 分隔 | 直接 `parse_qs` | 取不到 `mid`／`idx`，整页被判成 `SCHEMA_CHANGED` |
| 字段名 `art_url`／`pic_url`／`hd_head_img`／`signature` | 只认 `url`／`cover`／`avatar`／`description` | 地址、头像、简介全取不到 |
| 业务码 1001／1002／1003／1004／9999 | 只区分 1000 与 1005 | 用户看不懂到底哪里不对 |
| 同一推送共享 `mid`，`idx` 区分头条与副条 | 副条会被当成独立文章 | 副条覆盖 |

修法（提交 `7ae0e20`）：

- 只解**一层**安全实体，`&amp;` 排在最后；**不用 `html.unescape`**——它认识
  `&times;`／`&timestamp` 这类实体名，会把 `&times=1` 改成 `×=1`，把地址改坏。
- 解完再统一升 https；真实字段名优先，旧写法保留兜底。
- 1003 用独立错误码 `CURSOR_INVALID`：业务层据此丢掉已经不可用的检查点，
  下次回溯从头重扫，而不是反复买同一个坏游标。
- 解析版本升到 `wxrank-2`：旧检查点的解析口径已变，一律作废重扫。
- 付费页是**原子的**：一页可能多于「每页 10 条」的估算，整页保留
  （上限 100 条兜底），条数窗口仍由采集引擎收敛——不按估算条数丢掉已经付过钱的文章。

## 9. 检查点语义修正（提交 `2f314d7`）

检查点原先只在 `mode == "backfill"` 时写，等于把「回溯位置」误当成回溯专用进度。
后果：**第一次回溯会把刚采过的头页再买一遍**（真实上游上就是白花 5 积分，
回来的还全是已收录条目）。

现在检查点的语义是「**最后一次成功提交的页之后的位置**」，刷新与回溯共用同一套规则：
刷新提交的就是头部页，回溯从它后面接着走；终止页（空列表）没有下一游标，检查点照旧清掉。

## 10. 验收档位 `SUBSCRIBE_FLOW_WXRANK_FIXTURE=http`

没有授权的真实密钥时，仍然要用**产品的真实传输层**验证真实 HTTP 条件下的行为：

- 传输层是产品的真实传输层：真实 urllib、真实 JSON 请求体、真实超时、**拒绝一切重定向**。
- 上游是本机 HTTP 服务（`scripts/wxrank-mock-upstream.cjs`），响应形状严格照真实契约复刻。
- **只允许回环地址**：非回环直接拒绝启动。请求体里带着密钥，绝不能发到本机以外。
- 生产启动不设置该环境变量，那时走的是真正发网的传输层。

配套脚本：`scripts/wxrank-real-smoke.cjs`（正式 Renderer 验收）、
`scripts/wxrank-real-acceptance.cjs`（启动本机上游并拉起正式应用），
命令 `npm run smoke:wxrank:real`。

## 11. 第三批验证结果

```
cd python && PYTHONPATH=src python3 -m unittest discover -s tests -t .
→ Ran 633 tests … OK      （test_wxrank.py 75 项）

cd Subscribe_Flow && node --test tests/*.test.cjs
→ 155 / 155 / 0 fail

cd Subscribe_Flow && npm run smoke:wxrank
→ {"wxrankUi":"passed","confirmedCredits":15,"calls":3,"contents":10}

cd Subscribe_Flow && npm run smoke:wxrank:real
→ {"wxrankUi":"passed","upstream":"local-http (真实响应形状，非真实付费上游)",
   "calls":4,"confirmedCredits":20,"contents":30,"checkpointAfterBackfill":"resume"}
```

真实 LLM API（走产品正式链路，凭据只在进程内解析）：

```
provider-llm  api.minimax.cn   MiniMax-M3   HTTP 200  回答 145 字符  243 tokens
provider-jev  api.typesafe.ai  jev-1.14.0   HTTP 200  非空        input 289 / output 20
```

**真实付费上游没有验证**：本机没有授权的 wxrank 密钥（用户指定文件只有 LLM 配置；
已授权的公众号付费实验目录里也没有真实 key，方案本身写明成功路径从未用真实验证）。
全程没有任何真实扣费。详见交付说明里的外部阻塞一节。

---

# 第四批（最终核心返修）

Codex 第三批审查（HEAD0556b33）留下两个已复现的实质阻断，本轮合并修一次。

## 12. 刷新不得回退更深的有效检查点（BUG-132 重开）

第三批把检查点改成「任何一次成功提交的页都推进」，过头了：刷新拿到的是
「头页之后」的位置，如果历史已经走到更深处，刷新会把检查点退回去，
下一次回溯又重买已经采过的页（白花一次钱，采到的还全是已收录条目）。

现在的规则按任务种类分开：

| 任务 | 检查点 |
| --- | --- |
| 回溯 | 从上次的位置继续，本次提交一定更深 → **每次推进** |
| 刷新 | 永远从头部开始 → **只在没有有效检查点时建立起点** |

「有效」＝同密钥版本、同解析／进展版本、没过期。已有有效检查点就保留它：
那说明历史走到了更深处，刷新不该把它退回去。过期或换过密钥的检查点照旧作废
（从头重扫，不假称续采）。

**游标是不透明的**：不靠字符串比深浅，只判断「有没有有效检查点」。
实现落在 `Repository._write_channel_checkpoint`（与页数据同一事务）。

## 13. 付费页整页保存（BUG-137）

上游一页是「10 次推送 × 每次最多 8 篇」，一次付费调用买下的是**整页**。
条目已经付过钱，裁掉余量等于白花钱，而且余量再也拿不回来：
下次只能重买头页，采到的还是那几篇。

所以付费渠道不再按条数裁剪已购页面：

- 引擎的条目窗口对 `paid` 渠道不裁剪（`SyncService._limit_page_items(..., atomic=descriptor.paid)`）；
- `collect_items` 变成**折算扫描页数的窗口**（0／10／30／50 → 3／1／3／5 页），
  **调用页数与费用不越界**，但实际保存条数可能多于设定值；
- 界面与方案各写一句必要说明：渠道卡片限制说明（Core 下发）、
  刷新／回溯确认框、采集条数对话框、方案 §5.1 与 W45-08/09。

其它渠道的条目窗口语义不变。

## 14. 第四批验证结果

```
cd python && PYTHONPATH=src python3 -m unittest tests.test_wxrank
→ Ran 80 tests … OK      （新增 5 项：CheckpointDepthTests 2 项 + WidePaidPageTests 3 项）

cd python && PYTHONPATH=src python3 -m unittest tests.test_wxrank tests.test_application tests.test_storage
→ Ran 104 tests … OK

cd Subscribe_Flow && npm run smoke:wxrank:real
→ {"wxrankUi":"passed","calls":4,"confirmedCredits":20,"contents":30,"checkpointAfterBackfill":"resume"}
```

新增的 5 项回归在修复前是**红的**（用 `git stash` 去掉两处修复对照跑过）：
`page-3` 退回 `page-2`、宽页只存 10 条、续采又从头买。

本轮**没有调用任何真实 LLM、Jev 或付费 wxrank 接口**；
真实付费上游仍因本机没有授权密钥而未验证。

---

# 第五批（2026-10-25）：真实付费验收

第四批末尾写的「真实付费上游仍因本机没有授权密钥而未验证」说的是**当时**的状态；
本批已用真实密钥完成真实付费验收。

## 实际结果

- 真实上游 `https://data.wxrank.com`、正式 `WxrankTransport`、真实 wechat 分组密钥。
- **5 次真实调用全部成功**：冷解析 1、刷新 1、两次一页回溯 2、重启后续采 1。
- 费用：每次 5 积分、合计 **25 积分确认消费**，`unknownCount=0`；
  服务端余额 55 → 50 → 45 → 40 → 35 → 30，最近观察时点 `2026-10-25T13:58:38Z`。
- 真实数据：账号名「超级美工」，`external_id` 与已授权实验缓存一致；
  `art_url` 解一层 `&amp;` 并升 https，链接含 `mid=`／`idx=`；
  发布时间 `2026-10-23T09:00:00+08:00`；入库 9 → 19 → 29 → 40 条，逐页递增无重复。
- 游标：两次一页回溯后检查点都是 `resume`（备注「从上次已提交成功的页继续」）；
  隔离重启后检查点与条数不变，再回溯一页成功到 40 条。
- 免费步骤零付费：保存密钥与本地检查都没有触发任何付费请求；确认添加命中解析缓存，
  **没有再收一次费**。

## 本批新增的产品修复：BUG-138

首轮真实调用在 TLS 阶段失败（握手前就断了，没有产生扣费）。根因不是上游不可信，
而是**本机没有 CA**：python.org 的 CPython 把 OpenSSL 指向不存在的证书路径，
`ssl.create_default_context()` 一个 CA 都不信任，Core 侧每次 HTTPS 必失败。

修复：**根证书装在环境里**——本机 Python 的 OpenSSL 默认 CA 路径
`/Library/Frameworks/Python.framework/Versions/3.12/etc/openssl/cert.pem` 指向 certifi 的
`cacert.pem`，`ssl.create_default_context()` 从 0 张变成 118 张，裸路径即可用。
产品侧只按 `channels/github/transport.py` 同款写法在 `channels/wxrank/transport.py` 内
保留最小兜底，**没有新增共享 HTTP 层**。
**校验一个字都不放宽**：找不到 CA 就大声失败，不用 `CERT_NONE`，不注入未认证来源的证书。

验证：裸 `ssl.create_default_context()`（118 张 CA）访问上游首页 HTTP 200；产品
`WxrankTransport` 的 opener 访问上游首页 HTTP 302（TLS 与 HTTP 均通）；
新增 `tests/test_wxrank_trust.py` 3 项；
`PYTHONPATH=src python3 -m unittest tests.test_wxrank_trust tests.test_wxrank` → **Ran 83 tests … OK**。

## 凭据更正

`test_api_key.md` 的 `wechat` 分组密钥**原本就存在**；先前「缺少公众号密钥」是
**分组识别漏判**（旧解析器按 URL 推导组名，跳过了只有 `key:` 没有 `url:` 的 wechat 组）。
该密钥已由本批真实调用证明有效。「缺 key」不再是当前外部阻塞。

证据与交付说明：[batch-05-live-wechat/DELIVERY.md](verification/m45-minimax/batch-05-live-wechat/DELIVERY.md)。
