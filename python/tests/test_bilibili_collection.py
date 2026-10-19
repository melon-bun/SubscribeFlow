import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ChannelError


class VideoBridge:
    """Platform boundary only; use the real adapter, sync service and database."""
    def __init__(self):
        self.calls = []
        self.fail_page = None
        self.reset_rows()

    def reset_rows(self, count=80, offset=0):
        self.rows = [dict(bvid=f'BV{offset + index:010d}', mid=946974,
                          title=f'Video {index}', created=1700000000 - index)
                     for index in range(count)]
        self.calls.clear()

    async def call(self, params, context, operation):
        self.calls.append(params)
        if params['page'] == self.fail_page:
            raise ChannelError('TIMEOUT', operation, 'Fixture page timeout')
        page, size = params['page'], params['limit']
        return dict(code=0, data=dict(
            page=dict(pn=page, ps=size, count=len(self.rows)),
            list=dict(vlist=self.rows[(page - 1) * size:page * size])))


class BilibiliCollectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = VideoBridge()
        self.core = Core(Path(self.temp.name) / 'core.sqlite3', browser_bridge=self.bridge,
                         schedule_policy=SchedulePolicy(startup_delay=0, resource_gap=0))
        self.sub = await self.core.subscriptions.add('946974', 'bilibili:default', confirmed=True)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def scan(self, mode='backfill', **kwargs):
        started = self.core.sync.start(self.sub['id'], mode=mode, **kwargs)
        return await self.core.sync.wait(started['job_id'])

    async def test_exact_saved_limits_for_initial_refresh_and_backfill(self):
        offset, total = 0, 0
        for mode in ('initial', 'refresh', 'backfill'):
            for ceiling in (1, 10, 20, 21, 35, 50):
                with self.subTest(mode=mode, ceiling=ceiling):
                    self.bridge.reset_rows(offset=offset)
                    offset += 100
                    await self.core.update_subscription(self.sub['id'], collect_items=ceiling)
                    job = await self.scan(mode)
                    self.assertEqual(job['state'], 'succeeded')
                    self.assertEqual((job['items'], job['new_items']), (ceiling, ceiling))
                    total += ceiling
                    self.assertEqual(self.core.queries.contents()['total'], total)
                    self.assertEqual([p['page'] for p in self.bridge.calls],
                                     list(range(1, -(-ceiling // 20) + 1)))
                    self.assertEqual({p['limit'] for p in self.bridge.calls}, {min(20, ceiling)})
                    self.assertEqual(job['coverage'], 'window_only')
                    self.assertIsNone(job['end_evidence'])

    async def test_duplicates_count_toward_window_and_preserve_user_state(self):
        await self.core.update_subscription(self.sub['id'], collect_items=20)
        await self.scan()
        first = 'bilibili:video:BV0000000000'
        self.core.content.update(first, {'read': True})
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        job = await self.scan()
        self.assertEqual((job['items'], job['new_items']), (35, 15))
        self.assertEqual(self.core.queries.contents()['total'], 35)
        self.assertTrue(self.core.queries.content(first)['state']['read'])
        job = await self.scan()
        self.assertEqual((job['items'], job['new_items']), (35, 0))
        self.assertEqual(self.core.queries.contents()['total'], 35)

    async def test_errors_consume_positions_and_outside_errors_are_not_committed(self):
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        for index in (25, 38):
            self.bridge.rows[index]['title'] = ''
        job = await self.scan()
        self.assertEqual(job['state'], 'partial')
        self.assertEqual((job['items'], job['item_errors']), (34, 1))
        self.assertEqual(self.core.queries.contents()['total'], 34)
        self.assertEqual(job['coverage'], 'possible_gaps')
        self.assertIsNone(job['end_evidence'])

    async def test_truncated_terminal_page_does_not_claim_platform_end(self):
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        self.bridge.reset_rows(count=40)
        job = await self.scan()
        self.assertEqual(job['items'], 35)
        self.assertEqual(len(self.bridge.calls), 2)
        self.assertIsNone(job['end_evidence'])
        self.assertFalse(self.core.repository.get_progress(self.sub['id'])[0]['payload']['complete'])

    async def test_error_outside_window_does_not_mark_the_run_partial(self):
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        self.bridge.rows[38]['title'] = ''
        job = await self.scan()
        self.assertEqual((job['state'], job['items'], job['item_errors']), ('succeeded', 35, 0))

    async def test_last_allowed_record_can_fail_without_saving_later_records(self):
        await self.core.update_subscription(self.sub['id'], collect_items=21)
        self.bridge.rows[20]['title'] = ''
        job = await self.scan()
        self.assertEqual((job['state'], job['items'], job['item_errors']), ('partial', 20, 1))
        self.assertEqual(job['coverage'], 'possible_gaps')
        self.assertIsNone(job['error'])
        self.assertEqual(self.core.queries.contents()['total'], 20)

    async def test_short_source_stops_at_available_content(self):
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        self.bridge.reset_rows(count=27)
        job = await self.scan()
        self.assertEqual((job['state'], job['items']), ('succeeded', 27))
        self.assertEqual(len(self.bridge.calls), 2)
        self.assertIn('api_count=27', job['end_evidence'])

    async def test_retry_keeps_exact_limit_after_a_partially_saved_run(self):
        await self.core.update_subscription(self.sub['id'], collect_items=35)
        self.bridge.fail_page = 2
        failed = await self.scan()
        self.assertEqual((failed['state'], failed['items']), ('partial', 20))
        self.bridge.fail_page = None
        started = await self.core.sync.retry(failed['id'])
        retried = await self.core.sync.wait(started['job_id'])
        self.assertEqual((retried['state'], retried['items'], retried['new_items']), ('succeeded', 35, 15))
        self.assertEqual(self.core.queries.contents()['total'], 35)

    async def test_automatic_refresh_uses_the_same_exact_limit(self):
        await self.core.update_subscription(self.sub['id'], collect_items=10, sync_mode='automatic')
        self.core.scheduler.list()
        self.core.scheduler.store.update(self.sub['id'], next_due=0)
        await self.core.scheduler.tick()
        job = self.core.repository.list_jobs()[0]
        job = await self.core.sync.wait(job['id'])
        self.assertEqual((job['trigger'], job['state'], job['items']), ('automatic', 'succeeded', 10))
        self.assertEqual(self.core.queries.contents()['total'], 10)

    async def test_explicit_page_budget_does_not_exceed_saved_item_limit(self):
        await self.core.update_subscription(self.sub['id'], collect_items=25)
        job = await self.scan(page_budget=7)
        self.assertEqual(job['page_budget'], 7)
        self.assertEqual(job['items'], 25)
        self.assertEqual(self.core.queries.contents()['total'], 25)
        self.assertEqual(len(self.bridge.calls), 2)

    async def test_clearing_limit_restores_default_page_budgets(self):
        await self.core.update_subscription(self.sub['id'], collect_items=10)
        await self.core.update_subscription(self.sub['id'], collect_items=0)
        self.bridge.reset_rows(count=220)
        refreshed = await self.scan('refresh')
        self.assertEqual((refreshed['page_budget'], refreshed['items']), (1, 20))
        self.bridge.calls.clear()
        backfilled = await self.scan()
        self.assertEqual((backfilled['page_budget'], backfilled['items']), (10, 200))
        self.assertEqual(len(self.bridge.calls), 10)
        self.assertEqual(self.core.queries.contents()['total'], 200)
