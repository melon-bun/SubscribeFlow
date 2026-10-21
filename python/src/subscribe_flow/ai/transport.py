"""公共 HTTP 传输：默认实现只依赖标准库，包本身不带第三方依赖。

调用方可以注入自己的 transport（测试替身、代理、连接池），这个包不自己
决定网络策略。默认实现只发 HTTPS，并把超时当作硬边界。

三条边界，任何一条都不能靠供应商「应该不会」来保证：
- 重定向不跨来源转发认证头（见 _NoRedirect）；
- 远端错误正文不回显到异常、CLI 与日志；
- 网络读写异常统一分类，不泄出底层库的异常类型。
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import ssl
import time
import urllib.error
import urllib.request

from .contracts import ERROR_AUTH, ERROR_NETWORK, ERROR_RATE_LIMITED, ERROR_TIMEOUT, AiError

USER_AGENT = 'SubscribeFlow-ai/1.0'
DEFAULT_TIMEOUT = 30.0
READ_CHUNK = 8192
# 错误正文最多读取这么多字节：只为判断状态与分类，不需要也不应该读完整正文。
MAX_ERROR_BODY = 4096
# 成功响应体上限：正文截断在模型服务侧有上限，这里再兜一层，避免异常响应吃满内存。
MAX_BODY = 8 * 1024 * 1024

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
        raise AiError(
            ERROR_NETWORK,
            '找不到系统 CA 证书包，模型服务无法通过 HTTPS 校验。请安装系统的 ca-certificates 后重试。',
            retryable=False,
        )
    return context


def validate_timeout(value, name='timeout') -> float:
    """公开入口的 timeout 必须是正有限数，否则请求前就失败。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < float(value) < 86400:
        raise AiError('invalid_input', f'{name} 需为大于 0 的有限秒数', retryable=False)
    return float(value)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """禁用自动重定向。

    urllib 默认会把 Authorization 头原样带到重定向目标，跨来源时等于把密钥
    送到第三方。API 调用没有跟随跳转的业务需要，宁可失败也不要泄露凭据。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpTransport:
    """标准库实现的 JSON POST。密钥只出现在请求头，不进日志也不进异常。"""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT, ssl_context: ssl.SSLContext | None = None):
        self.timeout = validate_timeout(timeout)
        self._ssl_context = ssl_context
        self._opener = None

    def ssl_context(self) -> ssl.SSLContext:
        if self._ssl_context is None:
            self._ssl_context = build_ssl_context()
        return self._ssl_context

    def opener(self):
        """延迟构建 opener：context 要绑在 HTTPSHandler 上。

        OpenerDirector.open() 不接受 context 参数，只有直接 urlopen 才接受。
        """
        if self._opener is None:
            self._opener = urllib.request.build_opener(
                _NoRedirect(), urllib.request.HTTPSHandler(context=self.ssl_context()))
        return self._opener

    def post_json(self, url: str, payload: dict, headers: dict, timeout: float | None = None) -> tuple[int, dict]:
        budget = validate_timeout(timeout, 'timeout') if timeout is not None else self.timeout
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(url, data=data, method='POST')
        request.add_header('Content-Type', 'application/json')
        request.add_header('User-Agent', USER_AGENT)
        for key, value in headers.items():
            request.add_header(key, value)
        deadline = time.monotonic() + budget
        try:
            with self.opener().open(request, timeout=budget) as response:
                status = response.status
                raw = self._read_within(response, deadline)
        except urllib.error.HTTPError as error:
            # HTTPError 也是一个响应对象：错误正文同样受限长保护。
            raw_error = self._read_error_body(error)
            error.close()
            self._raise_for_status(error.code, raw_error)
        except urllib.error.URLError as error:
            raise self._classify_url_error(error.reason) from None
        except (socket.timeout, TimeoutError):
            # 读超时就是超时：不能和「连接被中断」混为一类，调用方要按超时退避。
            raise AiError(ERROR_TIMEOUT, '读取模型响应超时') from None
        except (http.client.HTTPException, ConnectionError):
            raise AiError(ERROR_NETWORK, '与模型服务的连接在传输过程中中断') from None
        except ssl.SSLCertVerificationError:
            raise AiError(
                ERROR_NETWORK, '模型服务的 HTTPS 证书校验失败，请检查系统时间与 CA 证书包', retryable=False) from None
        except ssl.SSLError as error:
            raise AiError(ERROR_NETWORK, f'模型服务的 HTTPS 连接失败：{type(error).__name__}') from None
        except AiError:
            raise
        except Exception:
            # 未预期的异常类型不当作可重试网络错误：那会把代码缺陷伪装成偶发失败。
            raise
        return status, self._decode(raw)

    # ------------------------------------------------------------ 读取

    @staticmethod
    def _read_within(response, deadline: float) -> bytes:
        """在总预算内读完响应体。

        socket 超时只约束单次阻塞读；服务持续慢速送字节时总耗时可以无限延长，
        所以这里按块读取并对照总 deadline。
        """
        chunks, total = [], 0
        while True:
            if time.monotonic() > deadline:
                raise AiError(ERROR_TIMEOUT, '读取模型响应超过约定的时间预算')
            try:
                # 必须用 read1（单次 recv）：BufferedReader.read(n) 会在内部循环收包，
                # 每次 recv 都重置 socket 超时，服务端只要持续慢速送字节就能无限拖长，
                # 外层 deadline 根本没有机会执行。read1 收到一块就返回。
                chunk = response.read1(READ_CHUNK) if hasattr(response, 'read1') else response.read(READ_CHUNK)
            except (socket.timeout, TimeoutError):
                raise AiError(ERROR_TIMEOUT, '读取模型响应超时') from None
            except (http.client.HTTPException, ConnectionError):
                # 短读、连接重置等都在这里收口：底层库的异常类型不外泄。
                raise AiError(ERROR_NETWORK, '模型服务在返回过程中中断了连接') from None
            if time.monotonic() > deadline:
                raise AiError(ERROR_TIMEOUT, '读取模型响应超过约定的时间预算')
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_BODY:
                raise AiError('invalid_response', '模型服务返回的响应体过大', retryable=False)
        return b''.join(chunks)

    @staticmethod
    def _read_error_body(error) -> bytes:
        try:
            return error.read(MAX_ERROR_BODY)
        except Exception:
            return b''

    # ------------------------------------------------------------ 分类

    @staticmethod
    def _raise_for_status(code: int, raw: bytes):
        """按状态码分类，**不使用远端正文**。

        供应商的错误正文可能回显提交的 Key 或原文，直接拼进异常会让密钥和
        个人内容流进任务状态与日志。这里只保留状态码与固定文案。
        """
        if code in (401, 403):
            raise AiError(ERROR_AUTH, f'模型服务拒绝了当前密钥（HTTP {code}）')
        if code == 429:
            raise AiError(ERROR_RATE_LIMITED, f'模型服务触发了限流（HTTP {code}）')
        if code in (301, 302, 303, 307, 308):
            raise AiError(
                'invalid_response',
                f'模型地址返回了重定向（HTTP {code}）。请把接口地址直接填成最终地址。',
                retryable=False,
            )
        if code >= 500:
            raise AiError(ERROR_NETWORK, f'模型服务暂时不可用（HTTP {code}）', retryable=True)
        raise AiError(
            'invalid_response', f'模型服务拒绝了本次请求（HTTP {code}）', retryable=False)

    @staticmethod
    def _classify_url_error(reason) -> AiError:
        if isinstance(reason, TimeoutError) or 'timed out' in str(reason).lower():
            return AiError(ERROR_TIMEOUT, '模型服务请求超时')
        if isinstance(reason, ssl.SSLCertVerificationError):
            return AiError(ERROR_NETWORK, '模型服务的 HTTPS 证书校验失败', retryable=False)
        if isinstance(reason, ssl.SSLError):
            return AiError(ERROR_NETWORK, '模型服务的 HTTPS 连接失败')
        if isinstance(reason, socket.gaierror):
            return AiError(ERROR_NETWORK, '无法解析模型服务地址')
        # 只回显异常类型名，不回显可能含地址或正文的 repr。
        return AiError(ERROR_NETWORK, f'无法连接模型服务（{type(reason).__name__}）')

    @staticmethod
    def _decode(raw: bytes) -> dict:
        try:
            value = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise AiError('invalid_response', '模型服务返回的不是合法 JSON') from None
        if not isinstance(value, dict):
            raise AiError('invalid_response', '模型服务返回的 JSON 不是对象')
        return value