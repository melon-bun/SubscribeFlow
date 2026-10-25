"""Core 侧 HTTPS 客户端共用的信任库解析。

python.org 的 CPython 构建会把 OpenSSL 指向一个不存在的证书路径，
于是 ``ssl.create_default_context()`` 可能**一个 CA 都不信任**，
所有 HTTPS 请求都会以 ``CERTIFICATE_VERIFY_FAILED`` 失败。
浏览器渠道不受影响（Chromium 自带信任库），但 Core 侧直接发 HTTP 的客户端
必须自己解决信任库。

**校验永远不关闭**：找不到任何可用 CA 时就返回空的上下文，让请求大声失败，
而不是去信任任何东西。
"""

from __future__ import annotations

import functools
import os
import ssl
from pathlib import Path

#: 各发行版常见的 CA 包位置。按顺序试第一个能用的。
CA_BUNDLES = ("/etc/ssl/cert.pem",                      # macOS
              "/etc/ssl/certs/ca-certificates.crt",    # Debian / Ubuntu
              "/etc/pki/tls/certs/ca-bundle.crt",       # RHEL / Fedora
              "/etc/ssl/ca-bundle.pem",                 # SUSE
              "/usr/local/etc/openssl/cert.pem",        # Homebrew OpenSSL
              "/opt/homebrew/etc/openssl@3/cert.pem")


@functools.lru_cache(maxsize=1)
def ssl_context() -> ssl.SSLContext:
    """一个能用的、**仍然校验证书**的 TLS 上下文。

    默认信任库为空时依次尝试：``SSL_CERT_FILE`` → ``certifi`` → 常见 CA 包位置。
    另外会把 ``certifi`` 并进上下文：有些环境的系统信任库缺少 Let's Encrypt
    的根或中间证书，而部分上游只下发叶子证书，链就断在中间证书那一环
    （实测 ``data.wxrank.com`` 就是这种：只发叶子，签发者是 LE 的中间证书）。
    """
    context = ssl.create_default_context()
    certifi_bundle: str | None = None
    try:
        import certifi

        certifi_bundle = certifi.where()
    except ImportError:
        pass

    if not context.get_ca_certs():
        for candidate in (os.environ.get("SSL_CERT_FILE"), certifi_bundle, *CA_BUNDLES):
            if not candidate or not Path(candidate).is_file():
                continue
            try:
                context.load_verify_locations(cafile=candidate)
            except (OSError, ssl.SSLError):
                continue
            if context.get_ca_certs():
                break

    # 并入 certifi：系统信任库可能有根却没有中间证书，付费渠道会直接不可用。
    if certifi_bundle and Path(certifi_bundle).is_file():
        try:
            context.load_verify_locations(cafile=certifi_bundle)
        except (OSError, ssl.SSLError):
            pass
    return context


__all__ = ["ssl_context", "CA_BUNDLES"]
