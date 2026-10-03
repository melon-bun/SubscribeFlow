import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

from subscribe_flow.acquisition.cli import CLITransport, redact
from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ChannelError, Connection, Context, FetchPage, FetchRequest
from tests.fakes import TestAdapter


def context(seconds=5, resource="browser:test"):
    return Context(Connection("test", "test", "test", resource), "test-job", time.monotonic() + seconds)


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_independent_gateway_and_blocked_state(self):
        gateway = ChannelGateway()
        adapter = TestAdapter()
        gateway.register(adapter)
        ctx = context()
        source = await gateway.resolve_source("1", ctx)
        self.assertEqual((await gateway.fetch_page(source, FetchRequest(), ctx)).items[0].key, "test:video:1")
        adapter.error = ChannelError("AUTH_REQUIRED", "list_items", "请登录")
        self.assertEqual((await gateway.check_readiness("list_items", ctx)).state, "blocked")
        with self.assertRaises(ChannelError) as error:
            await gateway.search_sources("x", FetchRequest(), ctx)
        self.assertEqual(error.exception.code, "UNSUPPORTED_OPERATION")
        with self.assertRaises(ValueError):
            gateway.register(adapter)

    def test_terminal_requires_evidence(self):
        with self.assertRaises(ValueError):
            FetchPage((), None, "history_end", True)


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = CLITransport(ResourceCoordinator(), max_output=10000)

    async def test_argument_safety_and_redaction(self):
        value = "$(touch /tmp/subscribe-flow-must-not-exist); ' hello"
        result = await self.transport.run([sys.executable, "-c", "import sys; print(sys.argv[1])", value], context(), "test")
        self.assertEqual(result.stdout.strip(), value)
        self.assertNotIn("secret", redact("Cookie: SESSDATA=secret\naccess_token=secret"))

    async def test_timeout_cancellation_and_output_limit_are_distinct(self):
        for expected in ("TIMEOUT", "CANCELLED", "OUTPUT_LIMIT"):
            with self.subTest(expected=expected):
                ctx = context(0.15 if expected == "TIMEOUT" else 5)
                code = "import time; time.sleep(60)"
                if expected == "CANCELLED":
                    asyncio.get_running_loop().call_later(0.1, ctx.cancelled.set)
                if expected == "OUTPUT_LIMIT":
                    code = "print('x' * 20000)"
                with self.assertRaises(ChannelError) as error:
                    await self.transport.run([sys.executable, "-c", code], ctx, "test")
                self.assertEqual(error.exception.code, expected)

    async def test_waiting_for_shared_resource_is_cancellable(self):
        ctx = context()
        async with self.transport.resources.acquire(context(), "test"):
            asyncio.get_running_loop().call_later(0.1, ctx.cancelled.set)
            with self.assertRaises(ChannelError) as error:
                await self.transport.run([sys.executable, "-c", "print(1)"], ctx, "test")
            self.assertEqual(error.exception.code, "CANCELLED")

    @unittest.skipUnless(os.name == "posix", "POSIX process-group validation")
    async def test_cancel_cleans_child_process(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "child-survived"
            child = f"import time,pathlib; time.sleep(1); pathlib.Path({str(marker)!r}).touch()"
            code = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); time.sleep(60)"
            with self.assertRaises(ChannelError):
                await self.transport.run([sys.executable, "-c", code], context(0.25), "test")
            await asyncio.sleep(1)
            self.assertFalse(marker.exists())
