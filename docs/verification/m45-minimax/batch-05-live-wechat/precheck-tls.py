#!/usr/bin/env python3
"""免费预检：用产品传输层的 opener 打上游首页，确认 TLS 通（不碰付费端点、不带密钥）。"""

from __future__ import annotations

import pathlib
import sys
import urllib.error

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "python" / "src"))

from subscribe_flow.channels import http                      # noqa: E402
from subscribe_flow.channels.wxrank.protocol import API_ROOT  # noqa: E402
from subscribe_flow.channels.wxrank.transport import WxrankTransport  # noqa: E402


def main() -> int:
    context = http.ssl_context()
    print("产品信任库 CA 数:", len(context.get_ca_certs()))
    opener = WxrankTransport._default_opener()
    try:
        request = opener.open(API_ROOT + "/", timeout=20)
        with request:
            body = request.read(2048)
        print("上游首页可达, HTTP", request.status, "首字节数", len(body))
    except urllib.error.HTTPError as error:
        # 产品传输层拒绝一切重定向：拿到 3xx 同样说明 TLS 与 HTTP 都通了。
        print(f"上游返回 HTTP {error.code}（产品传输层拒绝重定向属预期），TLS 与 HTTP 均已打通")
        return 0
    print("含登录页特征:", "微小榜" in body.decode("utf-8", "replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
