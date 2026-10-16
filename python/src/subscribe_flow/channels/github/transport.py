"""Plain HTTP GET for GitHub's public HTML, on the standard library alone.

No browser session, no login and no third-party dependency: ``urllib`` is enough
because ``github.com/trending`` serves the same document to every client
(measured identical byte counts for curl, ``Python-urllib`` and an empty UA).

Three hard limits are enforced here rather than in the adapter, because they
protect the process before a single byte of a page is parsed:

* **Host whitelist** - redirects are re-checked, so a GitHub page can never
  bounce the request onto a third-party host.
* **Response size cap** - the body is read in chunks and abandoned past 4 MiB.
* **Single timeout** - connect and read share one deadline; the measured
  end-to-end time for the largest board is about 3 seconds.
"""
import asyncio
import functools
import http.client
import os
import socket
import ssl
import urllib.error
import urllib.request
from html import unescape
from pathlib import Path
from urllib.parse import urlsplit

from subscribe_flow.contracts import ChannelError

HOST = "github.com"
# 实测最大响应体约 711 KB（月榜）；4 MiB 留足余量，同时挡住异常膨胀的页面。
MAX_BYTES = 4 * 1024 * 1024
TIMEOUT = 10.0
CHUNK = 64 * 1024
# 官方与 CDN 主机名。趋势页与仓库页只会落到这两类。
ALLOWED_HOSTS = {"github.com", "www.github.com", "repository-images.githubusercontent.com",
                 "opengraph.githubassets.com", "avatars.githubusercontent.com"}

# 明确的信任库候选。顺序即优先级：环境变量 → 平台自带 → certifi。
CA_BUNDLES = ("/etc/ssl/cert.pem",                      # macOS
              "/etc/ssl/certs/ca-certificates.crt",    # Debian / Ubuntu
              "/etc/pki/tls/certs/ca-bundle.crt",       # RHEL / Fedora
              "/etc/ssl/ca-bundle.pem",                 # SUSE
              "/usr/local/etc/openssl/cert.pem",        # Homebrew OpenSSL
              "/opt/homebrew/etc/openssl@3/cert.pem")


@functools.lru_cache(maxsize=1)
def _ssl_context():
    """A verifying TLS context that works even when the build ships no CA store.

    python.org's CPython builds point OpenSSL at a cert path that does not
    exist, so ``ssl.create_default_context()`` can end up trusting nobody and
    every HTTPS request fails with CERTIFICATE_VERIFY_FAILED. The browser-backed
    channels never hit this because Chromium carries its own trust store; a
    Core-side HTTP client has to resolve a trust store itself.

    Verification is never switched off. If no bundle can be found the context is
    returned empty, so requests fail loudly instead of trusting anything.
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


def _host(url):
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    return parsed.hostname


def allowed(url):
    """True only for plain HTTP(S) URLs on a host this app is willing to read."""
    return _host(url) is not None and _host(url) in ALLOWED_HOSTS


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Refuse any redirect that leaves the GitHub host allowlist."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not allowed(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect off allowlist", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _classify(error, operation):
    """Map transport failures onto the error vocabulary the scheduler already knows."""
    if isinstance(error, (socket.timeout, TimeoutError)):
        return ChannelError("TIMEOUT", operation, "GitHub 请求超时，请稍后重试", retryable=True)
    if isinstance(error, urllib.error.HTTPError):
        status = error.code
        if status in {403, 429}:
            # GitHub 对匿名访问限流时返回 403，并附 x-ratelimit-remaining: 0。
            # 这类失败按 shared 错误熔断，不重试到对方彻底拒绝为止。
            return ChannelError("RATE_LIMITED", operation,
                                "GitHub 访问频率受限，已放慢请求，请稍后重试",
                                retryable=True, retry_after=60.0)
        if status == 404:
            return ChannelError("NOT_FOUND", operation, "GitHub 页面不存在或已不可见")
        if status >= 500:
            return ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                                f"GitHub 服务暂时不可用（HTTP {status}）", retryable=True)
        return ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                            f"GitHub 返回了意外状态（HTTP {status}）", retryable=False)
    if isinstance(error, (urllib.error.URLError, http.client.HTTPException, ssl.SSLError,
                          OSError, ValueError)):
        return ChannelError("DEPENDENCY_UNAVAILABLE", operation,
                            "无法连接 GitHub，请检查网络后重试", retryable=True)
    return None


class GithubTransport:
    """One blocking GET per call, executed off the event loop."""

    def __init__(self, *, timeout=TIMEOUT, max_bytes=MAX_BYTES, opener=None, ssl_context=None):
        self.timeout, self.max_bytes = timeout, max_bytes
        if opener is not None:
            self.opener = opener
        else:
            # Supplying an HTTPSHandler instance makes urllib skip its default
            # one, which is what actually applies the trust store.
            self.opener = urllib.request.build_opener(
                _Redirects, urllib.request.HTTPSHandler(context=ssl_context or _ssl_context()))
        self.requests = 0

    def _read(self, url, operation):
        if not allowed(url):
            raise ChannelError("INVALID_INPUT", operation, "只允许访问 GitHub 官方域名")
        request = urllib.request.Request(url, headers={
            "User-Agent": "Subscribe-Flow/0.3 (local desktop app; single-user)",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en",
        }, method="GET")
        self.requests += 1
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                final = _host(response.geturl())
                if final not in ALLOWED_HOSTS:
                    raise ChannelError("SCHEMA_CHANGED", operation,
                                       "GitHub 跳转到了非官方域名，已停止读取")
                chunks, total = [], 0
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > self.max_bytes:
                        raise ChannelError("SCHEMA_CHANGED", operation,
                                           "GitHub 页面超过体积上限，已停止读取")
                    chunks.append(chunk)
                charset = "utf-8"
                content_type = response.headers.get("Content-Type", "")
                if "charset=" in content_type.lower():
                    charset = content_type.lower().split("charset=", 1)[1].split(";")[0].strip() or "utf-8"
                try:
                    return b"".join(chunks).decode(charset, "replace")
                except LookupError:
                    return b"".join(chunks).decode("utf-8", "replace")
        except ChannelError:
            raise
        except BaseException as error:  # noqa: BLE001 - re-raised as ChannelError
            mapped = _classify(error, operation)
            if mapped is None:
                raise
            raise mapped from error

    async def get_html(self, url, context, operation):
        """Fetch one page. Cancellation and deadlines are the caller's contract."""
        context.check(operation)
        return await asyncio.to_thread(self._read, url, operation)
