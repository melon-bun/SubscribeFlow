#!/usr/bin/env python3
"""核对 certifi 里与上游叶子配对的中间证书（不带密钥、不调付费接口）。

只用公开证书信息：CN、SHA-256 指纹、是否签发上游叶子。
"""

from __future__ import annotations

import hashlib
import pathlib
import ssl
import tempfile

HOST = "data.wxrank.com"


def main() -> int:
    import certifi

    bundle = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = []
    for part in bundle.split(marker)[1:]:
        blocks.append(marker + part.split("-----END CERTIFICATE-----")[0]
                      + "-----END CERTIFICATE-----\n")
    print(f"certifi 证书总数: {len(blocks)}")

    leaf_pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    leaf_path = pathlib.Path(tempfile.mkdtemp()) / "leaf.pem"
    leaf_path.write_text(leaf_pem)
    leaf = ssl._ssl._test_decode_cert(str(leaf_path))
    issuer_cn = dict(x[0] for x in leaf["issuer"]).get("commonName", "")
    print(f"上游叶子 issuer CN: {issuer_cn}")
    print(f"上游叶子 sha256   : {hashlib.sha256(leaf_pem.encode()).hexdigest()}")

    matched = []
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception:  # noqa: BLE001
            continue
        subject_cn = dict(x[0] for x in decoded["subject"]).get("commonName", "")
        if issuer_cn.lower() in subject_cn.lower() or "YE" in subject_cn.upper():
            matched.append((index, subject_cn, decoded["issuer"], decoded["notBefore"],
                            decoded["notAfter"], hashlib.sha256(block.encode()).hexdigest()))
    print("certifi 中与 YE 相关的证书:")
    for index, subject_cn, issuer, not_before, not_after, digest in matched:
        print(f"  [{index}] CN={subject_cn} issuer={issuer}")
        print(f"       有效期 {not_before} → {not_after}")
        print(f"       sha256(pem)={digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
