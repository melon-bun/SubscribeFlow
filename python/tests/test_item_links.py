import tempfile
import time
import unittest
from pathlib import Path
from dataclasses import replace

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.bilibili.electron import BilibiliElectronAdapter
from subscribe_flow.channels.xiaohongshu.adapter import XiaohongshuAdapter
from subscribe_flow.contracts import ChannelError, Connection, Context, FetchPage

BV = 'BV1xx411c700'
NOTE = '1' * 24
AUTHOR = '2' * 24
SIGNED = f'https://www.xiaohongshu.com/discovery/item/{NOTE}?source=webshare&xsec_source=pc_share&xsec_token=fixture%3D'


class Bridge:
    def __init__(self):
        self.calls = []
        self.bili = {'bvid': BV, 'aid': 123, 'title': 'Video', 'owner': {'mid': 946974, 'name': 'Author'}, 'pubdate': 946684800}
        self.note = {'id': NOTE, 'authorId': AUTHOR, 'author': 'Note Author', 'title': 'Note', 'content': 'Content',
                     'url': SIGNED, 'published': {'value': None, 'precision': 'unknown'}, 'acquisition_complete': True}

    async def call(self, params, context, operation):
        self.calls.append(params)
        if context.connection.channel == 'bilibili':
            return {'code': 0, 'data': {'authenticated': True} if params['operation'] == 'check' else self.bili}
        if params['operation'] == 'check':
            return {'authenticated': True}
        if params['operation'] == 'resolve':
            return {'id': NOTE, 'url': SIGNED}
        return {'note': self.note}


class ItemLinkTests(unittest.IsolatedAsyncioTestCase):
    def context(self, channel):
        return Context(Connection(channel + ':default', channel, 'electron-session', channel), 'task', time.monotonic() + 5)

    async def test_bili_identity_first_and_real_owner_without_subscription(self):
        bridge = Bridge()
        adapter = BilibiliElectronAdapter(bridge)
        refs = [await adapter.resolve_item(u, self.context('bilibili')) for u in
                [f'https://www.bilibili.com:443/video/{BV}', f'https://m.bilibili.com/video/{BV}?p=2', f'https://www.bilibili.com/video/{BV}/']]
        self.assertEqual(bridge.calls, [])
        self.assertEqual(refs[0], refs[1])
        item = await adapter.read_item(refs[0], self.context('bilibili'))
        self.assertEqual(item.source.external_id, '946974')
        self.assertTrue(item.source.confirmed)
        self.assertTrue(item.acquisition_complete)
        self.assertEqual(item.published.precision, 'second')
        bridge.bili['owner']['mid'] = 'invalid'
        with self.assertRaises(ChannelError) as error:
            await adapter.read_item(refs[0], self.context('bilibili'))
        self.assertEqual(error.exception.code, 'SCHEMA_CHANGED')

    async def test_bili_av_and_short_normalize_and_av_mismatch_fails(self):
        bridge = Bridge()
        adapter = BilibiliElectronAdapter(bridge)
        for url in ['https://b23.tv/fixture', 'https://www.bilibili.com/video/av123']:
            self.assertEqual((await adapter.resolve_item(url, self.context('bilibili'))).external_id, BV)
        with self.assertRaises(ChannelError):
            await adapter.resolve_item('https://www.bilibili.com/video/av124', self.context('bilibili'))

    async def test_xhs_forms_preserve_signed_query_and_real_author_unknown_time(self):
        bridge = Bridge()
        adapter = XiaohongshuAdapter(bridge)
        refs = [await adapter.resolve_item(f'https://www.xiaohongshu.com/{p}?xsec_token=a%2Bb%3D', self.context('xiaohongshu'))
                for p in [f'explore/{NOTE}', f'search_result/{NOTE}', f'discovery/item/{NOTE}', f'user/profile/{AUTHOR}/{NOTE}']]
        self.assertEqual(bridge.calls, [])
        self.assertTrue(all(r == refs[0] for r in refs))
        self.assertIn('xsec_token=a%2Bb%3D', refs[0].url)
        item = await adapter.read_item(refs[0], self.context('xiaohongshu'))
        self.assertEqual(item.source.external_id, AUTHOR)
        self.assertTrue(item.source.confirmed)
        self.assertEqual(item.published.precision, 'unknown')
        self.assertEqual(item.url, SIGNED)
        bridge.note['id'] = '3' * 24
        with self.assertRaises(ChannelError):
            await adapter.read_item(refs[0], self.context('xiaohongshu'))

    async def test_foreign_urls_and_missing_author_are_rejected(self):
        for adapter in [BilibiliElectronAdapter(Bridge()), XiaohongshuAdapter(Bridge())]:
            for url in ['https://example.com/item', 'https://www.bilibili.com.evil.test/video/' + BV,
                        f'https://user@www.xiaohongshu.com/explore/{NOTE}', f'https://www.xiaohongshu.com:99/explore/{NOTE}']:
                self.assertFalse(adapter.match_item_url(url))
        bridge = Bridge()
        adapter = XiaohongshuAdapter(bridge)
        ref = await adapter.resolve_item(SIGNED, self.context('xiaohongshu'))
        bridge.note['author'] = ''
        with self.assertRaises(ChannelError):
            await adapter.read_item(ref, self.context('xiaohongshu'))

    async def test_xhs_core_preview_no_shell_then_manual_and_auto_duplicates(self):
        bridge = Bridge()
        with tempfile.TemporaryDirectory() as folder:
            core = Core(Path(folder) / 'test.db', browser_bridge=bridge)
            core.sync.resource_gap = 0
            try:
                task = core.intake.start(SIGNED)
                task = await core.intake.wait(task['task_id'])
                self.assertEqual(task['state'], 'preview', task)
                self.assertEqual(core.repository.query_contents()['total'], 0)
                self.assertEqual(core.repository.list_subscriptions(), [])
                saved = core.intake.save(task['preview_id'], priority='low')
                before = core.repository.get_content(saved['item_id'])
                self.assertEqual(before['intake_method'], 'manual')
                self.assertEqual(before['published']['precision'], 'unknown')
                item = core.intake.records[task['task_id']].item
                sub = core.repository.subscribe(item.source, 'xiaohongshu:default')
                job, _ = core.repository.create_job(sub['id'], 'refresh')
                core.repository.set_job_state(job['id'], 'running')
                core.repository.commit_page(job['id'], FetchPage((replace(item, title='Changed'),), None, 'window_only'))
                self.assertEqual(core.repository.get_content(saved['item_id'])['title'], before['title'])
                self.assertEqual(core.repository.get_content(saved['item_id'])['manual_added_at'], before['manual_added_at'])
                reads = sum(p['operation'] == 'read' for p in bridge.calls)
                again = await core.intake.wait(core.intake.start(f'https://www.xiaohongshu.com/explore/{NOTE}')['task_id'])
                self.assertEqual(again['state'], 'exists')
                self.assertEqual(sum(p['operation'] == 'read' for p in bridge.calls), reads)
                self.assertEqual(core.repository.query_contents()['total'], 1)
            finally:
                await core.close()
