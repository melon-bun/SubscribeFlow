# Subscribe Flow · 知流

本地优先订阅聚合桌面应用，Electron + 原生 HTML/CSS/JavaScript + Python + SQLite。
默认启动已接入真实业务的 F1 界面；F1 独立交付目录 `../Subscribe_Flow_F1/` 保持不变。

## 启动

```sh
npm install
npm run configure
npm start
```

本机已完成依赖安装和路径配置，可以直接 `npm start`。请使用独立桌面窗口；
普通浏览器打开 HTML 只会显示启动说明。业务数据存入 Electron 应用用户目录，不进入 Git。

从“渠道管理”添加作者 UID/主页，核对身份后确认，再手动刷新。
可以查看投稿、按日历浏览、标记已读/稍后处理/归档，查看任务、取消或重试。
B站已改为应用内独立会话：在“渠道与连接”里登录，无需外部 Chrome、扩展或 OpenCLI。
关闭登录窗口后仍可采集；登录信息保存在应用自己的 Chromium 分区中。
新会话的匿名投稿请求收到 B站 -352 验证要求，登录后真实采集仍待验收，详见问题记录。
列表未提供封面或摘要时，可尝试“补充详情”。

首期只有 B站；分页窗口不代表完整历史。优先级/规则/标签/收藏尚未接入。
M6 自动调度与 M7 独立安装包未开始。M4 最小联调页仍可用：

```sh
SUBSCRIBE_FLOW_DIAGNOSTICS=1 npm start
```

旧 OpenCLI 的间歇性 `Navigation rejected` 已移出桌面采集路径，旧根因未查明。
M6 按用户要求暂缓，先完成应用内会话的真实采集验收。详见 [已知问题](docs/KNOWN_ISSUES.md)。

## 开发验收

```sh
npm test
npm run smoke:desktop
npm run smoke:renderer
cd python
PYTHONPATH=src python3 -m unittest discover -s tests -t . -v
```

应用内会话与真实平台验收：

```sh
npm run smoke:session
npm run bilibili:login
npm run smoke:bilibili:live
```

真实验收使用独立的应用会话和数据库，用户在官方页面登录；不读取 Chrome Cookie。

Python 需要 3.12+。可在 `python/` 下使用 `uv sync` 安装开发入口；运行时仅用标准库。
旧 OpenCLI 渠道独立入口（不代表当前桌面后端）：`python3 python/tools/channel_probe.py describe`。

详见 [进度](docs/PROGRESS.md)、[交接](HANDOFF.md)、[已知问题](docs/KNOWN_ISSUES.md)、
[F1 接入](docs/frontend/IMPLEMENTATION.md)、
[桌面说明](docs/DESKTOP.md)、[业务 API](docs/API.md) 和 [存储约定](docs/STORAGE.md)。
权威计划在 `../doc/DEVELOPMENT_PLAN.md`，仓库保留 [文档快照](docs/reference/README.md)。
