#!/usr/bin/env python3
"""校验加固后的信任库逻辑：正常路径与「没有 certifi」路径都要能验通上游（免费，不碰付费端点）。"""

from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "python" / "src"))


class BlockCertifi:
    """让 ``import certifi`` 失败，模拟没有装 certifi 的机器。"""

    def find_module(self, name, path=None):  # 兼容旧式 finder
        return self if name == "certifi" else None

    def find_spec(self, name, path=None, target=None):
        if name == "certifi":
            raise ImportError("模拟：机器上没有 certifi")
        return None

    def load_module(self, name):
        raise ImportError("模拟：机器上没有 certifi")


def probe(label: str) -> None:
    from subscribe_flow.channels import http
    from subscribe_flow.channels.wxrank.transport import WxrankTransport
    import urllib.error

    http.ssl_context.cache_clear()
    context = http.ssl_context()
    opener = WxrankTransport._default_opener()
    try:
        with opener.open("https://data.wxrank.com/", timeout=20) as response:
            print(f"  [{label}] CA 数={len(context.get_ca_certs())} HTTP {response.status} → 通了")
    except urllib.error.HTTPError as error:
        print(f"  [{label}] CA 数={len(context.get_ca_certs())} HTTP {error.code} → TLS 与 HTTP 通了")


def main() -> int:
    print("正常环境：")
    probe("有 certifi")

    print("模拟没有 certifi：")
    blocker = BlockCertifi()
    sys.meta_path.insert(0, blocker)
    sys.modules.pop("certifi", None)
    try:
        probe("无 certifi")
    finally:
        sys.meta_path.remove(blocker)
        sys.modules.pop("certifi", None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
