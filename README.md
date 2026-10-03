# Subscribe Flow

本地优先订阅聚合桌面应用。工程位于本目录，架构和开发计划位于 `../doc/`。
F1 界面由另一 Agent 在 `../Subscribe_Flow_F1/` 制作，本仓库不修改该工作区。

当前已实现 M0、M2、M3、M4；M1 已通过真实搜索、分页窗口、详情和 Core 入库，
仍缺可靠全历史末页证据。M5 正式页面接入、M6 自动调度、M7 打包尚未完成。

## 启动开发联调窗口

```sh
npm install
npm run configure
npm start
```

本机已完成依赖安装和运行时路径配置，可直接 `npm start`。
这是 M4 最小窗口，正式界面待 F1 交接后由 M5 集成。
配置与真实数据不进 Git；业务数据存入 Electron 的应用用户目录。

## Python 开发

需要 Python 3.12+；Core 当前仅使用标准库，依赖采用 `uv` 和 `python/uv.lock` 管理。

```sh
cd python
uv sync
uv run python -m unittest discover -s tests -t . -v
# 已有 Python 3.12+ 时，也可无需安装直接运行：
PYTHONPATH=src python3 -m unittest discover -s tests -t . -v
```

渠道独立入口（不依赖数据库和 Electron）：

```sh
python3 python/tools/channel_probe.py describe
python3 python/tools/channel_probe.py fetch 946974 --pages 2 --limit 5
python3 python/tools/core_smoke.py 946974
```

最后两条会访问已有浏览器会话；core_smoke 使用临时数据库，不写入正式用户数据。

```sh
npm test
npm run smoke:desktop
```

实际模块状态、验收证据和限制见 [实施记录](docs/PROGRESS.md)、
[业务 API](docs/API.md)、[桌面说明](docs/DESKTOP.md) 和 [存储说明](docs/STORAGE.md)。
仓库同时保留 [开发依据快照](docs/reference/README.md)，原始开发计划仍维护在同级 `../doc/`。
