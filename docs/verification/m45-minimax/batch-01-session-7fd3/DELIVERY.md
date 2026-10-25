# M45 第一批交付说明（batch-01 / session-7fd3）

- 会话：`mvs_7fd3c6dc294c49eb80baf7812ac195fa`
- 分支：`feature/m45-wxrank-paid-channel`
- 基线：`e47f661`
- 批次范围：**M45.1～M45.3**（M45.4／M45.5 不在本批，不自行开始）
- 本批**没有任何真实收费调用**。真实 LLM API 测试与少量真实 wxrank 产品流程属 M45.6。

---

## 1. 完成项

### M45.1 契约冻结

| 交付 | 位置 |
| --- | --- |
| 协议／身份／计费契约唯一来源 | `python/src/subscribe_flow/channels/wxrank/protocol.py` |
| 脱敏样本（六组结构样本） | `python/src/subscribe_flow/channels/wxrank/fixtures.py` |
| 契约说明 | 本文件 §2、`docs/M45_WXRANK_IMPLEMENTATION.md` |

冻结内容：上游入口与两个允许路径、密钥只在请求体、业务码必须为整数、一次成功调用 5 积分口径；
biz 归一规则（补 0／1／2 填充、长度 % 4 == 1 无效、严格解码再编码）、来源键
`wxrank:account:{gh_id}`、内容键 `wxrank:article:{biz}_{mid}_{idx}`、文章地址只接受官方域名且保留查询参数；
三种扣费判定（`confirmed` / `not_charged` / `unknown`）。

### M45.2 账本、缓存与凭据

| 交付 | 位置 |
| --- | --- |
| 迁移 015（编号已核对：原有到 014） | `python/src/subscribe_flow/storage/migrations/015_paid_channels.sql` |
| 账本／缓存／检查点仓储 | `python/src/subscribe_flow/storage/paid_channels.py` |
| 设置分区 `channels` | `python/src/subscribe_flow/application/settings.py` |
| 渠道凭据生命周期（Main） | `electron/main/settings-bridge.cjs` |
| 受控入口（应用层） | `python/src/subscribe_flow/application/paid_channels.py` |

三张表：`paid_channel_attempts`（付费调用账本）、`paid_channel_sources`（来源解析缓存）、
`paid_channel_checkpoints`（回溯检查点，M45.4 使用）。

设置分区只保存凭据引用与调用版本，**没有余额预算字段**；换密钥推进 `revision`。
Main 侧渠道密钥走既有凭据编排：先加密落盘 → 提交引用 → 推送 Core → 撤销／裁剪／重启重推；
引用前缀 `channel-{channelId}-{hex}` 与 AI 的 `provider-{hex}` 分开，互不覆盖。

### M45.3 传输、服务、Adapter 与受控 RPC

| 交付 | 位置 |
| --- | --- |
| 非阻塞传输 | `python/src/subscribe_flow/channels/wxrank/transport.py` |
| 业务层（记账／缓存／单飞／限流） | `python/src/subscribe_flow/channels/wxrank/service.py` |
| 正式 Adapter | `python/src/subscribe_flow/channels/wxrank/adapter.py` |
| 资源与装配 | `python/src/subscribe_flow/bootstrap.py` |
| 受控 RPC | `python/src/subscribe_flow/rpc/dispatcher.py` |
| 桌面三层接线 | `electron/main/methods.cjs`、`electron/preload/index.cjs`、`electron/renderer/scripts/core/app-client.js` |

- 传输：标准库 + `asyncio.to_thread`，可取消、带超时、**拒绝一切重定向**（请求体带密钥）；
  只有「HTTP 2xx + 可解析 JSON + 整数业务码」才算业务答复，其余按「结果未知」记账。
- 业务层：先落账再发请求；按上游答复结算；同一规范 biz 的并发解析合并为一次请求；
  所有付费入口共用一把闸门（同一时刻至多一个请求，按 QPS 做起始时间节流）。
- Adapter：与其它渠道同层级，支持 `resolve_source`／`list_items`；
  **不提供**搜索／正文／单条文章接入，因此不与 M14 争抢单条链接路由；
  「检查配置」**不发网络请求**（付费渠道的连通性检查本身就要花钱）。
- 资源：`RESOURCE_KEYS["paid-http"] → http:{channel}`（本渠道 `http:wxrank`）。
- 受控 RPC：`wxrank.usage`（只读本地）、`wxrank.cache_clear`（只读本地）、`wxrank.test`（**唯一花钱**）。

---

## 2. 关键行为与口径

| 情形 | 账本判定 | 说明 |
| --- | --- | --- |
| 上游回 `code=0` | `confirmed`，5 积分 | **含 data 是坏数据的情况**：调用已发生，费用已产生 |
| 上游回非 0 业务码 | `not_charged` | 服务端明确答复失败；业务失败不重试 |
| 网络未决（超时／断连／取消／读不到响应） | `unknown` | **可能已扣费**，绝不写成零消费 |
| 请求未发出（取消／闸门失败） | `not_charged` | 确实没打出去 |
| 进程崩溃遗留的未完成调用 | `unknown` | 启动时统一结算 |
| 换密钥后的旧余额快照 | 不继承 | 余额按 `credential_version` 区分 |

不静默重试不明付费请求；不新增本地余额预算拦截；不做无关防御重构。

---

## 3. 提交

| 提交 | 内容 |
| --- | --- |
| `15fef9f` | `feat(m45): 付费公众号渠道第一批（契约、账本缓存凭据、传输与适配器）` |

