# BUG-143 单微信 Adapter 验收

日期：2026-10-27（Asia/Tokyo）。分支 `fix/bug-143-unified-wechat-adapter`；产品提交 `170cd98761251f7377f77e97a9fa25edbab52bb8`。状态：源码隔离验收通过，版本仍为 0.5.3.2，未打包。

## 实现

只注册一个 `WechatAdapter`，公开模型为 `wechat / electron-session / wechat:default`，同时提供订阅列表与人工单篇能力。Adapter 内部按操作调用付费服务或页面读取，共用公共 Sync、Intake、Gateway 和仓储。删除独立 WxrankAdapter／平台项。来源和文章身份分别按规范 biz 与 biz+mid+idx 统一，重复导入遵守首次收录口径。

供应商配置、受保护密钥引用与账本继续使用 wxrank；持久账号绑定独立于可清资料缓存。内容使用通用 body_state 描述正文状态，费用、主页和详情能力来自真实契约。

schema v16 在启动任务前同事务归一旧来源、内容、连接及关联，保留有效历史游标、日程、凭据和未知扣费阻塞。旧记录与用户数据冲突保存在本机迁移档案。升级前创建不覆盖备份；映射冲突或外键失败整体回滚。升级后旧程序不能直接打开 v16，回退须使用升级前备份；本轮未触碰日常数据库。

## 验证

| 检查 | 结果 |
|---|---|
| 完整 Python | 664/664，通过 |
| 完整 Node | 159/159，通过 |
| v16 专门迁移 | 9 项，通过；包含 v2→v16、双向重复、冲突归档、AI 引用、费用／游标／阻塞、回滚备份、幂等 |
| 人工正式 Renderer | 通过；无付费密钥、3 条手动内容、全文、别名、原始时间／日历、风控、重启及方式筛选 |
| 付费夹具正式 Renderer | 通过；单平台／连接／双能力，3 次假调用、15 模拟积分、10 条，费用与方式筛选／正文状态 |
| 本机 HTTP 正式 Renderer | 通过；真实传输接线，4 次调用、20 模拟积分、30 条，回溯保持 resume |
| 通用正式 Renderer | 通过；25 条隔离内容，搜索、并发写与刷新、列表／日历／看板／标签／优先级、重启／重载持久化 |

两个导入顺序均只存一篇、一个来源；通用仓储并发查重回归通过。清缓存后已订阅来源直接使用持久 gh_id，不额外发解析请求。人工免费操作不会解除付费列表的 AUTH／DEPENDENCY 阻塞；付费请求排队后会重检关闭、启用与凭据，等待期间失效时不发送。相关 6 项确定性回归通过。

初次完整 Python 的一项总结线程测试依赖“瞬时响应在下一轮事件循环一定未完成”，出现时序失败。测试已使用显式事件保持请求在途验证事件循环可调度；生产执行方式未变，最终完整 664 项通过。既有测试仍输出部分 SQLite 资源警告，本轮没有把警告作为通过项或产品修复内容。

未调用真实平台、付费上游、LLM 或 Jev，未读取日常数据，未推送或发布。

## 证据与复跑

- [结构化结果](results.json)、[界面聚合](ui-acceptance.json)、[本机 HTTP 调用记录](http/real-wxrank-ui-evidence.json)
- [完整 Python 日志](python-final.log)、[完整 Node 日志](node-final.log)、[通用界面日志](general-renderer.log)
- [单微信平台与列表信息截图](wxrank/bug143-unified-platform-filters.png)、[人工全文截图](manual/m14-wechat-saved-detail.png)

项目根目录执行 `npm test`、`npm run test:py`；三项微信界面回归为 `npm run smoke:wechat`、`npm run smoke:wxrank`、`npm run smoke:wxrank:real`，均默认使用隔离夹具／本机假上游。通用界面回归执行 `npm run smoke:renderer`。设置 `SUBSCRIBE_FLOW_VERIFY_OUTPUT` 指定本轮证据目录，避免覆盖历史验收。

Bug 的现象、原因、固定合并规则与提交统一维护在 [BUG-143](../../BUG_FIXES.md#bug-143微信自动采集与人工添加被拆为两个渠道采集架构与其他渠道不一致)。
