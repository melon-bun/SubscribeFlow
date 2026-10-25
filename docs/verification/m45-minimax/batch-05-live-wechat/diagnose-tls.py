#!/usr/bin/env python3
"""诊断到真实上游的 TLS 情况（不带密钥、不调付费接口）。

只看：证书签发者、有效期、机器上的 CA 情况、代理变量。
不打印任何凭据。
"""

from __future__ import annotations

import os
import pathlib
import ssl
import tempfile

HOST = "data.wxrank.com"


def main() -> int:
    pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    path = pathlib.Path(tempfile.mkdtemp()) / "leaf.pem"
    path.write_text(pem)
    info = ssl._ssl._test_decode_cert(str(path))
    print("证书 subject:", info.get("subject"))
    print("证书 issuer :", info.get("issuer"))
    print("有效期       :", info.get("notBefore"), "→", info.get("notAfter"))
    print("--- CA／代理相关环境变量 ---")
    for name in ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
                 "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE",
                 "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"):
        print(f"  {name} = {os.environ.get(name)}")
    print("--- 系统默认信任库 ---")
    context = ssl.create_default_context()
    print("  default context 的 CA 数量:", len(context.get_ca_certs()))
    for candidate in ("/etc/ssl/certs", "/usr/local/etc/openssl/certs",
                      "/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"):
        path = pathlib.Path(candidate)
        print(f"  {candidate}: 存在={path.exists()}",
              (f"条目={len(list(path.iterdir()))}" if path.is_dir() else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
