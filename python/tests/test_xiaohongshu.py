import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.xiaohongshu.adapter import XiaohongshuAdapter, source_from_locator
from subscribe_flow.contracts import ChannelError, ContentItem, FetchPage, FetchRequest, PublishedTime, Source

UID = '123456789012345678901234'
OTHER = '999999999999999999999999'
IDS = ['111111111111111111111111', '222222222222222222222222']
TOKEN = 'a' * 8 + '-' + 'a' * 4 + '-' + 'a' * 4 + '-' + 'a' * 4 + '-' + 'a' * 12


def note(id):
    return dict(id=id, authorId=UID, title='笔记 ' + id, content='正文', acquisition_complete=True,
                url=f'https://www.xiaohongshu.com/discovery/item/{id}?source=webshare&xhsshare=pc_web&xsec_token=fixture-share%3D&xsec_source=pc_share',
                published=dict(value='2026-01-02', precision='date', provenance='date-label', raw_label='2026-01-02'), images=[])


class Bridge:
    def __init__(self):
        self.calls = []
        self.fail_detail = False
        self.ids = list(IDS)

    async def call(self, params, context, operation):
        self.calls.append(params)
        if params['operation'] == 'check':
            return {'authenticated': True}
        if params['operation'] == 'search':
            return {'users': [dict(id=id, name='同名作者', description='简介 ' + id) for id in [UID, OTHER]], 'empty': False}
        if params['operation'] == 'detail':
            return {'note': note(params['id'])}
        cursor = params['cursor']
        if cursor is None:
            known = params.get('known_ids', [])
            window = self.ids[:params['limit']]
            self.pending = [id for id in window if id not in known]
            return dict(items=[], errors=[], metrics=dict(profile_reads=1, discovered=len(window), skipped=len(window)-len(self.pending), detail_requests=0),
                        cursor=TOKEN + ':1' if self.pending else None, terminal=not self.pending, end_evidence=None if self.pending else 'profile_end')
        if self.fail_detail:
            raise ChannelError('AUTH_REQUIRED', operation, 'fixture auth expired', scope='connection', scope_key=context.connection.id)
        id = self.pending.pop(0)
        return dict(items=[note(id)], errors=[], metrics=dict(profile_reads=0, discovered=0, skipped=0, detail_requests=1),
                    cursor=TOKEN + ':2' if self.pending else None, terminal=not self.pending, end_evidence=None if self.pending else 'profile_end')


class XHSTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = Bridge()
        self.adapter = XiaohongshuAdapter(self.bridge)
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.core = Core(Path(self.temp.name) / 'core.sqlite3', gateway=gateway)
        result = await self.core.subscriptions.search('同名', 'xiaohongshu:default')
        self.assertEqual(len(result.items), 2)
        self.sub = await self.core.subscriptions.add(UID, 'xiaohongshu:default', confirmed=True)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def scan(self, **kwargs):
        started = self.core.sync.start(self.sub['id'], **kwargs)
        return await self.core.sync.wait(started['job_id'])

    async def test_candidate_confirmation_and_stable_author_identity(self):
        self.assertEqual(self.sub['name'], '同名作者')
        self.assertEqual(len(self.core.queries.subscriptions()), 1)
        with self.assertRaises(ChannelError):
            await self.core.subscriptions.add(OTHER, 'xiaohongshu:default')
        self.assertEqual(source_from_locator(f'https://www.xiaohongshu.com/user/profile/{UID}?xsec_token=private').url,
                         f'https://www.xiaohongshu.com/user/profile/{UID}')
        self.assertFalse(hasattr(self.adapter, 'repository'))

    async def test_incremental_scan_persists_and_repeat_skips_complete_ids_without_losing_manual_data(self):
        job = await self.scan()
        self.assertEqual((job['state'], job['items'], job['new_items']), ('succeeded', 2, 2))
        self.assertEqual(job['page_budget'], 8)
        self.assertEqual(job['acquisition_metrics'], dict(profile_reads=1, discovered=2, skipped=0, detail_requests=2))
        key = 'xiaohongshu:note:' + IDS[0]
        self.core.content.update(key, {'read': True, 'priority': 'high'})
        tag = self.core.tags.create('保留标签')
        self.core.tags.set_content(key, [tag['id']])
        job = await self.scan()
        self.assertEqual((job['state'], job['items'], job['new_items']), ('succeeded', 0, 0))
        self.assertEqual(job['acquisition_metrics']['detail_requests'], 0)
        self.assertEqual(job['acquisition_metrics']['skipped'], 2)
        item = self.core.queries.content(key)
        self.assertEqual(item['url'],note(IDS[0])['url'])
        self.assertTrue(item['state']['read'])
        self.assertEqual(item['priority'], 'high')
        self.assertEqual(item['tags'][0]['id'], tag['id'])
        self.assertEqual(self.core.queries.calendar('2026-01')['total'], 2)

    async def test_incomplete_record_is_not_pre_filtered_and_channel_uses_exact_item_ceiling(self):
        source = self.core.repository.source_for(self.sub['id'])
        job = self.core.repository.create_job(self.sub['id'], 'refresh')[0]
        self.core.repository.set_job_state(job['id'], 'running')
        self.core.repository.commit_page(job['id'], FetchPage((ContentItem('xiaohongshu','note',IDS[0],source,'占位','https://example.com'),),None,'window_only'))
        self.core.repository.finish_scan(job['id'], coverage='window_only')
        self.assertEqual(self.core.repository.complete_source_ids(source.key), ())
        original = self.core.queries.content('xiaohongshu:note:'+IDS[0])
        await self.core.update_subscription(self.sub['id'], collect_items=1)
        job = await self.scan()
        self.assertEqual(job['page_budget'], 1)
        self.assertEqual(job['items'], 1)
        # Recollection is now a no-op even for incomplete legacy content.
        self.assertEqual(self.core.queries.content('xiaohongshu:note:'+IDS[0]), original)
        detail = self.core.sync.start(self.sub['id'], mode='detail', item_key=original['id'])
        self.assertEqual((await self.core.sync.wait(detail['job_id']))['state'], 'succeeded')
        self.assertTrue(self.core.queries.content(original['id'])['acquisition_complete'])

    async def test_auth_failure_after_commit_retains_results_and_marks_connection(self):
        original = self.bridge.call
        async def call(params, context, operation):
            result = await original(params, context, operation)
            if result.get('items'):
                self.bridge.fail_detail = True
            return result
        self.bridge.call = call
        job = await self.scan()
        self.assertEqual(job['state'], 'waiting')
        self.assertEqual(job['new_items'], 1)
        self.assertEqual(self.core.queries.contents()['total'], 1)
        self.assertEqual(self.core.repository.list_connections()[0]['readiness']['authentication'], 'required')
        from tests.fakes import TestAdapter
        from subscribe_flow.contracts import Connection
        self.core.gateway.register(TestAdapter())
        self.core.repository.add_connection(Connection('test:default','test','test','test:isolated'))
        other=await self.core.subscriptions.add('other','test:default',confirmed=True)
        started=self.core.sync.start(other['id'])
        self.assertEqual((await self.core.sync.wait(started['job_id']))['state'],'succeeded')
        self.assertEqual(self.core.queries.contents(channel='test')['total'],1)

    async def test_detail_uses_shared_source_context_and_completion_marker(self):
        await self.scan()
        key='xiaohongshu:note:'+IDS[0]
        job=await self.scan(mode='detail',item_key=key)
        self.assertEqual(job['state'],'succeeded')
        self.assertEqual(self.bridge.calls[-1]['uid'],UID)
        self.assertEqual(self.core.queries.content(key)['url'],note(IDS[0])['url'])
        original=self.bridge.call
        async def uncertain(params,ctx,op):
            result=await original(params,ctx,op)
            if params['operation']=='detail':
                result['note']['published']=dict(value=None,precision='unknown',provenance='unavailable')
            return result
        self.bridge.call=uncertain
        await self.scan(mode='detail',item_key=key)
        self.assertEqual(self.core.queries.content(key)['published']['value'],'2026-01-02')

    async def test_automatic_refresh_uses_channel_default_budget(self):
        from dataclasses import replace
        import time
        await self.core.update_subscription(self.sub['id'], sync_mode='automatic')
        self.core.scheduler.policy = replace(self.core.scheduler.policy, startup_delay=0, dispatch_gap=0, resource_gap=0)
        self.core.scheduler.next_dispatch = 0
        self.core.scheduler.store.update(self.sub['id'], next_due=time.time()-1)
        await self.core.scheduler.tick()
        for task in list(self.core.sync.tasks.values()):
            await task
        job = self.core.repository.list_jobs()[0]
        self.assertEqual((job['trigger'], job['page_budget']), ('automatic',8))

    async def test_known_entries_consume_budget_in_mixed_and_repeated_windows(self):
        await self.core.update_subscription(self.sub['id'], collect_items=1)
        job = await self.scan()
        self.assertEqual((job['items'], job['new_items']), (1, 1))
        for mode in ('refresh', 'backfill'):
            job = await self.scan(mode=mode)
            self.assertEqual((job['state'], job['items'], job['new_items']), ('succeeded', 0, 0))
            self.assertEqual(job['acquisition_metrics'], dict(profile_reads=1, discovered=1, skipped=1, detail_requests=0))
            self.assertEqual(self.core.queries.contents()['total'], 1)
        await self.core.update_subscription(self.sub['id'], collect_items=2)
        job = await self.scan()
        self.assertEqual((job['state'], job['new_items']), ('succeeded', 1))
        self.assertEqual(job['acquisition_metrics'], dict(profile_reads=1, discovered=2, skipped=1, detail_requests=1))
        self.assertEqual(self.core.queries.contents()['total'], 2)
        job = await self.scan()
        self.assertEqual(job['acquisition_metrics']['detail_requests'], 0)
        self.bridge.ids.insert(0, '333333333333333333333333')
        job = await self.scan()
        self.assertEqual((job['state'], job['new_items']), ('succeeded', 1))
        self.assertEqual(job['acquisition_metrics']['detail_requests'], 1)
        self.assertEqual(self.core.queries.contents()['total'], 3)

    async def test_replacement_adapter_reuses_persisted_subscriptions_and_views(self):
        await self.scan()
        source=self.core.repository.source_for(self.sub['id'])
        class Replacement:
            def describe(inner):
                from dataclasses import replace
                return replace(self.adapter.describe(),operations={k:v for k,v in self.adapter.describe().operations.items() if k not in {'match_item_url','resolve_item','read_item'}},backend='replacement',progress_version='replacement-1',scan_overhead_budget=0,budget_unit='pages')
            async def fetch_page(inner, src, request, context):
                return FetchPage((ContentItem('xiaohongshu','note','333333333333333333333333',src,'替换后端的笔记',
                    'https://www.xiaohongshu.com/explore/333333333333333333333333',kind='note',published=PublishedTime('2026-01-03','date'),acquisition_complete=True),),None,'window_only',True,'fixture end')
        self.core.gateway.register(Replacement())
        self.core.repository.update_connection('xiaohongshu:default',backend='replacement',resource_key='replacement:xhs')
        result=await self.scan()
        self.assertEqual(result['state'],'succeeded')
        self.assertEqual(self.core.queries.contents(channel='xiaohongshu')['total'],3)
        self.assertEqual(self.core.repository.source_for(self.sub['id']).key,source.key)
