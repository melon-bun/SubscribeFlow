# 0.5.2 本地优化与打包

用户授权（2026-10-24）：小红书采集时截取笔记封面，尺寸适配应用；修复小红书原文链接超出屏幕。只在本地提交与打包 0.5.2，不推送远端、不上传 Release。

## 实施范围

- 在既有小红书详情读取路径中截取首张封面，涵盖订阅采集、单条收录和补充详情。使用现有应用内会话，截图保持窗口隐藏。
- 封面按卡片 96×72 CSS 像素保存 192×144 像素 JPEG（2x），随内容存储为有界内嵌缩略图，重启及离线时可显示；无需新增 schema 或文件服务。
- 封面缺失或图片未成功加载时保留原有内容采集能力；登录、验证和取消继续遵循原错误契约。
- BUG-121 续修：详情原文按钮限宽，文字在面板内省略，完整原始分享链接与打开行为保留；同时覆盖深浅主题和窄窗。
- 更新四处版本为 0.5.2，验证后生成本地 macOS Intel 安装包与校验文件。README 公开下载入口继续指向已发布版本。

## 当前状态

**0.5.2 已完成本地打包和正式安装包验收。未推送远端、未创建远端标签、未上传 Release。**
源码基线为 `0154da8`（0.5.1），产品修改 `c2f7f78`，最终构建基线 `b9892a833d89b45d17f80776d45c07edcb58238e`；后续仅更新文档和证据。远端 main 经只读核对仍为 `0154da8`。

## 已完成的验证

- Node 148/148、小红书 Python 9/9、完整正式 Renderer 回归通过。
- 原生封面专项：三张不同颜色的样本均为 192×144 像素，可验证到图像边缘和中心，截图窗口不显示且用后释放；取消不会留下窗口。
- 正式小红书 Main／Renderer／Core 隔离流程通过：订阅采集截图、重复窗口去重、Core 重启与 Renderer 重载后封面保持，失效登录不影响已保存内容。
- 超长分享链接修前按钮约 3578px，修后 359px；面板滚动宽由 3598px 降至可见宽 399px，深浅主题及紧凑窗口通过。
- 本轮使用隔离站点与合成图片，未操作日常库或真实登录；真实小红书站点未在本轮重测。

## 实现与验收维护

隐藏 WebContentsView 直接截图会返回 `UnknownVizError`，因此使用同一渠道 Session／官方来源 Referer 的离屏 BrowserWindow，仅渲染封面图片并截取 96×72 的画布，再编码为 2x JPEG。读取有独立超时和取消清理，Python 适配器仅接受有界 JPEG；未改 schema。实现依据 [Electron 离屏渲染文档](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)。

既有小红书验收脚本因渠道连接折叠行新增同名 data 属性而误选页面元素，已将弹窗控件选择限定在 `.dialog` 内（沿 BUG-052 的验收维护），无产品交互修改。

既有条目仍遵循已知 ID 去重规则；「补充详情」会走同一封面读取路径。1024px 窄窗旧页头挤压在修复前后均存在，沿 BUG-121 记录待后续；本次不将其标为已修复。


打包前检测到旧版 `dist/Subscribe Flow-darwin-x64/Subscribe Flow.app` 正在运行。因此构建目录按版本隔离为 `dist/0.5.2/`，根目录下载 ZIP 的文件名仍含 0.5.2。保持旧版应用和用户数据原样运行，不结束其进程；正式包验收继续使用独立临时目录。


## 本地安装包

- 安装包：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/Subscribe-Flow-0.5.2-mac-x64.zip`（3096 字节）。
- 校验文件：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/Subscribe-Flow-0.5.2-mac-x64.zip.sha256`。
- SHA-256：`5ddd550d40a6654eed5f777b92426111edcb11d62422b3731a17d9f906703e82`。
- 应用目录：`/Users/xor/Documents/Subscribe_Call/Subscribe_Flow/dist/0.5.2/Subscribe Flow-darwin-x64/Subscribe Flow.app`。

macOS Intel（x64），内置 Electron 44.5.1 与 Python 3.12.5，本机 ad-hoc 签名。退出旧版后再打开新版；本轮未安装或替换用户正在运行的旧版。

最终安装包的 61 个 Main／Preload／Renderer 文件逐字节匹配构建源码，原始 logo、应用图标与打包白名单通过；签名、ZIP 和 SHA 校验通过。包移到项目目录外，用最小 PATH 启动，确认内置 Core、开发验收标志忽略、v2→v12 升级与备份、笔记／总结设置／优先级／标签持久化、Core 自动恢复与缺失提示均通过。另以冻结 Core 验证小红书本地 JPEG 入库及重启后保持。

证据：[本地构建收据](verification/v0.5.2-local/local-build-receipt.json)、[正式包结果](verification/v0.5.2-local/packaged/result.json)、[包内文件核对](verification/v0.5.2-local/package-content.json)、[构建日志](verification/v0.5.2-local/build.log)。
