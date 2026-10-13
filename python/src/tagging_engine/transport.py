"""HTTP 传输：默认实现只依赖标准库，包本身不带第三方依赖。

调用方可以注入自己的 transport（测试替身、代理、连接池），这个包不自己
决定网络策略。默认实现只发 HTTPS，并把超时当作硬边界。
"""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request

from .contracts import ERROR_AUTH, ERROR_NETWORK, ERROR_RATE_LIMITED, ERROR_TIMEOUT, RecognitionError

USER_AGENT = 'SubscribeFlow-tagging-engine/1.0'
DEFAULT_TIMEOUT = 30.0

# 官方 python.org 安装包在部分系统上没有自带 CA 包，OpenSSL 默认会指向一个
# 不存在的 cert.pem，导致所有 HTTPS 调用直接证书校验失败。这里只补「去哪儿找
# CA」，绝不关闭校验：校验失败必须报错，不能变成静默的不安全连接。
SYSTEM_CA_CANDIDATES = (
    '/etc/ssl/cert.pem',                                  # macOS
    '/etc/ssl/certs/ca-certificates.crt',                 # Debian/Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt',                   # RHEL/Fedora
    '/etc/ssl/ca-bundle.pem',                             # SUSE
)


def build_ssl_context() -> ssl.SSLContext:
    """构造校验证书的上下文，并在默认 CA 缺失时回退到系统 CA 包。"""
    context = ssl.create_default_context()
    paths = ssl.get_default_verify_paths()
    if paths.cafile and os.path.exists(paths.cafile):
        return context
    if paths.capath and os.path.isdir(paths.capath) and context.get_ca_certs():
        return context
    loaded = False
    for candidate in SYSTEM_CA_CANDIDATES:
        if os.path.exists(candidate):
            try:
                context.load_verify_locations(cafile=candidate)
                loaded = True
            except OSError:
                continue
    if not loaded:
        # 不降级成不校验证书：让调用以明确的证书错误失败。
        raise RecognitionError(
            ERROR_NETWORK,
            '找不到系统 CA 证书包，模型服务无法通过 HTTPS 校验。请安装系统的 ca-certificates 后重试。',
            retryable=False,
        )
    return context


class HttpTransport:
    """标准库实现的 JSON POST。密钥只出现在请求头，不进日志也不进异常。"""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT, ssl_context: ssl.SSLContext | None = None):
        self.timeout = timeout
        self._ssl_context = ssl_context

    def ssl_context(self) -> ssl.SSLContext:
        if self._ssl_context is None:
            self._ssl_context = build_ssl_context()
        return self._ssl_context

    def post_json(self, url: str, payload: dict, headers: dict, timeout: float | None = None) -> tuple[int, dict]:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(url, data=data, method='POST')
        request.add_header('Content-Type', 'application/json')
        request.add_header('User-Agent', USER_AGENT)
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout,
                                        context=self.ssl_context()) as response:
                return response.status, self._decode(response.read())
        except urllib.error.HTTPError as error:
            body = self._safe_decode(error.read())
            # 认证失败单独归类：重试没有意义，改配置才会恢复。
            if error.code in (401, 403):
                raise RecognitionError(ERROR_AUTH, f'模型服务拒绝了当前密钥（HTTP {error.code}）') from None
            if error.code == 429:
                raise RecognitionError(ERROR_RATE_LIMITED, '模型服务触发了限流（HTTP 429）') from None
            detail = body.get('error', {}).get('message') if isinstance(body.get('error'), dict) else None
            message = f'模型服务返回 HTTP {error.code}' + (f'：{detail}' if detail else '')
            # 5xx 视为暂时不可用；4xx 的其余部分是请求本身的问题，不重试。
            raise RecognitionError(ERROR_NETWORK if error.code >= 500 else 'invalid_response', message,
                                   retryable=error.code >= 500) from None
        except ssl.SSLCertVerificationError:
            raise RecognitionError(
                ERROR_NETWORK,
                '模型服务的 HTTPS 证书校验失败，请检查系统时间与 CA 证书包',
                retryable=False,
            ) from None
        except urllib.error.URLError as error:
            reason = getattr(error, 'reason', None)
            if isinstance(reason, TimeoutError) or 'timed out' in str(reason).lower():
                raise RecognitionError(ERROR_TIMEOUT, '模型服务请求超时') from None
            if isinstance(reason, ssl.SSLError):
                raise RecognitionError(ERROR_NETWORK, f'模型服务的 HTTPS 连接失败：{reason}') from None
            raise RecognitionError(ERROR_NETWORK, f'无法连接模型服务：{reason}') from None
        except TimeoutError:
            raise RecognitionError(ERROR_TIMEOUT, '模型服务请求超时') from None

    @staticmethod
    def _decode(raw: bytes) -> dict:
        try:
            value = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise RecognitionError('invalid_response', '模型服务返回的不是合法 JSON') from None
        if not isinstance(value, dict):
            raise RecognitionError('invalid_response', '模型服务返回的 JSON 不是对象')
        return value

    @staticmethod
    def _safe_decode(raw: bytes) -> dict:
        try:
            value = json.loads(raw.decode('utf-8'))
        except Exception:
            return {}
        return value if isinstance(value, dict) else {}