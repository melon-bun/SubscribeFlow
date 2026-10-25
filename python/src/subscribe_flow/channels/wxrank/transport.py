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
import json
import ssl
import time
import urllib.error
import urllib.request

from subscribe_flow.contracts import ChannelError

from . import protocol

#: 单次响应体上限。超出按协议异常处理，不继续读。
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

#: 单次请求超时上限（秒）。实际等待取「它」与「任务剩余时间」的较小值。
DEFAULT_TIMEOUT = 20.0


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
        context = ssl.create_default_context()
        return urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), _NoRedirect())

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
