"""传输层边界测试：重定向、错误正文、超时与中断。

全部指向本机临时服务，不联网、不使用真实凭据。
这里覆盖的是「供应商和操作系统都可能做什么」，不能假设它们配合。
"""

import http.client
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from tagging_engine.contracts import RecognitionError
from tagging_engine.transport import HttpTransport, validate_timeout


class Server:
    """一次性本机 HTTP 服务。"""

    def __init__(self, handler):
        self.httpd = HTTPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path='/x'):
        return f'http://127.0.0.1:{self.port}{path}'

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class RedirectTests(unittest.TestCase):
    """认证头只能发给明确配置的来源。"""

    def setUp(self):
        self.seen = {}
        outer = self

        class Target(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _capture(self):
                outer.seen['method'] = self.command
                outer.seen['auth'] = self.headers.get('Authorization')
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')

            do_POST = _capture
            do_GET = _capture

        self.target = Server(Target)
        destination = self.target.port

        class Redirector(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{destination}/target')
                self.send_header('Content-Length', '0')
                self.end_headers()

        self.redirector = Server(Redirector)

    def tearDown(self):
        self.redirector.close()
        self.target.close()

    def test_cross_origin_redirect_must_not_forward_authorization(self):
        with self.assertRaises(RecognitionError) as caught:
            HttpTransport(timeout=5).post_json(self.redirector.url(), {},
                                               {'Authorization': 'Bearer SECRET-TOKEN'})
        self.assertIsNone(self.seen.get('auth'), '跨来源跳转不得带上认证头')
        self.assertEqual(caught.exception.code, 'invalid_response')
        self.assertFalse(caught.exception.retryable)


class ErrorBodyTests(unittest.TestCase):
    """远端正文可能回显密钥或原文，不能进异常、CLI 与日志。"""

    SECRET = 'sk-api-PLACEHOLDER-NOT-REAL'
    TEXT = 'synthetic-private-text'

    def serve(self, status, payload):
        raw = json.dumps(payload).encode()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        return Server(Handler)

    def test_error_body_is_not_echoed_into_the_exception(self):
        server = self.serve(400, {'error': {'message': f'bad key {self.SECRET} text={self.TEXT}'}})
        try:
            with self.assertRaises(RecognitionError) as caught:
                HttpTransport(timeout=5).post_json(server.url(), {}, {'Authorization': f'Bearer {self.SECRET}'})
            rendered = json.dumps(caught.exception.to_dict(), ensure_ascii=False)
            self.assertNotIn(self.SECRET, rendered, '密钥不得出现在异常里')
            self.assertNotIn(self.TEXT, rendered, '原文不得出现在异常里')
            self.assertFalse(caught.exception.retryable)
        finally:
            server.close()

    def test_server_error_is_retryable_but_still_redacted(self):
        server = self.serve(500, {'error': {'message': f'boom {self.SECRET}'}})
        try:
            with self.assertRaises(RecognitionError) as caught:
                HttpTransport(timeout=5).post_json(server.url(), {}, {'Authorization': f'Bearer {self.SECRET}'})
            self.assertTrue(caught.exception.retryable)
            self.assertNotIn(self.SECRET, json.dumps(caught.exception.to_dict(), ensure_ascii=False))
        finally:
            server.close()

    def test_auth_and_rate_limit_stay_distinguishable(self):
        for status, code, retryable in ((401, 'auth_failed', False), (429, 'rate_limited', True)):
            with self.subTest(status=status):
                server = self.serve(status, {'error': {'message': 'x'}})
                try:
                    with self.assertRaises(RecognitionError) as caught:
                        HttpTransport(timeout=5).post_json(server.url(), {}, {})
                    self.assertEqual(caught.exception.code, code)
                    self.assertEqual(caught.exception.retryable, retryable)
                finally:
                    server.close()


class TruncationAndTimeoutTests(unittest.TestCase):
    def test_incomplete_read_becomes_a_retryable_network_error(self):
        """读一半断开的异常类型不得泄出调用方。

        服务端何时关闭连接与协议版本相关，这里直接对传输层的读取边界做
        单元测试，确定性地覆盖这条路径，而不是依赖某个服务端是否恰好触发。
        """
        class Truncated:
            status = 200

            def read(self, size):
                raise http.client.IncompleteRead(b'{}', 98)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        transport = HttpTransport(timeout=5)
        with self.assertRaises(RecognitionError) as caught:
            transport._read_within(Truncated(), time.monotonic() + 5)
        self.assertEqual(caught.exception.code, 'network_failed')
        self.assertTrue(caught.exception.retryable)

    def test_truncated_server_response_never_leaks_library_exceptions(self):
        class Handler(BaseHTTPRequestHandler):
            # 真实模型服务都是 HTTP/1.1；1.0 下客户端不会按 Content-Length 判短读。
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', '100')
                self.end_headers()
                self.wfile.write(b'{}')
                self.close_connection = True

        server = Server(Handler)
        try:
            # 是否触发短读取决于服务端关闭时机，这里只断言契约：
            # 无论成功还是失败，都不能出现底层库的异常类型。
            try:
                HttpTransport(timeout=5).post_json(server.url(), {}, {})
            except RecognitionError as error:
                self.assertIn(error.code, ('network_failed', 'timeout'))
                self.assertIsInstance(error.retryable, bool)
            except (http.client.HTTPException, ConnectionError) as error:  # pragma: no cover
                self.fail(f'底层库异常泄漏：{type(error).__name__}')
        finally:
            server.close()

    def test_slow_response_respects_the_total_budget(self):
        # socket 超时只约束单次读；慢速持续送字节必须由总预算兜住。
        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_POST(self):
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                try:
                    for _ in range(200):
                        self.wfile.write(b' ')
                        self.wfile.flush()
                        time.sleep(0.02)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        server = Server(Handler)
        try:
            started = time.monotonic()
            with self.assertRaises(RecognitionError) as caught:
                HttpTransport(timeout=0.3).post_json(server.url(), {}, {})
            elapsed = time.monotonic() - started
            self.assertIn(caught.exception.code, ('timeout', 'network_failed'))
            self.assertLess(elapsed, 3.0, f'总耗时 {elapsed:.2f}s 超出预算，慢响应不被约束')
        finally:
            server.close()

    def test_timeout_validation_rejects_bad_values(self):
        for value in (0, -1, float('nan'), float('inf'), True, '5', None):
            with self.subTest(value=value):
                with self.assertRaises(RecognitionError):
                    validate_timeout(value)
        self.assertEqual(validate_timeout(1.5), 1.5)


if __name__ == '__main__':
    unittest.main()