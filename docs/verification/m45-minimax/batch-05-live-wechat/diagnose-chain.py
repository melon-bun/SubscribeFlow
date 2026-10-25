#!/usr/bin/env python3
"""看证书链缺的是哪一环（不触付费接口、不带密钥）。"""

from __future__ import annotations

import pathlib
import ssl
import tempfile

HOST = "data.wxrank.com"


def main() -> int:
    pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    path = pathlib.Path(tempfile.mkdtemp()) / "leaf.pem"
    path.write_text(pem)
    info = ssl._ssl._test_decode_cert(str(path))
    print("leaf subject :", info.get("subject"))
    print("leaf issuer  :", info.get("issuer"))
    print("AIA 签发者URL:", info.get("caIssuers"))
    print("AIA OCSP URL  :", info.get("ocsp"))
    print("subjectAltName:", info.get("subjectAltName"))

    try:
        import certifi
        bundle = pathlib.Path(certifi.where())
    except ImportError:
        print("certifi 不可用")
        return 0
    text = bundle.read_text(encoding="utf-8", errors="replace")
    for needle in ("ISRG Root X1", "Let's Encrypt YE1", "YE1"):
        print(f"certifi 里有 {needle!r}:", needle in text)
    print("certifi 证书数量:", text.count("BEGIN CERTIFICATE"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
