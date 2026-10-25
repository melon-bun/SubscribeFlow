#!/usr/bin/env python3
"""取回 data.wxrank.com 的中间证书并做链验证（不带密钥、不触付费接口）。

步骤：
1. 取服务端叶子证书（不校验），读出它的 AIA 签发者地址。
2. 从该地址的 **HTTPS** 版本取回中间证书（认证的来源）。
3. 交给 Node 校验链：叶子 ← 中间证书 ← 根（Node 自带信任库里有根）。
4. 打印中间证书的 SHA-256 指纹，供产品侧固定使用。

只打印证书主题、签发者与指纹，不打印任何凭据。
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import ssl
import tempfile
import urllib.request

HOST = "data.wxrank.com"
OUT = pathlib.Path(__file__).resolve().parent / "wxrank-chain"


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "SubscribeFlow/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return response.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    pem = ssl.get_server_certificate((HOST, 443), timeout=15)
    leaf_path = pathlib.Path(tempfile.mkdtemp()) / "leaf.pem"
    leaf_path.write_text(pem)
    info = ssl._ssl._test_decode_cert(str(leaf_path))
    print("叶子 subject:", info.get("subject"))
    print("叶子 issuer :", info.get("issuer"))
    aia = (info.get("caIssuers") or (None,))[0]
    print("AIA 签发者地址:", aia)
    if not aia:
        print("没有 AIA 地址，无法取回中间证书")
        return 1

    # 优先用 HTTPS 版本（AIA 给的是 http，但同一台服务器通常也提供 https）。
    candidates = [aia.replace("http://", "https://", 1), aia]
    chain = None
    used = None
    for url in candidates:
        try:
            chain = fetch(url)
            used = url
            break
        except Exception as error:
            print(f"取 {url} 失败: {type(error).__name__}")
    if chain is None:
        print("取不到中间证书")
        return 1
    print("中间证书来源:", used)
    (OUT / "intermediate.pem").write_bytes(chain)

    # 从 PEM 里挑出真正的证书（目录页可能带 HTML）。
    blocks = []
    text = chain.decode("utf-8", errors="replace")
    marker = "-----BEGIN CERTIFICATE-----"
    if marker in text:
        parts = text.split(marker)
        for part in parts[1:]:
            blocks.append(marker + part.split("-----END CERTIFICATE-----")[0]
                          + "-----END CERTIFICATE-----\n")
    print("取到的证书块:", len(blocks))
    for index, block in enumerate(blocks):
        path = OUT / f"candidate-{index}.pem"
        path.write_text(block)
        decoded = ssl._ssl._test_decode_cert(str(path))
        digest = hashlib.sha256(block.encode()).hexdigest()
        print(f"  [{index}] subject={decoded.get('subject')} issuer={decoded.get('issuer')}")
        print(f"       sha256={digest}")

    # 让 Node 校验链：叶子 ← 候选 ← 根（Node 自带信任库）。
    node = pathlib.Path(__file__).resolve().parents[4] / "scripts" / "verify-chain.cjs"
    result = subprocess_run(node, [str(leaf_path), str(OUT)])
    print(result)
    return 0


def subprocess_run(script: pathlib.Path, args: list[str]) -> str:
    import subprocess
    result = subprocess.run(["node", str(script), *args], capture_output=True, text=True)
    return (result.stdout or "") + (result.stderr or "")


if __name__ == "__main__":
    raise SystemExit(main())
