# M45 公众号付费渠道（wxrank）实施说明

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
