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
本轮首次真实采集已通过；后续搜索及再次采集复验均出现 OpenCLI 拒绝导航。页面会显示实际错误，
不会伪装成功。搜索成功及详情的完整桌面验收待外部访问恢复后复验。
列表未提供封面或摘要时，可尝试“补充详情”。

首期只有 B站；分页窗口不代表完整历史。优先级/规则/标签/收藏尚未接入。
M6 自动调度与 M7 独立安装包未开始。M4 最小联调页仍可用：

```sh
SUBSCRIBE_FLOW_DIAGNOSTICS=1 npm start
```

## 开发验收

```sh
npm test
npm run smoke:desktop
npm run smoke:renderer
cd python
PYTHONPATH=src python3 -m unittest discover -s tests -t . -v
```

显式真实平台验收（使用现有浏览器会话，业务数据仅写临时目录）：

```sh
npm run smoke:renderer:live
# 搜索被平台阻塞时，只验证 UID 路径与详情，跳过搜索：
npm run smoke:renderer:live -- --uid-only
```

Python 需要 3.12+。可在 `python/` 下使用 `uv sync` 安装开发入口；运行时仅用标准库。
渠道独立入口：`python3 python/tools/channel_probe.py describe`。

详见 [进度](docs/PROGRESS.md)、[交接](HANDOFF.md)、[F1 接入](docs/frontend/IMPLEMENTATION.md)、
[桌面说明](docs/DESKTOP.md)、[业务 API](docs/API.md) 和 [存储约定](docs/STORAGE.md)。
权威计划在 `../doc/DEVELOPMENT_PLAN.md`，仓库保留 [文档快照](docs/reference/README.md)。
