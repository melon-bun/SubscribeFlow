#!/usr/bin/env python3
"""对照实验：确认 Python 侧证书校验确实生效（不带密钥、不调付费接口）。

- 用只含 ISRG Root X1 的信任库访问 example.com：应当失败（校验没被绕过）
- 用只含 ISRG Root X1 的信任库访问上游：观察结果
- 用空信任库访问上游：观察结果
"""

from __future__ import annotations

import ssl
import urllib.request

CASES = (
    ("https://data.wxrank.com/", "上游"),
    ("https://example.com/", "example.com（对照）"),
)


def context_with(blocks: list[str]) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    for block in blocks:
        context.load_verify_locations(cadata=block)
    return context


def fetch(url: str, context: ssl.SSLContext) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "SubscribeFlow/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            return f"OK status={response.status}"
    except Exception as error:  # noqa: BLE001
        reason = getattr(error, "reason", error)
        return f"失败 {type(reason).__name__}: {reason}"


def main() -> int:
    import certifi
    import pathlib
    import tempfile

    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = [
        marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        for part in text.split(marker)[1:]
    ]
    by_cn = {}
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception:  # noqa: BLE001
            continue
        by_cn.setdefault(dict(x[0] for x in decoded["subject"]).get("commonName", ""), block)

    x1 = by_cn.get("ISRG Root X1", "")
    print(f"X1 证书块长度: {len(x1)}")
    print(f"X1-only 上下文 CA 数: {len(context_with([x1]).get_ca_certs())}")
    print(f"空上下文 CA 数: {len(context_with([]).get_ca_certs())}")

    for label, blocks_in in (("仅 X1", [x1] if x1 else []), ("空信任库", [])):
        context = context_with(blocks_in)
        for url, name in CASES:
            print(f"  [{label}] {name}: {fetch(url, context)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
