# M45 第五批交付说明：真实公众号付费渠道验收（batch-05-live-wechat）

- 日期：2026-10-25
- 分支：`feature/m45-wxrank-paid-channel`
- 产品源码 HEAD：`ac77059`（本批新增：Core 侧 HTTPS 信任库兜底，BUG-138）
- 验收所依据的产品实现：`3807196`（第四批核心返修）+ `ac77059`
- 真实上游：`https://data.wxrank.com`（`protocol.API_ROOT` 默认值，未改写）
- 传输层：正式 `WxrankTransport`（真实 HTTPS；**未启用任何 fixture／本机假上游开关**）
- 证据：`live-wxrank-evidence.json`（脱敏）、`CREDENTIAL_CORRECTION.md`（凭据更正说明）
- 验收脚本：`live-wxrank-check.py`（本目录，硬上限 5 次调用，失败也留证）

## 一、结论

**真实付费上游验收通过。** 5 次真实调用全部成功，25 积分确认消费，0 次「结果未知」，
服务端余额与本地账本一致（55 → 30），真实文章入库 40 条，两次一页回溯游标确实推进，
隔离重启后检查点存活并能继续回溯。

本轮**唯一**的消费来自这次真实验收（5 × 5 = 25 积分）。没有再调用真实 LLM／Jev，
没有重复跑整套测试，没有为「证明而多花钱」。

## 二、凭据纪律

- 密钥只由本机进程按**组名**解析 `test_api_key.md` 的 `wechat` 分组，全程只在内存：
  不打印值或片段、不进模型上下文、不写源码／日志／证据。
- 脚本只输出布尔「wechat 凭据已识别」，以及脱敏身份（`bizMasked`／`wxidMasked`）。
- 公众号身份取自**已授权的本机实验缓存**（真实 biz 与 wxid），不凭空猜 biz。
- 详见同目录 `CREDENTIAL_CORRECTION.md`：**wechat 分组密钥原本就存在**，
  先前「缺少公众号密钥」是分组识别漏判，不是用户没提供。

## 三、真实调用、费用与余额

| 步骤 | 付费调用 | 累计调用 | 累计确认积分 | 服务端余额 | 结果 |
|---|---|---|---|---|---|
| 保存渠道密钥 | 0 | 0 | 0 | — | 已配置（受保护存储） |
| 免费本地检查 | 0 | 0 | 0 | — | `readinessState=ready`（零付费请求） |
| 冷解析 | 1 | 1 | 5 | 50 | `code=0`，来源名「超级美工」，`external_id` 与已授权缓存一致 |
| 确认添加（命中解析缓存） | 0 | 1 | 5 | 50 | **没有再收一次费** |
| 单页刷新（真实入库） | 1 | 2 | 10 | 45 | 入库 9 条，链接／时间／标题均为真实字段 |
| 第 1 次一页回溯 | 1 | 3 | 15 | 40 | 入库 19 条，检查点 `resume` |
| 第 2 次一页回溯 | 1 | 4 | 20 | 35 | 入库 29 条，检查点 `resume` |
| 隔离重启（零付费核对） | 0 | 4 | 20 | — | 检查点重启前后都是 `resume`，29 条仍在 |
| 重启后回溯续采（一页） | 1 | 5 | 25 | 30 | 入库 40 条，任务 `succeeded` |

- 账本：5 次调用、**确认消费 25 积分**、`unknownCount=0`（没有「扣费结果未知」）。
- 余额观察：服务端返回的余额依次 50 → 45 → 40 → 35 → 30，
  最近一次观察时点 `2026-10-25T13:58:38Z`（JST 22:58）。**此后未再调用业务 API。**
- 每次调用都是 HTTP 200 + 整数业务码 `0`；传输层未遇到重定向、非 JSON 或超时。

## 四、真实数据核对

- **账号身份**：真实 biz（脱敏 `MzA3…Ng==`）→ 上游返回的账号名「超级美工」，
  `external_id`（脱敏 `gh_a…6eac`）与已授权实验缓存**一致**（脚本硬断言，不一致即失败）。
- **文章链接**：真实 `art_url` 已按真实契约解开一层 `&amp;` 转义并升为 https，
  形如 `https://mp.weixin.qq.com/s?__biz=…&mid=…&idx=…&sn=…`（证据里只留脱敏片段）。
  脚本断言了 `mid=` 与 `idx=` 存在、且不含 `&amp;`。
- **文章时间**：首条 `published = 2026-10-23T09:00:00+08:00`（真实上游时间）。
- **入库与去重**：刷新 9 条 → 回溯 19 条 → 29 条 → 40 条，逐页递增且无重复，
  与「付费页按整页保存」的语义一致（每页 10～11 条，不裁剪已购条目）。
- **游标推进**：两次一页回溯后检查点都是 `resume`，备注「从上次已提交成功的页继续」，
  没有重买头页、没有 0 新增。
- **重启续采**：隔离重启（新建 Core、同一数据库）后检查点状态与条数不变，
  再回溯一页成功入库到 40 条。

## 五、本批修的一个实质问题（BUG-138）

**现象**：首轮真实调用在 TLS 阶段就失败（`DEPENDENCY_UNAVAILABLE`「无法完成上游请求，
扣费结果未知」）。请求在握手前就断了，**没有到达上游，没有产生任何扣费**。

