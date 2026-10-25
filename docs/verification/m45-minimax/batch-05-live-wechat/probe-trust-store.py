#!/usr/bin/env python3
"""信任库机制探针：定位究竟哪些 CA 能验通上游叶子（不带密钥、不调付费接口）。"""

from __future__ import annotations

import pathlib
import ssl
import tempfile
import urllib.request

HOST = "data.wxrank.com"
URL = f"https://{HOST}/"
SYSTEM_BUNDLES = (
    "/etc/ssl/cert.pem",
    "/private/etc/ssl/cert.pem",
    "/etc/ssl/certs/ca-certificates.crt",
    "/usr/local/etc/openssl/cert.pem",
)


def load_certifi() -> dict[str, str]:
    import certifi

    text = pathlib.Path(certifi.where()).read_text(encoding="utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    blocks = [
        marker + part.split("-----END CERTIFICATE-----")[0] + "-----END CERTIFICATE-----\n"
        for part in text.split(marker)[1:]
    ]
    by_cn: dict[str, str] = {}
    for index, block in enumerate(blocks):
        path = pathlib.Path(tempfile.mkdtemp()) / f"c{index}.pem"
        path.write_text(block)
        try:
            decoded = ssl._ssl._test_decode_cert(str(path))
        except Exception:  # noqa: BLE001
            continue
        cn = dict(x[0] for x in decoded["subject"]).get("commonName", "")
        by_cn.setdefault(cn, block)
    return by_cn


def fetch(context: ssl.SSLContext) -> str:
    request = urllib.request.Request(URL, headers={"User-Agent": "SubscribeFlow/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=20, context=context) as response:
            return f"OK status={response.status}"
    except Exception as error:  # noqa: BLE001
        reason = getattr(error, "reason", error)
        return f"失败 {type(reason).__name__}: {str(reason)[:90]}"


def context_with(blocks: list[str]) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    for block in blocks:
        context.load_verify_locations(cadata=block)
    return context


def main() -> int:
    print("--- 系统 CA 包里是否有 YE 系材料 ---")
    for candidate in SYSTEM_BUNDLES:
        path = pathlib.Path(candidate)
        if not path.is_file():
            print(f"  {candidate}: 不存在")
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        hits = [needle for needle in ("Root YE", "YE1", "ISRG Root YE0") if needle in text]
        print(f"  {candidate}: 证书数={text.count('BEGIN CERTIFICATE')} 命中={hits}")

    certifi_cns = load_certifi()
    x1 = certifi_cns.get("ISRG Root X1", "")
    x2 = certifi_cns.get("ISRG Root X2", "")
    unrelated = ""
    for name, block in certifi_cns.items():
        if "DigiCert" in name:
            unrelated = block
            break
    print(f"\ncertifi: ISRG Root X1={'有' if x1 else '无'} ISRG Root X2={'有' if x2 else '无'} "
          f"其它CA={'有' if unrelated else '无'}")

    scenarios = (
        ("空信任库（不调用 load_verify_locations）", None),
        ("仅 X1", [x1]),
        ("仅 X2", [x2]),
        ("仅一个无关 CA（DigiCert）", [unrelated] if unrelated else []),
        ("X1 + 无关 CA", [x1, unrelated] if unrelated else [x1]),
        ("全部 certifi", list(certifi_cns.values())),
    )
    for label, blocks in scenarios:
        if blocks is None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = True
            context.verify_mode = ssl.CERT_REQUIRED
        else:
            context = context_with(blocks)
        print(f"  [{label:32s}] CA数={len(context.get_ca_certs()):3d} → {fetch(context)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
