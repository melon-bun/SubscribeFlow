#!/usr/bin/env python3
"""TLS 版本 × 信任库矩阵：确认上游链路到底靠什么验证成功（不带密钥、不调付费接口）。"""

from __future__ import annotations

import pathlib
import ssl
import tempfile

HOST = "data.wxrank.com"
URL = f"https://{HOST}/"


def split_certifi():
    import certifi

    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = [
        marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        for part in text.split(marker)[1:]
    ]
    keep = {}
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception:  # noqa: BLE001
            continue
        cn = dict(x[0] for x in decoded["subject"]).get("commonName", "")
        keep.setdefault(cn, block)
    return keep


def context_with(blocks: list[str]) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    for block in blocks:
        context.load_verify_locations(cadata=block)
    return context


def try_connect(context: ssl.SSLContext, label: str, tls12: bool) -> None:
    if tls12:
        context.maximum_version = ssl.TLSVersion.TLSv1_2
    else:
        context.minimum_version = ssl.TLSVersion.TLSv1_3
    results = []
    issuers = []
    for _ in range(6):
        try:
            with socket_connect(HOST, context) as sock:
                peer = sock.getpeercert(True)
                if peer:
                    path = pathlib.Path(tempfile.mkdtemp()) / "peer.pem"
                    import base64

                    body = base64.encodebytes(peer).decode("ascii")
                    path.write_text("-----BEGIN CERTIFICATE-----\n" + body
                                    + "-----END CERTIFICATE-----\n")
                    decoded = ssl._ssl._test_decode_cert(str(path))
                    issuer_cn = dict(x[0] for x in decoded["issuer"]).get("commonName", "")
                    subject_cn = dict(x[0] for x in decoded["subject"]).get("commonName", "")
                    issuers.append(f"{subject_cn}/{issuer_cn}")
                results.append("OK")
        except Exception as error:  # noqa: BLE001
            reason = getattr(error, "reason", error)
            results.append(f"失败({type(reason).__name__})")
    print(f"  {label:28s} {'TLS1.2' if tls12 else 'TLS1.3'}  {results}")
    if issuers:
        print(f"      叶子 subject/issuer: {sorted(set(issuers))}")


def socket_connect(host: str, context: ssl.SSLContext):
    import socket

    raw = socket.create_connection((host, 443), timeout=20)
    return context.wrap_socket(raw, server_hostname=host)


def main() -> int:
    certs = split_certifi()
    x1 = certs.get("ISRG Root X1", "")
    x2 = certs.get("ISRG Root X2", "")
    all_blocks = list(certs.values())
    print(f"certifi 去重后: {len(all_blocks)} 张；X1={'有' if x1 else '无'} X2={'有' if x2 else '无'}")
    print()
    scenarios = (
        ("全部 certifi", all_blocks),
        ("仅 ISRG Root X1", [x1] if x1 else []),
        ("仅 ISRG Root X2", [x2] if x2 else []),
        ("空信任库", []),
    )
    for label, blocks in scenarios:
        if label == "空信任库":
            context = ssl.create_default_context()
            context.check_hostname = True
            context.verify_mode = ssl.CERT_REQUIRED
            # 清空默认信任库
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = True
            context.verify_mode = ssl.CERT_REQUIRED
        else:
            context = context_with(blocks)
        for tls12 in (False, True):
            try_connect(context, label, tls12)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
