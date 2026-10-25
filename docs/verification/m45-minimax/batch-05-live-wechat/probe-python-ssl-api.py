#!/usr/bin/env python3
"""打印 Python 版本与可用的链接口（不带密钥、不调付费接口）。"""

from __future__ import annotations

import ssl
import sys


def main() -> int:
    print("python:", sys.version)
    print("OPENSSL_VERSION:", ssl.OPENSSL_VERSION)
    for name in ("get_verified_chain", "get_unverified_chain", "getpeercert", "getpeercerts"):
        print(f"  SSLSocket.{name}: {hasattr(ssl.SSLSocket, name)}")
    print("SSLContext.set_default_verify_paths:", hasattr(ssl.SSLContext, "set_default_verify_paths"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
