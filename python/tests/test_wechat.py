import tempfile
import time
import unittest
from copy import deepcopy
from pathlib import Path

from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.wechat.adapter import WechatAdapter, article_link
from subscribe_flow.contracts import ChannelError, Connection, Context, FetchRequest

SHORT = 'https://mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g'
PARAMS = ('https://mp.weixin.qq.com/s?__biz=MzIxODg1OTk1MA%3D%3D&mid=2247551517&idx=1'
          '&sn=96379061cbb1d4f60b3553d285b13bd0&chksm=fixture&scene=27')
ARTICLE = 'MzIxODg1OTk1MA==_2247551517_1'
OTHER_ARTICLE = 'MzIxODg1OTk1MA==_2247551518_2'


def article(id=ARTICLE, *, account='MzIxODg1OTk1MA==', name='M14 隔离公众号', byline='署名甲'):
    return {'id': id, 'url': SHORT, 'title': '一篇公众号文章',
            'content': '第一段正文\n\n第二段完整正文。',
            'images': ['https://mmbiz.qpic.cn/mmbiz_png/fixture.png'],
            'cover': ['https://mmbiz.qpic.cn/mmbiz_jpg/fixture-cover.jpeg'],
            'account': {'id': account, 'name': name, 'url': SHORT,
                        'avatar': 'http://mmbiz.qpic.cn/mmbiz_png/fixture-avatar.png',
                        'description': f'文章署名：{byline}'},
            'published': {'value': '2026-06-05T18:51:40+08:00', 'precision': 'second',
                          'provenance': 'wechat-page:ct'},
            'acquisition_complete': True}


class Bridge:
    """Test-only private backend. Every response is a page-confirmed row."""

    def __init__(self):
        self.row = article()
        self.read_row = None
        self.visits = []
        self.error = None
        self.blocked = False

    async def call(self, params, context, operation):
        self.visits.append((params['operation'], params.get('url'), params.get('id')))
        if self.error:
            raise self.error
        if self.blocked:
            raise ChannelError('INTERACTION_REQUIRED', operation, '微信要求人工验证，本次已停止采集且未保存任何内容。',
                               scope='connection', scope_key=context.connection.id)
        if params['operation'] == 'resolve':
            return {'article': deepcopy(self.row)}
        if params['operation'] == 'read':
            row = deepcopy(self.read_row or self.row)
            # The page identity is checked against the reference the caller holds.
            if params.get('id') != row['id']:
                raise ChannelError('SCHEMA_CHANGED', operation, '读取到的文章与预览身份不一致')
            return {'article': row}
        raise AssertionError(f'unexpected operation {params["operation"]}')


class WechatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.bridge = Bridge()
        self.adapter = WechatAdapter(self.bridge)
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.core = Core(Path(self.temp.name) / 'core.db', gateway=gateway,
                         schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0))

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    def context(self):
        return Context(Connection('wechat:default', 'wechat', 'electron-session', 'wechat'), 'job',
                       time.monotonic() + 5)

    async def recognize(self, url=SHORT):
        task = self.core.intake.start(url)
        return await self.core.intake.wait(task['task_id'])

    async def test_declares_single_item_operations_only(self):
        operations = self.adapter.describe().operations
        self.assertEqual({name for name, cap in operations.items() if cap.supported},
                         {'match_item_url', 'resolve_item', 'read_item'})
        self.assertEqual(self.adapter.describe().content_types, ('article',))

    async def test_official_link_matching_without_io(self):
        for url in (SHORT, PARAMS, SHORT.replace('https://', 'http://')):
            self.assertTrue(self.adapter.match_item_url(url))
            self.assertIsNotNone(article_link(url))
        for url in ('https://mp.weixin.qq.com/s/short', 'https://mp.weixin.qq.com/mp/homepage',
                    'https://example.com/s/xU4gmCIp_MSONxdFXPwZ3g', 'https://mp.weixin.qq.com/s?__biz=x&mid=1',
                    'https://user:pw@mp.weixin.qq.com/s/xU4gmCIp_MSONxdFXPwZ3g', 'javascript:alert(1)'):
            self.assertFalse(self.adapter.match_item_url(url), url)

    async def test_both_link_forms_resolve_to_one_key(self):
        first = await self.recognize(SHORT)
        self.assertEqual(first['state'], 'preview')
        self.core.intake.save(self.core.intake.records[first['task_id']].preview_id)
        self.bridge.visits.clear()
        second = await self.recognize(PARAMS)
        self.assertEqual(second['state'], 'exists')
        self.assertEqual(second['item_id'], first['preview']['id'])
        # 只解析身份一次就命中已有记录：不为同一篇文章重复读取正文。
        self.assertEqual([visit[0] for visit in self.bridge.visits], ['resolve'])

    async def test_preview_carries_account_body_and_original_time(self):
        task = await self.recognize()
        self.assertEqual(task['state'], 'preview')
        preview = task['preview']
        self.assertEqual(preview['external_id'], ARTICLE)
        self.assertEqual(preview['source']['external_id'], 'MzIxODg1OTk1MA==')
        self.assertEqual(preview['source']['kind'], 'account')
        self.assertTrue(preview['source']['confirmed'])
        self.assertIn('第二段完整正文', preview['summary'])
        self.assertEqual(preview['thumbnail'], 'https://mmbiz.qpic.cn/mmbiz_jpg/fixture-cover.jpeg')
        self.assertEqual(preview['source']['avatar'], 'https://mmbiz.qpic.cn/mmbiz_png/fixture-avatar.png')
        self.assertEqual(preview['published']['value'], '2026-06-05T18:51:40+08:00')
        self.assertEqual(preview['published']['timezone'], 'Asia/Shanghai')
        sources = self.core.repository.list_content_sources()
        self.assertEqual(sources, {'items': []})  # 预览阶段不写来源

    async def test_preview_writes_nothing_and_saves_without_subscription(self):
        await self.recognize()
        self.assertEqual(self.core.queries.contents()['total'], 0)
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        task = self.core.intake.start(SHORT)
        await self.core.intake.wait(task['task_id'])
        preview_id = self.core.intake.records[task['task_id']].preview_id
        saved = self.core.intake.save(preview_id, priority='high')
        content = self.core.repository.get_content(saved['item_id'])
        self.assertEqual(content['intake_method'], 'manual')
        self.assertEqual(content['calendar_basis'], 'manual_added_at')
        self.assertTrue(content['manual_added_at'])
        self.assertEqual(content['priority_override'], 'high')
        self.assertEqual(self.core.repository.list_content_sources()['items'][0]['kind'], 'account')
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        self.assertEqual(self.core.repository.list_jobs(), [])

    async def test_duplicate_is_an_atomic_no_op(self):
        first = await self.recognize()
        record = self.core.intake.records[first['task_id']]
        saved = self.core.intake.save(record.preview_id)
        before = self.core.repository.get_content(saved['item_id'])
        again = await self.recognize(PARAMS)
        self.assertEqual(again['state'], 'exists')
        self.assertEqual(self.core.queries.contents()['total'], 1)
        self.assertEqual(self.core.repository.get_content(before['id']), before)

    async def test_second_article_of_one_push_is_a_separate_record(self):
        first = await self.recognize()
        self.core.intake.save(self.core.intake.records[first['task_id']].preview_id)
        self.bridge.row = article(OTHER_ARTICLE)
        task = await self.recognize()
        self.assertEqual(task['state'], 'preview')
        self.assertEqual(task['preview']['external_id'], OTHER_ARTICLE)
        self.core.intake.save(task['preview_id'])
        self.assertEqual(self.core.queries.contents()['total'], 2)

    async def test_account_identity_ignores_byline(self):
        first = await self.recognize()
        self.core.intake.save(self.core.intake.records[first['task_id']].preview_id)
        self.bridge.row = article(name='M14 隔离公众号', byline='另一个署名')
        task = await self.recognize()
        self.assertEqual(task['state'], 'exists')
        self.assertEqual(self.core.queries.contents()['total'], 1)
        self.assertEqual(self.core.repository.list_content_sources()['items'][0]['external_id'],
                         'MzIxODg1OTk1MA==')

    async def test_blocked_page_stops_without_saving_or_retrying(self):
        self.bridge.blocked = True
        task = await self.recognize()
        self.assertEqual(task['state'], 'failed')
        self.assertEqual(task['error']['code'], 'INTERACTION_REQUIRED')
        self.assertEqual(self.core.queries.contents()['total'], 0)
        self.assertEqual([v[0] for v in self.bridge.visits], ['resolve'])
        self.assertEqual(self.core.repository.list_jobs(), [])

    async def test_missing_identity_is_never_saved(self):
        self.bridge.row = {k: v for k, v in article().items() if k != 'account'}
        task = await self.recognize()
        self.assertEqual(task['state'], 'failed')
        self.assertEqual(task['error']['code'], 'SCHEMA_CHANGED')
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_missing_reference_identity_is_refused(self):
        self.bridge.error = ChannelError('SCHEMA_CHANGED', 'read_item', '微信页面未提供可确认的公众号身份')
        task = await self.recognize()
        self.assertEqual(task['state'], 'failed')
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_read_refuses_a_different_article(self):
        # 读取时页面返回了另一篇文章：拒绝预览，不迁就为另一条内容。
        self.bridge.read_row = article(OTHER_ARTICLE)
        task = await self.recognize()
        self.assertEqual(task['state'], 'failed')
        self.assertEqual(task['error']['code'], 'SCHEMA_CHANGED')
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_channel_has_no_subscription_or_listing_operations(self):
        context = self.context()
        gateway = self.core.gateway
        with self.assertRaises(ChannelError) as caught:
            await gateway.resolve_source('uid', context)
        self.assertEqual(caught.exception.code, 'UNSUPPORTED_OPERATION')
        with self.assertRaises(ChannelError):
            await gateway.search_sources('name', FetchRequest(), context)
        with self.assertRaises(ChannelError):
            await gateway.get_item_detail('x', context)
        with self.assertRaises(ChannelError):
            await self.core.check_connection('wechat:default', 'list_items')
        self.assertEqual((await self.core.check_connection('wechat:default', 'read_item')).state, 'ready')
        self.assertFalse(hasattr(self.adapter, 'resolve_source'))

    async def test_route_only_accepts_enabled_wechat_connection(self):
        connections = [self.core.repository.get_connection('wechat:default')]
        routed = self.core.gateway.route_item_url(SHORT, connections)
        self.assertEqual(routed.id, 'wechat:default')
        with self.assertRaises(ChannelError):
            self.core.gateway.route_item_url('https://www.bilibili.com/video/BV1yEaJ6CEUk', connections)

    async def test_saved_article_survives_restart(self):
        task = await self.recognize()
        self.core.intake.save(task['preview_id'])
        gateway = self.core.gateway
        await self.core.close()
        self.core = Core(Path(self.temp.name) / 'core.db', gateway=gateway,
                         schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0))
        self.assertEqual(self.core.queries.contents(channel='wechat', intake_method='manual')['total'], 1)
        self.assertEqual(self.core.repository.list_subscriptions(), [])


if __name__ == '__main__':
    unittest.main()