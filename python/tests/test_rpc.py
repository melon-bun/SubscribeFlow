import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.rpc.dispatcher import Dispatcher
from tests.fakes import TestAdapter


class RPCTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        gateway = ChannelGateway()
        gateway.register(TestAdapter())
        self.core = Core(Path(self.temp.name) / "rpc.sqlite3", gateway=gateway)
        self.stopping = asyncio.Event()
        self.rpc = Dispatcher(self.core, self.stopping.set)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def call(self, method, params=None):
        return await self.rpc.handle({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    async def hello(self):
        return await self.call("core.hello", {"protocol_version": "1.0"})

    async def test_handshake_version_whitelist_and_exact_validation(self):
        self.assertEqual((await self.call("content.list"))["error"]["code"], -32001)
        self.assertEqual((await self.call("core.hello", {"protocol_version": "999"}))["error"]["code"], -32001)
        await self.hello()
        self.assertEqual((await self.call("os.system", {"command": "touch forbidden"}))["error"]["code"], -32601)
        for params in ({"limit": True}, {"limit": "10"}, {"sql": "SELECT 1"}):
            self.assertEqual((await self.call("content.list", params))["error"]["code"], -32602)

    async def test_query_add_start_cancel_and_error_shape(self):
        await self.hello()
        sub = (await self.call("subscription.add", {"locator": "1", "connection_id": "test:default", "confirmed": True}))["result"]
        job = (await self.call("sync.start", {"subscription_id": sub["id"]}))["result"]
        self.assertTrue((await self.call("sync.cancel", {"job_id": job["job_id"]}))["result"]["cancelled"])
        self.assertEqual((await self.call("content.list"))["result"]["total"], 0)
        error = (await self.call("sync.get", {"job_id": "missing"}))["error"]
        self.assertEqual(error["data"]["code"], "NOT_FOUND")
        await self.call("core.shutdown")
        self.assertTrue(self.stopping.is_set())

    async def test_invalid_requests_and_notifications(self):
        for data in ([], None, {"jsonrpc": "2.0", "id": {}, "method": "core.hello"}):
            self.assertEqual((await self.rpc.handle(data))["error"]["code"], -32600)
        await self.hello()
        self.assertIsNone(await self.rpc.handle({"jsonrpc": "2.0", "method": "channel.list"}))
