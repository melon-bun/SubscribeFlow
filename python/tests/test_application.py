import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ChannelError, ContentItem, FetchPage, ItemError, Source
from tests.fakes import TestAdapter


class ApplicationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.adapter = TestAdapter()
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.core = Core(Path(self.temp.name) / "core.sqlite3", gateway=gateway)
        self.sub = await self.core.subscriptions.add("author", "test:default", confirmed=True)
        self.source = self.core.repository.source_for(self.sub["id"])
        self.item = ContentItem("test", "video", "1", self.source, "One", "https://example.com/1")

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def run_scan(self, **kwargs):
        result = self.core.sync.start(self.sub["id"], **kwargs)
        return await self.core.sync.wait(result["job_id"])

    async def test_confirmation_and_complete_subscription_loop(self):
        with self.assertRaises(ChannelError):
            await self.core.subscriptions.add("other", "test:default")
        job = await self.run_scan()
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(self.core.queries.contents()["total"], 1)
        item = self.core.queries.contents()["items"][0]
        self.core.content.update(item["id"], {"read": True})
        await self.run_scan()
        self.assertTrue(self.core.queries.content(item["id"])["state"]["read"])
        self.assertEqual(self.core.queries.contents()["total"], 1)
        await self.core.update_subscription(self.sub["id"], status="cancelled")
        self.assertEqual(self.core.queries.contents()["total"], 1)

    async def test_duplicate_clicks_merge_and_cancel_stops_before_commit(self):
        self.adapter.delay = 1
        first = self.core.sync.start(self.sub["id"])
        second = self.core.sync.start(self.sub["id"])
        self.assertEqual(first["job_id"], second["job_id"])
        self.assertFalse(second["created"])
        await asyncio.sleep(0.01)
        await self.core.sync.cancel(first["job_id"])
        self.assertEqual(self.core.repository.get_job(first["job_id"])["state"], "cancelled")
        self.assertEqual(self.core.queries.contents()["total"], 0)

    async def test_cancel_before_task_has_started(self):
        job = self.core.sync.start(self.sub["id"])
        await self.core.sync.cancel(job["job_id"])
        self.assertEqual(self.core.repository.get_job(job["job_id"])["state"], "cancelled")

    async def test_partial_failure_preserves_committed_page_and_no_checkpoint(self):
        page = FetchPage((self.item,), {"page": 1}, "window_only")
        self.adapter.pages = [page]
        original = self.adapter.fetch_page
        async def fetch(source, request, context):
            if request.cursor:
                raise ChannelError("TIMEOUT", "list_items", "Timed out")
            return await original(source, request, context)
        self.adapter.fetch_page = fetch
        job = await self.run_scan(mode="backfill")
        self.assertEqual(job["state"], "partial")
        self.assertEqual(job["new_items"], 1)
        self.assertEqual(self.core.queries.contents()["total"], 1)
        progress = self.core.repository.get_progress(self.sub["id"])
        self.assertFalse(progress[0]["payload"]["complete"])

    async def test_repeated_pages_stop_without_claiming_complete(self):
        self.adapter.pages = [FetchPage((self.item,), {"page": 1}, "window_only"),
                              FetchPage((self.item,), {"page": 1}, "window_only")]
        job = await self.run_scan(mode="backfill")
        self.assertEqual(job["error"]["code"], "NO_PROGRESS")
        self.assertEqual(job["pages"], 2)
        self.assertEqual(job["coverage"], "possible_gaps")

    async def test_multpage_history_checks_head_and_saves_complete_evidence(self):
        second = replace(self.item, external_id="2", title="Two")
        self.adapter.pages = [FetchPage((self.item,), {"page": 1}, "window_only"),
                              FetchPage((second,), None, "history_end", True, "verified empty next range")]
        job = await self.run_scan(mode="backfill")
        self.assertEqual(job["state"], "succeeded")
        self.assertEqual(self.adapter.calls, 3)
        self.assertTrue(self.core.repository.get_progress(self.sub["id"])[0]["payload"]["complete"])

    async def test_moving_head_does_not_claim_complete(self):
        second = replace(self.item, external_id="2", title="Two")
        newest = replace(self.item, external_id="3", title="Three")
        self.adapter.pages = [FetchPage((self.item,), {"page": 1}, "window_only"),
                              FetchPage((second,), None, "history_end", True, "end")]
        original = self.adapter.fetch_page
        async def fetch(source, request, context):
            if self.adapter.calls >= 2:
                return FetchPage((newest, self.item), {"page": 1}, "window_only")
            return await original(source, request, context)
        self.adapter.fetch_page = fetch
        job = await self.run_scan(mode="backfill")
        self.assertEqual(job["state"], "partial")
        self.assertEqual(self.core.queries.contents()["total"], 3)
        self.assertFalse(self.core.repository.get_progress(self.sub["id"])[0]["payload"]["complete"])

    async def test_auth_waiting_does_not_change_subscription_or_block_local_reads(self):
        await self.run_scan()
        self.adapter.error = ChannelError("AUTH_REQUIRED", "list_items", "Login required", scope="connection", scope_key="test:default")
        job = await self.run_scan()
        self.assertEqual(job["state"], "waiting")
        self.assertEqual(self.core.repository.get_subscription(self.sub["id"])["status"], "active")
        self.assertEqual(self.core.queries.contents()["total"], 1)
        self.assertEqual(self.core.repository.list_connections()[0]["readiness"]["state"], "blocked")

    async def test_connection_change_during_fetch_discards_stale_result(self):
        self.adapter.delay = 0.05
        job = self.core.sync.start(self.sub["id"])
        await asyncio.sleep(0.01)
        self.core.repository.update_connection("test:default", resource_key="changed")
        result = await self.core.sync.wait(job["job_id"])
        self.assertEqual(result["error"]["code"], "STALE_CONFIG")
        self.assertEqual(self.core.queries.contents()["total"], 0)

    def test_second_core_cannot_recover_an_active_database(self):
        with self.assertRaises(RuntimeError):
            Core(self.core.database.path, gateway=self.core.gateway)
