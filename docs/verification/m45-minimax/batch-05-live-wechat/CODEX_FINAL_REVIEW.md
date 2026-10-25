# M45 Codex 最终独立验收

日期：2026-10-25（Asia/Tokyo）。产品源码ac77059，交付文档fcc0134；此前实现基线3807196已独立通过80项wxrank聚焦测试及正式Renderer本机HTTP链路。

## 结论

M45本次授权范围完成并验收通过，非致命遗留按用户口径仅记录。未打包、未推送、未发布，版本仍0.5.2。本次只做审查，没有恢复定时开发或重复调用任何真实模型/付费API。

## 本次核验

1. 代码核对：ac77059仅为既有wxrank HTTPS客户端接入信任库兜底，优先既有环境/受支持系统CA和certifi；SSLContext保持check_hostname=True与CERT_REQUIRED，未关闭校验，也未注入本次抓取的叶子/未知根。
2. 独立实际运行：PYTHONPATH=src python3 -m unittest tests.test_http_trust，3项通过（0.334s），没有网络调用。
3. 真实证据核查：live-wxrank-check.py使用正式Core/Dispatcher/WxrankTransport，API_ROOT为https://data.wxrank.com，未启用fixture；wechat分组key只由本机进程解析并进Core内存。核对代码及live-wxrank-evidence.json的一致性断言全部通过。
4. 本批5条调用记录均succeeded/confirmed，各5积分，确认合计25积分；余额观察依次50/45/40/35/30。免费配置检查和确认添加没有新增付费请求。
5. 内容条数9→19→29→40；两次回溯均推进；隔离重启前后检查点resume，重启后续采succeeded并新增11条。未为独立验收重复付费。
6. 真实LLM与Jev正式产品调用的成功证据已于第三/四批审查，未重复调用。

## 证据边界与纠正

- 第五批最初后台runner退出137，不能把该运行状态改为succeeded。后续原MiniMax会话交付了ac77059/fcc0134提交，当前验收依据是实际最终代码及业务收据，不依赖其早期进程状态。
- 真实公众号服务证据来自正式Core/RPC；正式Renderer/Main/Preload整链此前用本机HTTP替身独立验证通过。没有把本机上游伪称真实服务，也没有为了补一套真实UI截图再次收费。
- 成功验收批次5条记录unknownCount=0；先前TLS失败尝试曾记unknown，不能将其全局改成确认零扣费。当前只确认成功批次的25积分账本及观察到的余额，不声称拿到供应商全账户扣费流水。
- wechat密钥从最初就存在于用户指定文件，之前“缺key”是分组识别漏判。旧报告保留为历史，当前已纠正，不再等待用户补文件。
- 不采信早期不完整FFI探针关于X1链的解释；固定公开证书的独立ctypes诊断另见codex-openssl-chain/REPORT.md。链根因研究不再作为本次功能交付门槛。

## 仅记录的非致命遗留

BUG132首次多页刷新后的首次回溯可能重扫部分已采页，但仍能推进、费用账本与调用上限正确；BUG134主页禁用按钮样式不明显；BUG135新增条数提示重复；BUG136来源头像/简介未落库。未单独派修。
