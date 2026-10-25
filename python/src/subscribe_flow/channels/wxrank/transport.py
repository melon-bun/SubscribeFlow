"""M45 付费渠道 HTTP 传输。

传输层只负责把一次付费请求送出去，并把结果分成三类：

- 业务答复：拿到 JSON 且含整数业务码。扣费判定由 service 依据业务码做。
- 网络未决：超时、断连、取消、读不到完整响应。扣费结果未知。
- 协议异常：HTTP 非 2xx、响应体不是 JSON、业务码不是整数。同样按未知处理。

传输层不写账本、不认识业务语义，也不碰密钥本身：密钥由 service 放进请求体，
这里只负责把它送出去，并且不把它写进任何日志或错误信息。
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

from subscribe_flow.contracts import ChannelError

from . import protocol

#: 单次响应体上限。超出按协议异常处理，不继续读。
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

#: 单次请求超时上限（秒）。实际等待取「它」与「任务剩余时间」的较小值。
DEFAULT_TIMEOUT = 20.0

#: 明确的信任库候选。顺序即优先级：环境变量 → certifi → 平台自带。
CA_BUNDLES = ("/etc/ssl/cert.pem",                      # macOS
              "/etc/ssl/certs/ca-certificates.crt",    # Debian / Ubuntu
              "/etc/pki/tls/certs/ca-bundle.crt",       # RHEL / Fedora
              "/etc/ssl/ca-bundle.pem",                 # SUSE
              "/usr/local/etc/openssl/cert.pem",        # Homebrew OpenSSL
              "/opt/homebrew/etc/openssl@3/cert.pem")


@functools.lru_cache(maxsize=1)
def _ssl_context() -> ssl.SSLContext:
    """一个能用的、**仍然校验证书**的 TLS 上下文。

    python.org 的 CPython 构建会把 OpenSSL 指向一个不存在的证书路径，
    于是 ``ssl.create_default_context()`` 可能一个 CA 都不信任，
    Core 侧每一次 HTTPS 都会以 CERTIFICATE_VERIFY_FAILED 失败——付费渠道直接不可用。
    浏览器渠道不受影响（Chromium 自带信任库），但 Core 直连上游的客户端得自己解决信任库。

    **校验永远不关闭**：找不到任何可用 CA 时就返回空上下文，让请求大声失败，
    而不是去信任任何东西。写法与 GitHub 渠道的 ``_ssl_context()`` 保持一致。
    """
    context = ssl.create_default_context()
    if context.get_ca_certs():
        return context
    candidates = [os.environ.get("SSL_CERT_FILE")]
    try:
        import certifi
        candidates.append(certifi.where())
    except ImportError:
        pass
    candidates.extend(CA_BUNDLES)
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():
            continue
        try:
            context.load_verify_locations(cafile=candidate)
        except (OSError, ssl.SSLError):
            continue
        if context.get_ca_certs():
            return context
    return context


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """拒绝一切重定向。

    请求体里带着运行时密钥：一旦允许重定向，就可能把它送到别的主机。
    这里直接拒绝，3xx 会变成 HTTPError，按「结果未知」记账。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class WxrankResponse:
    """一次业务答复。只保留业务码、文案与数据，不保留响应原文。"""

    __slots__ = ("code", "message", "data")

    def __init__(self, code: int, message: str, data):
        self.code = code
        self.message = message
        self.data = data


class WxrankTransport:
    """一次付费 HTTP POST。非阻塞、可取消、带超时。"""

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT, max_bytes: int = MAX_RESPONSE_BYTES,
                 opener=None):
        self.timeout = float(timeout)
        self.max_bytes = int(max_bytes)
        self._opener = opener if opener is not None else self._default_opener()

    @staticmethod
    def _default_opener():
        # 信任库要自己解决：有些 Python 构建不自带任何 CA，
        # 那样每一次 HTTPS 调用都会以「证书无法验证」失败——付费渠道会完全不可用。
        # 校验仍然开启：找不到 CA 就让请求大声失败，不去信任任何东西。
        return urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=_ssl_context()), _NoRedirect())

    async def post(self, path: str, payload: dict, context, operation: str) -> WxrankResponse:
        """发一次请求并返回业务答复。

        只有拿到「HTTP 2xx + 可解析 JSON + 整数业务码」才算业务答复。
        其余情况一律抛错，由上层按「结果未知」记账。
        """
        if path not in protocol.ALLOWED_PATHS:
            raise ChannelError("INVALID_INPUT", operation, "未登记的上游端点")
        context.check(operation)
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            protocol.API_ROOT + path, data=body, method="POST",
            headers={"Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "SubscribeFlow/1.0"},
        )
        remaining = context.deadline - time.monotonic()
        if remaining <= 0:
            raise ChannelError("TIMEOUT", operation, "执行超过时间限制，扣费结果未知")
        try:
            raw, status = await asyncio.wait_for(
                asyncio.to_thread(self._send, request),
                timeout=min(self.timeout, remaining))
        except (asyncio.TimeoutError, TimeoutError):
            raise ChannelError("TIMEOUT", operation, "上游请求超时，扣费结果未知") from None
        except asyncio.CancelledError:
            raise
        except urllib.error.HTTPError as error:
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                               f"上游返回 HTTP {error.code}，扣费结果未知") from None
        except Exception:
            # 连接失败、读取中断、TLS 错误等一律按「结果未知」处理：
            # 请求可能已经到达上游并扣了费，不能当成没扣。
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                               "无法完成上游请求，扣费结果未知") from None
        if status != 200:
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                               f"上游返回 HTTP {status}，扣费结果未知")
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ChannelError("SCHEMA_CHANGED", operation,
                               "上游响应不是有效 JSON，扣费结果未知") from None
        if not isinstance(document, dict):
            raise ChannelError("SCHEMA_CHANGED", operation, "上游响应结构无效，扣费结果未知")
        code = document.get("code")
        if type(code) is not int:
            # 业务码必须是整数：字符串 "0" 与布尔值都不算数。
            raise ChannelError("SCHEMA_CHANGED", operation, "上游响应缺少整数业务码，扣费结果未知")
        message = document.get("msg")
        if not isinstance(message, str):
            message = document.get("message") if isinstance(document.get("message"), str) else ""
        return WxrankResponse(code, message, document.get("data"))

    def _send(self, request):
        with self._opener.open(request, timeout=self.timeout) as response:
            status = response.status
            raw = response.read(self.max_bytes + 1)
        if len(raw) > self.max_bytes:
            raise ValueError("response too large")
        return raw, status