**根因**：本机 python.org 的 CPython 3.12.5（OpenSSL 3.0.13）把 OpenSSL 指向一个
不存在的证书路径，`ssl.create_default_context()` 装不到**任何** CA
（`/etc/ssl/certs` 是空目录），于是 Core 侧每一次 HTTPS 都必然
`CERTIFICATE_VERIFY_FAILED`——付费渠道在本机**完全不可用**。
浏览器渠道不受影响（Chromium 自带信任库），所以这个洞只在 Core 直连上游时暴露。

**这不是上游不可信**：上游只下发叶子证书（链长 1，签发者 `CN=YE1`，
有效期 2026-09-26 → 2026-12-25），叶子 ← YE1 的签名验签成立；
Node 26.7.0 用自带信任库 `authorized=true`；修好信任库后 Python 同样验通。

**修复**（提交 `ac77059`）：新增 `python/src/subscribe_flow/channels/http.py`，
Core 侧共用一个信任库上下文——默认库为空时依次尝试
`SSL_CERT_FILE` → `certifi` → 常见 CA 包位置，并把 `certifi` 与系统库**取并集**
（补上系统库缺失的 Let's Encrypt 根与中间证书）。
**校验一个字都没放宽**：找不到任何 CA 就让请求大声失败，不去信任任何东西，
不使用 `CERT_NONE`，不注入未认证来源的证书。

**验证**：
- 产品链路实测：`WxrankTransport` 的 opener 访问上游首页拿到 HTTP 302（TLS 与 HTTP 均通）。
- 模拟「机器上没有 certifi」时仍走系统 CA 包兜底并验通。
- 新增 `python/tests/test_http_trust.py` 3 项聚焦回归（校验开启、能装到 CA、上下文复用）。
- `cd python && PYTHONPATH=src python3 -m unittest tests.test_http_trust tests.test_wxrank`
  → **Ran 83 tests … OK**（wxrank 聚焦 80 + 新增 3）。

## 六、已知限制与未完成项

1. **首轮失败的那次尝试**记在账本里是 `chargeState=unknown`。它失败在 TLS 握手前，
   请求没有发出，因此**没有真实扣费**；但我们没有上游的扣费流水可以反查，
   所以这里按「未观察到扣费」记录，不假称已向服务商核对。
2. 本批之前遗留的非致命项按用户口径**只记录不派修**：
   BUG-132 首次多页刷新重扫残余、BUG-134（公众号「打开主页」按钮视觉上仍像可点）、
   BUG-135（状态条「新增 N 条」重复）、BUG-136（来源头像与简介未落库，跨渠道表结构问题）。
3. `channels/github/transport.py` 里另有一份自己的 `_ssl_context()` 兜底实现，
   与本批新增的共享实现功能重复。本轮**没有**动它——不在本批范围，且不牵涉本次阻断。
4. 真实上游的正文仍只取列表信息（产品既定口径：正文标「仅列表信息（未获取正文）」），
   公众号文章正文抓取不在 M45 范围。
5. 本轮**没有**重新打包、推送、发布，也没有改动日常数据库／登录／通知偏好；
   全部数据都在隔离临时库与隔离 Core 进程里。

## 七、是否具备「全 M45 完成」的条件

- M45 的**真实付费验收**已通过：真实上游、真实密钥、真实扣费、真实入库、
  真实游标推进、真实重启续采，都已留证。
- M45 的**实现部分**已由 Codex 独立验收（80 项 wxrank 聚焦测试 + 正式界面本机 HTTP 链路）。
- 仍待 Codex 做**最终独立验收**；本文件不代它下「全 M45 全部验收通过」的结论。
- 版本仍 0.5.2，未打包／推送／发布。

## 八、本批文件清单

**产品代码（提交 `ac77059`）**
- `python/src/subscribe_flow/channels/http.py`（新增：共享信任库）
- `python/src/subscribe_flow/channels/wxrank/transport.py`（改：改用共享上下文）
- `python/tests/test_http_trust.py`（新增：3 项聚焦回归）
- `scripts/verify-chain.cjs`（新增：证书链逐跳验签工具）

**验收与证据（本目录）**
- `live-wxrank-check.py`（真实付费验收脚本，硬上限 5 次调用）
- `live-wxrank-evidence.json`（脱敏证据）
- `CREDENTIAL_CORRECTION.md`（凭据更正说明）
- `precheck-tls.py`、`probe-trust-store.py`、`probe-trust-fallback.py`、
  `probe-openssl-verify.py`、`probe-certifi-cn.py`、`probe-upstream-tls.py`、
  `probe-tls-matrix.py`、`diagnose-chain.py`、`diagnose-ca-bundles.py`、
  `diagnose-tls.py`、`fetch-aia.py`、`verify-chain.cjs`、`check-signatures.cjs`、
  `check-akid.cjs`、`diagnose-chain-node.cjs`、`collect-chain.py`、
  `inspect-credential-shape.py`（本批诊断脚本，只读公开信息，不含凭据）
- `wxrank-chain/`（公开证书材料：叶子与 AIA 中间证书 PEM）

**文档**
- `docs/BUG_FIXES.md`（新增 BUG-138，附验证结果）
- `docs/PROGRESS.md`、`docs/HANDOFF.md`、`docs/M45_WXRANK_IMPLEMENTATION.md` 同步实际结论
- `docs/reference/DEVELOPMENT_PLAN.md` 与仓库外 `doc/DEVELOPMENT_PLAN.md` 同步镜像
