# M45 公众号付费渠道 · 第三批（M45.6 联合真实验收）交付说明

- 日期：2026-10-25
- 分支：`feature/m45-wxrank-paid-channel`
- 实施：MiniMax（session `mvs_7fd3c6dc294c49eb80baf7812ac195fa`）
- 独立验收：Codex（本批提交后等待最终验收）
- 结论：**真实 LLM API 验收通过；真实付费上游因本机没有授权密钥而外部阻塞，未验证也未伪造。**
  付费渠道的接线、解析、计费、检查点与正式界面链路已用**真实传输层 + 本机真实 HTTP 上游**整体跑通。

---

## 1. 提交

| 提交 | 内容 |
| --- | --- |
| `15fef9f` | 第一批产品码（M45.1～M45.3）：契约、账本／缓存／凭据、传输与适配器 |
| `3708fa1` | 第一批交付文档 |
| `badf950` | 第二批产品码＋文档（M45.4～M45.5）：付费分页与检查点、调度保护、正式界面 |
| `4136e51` | 第二批收尾：补记提交号与 137 执行中断记录（**未回退代码**） |
| `7ae0e20` | 第三批：按真实上游契约对齐解析与付费页语义（BUG-131／BUG-133） |
| `2f314d7` | 第三批：刷新也推进回溯检查点（BUG-132）＋真实传输层验收档位与脚本 |
| 本提交 | 第三批文档与交付说明（含本文件、截图与证据文件） |

**最终 HEAD = 本交付说明所在的提交**（`docs(m45): 第三批文档与交付说明`），其父提交是 `2f314d7`；
`git log --oneline -3` 可直接核对。工作区在提交后应当干净。

第二批收尾状态：上一轮以 137 退出、`result.json` 无最终结果、stderr 为空，原因未确认——
**既不写成 succeeded，也不当作测试失败**；Codex 已独立复跑 wxrank 66 项与 `npm run smoke:wxrank` 通过。

---

## 2. 真实 LLM API（走正式产品链路）——已通过

链路与界面上的「测试连接」完全同一条：
`Dispatcher → ai.provider.test → AiGateway.test_connection → 协议适配器 → HttpTransport`。

| 连接 | 服务 host | 模型 | 结果 | 用量 |
| --- | --- | --- | --- | --- |
| `provider-llm` | `api.minimax.cn` | `MiniMax-M3` | HTTP 200，回答 145 字符，非空 | 243 tokens（prompt 201／completion 42，其中 reasoning 30） |
| `provider-jev` | `api.typesafe.ai` | `jev-1.14.0`（配置值 `jev-latest`） | HTTP 200，非空 | input 289／output 20 |

- 凭据来源：`/Users/xor/Documents/Subscribe_Call/test_api_key.md`，**只由本机进程解析**：
  密钥只在内存里，不进模型上下文、不进源码、不进日志、不进证据文件。
- 证据文件只含脱敏的 host／protocol／model／状态／非空结果长度与用量，没有密钥、没有请求头、没有响应原文。
- 脚本：`batch-03/real-llm-check.py`；证据：`batch-03/real-llm-evidence.json`。

---

## 3. 真实付费渠道（wxrank）——外部阻塞，未验证

### 3.1 阻塞事实

本机**没有授权的 wxrank 密钥**：

| 找过的地方 | 结果 |
| --- | --- |
| 用户指定文件 `test_api_key.md` | 只有 LLM 配置，没有 wxrank 密钥 |
| 已授权的公众号付费实验目录（原实验方案、验证记录） | 方案本身写明「**成功路径没有真实 key，未验证**」；只有真实 biz 缓存与真实响应样本，没有密钥 |
| 实验项目源码与状态文件（`.wxrank-state.json` 等） | 只有代码标识符与真实 biz／wxid／名称缓存，**没有 key** |
| 桌面／文档目录的定向检索 | 无 wxrank 凭据命中（扫描结果全是误报） |

定位脚本只输出路径与掩码，不输出秘密：`batch-03/locate-wxrank-credential.py`、
`batch-03/scan-lab-credential.py`。

**因此：没有产生任何真实扣费，没有真实余额可观察，没有高频尝试，也没有把假上游说成真实上游。**
本批**不**声称 M45 的真实付费上游验收通过。

### 3.2 已经拿到的东西：真实契约（据真实样本与上游文档核对）

- `getinfo` 成功字段：`name`／`user_name`(gh_xxx)／`signature`／`hd_head_img`（http）。
- `getps` 成功字段：`list[]`／`wxid`／`cursor`；列表项：`art_url`／`title`／`pub_time`／`pic_url`／`sn`。
- `art_url` 是 **http** 且参数之间用 `&amp;` 分隔；只解一层安全实体后再升 https。
- 业务码全表：`0` 成功（扣 5 分）／`1000` 积分不足或密钥无效（msg 带剩余余额）／`1001` 缺 wxid／
  `1002` wxid 校验失败／`1003` cursor 校验失败／`1004` 请求失败／`1005` 超时／`9999` QPS 超限；
  **code≠0 一律不扣**。