- 分支：`feature/m45-wxrank-paid-channel`，父提交 `e47f661`。
- 一次提交包含产品代码与本批文档（`docs/M45_WXRANK_IMPLEMENTATION.md`、
  `docs/verification/m45-minimax/batch-01-session-7fd3/DELIVERY.md`、
  `docs/API.md`、`docs/STORAGE.md`、`docs/PROGRESS.md`、`docs/reference/DEVELOPMENT_PLAN.md`）。
- 仓库外的总计划 `doc/DEVELOPMENT_PLAN.md` 与本地 `docs/HANDOFF.md` 同步更新
  （前者不在本仓库内，后者按仓库约定保持本地忽略）。
- **未打包、未推送、未发布。**

---

## 4. 验证命令与实际结果

全部离线执行，传输层替换为假传输，因此**没有产生任何真实费用**。

```
$ cd Subscribe_Flow/python && PYTHONPATH=src python3 -m unittest discover -s tests -t .
Ran 606 tests in 42.7s
OK

$ cd Subscribe_Flow && node --test tests/*.test.cjs
ℹ tests 155
ℹ pass 155
ℹ fail 0
```

### 覆盖到的关键行为（`python/tests/test_wxrank.py`，47 项）

- 契约：biz 补 0／1／2 填充、缺填充、非法输入、url-safe 字母表；同一账号三种写法得到同一个 biz；
  内容键由经校验的文章地址派生；非官方域名文章链接被拒；发布时间按 Asia/Shanghai 且保留精度。
- 账本：迁移建表；`code=0` 记 `confirmed`；业务失败记 `not_charged`；
  `code=0` + 坏 data 仍记 `confirmed` 5 积分；网络未决记 `unknown`；取消记 `unknown`；
  崩溃遗留结算为 `unknown`；月度汇总区分已确认与未知次数；换密钥后旧余额不继承。
- 设置：分区可跨重启存活；**没有预算字段**；未知渠道／预算字段被拒；换密钥推进版本；
  **改渠道分区不动 AI 分区**。
- 业务层：Adapter 能力声明与资源键正确；「检查配置」零请求；缺密钥时零请求且不记账；
  解析→确认添加只付一次费；**Core 重启后复用缓存不再付费**；同 biz 4 路并发只发一次请求；
  单页采集入库（`wxrank:article:*`）；二次刷新只付页费；空列表是终止证据；
  坏列表数据判结构变化但该页仍记 `confirmed`；清缓存后重新付费；显式测试每次都付费；
  付费调用按同一资源键串行且间隔不小于节流。
- 凭据隔离：换渠道密钥不动 AI 设置；Core 重启后 AI 与渠道凭据都在；旧账本不受影响。

### 覆盖到的 Main 侧行为（`tests/settings-credentials.test.cjs`，新增 4 项）

- 渠道密钥先落密文再提交引用并推送 Core，引用前缀 `channel-wxrank-…`，界面拿不到引用与密钥。
- 换渠道密钥裁掉旧版本，**AI 密钥不被牵连**。
- 清除渠道密钥撤销推送并清掉磁盘版本，AI 密钥继续可用。
- Core 重启后按当前设置重新推送渠道密钥。

---

## 5. 已知限制

1. **上游真实字段名待真实样本确认**。解析器目前按「几种可能写法」依次取第一个非空值
   （公众号名称／头像、列表项的时间与封面字段），取不到稳定身份即判结构变化。
   M45.6 用真实响应校正后应收敛为单一写法并升 `PARSER_VERSION`。
2. **5 积分／次是 2026-10-25 的观察值**，不是上游承诺；界面措辞要保留「预计」。
3. **余额只是服务端观察值**（从业务文案「剩余 N 积分」读出），读不到就没有；不参与任何拦截。
4. **本批没有界面**（M45.5）：现在无法在界面上配置渠道密钥、看用量或触发付费测试。
5. **本批只验证到单页采集**；多页付费分页、任务化与历史续采属 M45.4。
6. **真实上游的时延、限流与错误形状未经实测**（本批无真实收费调用）。
7. 传输层不记录请求体，失败时排障只能看到错误码与文案，看不到上游原文（有意为之：响应原文不入库）。

---

## 6. 后续接口（给第二批 M45.4～M45.5）

- `WxrankService._paid_request(...)`：统一记账入口。新增付费入口一律走它，不要另写记账。
- `WxrankService.resolve_source / fetch_page / paid_test`：业务入口。
- `WxrankService.usage_summary(since, until)`：M45.5 用量卡片直接用。
- `PaidChannelRepository.checkpoint / save_checkpoint / clear_checkpoint`：M45.4 游标续采。
- `paid_channel_attempts.charge_state` 三值口径：界面按它取值，不要另造状态。
- `WxrankService.resources` 闸门与 `paid-http` 资源键：多页任务会被同一把闸门串行化，这是预期行为，
  不要在别处再加第二把锁（会造成「持有同一不可重入锁再嵌套获取」的死锁）。

第二批需要做的：分页游标传递（`FetchRequest.cursor` → `getps` 的 `cursor`）、每页一次的付费记账、
任务化采集与持久检查点的续采与失效策略（M45.4）；渠道卡片、设置页渠道分区、
「打开主页」按钮的内部定位措辞（M45.5）。

---

## 7. 本批未做的事（按任务边界）

- 未开始第二批（M45.4～M45.5）。
- 未做真实收费调用；未做真实 LLM API 测试（属 M45.6）。
- 未打包、未推送、未发布；版本仍 0.5.2。
- 未改动用户日常数据库、登录态与通知偏好；未停止其他应用。
- 未把任何凭据写进源码、日志、提示词或证据文件。
