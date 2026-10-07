import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage
from tests.fakes import TestAdapter


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.timestamp = 1000000.
        self.adapter = TestAdapter()
        self.gateway = ChannelGateway()
        self.gateway.register(self.adapter)
        self.policy = SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0, retry_base=10, retry_cap=40)
        self.open()

    def open(self):
        self.core = Core(Path(self.temp.name)/'core.sqlite3', gateway=self.gateway,
                         schedule_policy=self.policy, clock=lambda: self.timestamp)
        self.scheduler = self.core.scheduler

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def add(self, name='one', **kwargs):
        sub = await self.core.subscriptions.add(name, 'test:default', confirmed=True, **kwargs)
        self.scheduler.list()
        return sub

    async def tick(self, seconds=0):
        self.timestamp += seconds
        await self.scheduler.tick()

    async def finish(self):
        tasks = list(self.core.sync.tasks.values())
        if tasks:
            await asyncio.gather(*tasks)
        await asyncio.sleep(0)

    async def due(self, sub):
        self.scheduler.store.update(sub['id'], next_due=self.timestamp)
        await self.tick()

    async def test_manual_default_and_24h_schedule_are_persisted_and_capped_at_72h(self):
        sub = await self.add()
        self.assertEqual((sub['sync_mode'], sub['interval_seconds']), ('manual', 86400))
        with self.assertRaises(ChannelError):
            self.core.sync.start(sub['id'], _trigger='automatic')
        await self.tick(4*86400)
        self.assertEqual(self.adapter.calls, 0)
        self.assertIsNone(self.scheduler.list()[0]['next_due'])
        for interval in (299, 259201, True):
            with self.assertRaises(ChannelError):
                await self.core.update_subscription(sub['id'], interval_seconds=interval)
        sub = await self.core.update_subscription(sub['id'], sync_mode='automatic', interval_seconds=259200)
        await self.tick(259199)
        self.assertEqual(self.adapter.calls, 0)
        await self.tick(1)
        await self.finish()
        self.assertEqual(self.adapter.calls, 1)
        due = self.scheduler.list()[0]['next_due']
        await self.core.close()
        self.open()
        self.assertEqual(self.scheduler.list()[0]['next_due'], due)
        await self.core.update_subscription(sub['id'], sync_mode='manual')
        await self.tick(5*86400)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(self.core.repository.get_subscription(sub['id'])['interval_seconds'], 259200)

    async def test_collect_items_persists_converts_to_whole_pages_and_defaults_are_unchanged(self):
        sub = await self.add()
        self.assertEqual(self.core.repository.get_subscription(sub['id'])['collect_items'], 0)
        for bad in (-1, 51, True, 1.5):
            with self.assertRaises(ChannelError):
                await self.core.update_subscription(sub['id'], collect_items=bad)
        # 20 items per page, so 1-20 -> 1 page, 21-40 -> 2, 41-50 -> 3.
        for items, pages in ((1, 1), (20, 1), (21, 2), (35, 2), (50, 3)):
            await self.core.update_subscription(sub['id'], collect_items=items)
            self.core.sync.start(sub['id'])
            await self.finish()
            latest = self.core.repository.list_jobs()[0]
            self.assertEqual((latest['page_budget'], latest['mode']), (pages, 'refresh'), f'{items} 条应为 {pages} 页')
        await self.core.update_subscription(sub['id'], collect_items=0)
        self.assertEqual(self.core.sync.page_budget_for(self.core.repository.get_subscription(sub['id']), 'backfill'), 10)
        self.assertEqual(self.core.sync.page_budget_for(self.core.repository.get_subscription(sub['id']), 'refresh'), 1)

    async def test_explicit_page_budget_still_overrides_the_collect_item_ceiling(self):
        sub = await self.add()
        await self.core.update_subscription(sub['id'], collect_items=25)
        self.core.sync.start(sub['id'], mode='backfill', page_budget=7)
        await self.finish()
        self.assertEqual(self.core.repository.list_jobs()[0]['page_budget'], 7)

    async def test_automatic_refresh_respects_the_subscription_collection_ceiling(self):
        sub = await self.add(sync_mode='automatic')
        await self.core.update_subscription(sub['id'], collect_items=35)
        await self.due(self.core.repository.get_subscription(sub['id']))
        await self.finish()
        job = self.core.repository.list_jobs()[0]
        self.assertEqual((job['trigger'], job['page_budget']), ('automatic', 2))

    async def test_manual_and_automatic_requests_merge_and_switching_mode_cancels_pending_work(self):
        sub = await self.add(sync_mode='automatic')
        self.adapter.delay = 1
        await self.due(sub)
        first = self.core.repository.list_jobs()[0]
        manual = self.core.sync.start(sub['id'])
        self.assertEqual(manual['job_id'], first['id'])
        self.assertFalse(manual['created'])
        await self.core.update_subscription(sub['id'], sync_mode='manual')
        await self.finish()
        self.assertEqual(self.core.repository.get_job(first['id'])['state'], 'cancelled')
        self.assertEqual(self.core.queries.contents()['total'], 0)
        await self.tick(5*86400)
        self.assertEqual(len(self.core.repository.list_jobs()), 1)

    async def test_bounded_transient_retries_are_idempotent_and_survive_restart(self):
        sub = await self.add(sync_mode='automatic')
        self.adapter.error = ChannelError('TIMEOUT', 'list_items', 'Temporary timeout', retryable=True)
        await self.due(sub)
        await self.finish()
        job = self.core.repository.list_jobs()[0]
        before = self.scheduler.store.get(sub['id'])
        self.scheduler.observe('sync.changed', job)
        self.assertEqual(self.scheduler.store.get(sub['id']), before)
        await self.core.close()
        self.open()
        self.assertEqual(self.scheduler.store.get(sub['id']), before)
        for delay in (10,20,40):
            await self.tick(delay)
            await self.finish()
        self.assertEqual(self.adapter.calls, 4)
        self.assertIsNone(self.scheduler.store.get(sub['id'])['next_due'])
        await self.tick(100000)
        self.assertEqual(self.adapter.calls, 4)
        self.adapter.error = None
        result = await self.core.sync.retry(self.core.repository.list_jobs()[0]['id'])
        await self.core.sync.wait(result['job_id'])
        self.assertEqual(self.scheduler.store.get(sub['id'])['failures'], 0)

    async def test_login_block_stops_entire_connection_without_polling_and_recovers_gradually(self):
        first = await self.add('one', sync_mode='automatic')
        second = await self.add('two', sync_mode='automatic')
        self.adapter.error = ChannelError('INTERACTION_REQUIRED', 'list_items', 'Please verify', scope='connection')
        await self.due(first)
        await self.finish()
        self.scheduler.store.update(second['id'], next_due=self.timestamp)
        await self.tick(86400)
        await self.tick(86400)
        self.assertEqual(self.adapter.calls, 1)
        self.assertEqual(len(self.core.repository.list_jobs()), 1)
        self.assertEqual(self.core.queries.contents()['total'], 0)
        await self.core.close()
        self.open()
        await self.tick()
        self.assertEqual(self.adapter.calls, 1)
        self.adapter.error = None
        await self.core.check_connection('test:default')
        await self.tick()
        await self.finish()
        self.assertEqual(self.adapter.calls, 2)
        await self.tick()
        await self.finish()
        self.assertEqual(self.adapter.calls, 3)

    async def test_rate_limit_respects_shared_resource_and_retry_after(self):
        first = await self.add('one', sync_mode='automatic')
        conn = self.core.repository.get_connection('test:default')
        self.core.repository.add_connection(Connection('second', 'test', 'test', conn.resource_key))
        second = await self.core.subscriptions.add('two', 'second', confirmed=True, sync_mode='automatic')
        self.scheduler.list()
        self.adapter.error = ChannelError('RATE_LIMITED', 'list_items', 'Slow down', scope='resource', retryable=True, retry_after=120)
        await self.due(first)
        await self.finish()
        self.scheduler.store.update(second['id'], next_due=self.timestamp)
        self.adapter.error = None
        await self.tick(119)
        self.assertEqual(self.adapter.calls, 1)
        await self.tick(1)
        await self.finish()
        self.assertEqual(self.adapter.calls, 2)

    async def test_dependency_probe_is_bounded_but_parser_block_needs_successful_manual_scan(self):
        sub = await self.add(sync_mode='automatic')
        checks = []
        original = self.adapter.check_readiness
        async def check(*args):
            checks.append(1)
            return await original(*args)
        self.adapter.check_readiness = check
        self.adapter.error = ChannelError('DEPENDENCY_UNAVAILABLE', 'list_items', 'Offline', scope='connection')
        await self.due(sub)
        await self.finish()
        await self.tick()
        await self.tick(10)
        self.assertEqual(len(checks), 1)
        self.adapter.error = None
        await self.tick(300)
        await self.tick()
        await self.finish()
        self.assertEqual(self.adapter.calls, 2)
        self.adapter.error = ChannelError('SCHEMA_CHANGED', 'list_items', 'Parser changed')
        await self.due(sub)
        await self.finish()
        self.adapter.error = None
        await self.core.check_connection('test:default')
        await self.tick(86400)
        self.assertEqual(self.adapter.calls, 3)
        self.core.sync.start(sub['id'])
        await self.finish()
        self.assertFalse(self.scheduler.blocked(sub))

    async def test_pause_resume_and_clock_jump_catch_up_once_without_replaying_every_interval(self):
        sub = await self.add(sync_mode='automatic')
        self.adapter.delay = 1
        await self.due(sub)
        await asyncio.sleep(0)
        await self.scheduler.power(True)
        self.assertEqual(self.core.repository.list_jobs()[0]['state'], 'interrupted')
        await self.tick(10*86400)
        self.assertEqual(self.core.queries.contents()['total'], 0)
        self.adapter.delay = 0
        await self.scheduler.power(False)
        await self.tick()
        await self.finish()
        self.assertEqual(self.core.queries.contents()['total'], 1)
        calls = self.adapter.calls
        await self.tick()
        await self.finish()
        self.assertEqual(self.adapter.calls, calls)

    async def test_restart_replays_interrupted_backfill_budget_without_resetting_user_state(self):
        sub = await self.add(sync_mode='automatic')
        self.core.sync.start(sub['id'])
        await self.finish()
        item = self.core.queries.contents()['items'][0]
        self.core.content.update(item['id'], {'read':True})
        self.adapter.delay = 1
        self.core.sync.start(sub['id'], mode='backfill', page_budget=3)
        await asyncio.sleep(0)
        await self.core.close()
        self.open()
        self.adapter.delay = 0
        await self.tick()
        await self.finish()
        latest = self.core.repository.list_jobs()[0]
        self.assertEqual((latest['mode'], latest['page_budget'], latest['trigger']), ('backfill',3,'recovery'))
        self.assertTrue(self.core.queries.content(item['id'])['state']['read'])
        self.assertEqual(self.core.queries.contents()['total'], 1)

    async def test_backfill_yields_shared_resource_to_due_subscription(self):
        first = await self.add('one', sync_mode='automatic')
        second = await self.add('two', sync_mode='automatic')
        entered = asyncio.Event()
        release = asyncio.Event()
        order = []
        async def fetch(source, request, context):
            page = (request.cursor or {}).get('page',0)
            order.append((source.external_id,page))
            if len(order) == 1:
                entered.set()
                await release.wait()
            item = ContentItem('test','video',source.external_id+str(page),source,'Title','https://example.com/item')
            return FetchPage((item,), {'page':page+1} if page < 2 and source.external_id == 'one' else None, 'window_only')
        self.adapter.fetch_page = fetch
        self.core.sync.start(first['id'], mode='backfill',page_budget=3, _trigger='recovery')
        await entered.wait()
        await self.due(second)
        await asyncio.sleep(0)
        release.set()
        await self.finish()
        self.assertIn(('two',0), order)
        self.assertLess(order.index(('two',0)), order.index(('one',2)))