- 一页 = 10 次推送 × 每次最多 8 篇（头条 idx=1，副条必须保留）；同推送共享 `mid`。
- QPS 上限 5/秒；游标 24 小时有效（**观察值，不当永久保证**）。

据此修掉 BUG-131／BUG-133（详见 `docs/BUG_FIXES.md`）：旧解析器在真实数据上会整页判成
`SCHEMA_CHANGED`；游标被上游拒绝后检查点不失效。

### 3.3 替代验证：真实传输层 + 本机真实 HTTP 上游（已通过）

这不是真实上游的替代品，但它把**除了「真实上游会怎么答」以外的全部环节**都在真实网络条件下跑通了。

- 传输层：产品的**真实传输层**（真实 urllib、真实 JSON 请求体、真实超时、**拒绝一切重定向**）。
- 上游：本机 HTTP 服务（`scripts/wxrank-mock-upstream.cjs`），响应形状严格照 3.2 复刻。
- 入口：新增验收档位 `SUBSCRIBE_FLOW_WXRANK_FIXTURE=http`，**只允许回环地址**，
  非回环直接拒绝启动（请求体里带着密钥，绝不能发到本机以外）；生产启动不设置该变量。

**A. 进程内（Core + 正式 RPC）验收**：`batch-03/real-wxrank-check.py`

| 步骤 | 调用 | 观察 |
| --- | --- | --- |
| 本地状态读取 | 0 | 未配置时读状态不触网 |
| 保存密钥 | 0 | 走产品凭据桥与设置写入；状态转为已配置 |
| 冷解析 | 1 | 密钥只在请求体、**不在 URL**；头像按 `hd_head_img` 解析并升 https；简介按 `signature` 解析 |
| 确认添加 | 0 | 命中解析缓存，不再收费 |
| 刷新一页 | 1 | 10 条真实入库；地址已解开一层转义（`https://mp.weixin.qq.com/s?...mid=...`）、发布时间与封面正确 |
| 回溯一页 | 1 | 请求带的是 `C1`（不是空游标）→ 累计 20 条、15 积分 |
| **重启隔离应用后续采** | 1 | 检查点活过重启，请求带的是 `C2` → 累计 30 条、20 积分 |
| 末页 | 1 | 请求带 `C3` → 空列表 → `coverage=history_end`、`complete=true`，检查点随之清掉 |
| 业务失败 `code=1000` | 1 | `charge_state=not_charged`、`errorCode=AUTH_REQUIRED` |
| 上游 302 重定向 | 1 | 传输层拒绝跟随，重定向目标**未被访问**，`charge_state=unknown`（不假报零消费） |

汇总：**7 次调用、25 积分已确认消费、1 次结果未知**；每次请求都确认 `hasKey=true` 且 `keyInUrl=false`。
证据：`batch-03/real-wxrank-evidence.json`。

**B. 正式界面链路验收**（Renderer → Preload → Main → Core → 真实传输层 → 真实 HTTP）：
`npm run smoke:wxrank:real`，脚本 `scripts/wxrank-real-smoke.cjs`＋`scripts/wxrank-real-acceptance.cjs`。

```json
{"wxrankUi":"passed","upstream":"local-http (真实响应形状，非真实付费上游)",
 "calls":4,"confirmedCredits":20,"contents":30,"checkpointAfterBackfill":"resume"}
```

覆盖：卡片渲染、密钥保存后加密落盘（磁盘无明文）、免费本地检查**零调用零费用**、
添加来源只解析一次、采集条数设为 10 后刷新按实际显示「本次最多 1 次调用 · 约 5 积分」、
回溯对话框显示调用次数与费用且写明「0 条新内容也可能收费」、回溯后内容增长且检查点为 `resume`、
来源「打开主页」禁用、详情显示「仅列表信息（未获取正文）」。
证据：`batch-03/real-wxrank-ui-evidence.json`；截图 5 张在 `batch-03/screenshots/`（已逐张查看）。

---

## 4. 预计与实际调用／费用

| 场景 | 预计 | 实际 | 说明 |
| --- | --- | --- | --- |
| 真实付费上游（冷解析＋刷新＋两次回溯） | 4 次 ≈ 20 积分 | **0 次 ≈ 0 积分** | 无授权密钥，未执行 |
| 显式付费测试（最多再加一次） | 1 次 ≈ 5 积分 | 0 次 | 未执行（本地验收里替代验证已覆盖该 RPC 的成功／业务失败／网络未决三条路） |
| 真实 LLM 探针 | 小型推理 | 2 次连接测试 | 243 tokens；input 289／output 20 |
| 本机上游（不产生真实费用） | — | 进程内 7 次／界面 4 次 | 7 次计 25 积分、1 次未知；界面 4 次计 20 积分 |

