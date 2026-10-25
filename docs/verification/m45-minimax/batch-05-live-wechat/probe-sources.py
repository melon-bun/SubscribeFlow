#!/usr/bin/env python3
"""探测中间证书的可用来源 + 本机 Python 的 ssl 能力（不带密钥、不调付费接口）。

只打印：URL、HTTP 状态、证书主体/签发者、字节数与 SHA-256 指纹。
不打印任何凭据。
"""

from __future__ import annotations

import hashlib
import ssl
import sys
import urllib.error
import urllib.request

PROBES = (
    ("https://letsencrypt.org/certs/", "LE 官方中间证书目录"),
    ("https://ye1.i.lencr.org/", "AIA 主机(HTTPS)"),
    ("http://ye1.i.lencr.org/", "AIA 主机(HTTP)"),
    ("https://data.wxrank.com/", "上游站点"),
)


def context() -> ssl.SSLContext:
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    return ctx


def probe(url: str, label: str) -> None:
    print(f"--- {label}: {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "SubscribeFlow/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20, context=context()) as response:
            body = response.read()
            print(f"    status={response.status} bytes={len(body)}")
            print(f"    sha256={hashlib.sha256(body).hexdigest()}")
            if b"BEGIN CERTIFICATE" in body:
                count = body.count(b"BEGIN CERTIFICATE")
                print(f"    含 PEM 证书块 {count} 张")
                name = url.rstrip("/").split("/")[-1] or "index"
                out = f"batch-05-live-wechat/wxrank-chain/probe-{name}.pem"
                with open(out, "wb") as handle:
                    handle.write(body)
                print(f"    已保存 {out}")
            else:
                head = body[:400].decode("utf-8", errors="replace")
                print("    前 400 字节:")
                for line in head.splitlines()[:12]:
                    print("      " + line)
    except urllib.error.HTTPError as error:
        print(f"    HTTPError {error.code} {error.reason}")
    except Exception as error:  # noqa: BLE001 - 诊断脚本，分类打印
        print(f"    失败 {type(error).__name__}: {error}")


def main() -> int:
    print("=== Python ssl 能力 ===")
    print("  OPENSSL_VERSION:", ssl.OPENSSL_VERSION)
    print("  HAS_NEVER_CHECK_COMMON_NAME:", getattr(ssl, "HAS_NEVER_CHECK_COMMON_NAME", None))
    print("  VERIFY_X509_PARTIAL_CHAIN:", getattr(ssl, "VERIFY_X509_PARTIAL_CHAIN", "不存在"))
    print("  create_default_context CA 数:", len(ssl.create_default_context().get_ca_certs()))
    print()
    for url, label in PROBES:
        probe(url, label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
