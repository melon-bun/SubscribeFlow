"""兼容层：HTTP 传输的实现已移到公共 AI 层。

识别包仍然可以用 `from tagging_engine.transport import HttpTransport` 拿到同一个
实现——传输只有一份，不会出现两套各自演进的网络代码。
"""

from subscribe_flow.ai.transport import (  # noqa: F401
    DEFAULT_TIMEOUT, MAX_BODY, MAX_ERROR_BODY, READ_CHUNK, SYSTEM_CA_CANDIDATES,
    USER_AGENT, HttpTransport, build_ssl_context, validate_timeout,
)

__all__ = [
    'HttpTransport', 'validate_timeout', 'build_ssl_context',
    'DEFAULT_TIMEOUT', 'MAX_BODY', 'MAX_ERROR_BODY', 'READ_CHUNK',
    'SYSTEM_CA_CANDIDATES', 'USER_AGENT',
]
