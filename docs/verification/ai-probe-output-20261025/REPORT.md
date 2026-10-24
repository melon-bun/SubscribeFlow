# BUG-126：连接测试输出预算过低，推理模型可能没有最终正文

日期：2026-10-25（Asia/Tokyo）。用户在白名单修复后反馈“模型服务返回了空内容”。Codex独立调查并修复连接探针预算。

## 证据与范围

连接测试原来固定 max_tokens=16，推理与最终回答共用这一预算。真实MiniMax-M3比较：16预算时finish_reason=length、completion_tokens=16、其中reasoning_tokens=15；1024预算时finish_reason=stop、completion_tokens=32、其中reasoning_tokens=22。见budget-comparison.json，只保存长度/状态/用量，不保存响应正文或凭据。

本次真实MiniMax样本16预算仍返回了87字符（思考文字），因此没有在该次请求复现用户的空正文；但已证实16预算在回答完成前截断。对把reasoning_content和content分开的响应，用同样预算会在最终正文产生前耗尽；新增固定传输用例修复前复现完全相同的“模型服务返回了空内容”，修复后通过。此前一次真实按钮成功不足以覆盖这个情况。

## 最小修复

公共AiGateway仅将连接探针预算从16改为有界的1024；每次测试仍只发一次请求，不改判断/总结/打标的调用预算，不改变Jev逻辑，不将空正文或思考字段冒充正常答案。

## 验证

- 新回归：推理消耗小预算时最终正文为None，预算足够后才有OK；修复前失败、修复后通过。
- 新回归：即使有reasoning_content，真正没有content仍返回invalid_response，不虚报成功。
- AI层28项测试全部通过，见python-ai-tests.log。
- 最终正式Electron设置页真实点击LLM测试按钮：1次调用、MiniMax-M3返回ok=true，界面显示连接正常。见live-ui-evidence.json。
- 证据扫描无测试密钥，使用独立临时数据/内存凭据，未修改用户日常配置或数据。未打包/推送/发布。

需要重启Core或应用来加载Python修改。若其他模型仍返回空正文，需要结合该模型实际响应继续定位，不能把所有空正文都推定为预算原因。
