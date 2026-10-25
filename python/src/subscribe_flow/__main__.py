import argparse
import asyncio
import logging
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from subscribe_flow.bootstrap import Core
from subscribe_flow.rpc.server import serve
from subscribe_flow.rpc.browser import BrowserBridge
from subscribe_flow.application.scheduler import SchedulePolicy


def main():
    parser = argparse.ArgumentParser(description="Subscribe Flow JSON-RPC Core")
    parser.add_argument("--data-dir", required=True, type=Path, help="Absolute application user-data directory")
    parser.add_argument("--opencli", default="opencli", help="Configured OpenCLI executable path")
    parser.add_argument("--backend", choices=["electron-session", "opencli", "direct-http"], default="electron-session")
    parser.add_argument('--schedule-policy', default='{}', help='JSON overrides for bounded scheduler policy')
    args = parser.parse_args()
    if not args.data_dir.is_absolute():
        parser.error("--data-dir must be absolute")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        policy = SchedulePolicy(**json.loads(args.schedule_policy))
    except (ValueError, TypeError):
        parser.error('Invalid scheduling policy')
    # 隔离验收用：把付费上游换成脱敏样本，正式 Renderer 验收因此不产生任何费用。
    # 生产启动不设置这个环境变量，那时走的是真正发网的传输层。
    paid_transport = None
    profile = os.environ.get("SUBSCRIBE_FLOW_WXRANK_FIXTURE")
    if profile == "http":
        # 验收档位：真实传输层打本机假上游。
        # 这样能验证真实 HTTP 条件下的接线、解析、计费与检查点，
        # 又不会碰真实付费上游。只允许回环地址：密钥绝不能被发到本机以外。
        from subscribe_flow.channels.wxrank import protocol
        from subscribe_flow.channels.wxrank.transport import WxrankTransport
        base = os.environ.get("SUBSCRIBE_FLOW_WXRANK_HTTP_BASE", "")
        parsed = urlsplit(base)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            logging.error("Refusing non-loopback wxrank acceptance upstream")
            raise SystemExit(1)
        protocol.API_ROOT = base.rstrip("/")
        paid_transport = WxrankTransport()
    elif profile:
        from subscribe_flow.channels.wxrank.fixture_transport import FixtureTransport
        paid_transport = FixtureTransport(profile)
    try:
        asyncio.run(serve(Core(args.data_dir / "subscribe-flow.sqlite3", opencli_path=args.opencli,
                              browser_bridge=BrowserBridge() if args.backend == "electron-session" else None,
                              schedule_policy=policy, paid_transport=paid_transport)))
    except (RuntimeError, OSError) as error:
        logging.error("Core startup failed: %s", error)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