---

## 5. 主要验证

```
cd python && PYTHONPATH=src python3 -m unittest discover -s tests -t .
→ Ran 633 tests … OK      （test_wxrank.py 75 项）

cd Subscribe_Flow && node --test tests/*.test.cjs
→ 155 / 155 / 0 fail

cd Subscribe_Flow && npm run smoke:wxrank
→ {"wxrankUi":"passed","confirmedCredits":15,"calls":3,"contents":10}

cd Subscribe_Flow && npm run smoke:wxrank:real
→ {"wxrankUi":"passed","calls":4,"confirmedCredits":20,"contents":30,"checkpointAfterBackfill":"resume"}

python3 docs/verification/m45-minimax/batch-03/real-llm-check.py
→ provider-llm ok=True calls=1（200，243 tokens）；provider-jev ok=True calls=1（200，input 289／output 20）

python3 docs/verification/m45-minimax/batch-03/real-wxrank-check.py
→ calls=7, confirmedCredits=25, unknownCharges=1；游标 C1→C2→C3；重启后接着 C2 续采
```

新增回归（9 项）：真实契约 6 项（链接单层解转义／实体名不误伤／真实账号字段／真实列表含副条／
七种业务码各自的错误码与不重试／真实 `art_url` 字段）＋付费页语义 2 项（宽页不按估算截断／
游标被拒后丢检查点）＋检查点语义 1 项（刷新也推进检查点）。

---

## 6. 完整 M45 范围（三批六步）

| 步骤 | 能力 | 状态 |
| --- | --- | --- |
| M45.1 | 协议／biz／locator／内容身份／计费契约冻结，脱敏样本 | 完成 |
| M45.2 | 迁移 015（账本／来源缓存／检查点）、`channels.wxrank` 设置分区、渠道凭据生命周期 | 完成 |
| M45.3 | 非阻塞传输、业务层（记账／缓存／单飞／限流）、正式 Adapter、受控 RPC | 完成 |
| M45.4 | 任务上限内有界分页、刷新从头部、回溯按持久检查点推进、页数据与检查点同事务、版本与过期识别、终止证据、调度器不静默重放付费请求 | 完成 |
| M45.5 | 正式界面：渠道卡片、受保护密钥、免费本地检查、显式付费测试、用量与余额观察、清缓存、解析→确认添加、刷新／回溯费用说明、自动检查配置、主页导航禁用、正文语义 | 完成 |
| M45.6 | 真实 LLM 验收 | **完成** |
| M45.6 | 真实付费上游验收 | **外部阻塞，未验证**（见 3.1） |

---

## 7. 未验证与已知限制

1. **真实付费上游（data.wxrank.com）未验证**：没有授权密钥。真实上游可能还有本批没有覆盖到的行为
   （真实积分余额、真实 QPS 表现、真实 cursor 过期行为、真实副条密度、真实 `hd_head_img` 是否始终 http）。
   这些只能在拿到密钥后由 Codex 复验。
2. **本机上游不等于真实上游**：响应形状是照契约复刻的，真实上游的边角行为可能不同。
3. 游标 24 小时有效与「一页最多 10 次推送」来自上游文档与少量样本，**不当永久保证**。
4. 来源的头像与简介不落库（`sources` 表没有这两列，所有渠道通用，BUG-136）。
5. 公众号来源的「打开主页」按钮已禁用但视觉上仍像可点（BUG-134）；任务状态条里「新增 N 条」重复（BUG-135）。
6. 未打包、未推送、未发布；版本仍 0.5.2。
7. 未改动用户日常数据库、登录态与通知偏好；未停止其他应用；全部验证都在隔离数据目录与本轮进程里完成。

---

## 8. 拿到真实密钥后怎么补验（给 Codex 的入口）

1. 把密钥放进用户指定的受保护凭据文件（**不要**写进仓库、提示词或证据）。
2. 用本机脚本把密钥安全注入隔离应用的受保护凭据，跑：
   `python3 docs/verification/m45-minimax/batch-03/real-wxrank-check.py` 的真实上游变体
   （把 `protocol.API_ROOT` 指回 `https://data.wxrank.com`，去掉本机上游与假密钥）。
3. 核对：冷解析 1 次、确认添加 0 次、刷新 1 次、两次一页回溯 2 次（合计 4 次 ≈ 20 积分）、
   游标确实推进、重启后接着上次游标续采、`code=0` 计费与余额观察时点。
4. 真实调用**集中且少量**：不为重复截图、轮询、重复启动或整套测试再消费。
