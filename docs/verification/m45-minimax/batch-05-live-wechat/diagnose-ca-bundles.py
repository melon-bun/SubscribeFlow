#!/usr/bin/env python3
"""系统 CA 包里有没有 Let's Encrypt YE1 这张中间证书。"""

from __future__ import annotations

import pathlib

CANDIDATES = (
    "/etc/ssl/cert.pem",
    "/private/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/usr/local/etc/openssl/cert.pem",
)

NEEDLES = ("Let's Encrypt YE1", "Lets Encrypt YE1", "ISRG Root X1")


def main() -> int:
    for candidate in CANDIDATES:
        path = pathlib.Path(candidate)
        if not path.is_file():
            print(f"{candidate}: 不存在")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        hits = [needle for needle in NEEDLES if needle in text]
        print(f"{candidate}: 证书数={text.count('BEGIN CERTIFICATE')} 命中={hits}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
