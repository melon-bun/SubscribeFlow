# Subscribe Flow

本地优先订阅聚合桌面应用。工程位于本目录，架构和开发计划位于 `../doc/`。
F1 界面由另一 Agent 在 `../Subscribe_Flow_F1/` 制作，本仓库不修改该工作区。

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
```

实际模块状态、验收证据和限制见 `docs/PROGRESS.md`。
