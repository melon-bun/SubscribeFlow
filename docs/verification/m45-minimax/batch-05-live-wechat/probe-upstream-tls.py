#!/usr/bin/env python3
"""重复探测上游 TLS：验证是否成功、失败时的原因码（不带密钥、不调付费接口）。"""

from __future__ import annotations

import pathlib
import ssl
import sys
import urllib.request

HOST = "data.wxrank.com"
ROUNDS = 5


def build_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def main() -> int:
    ctx = build_context()
    print(f"信任库 CA 数: {len(ctx.get_ca_certs())}")
    import certifi

    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    print("certifi 含 'ISRG Root YE0':", "ISRG Root YE0" in text)
    print("certifi 含 'YE1':", "YE1" in text)
    print(f"certifi 版本: {certifi.__version__ if hasattr(certifi, '__version__') else '未知'}")
    for index in range(ROUNDS):
        request = urllib.request.Request(f"https://{HOST}/", headers={"User-Agent": "SubscribeFlow/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=20, context=ctx) as response:
                print(f"  [{index}] OK status={response.status}")
        except Exception as error:  # noqa: BLE001 - 诊断脚本
            reason = getattr(error, "reason", error)
            print(f"  [{index}] 失败 {type(error).__name__}: {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
