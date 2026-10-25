#!/usr/bin/env python3
"""列出 certifi 里的 ISRG / YE 系证书，并打印上游叶子信息（不带密钥、不调付费接口）。"""

from __future__ import annotations

import pathlib
import ssl
import tempfile

import certifi


def main() -> int:
    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = [
        marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        for part in text.split(marker)[1:]
    ]
    print(f"certifi 证书块: {len(blocks)}")
    ok = 0
    skipped = 0
    rows = []
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception as error:  # noqa: BLE001
            skipped += 1
            print(f"  跳过 [{index}] {type(error).__name__}")
            continue
        ok += 1
        subject = dict(x[0] for x in decoded["subject"]).get("commonName", "")
        issuer = dict(x[0] for x in decoded["issuer"]).get("commonName", "")
        rows.append((index, subject, issuer))
    print(f"成功解码: {ok}，跳过: {skipped}")
    print("ISRG / Let's Encrypt 相关：")
    for index, subject, issuer in rows:
        if "ISRG" in subject or "Encrypt" in subject or "Encrypt" in issuer or "YE" in subject.upper():
            print(f"  [{index}] {subject}  <-  {issuer}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
