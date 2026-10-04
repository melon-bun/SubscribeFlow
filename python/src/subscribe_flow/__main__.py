import argparse
import asyncio
import logging
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.rpc.server import serve
from subscribe_flow.rpc.browser import BrowserBridge


def main():
    parser = argparse.ArgumentParser(description="Subscribe Flow JSON-RPC Core")
    parser.add_argument("--data-dir", required=True, type=Path, help="Absolute application user-data directory")
    parser.add_argument("--opencli", default="opencli", help="Configured OpenCLI executable path")
    parser.add_argument("--backend", choices=["electron-session", "opencli"], default="electron-session")
    args = parser.parse_args()
    if not args.data_dir.is_absolute():
        parser.error("--data-dir must be absolute")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(serve(Core(args.data_dir / "subscribe-flow.sqlite3", opencli_path=args.opencli,
                              browser_bridge=BrowserBridge() if args.backend == "electron-session" else None)))
    except (RuntimeError, OSError) as error:
        logging.error("Core startup failed: %s", error)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
