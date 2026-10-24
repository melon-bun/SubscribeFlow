# BUG-125：AI API连接测试被Preload拒绝

日期：2026-10-25（Asia/Tokyo）。用户反馈LLM测试返回“测试失败：不允许调用此方法”。Codex调查并最小修复，已验证。

## 原因与修复

设置页测试按钮调用 Renderer AppClient.testAiProvider，实际转为固定RPC `ai.provider.test`。Main的CORE_METHODS和Python dispatcher已支持，但Preload的allowed遗漏该方法，直接返回FORBIDDEN_METHOD，请求没有到模型服务。`ai.provider.list`同样遗漏。

仅在Preload白名单补上这两个既有固定方法；不改模型、地址、密钥、判断策略，也不开放任意RPC。1/3两项间距交原MiniMax并行处理，Codex不改其样式文件。

## 验证

- 新增 `tests/ai-provider-bridge.test.cjs`：真实Renderer客户端工厂＋实际Preload代码＋Main方法校验。修复前复现相同FORBIDDEN_METHOD和中文错误；修复后测试通过，任意方法与原始settings.update仍被拒绝、未触发IPC。
- `npm test`：150/150通过，日志 node-tests.log。
- 正式Electron＋Core，独立临时数据，程序从用户授权test_api_key.md在主进程读入测试凭据，只通过Core私有凭据接口放入内存，不把密钥送入Renderer、报告或截图。
- 实际点击设置页LLM卡片“测试连接”：1次调用，真实MiniMax-M3返回ok=true，界面显示“连接正常：MiniMax-M3。连接正常，协议可用。”。见 live-ui-evidence.json。
- 已扫描本目录证据/日志/验证脚本，无测试密钥。未修改日常数据库、AI配置或登录态，未打包/推送/发布。

验证脚本初次有等待选择器与文本提取的测试自身问题，校正后完成上述正式按钮实测；未据此更改产品或扩大修复范围。两处间距仍以MiniMax交付和Codex后续验收为准。
