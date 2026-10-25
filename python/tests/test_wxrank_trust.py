"""付费渠道传输层信任库的聚焦回归。

为什么要有这个测试：有些 Python 构建把 OpenSSL 指向一个不存在的证书路径，
``ssl.create_default_context()`` 一个 CA 都不信任，于是所有 Core 侧 HTTPS 请求
都会以 CERTIFICATE_VERIFY_FAILED 失败（付费渠道会直接不可用）。
兜底必须做到「能装到 CA」且「校验一个字都不放宽」。
"""

from __future__ import annotations

import ssl
import unittest

from subscribe_flow.channels.wxrank.transport import _ssl_context


class WxrankTrustStoreTests(unittest.TestCase):
    def test_校验始终开启(self):
        """兜底只能换信任来源，不能关校验。"""
        context = _ssl_context()
        self.assertTrue(context.check_hostname, "必须校验主机名")
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED, "必须校验证书链")

    def test_能装到至少一张CA(self):
        """默认信任库为空时要能兜底装到 CA，否则每次 HTTPS 都必然失败。"""
        self.assertGreater(len(_ssl_context().get_ca_certs()), 0,
                           "没有任何 CA 时付费渠道在本机完全不可用")

    def test_上下文可复用(self):
        """同一个进程里只建一次上下文，避免每次请求都重读证书包。"""
        self.assertIs(_ssl_context(), _ssl_context())


if __name__ == "__main__":
    unittest.main()
