import tempfile
import time
import unittest
from copy import deepcopy
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.zhihu.adapter import ZhihuAdapter, item_link, publication
from subscribe_flow.contracts import ChannelError, Connection, Context, FetchRequest

UID = 'a' * 32
OTHER = 'b' * 32
PIN = '1234567890123456789'
TOKEN = '11111111-1111-1111-1111-111111111111'


def author(id=UID):
    return dict(id=id, token='author-token', name='同名作者', url='https://www.zhihu.com/people/author-token')


def pin():
    return dict(id=PIN, author=author(), title='想法标题', content='第一段\n\n第二段完整正文',
                url=f'https://www.zhihu.com/pin/{PIN}', images=[], acquisition_complete=True,
                published=dict(value=None, precision='unknown', raw_label='编辑于昨天'))


class Bridge:
    def __init__(self):
        self.row = pin()
        self.auth = True
        self.fail = False
        self.calls = []

    async def call(self, params, context, operation):
        self.calls.append(params)
        if params['operation'] == 'check':
            return dict(authenticated=self.auth)
        if not self.auth:
            raise ChannelError('AUTH_REQUIRED', operation, '测试登录过期', scope='connection', scope_key=context.connection.id)
        if params['operation'] == 'author':
            return dict(author=author())
        if params['operation'] == 'search':
            return dict(users=[author(), author(OTHER)], empty=False)
        if params['operation'] in {'read', 'detail'}:
            return dict(pin=deepcopy(self.row))
        if params['cursor'] is None:
            known = PIN in params.get('known_ids', [])
            return dict(items=[], errors=[], metrics=dict(profile_reads=1, detail_requests=0, discovered=1, skipped=int(known)),
                        terminal=known, cursor=None if known else TOKEN + ':1', end_evidence='item_limit' if known else None)
        if self.fail:
            raise ChannelError('AUTH_REQUIRED', operation, '测试详情登录过期', scope='connection', scope_key=context.connection.id)
        return dict(items=[deepcopy(self.row)], errors=[], metrics=dict(profile_reads=0, detail_requests=1, discovered=0, skipped=0),
                    terminal=True, cursor=None, end_evidence='profile_end')


class ZhihuTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = Bridge()
        self.adapter = ZhihuAdapter(self.bridge)
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.clock = 1000000.
        self.core = Core(Path(self.temp.name) / 'core.db', gateway=gateway,
                         schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0), clock=lambda: self.clock)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    def context(self):
        return Context(Connection('zhihu:default', 'zhihu', 'electron-session', 'zhihu'), 'job', time.monotonic() + 5)

    async def test_search_stable_author_and_confirmation(self):
        candidates = await self.core.subscriptions.search('同名作者', 'zhihu:default')
        self.assertEqual([s.external_id for s in candidates.items], [UID, OTHER])
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        with self.assertRaises(ChannelError):
            await self.core.subscriptions.add(candidates.items[0].url, 'zhihu:default')
        sub = await self.core.subscriptions.add(candidates.items[0].url, 'zhihu:default', confirmed=True)
        self.assertEqual(sub['source_id'], 'zhihu:author:' + UID)
        self.assertNotEqual(sub['source_id'], 'zhihu:author:author-token')
        self.assertFalse(hasattr(self.adapter, 'repository'))

    async def test_manual_unknown_time_real_source_without_fake_subscription_and_noop(self):
        task = await self.core.intake.wait(self.core.intake.start(f'https://zhihu.com/pin/{PIN}?share=1')['task_id'])
        self.assertEqual(task['state'], 'preview')
        self.assertEqual(self.core.repository.query_contents()['total'], 0)
        saved = self.core.intake.save(task['preview_id'], priority='high')
        before = self.core.queries.content(saved['item_id'])
        self.assertEqual(before['published']['precision'], 'unknown')
        self.assertEqual(before['calendar_basis'], 'manual_added_at')
        self.assertEqual(before['summary'], '第一段\n\n第二段完整正文')
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        self.assertEqual(self.core.repository.list_jobs(), [])
        self.bridge.row['content'] = '变化正文'
        self.bridge.auth = False
        reads = sum(p['operation'] == 'read' for p in self.bridge.calls)
        duplicate = await self.core.intake.wait(self.core.intake.start(f'https://www.zhihu.com/pin/{PIN}')['task_id'])
        self.assertEqual(duplicate['state'], 'exists')
        self.assertEqual(sum(p['operation'] == 'read' for p in self.bridge.calls), reads)
        self.assertEqual(self.core.queries.content(saved['item_id']), before)

    async def test_malformed_identity_owner_time_or_missing_body_never_writes(self):
        for patch in [dict(author=author(OTHER), id='wrong'), dict(author=dict(id='', name='作者')),
                      dict(content=None), dict(published=dict(value='2026-10-09', precision='second'))]:
            self.bridge.row = {**pin(), **patch}
            task = await self.core.intake.wait(self.core.intake.start(f'https://www.zhihu.com/pin/{PIN}')['task_id'])
            self.assertEqual(task['state'], 'failed', patch)
            self.assertEqual(self.core.repository.query_contents()['total'], 0)
        self.bridge.row = pin()
        source = await self.adapter.resolve_source('author-token', self.context())
        self.bridge.row['author'] = author(OTHER)
        context = self.context()
        context.source = source
        with self.assertRaises(ChannelError) as error:
            await self.adapter.get_item_detail('zhihu:pin:' + PIN, context)
        self.assertEqual(error.exception.code, 'SCHEMA_CHANGED')

    async def test_auth_wait_cancel_recovery_and_automatic_schedule_use_existing_pipeline(self):
        sub = await self.core.subscriptions.add('author-token', 'zhihu:default', confirmed=True)
        self.bridge.auth = False
        job = await self.core.sync.wait(self.core.sync.start(sub['id'])['job_id'])
        self.assertEqual(job['state'], 'waiting')
        self.assertEqual(job['error']['code'], 'AUTH_REQUIRED')
        self.bridge.auth = True
        self.assertEqual((await self.core.check_connection('zhihu:default')).state, 'ready')
        await self.core.update_subscription(sub['id'], sync_mode='automatic', collect_items=1, interval_seconds=300)
        self.core.scheduler.store.ensure(self.core.repository.get_subscription(sub['id']), self.clock)
        self.clock += 300
        await self.core.scheduler.tick()
        for task in list(self.core.sync.tasks.values()):
            await task
        job = self.core.repository.list_jobs()[0]
        self.assertEqual(job['trigger'], 'automatic')
        self.assertEqual((job['state'], job['new_items']), ('succeeded', 1))
        item = self.core.queries.content('zhihu:pin:' + PIN)
        self.assertEqual(item['intake_method'], 'subscription')
        self.assertEqual(item['published']['precision'], 'unknown')
        self.assertEqual(self.core.queries.calendar('2026-10')['total'], 0)
        latest = self.core.sync.start(sub['id'])['job_id']
        await self.core.sync.cancel(latest)
        self.assertEqual(self.core.repository.get_job(latest)['state'], 'cancelled')

    async def test_cursor_progress_and_acquisition_evidence_validation(self):
        source = await self.adapter.resolve_source('author-token', self.context())
        request = FetchRequest(item_budget=1)
        page = await self.adapter.fetch_page(source, request, self.context())
        self.assertEqual(page.metrics['discovered'], 1)
        self.assertFalse(page.terminal)
        with self.assertRaises(ChannelError):
            await self.adapter.fetch_page(source, FetchRequest(item_budget=2, cursor=page.next_cursor), self.context())
        detail = await self.adapter.fetch_page(source, FetchRequest(item_budget=1, cursor=page.next_cursor), self.context())
        self.assertTrue(detail.terminal)
        self.assertEqual(detail.coverage, 'window_only')
        self.assertFalse(self.adapter.describe().operations['list_items'].full_history)
        original = self.bridge.call
        async def malformed(params, context, operation):
            row = await original(params, context, operation)
            row['metrics']['detail_requests'] = 3
            return row
        self.bridge.call = malformed
        with self.assertRaises(ChannelError):
            await self.adapter.fetch_page(source, request, self.context())

    def test_url_scope_and_publication_precision(self):
        self.assertEqual(item_link(f'https://www.zhihu.com:443/pin/{PIN}/')[0], PIN)
        for url in ['https://www.zhihu.com/question/1', 'https://zhuanlan.zhihu.com/p/1',
                    f'https://www.zhihu.com.evil/pin/{PIN}', f'https://user@www.zhihu.com/pin/{PIN}']:
            self.assertFalse(self.adapter.match_item_url(url))
        self.assertEqual(publication(dict(value='2000-01-01', precision='date')).precision, 'date')
        for row in [dict(value='2026-02-30', precision='date'), dict(value=None, precision='second'),
                    dict(value='2026-10-09T10:00:00', precision='second')]:
            with self.assertRaises(ValueError):
                publication(row)
