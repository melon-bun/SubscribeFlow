#!/usr/bin/env python3
"""取回 AIA 指向的中间证书（DER→PEM）并落盘，供验签使用（不带密钥、不调付费接口）。

AIA 地址是证书自己声明的 http 入口，本身不可信；
这里只把它当"待验材料"，可信性由下一步的签名验签来判定。
"""

from __future__ import annotations

import base64
import pathlib
import ssl
import urllib.request

HOST = "data.wxrank.com"
OUT = pathlib.Path(__file__).resolve().parent / "wxrank-chain"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    # 叶子
    leaf_pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    (OUT / "leaf.pem").write_text(leaf_pem)
    leaf_info = ssl._ssl._test_decode_cert(str(OUT / "leaf.pem"))
    aia = (leaf_info.get("caIssuers") or (None,))[0]
    print("叶子 issuer:", dict(x[0] for x in leaf_info["issuer"]).get("commonName"))
    print("AIA 地址:", aia)
    if not aia:
        return 1

    request = urllib.request.Request(aia, headers={"User-Agent": "SubscribeFlow/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        der = response.read()
    body = base64.encodebytes(der).decode("ascii")
    pem = "-----BEGIN CERTIFICATE-----\n" + body + "-----END CERTIFICATE-----\n"
    (OUT / "aia-intermediate.pem").write_text(pem)
    info = ssl._ssl._test_decode_cert(str(OUT / "aia-intermediate.pem"))
    print("AIA 中间证书 subject:", dict(x[0] for x in info["subject"]).get("commonName"))
    print("AIA 中间证书 issuer :", dict(x[0] for x in info["issuer"]).get("commonName"))
    print("AIA 中间证书 有效期 :", info.get("notBefore"), "→", info.get("notAfter"))
    print("AIA 中间证书 自带 AIA:", (info.get("caIssuers") or (None,))[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
