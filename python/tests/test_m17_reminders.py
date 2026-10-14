"""M17 提醒统计与统一列表口径。

覆盖计划 §4.1（R01/R02）：两个数量出自同一次读取、与列表复用同一谓词、
按内容去重，且收件箱原有含义不变。

用的是真实 Core 存储与真实 SQL，不是替身——这里要防的正是「统计和列表
各写一套谓词」这种错误。
"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.queries import QueryService
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ChannelError, Connection, ContentItem, PublishedTime, Source
from subscribe_flow.rpc.dispatcher import Dispatcher
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository


class ReminderSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / 'm17.sqlite3')
        self.repo = Repository(self.db)
        self.queries = QueryService(self.repo)
        self.source = Source('test', 'author', 'a1', '源', 'https://example.com/a', True)
        self.repo.remember_sources([self.source])
        self.repo.add_connection(Connection('c1', 'test', 'session', 'r1'))
        self.repo.subscribe(self.source, 'c1')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def seed(self, external_id, *, priority=None, **state):
        item = ContentItem('test', 'video', external_id, self.source, f'标题 {external_id}',
                           f'https://example.com/{external_id}',
                           published=PublishedTime('2026-10-01T00:00:00Z', 'day', 'UTC'))
        self.repo.save_manual(item, priority=priority)
        if state:
            self.repo.update_content_state([item.key], state)
        return item.key

    def test_counts_follow_the_documented_semantics(self):
        self.seed('a')                                   # 未读未归档 → 未处理
        self.seed('b', deferred=True)                    # 稍后处理 → 未处理
        self.seed('c', read=True)                        # 已读 → 不计未处理
        self.seed('d', archived=True)                    # 已归档 → 不计
        self.seed('e', priority='high')                  # 高优先级未归档（未读）
        self.seed('f', priority='high', read=True)       # 高优先级已读 → 计入 high
        self.seed('g', priority='high', archived=True)   # 高优先级已归档 → 不计

        summary = self.repo.reminder_summary()
        # 未读未归档的「高优先级未读」同时属于未处理，两个口径本就可能重叠。
        self.assertEqual(summary['pendingCount'], 3)
        # 已读的高优先级仍算「高优先级未归档」，这是两个口径可能不重合的原因。
        self.assertEqual(summary['highUnarchivedCount'], 2)

    def test_lists_and_counts_share_one_predicate(self):
        self.seed('a')
        self.seed('b', deferred=True)
        self.seed('e', priority='high')
        self.seed('f', priority='high', read=True)

        summary = self.repo.reminder_summary()
        pending = self.repo.query_contents(state='pending', limit=50)
        high = self.repo.query_contents(view='high_unarchived', limit=50)
        self.assertEqual(pending['total'], summary['pendingCount'])
        self.assertEqual(high['total'], summary['highUnarchivedCount'])
        self.assertEqual({i['id'] for i in pending['items']},
                         {'test:video:a', 'test:video:b', 'test:video:e'})
        self.assertEqual({i['id'] for i in high['items']},
                         {'test:video:e', 'test:video:f'})

    def test_inbox_keeps_its_original_meaning(self):
        self.seed('a')
        self.seed('b', deferred=True)
        inbox = self.repo.query_contents(read=False, archived=False, deferred=False, limit=50)
        self.assertEqual(inbox['total'], 1, '收件箱不能因为新增口径而偷偷包含稍后处理')
        self.assertNotIn('test:video:b', {i['id'] for i in inbox['items']})

    def test_content_linked_to_several_sources_is_counted_once(self):
        key = self.seed('dup')
        other = Source('test', 'author', 'a2', '源2', 'https://example.com/a2', True)
        self.repo.remember_sources([self.source, other])
        self.db.connection.execute(
            'INSERT OR IGNORE INTO content_sources(content_id,source_id) VALUES(?,?)', (key, other.key))
        self.assertEqual(self.repo.reminder_summary()['pendingCount'], 1)

    def test_summary_is_read_once_and_carries_observation_time(self):
        summary = self.repo.reminder_summary()
        self.assertEqual(summary['pendingCount'], 0)
        self.assertEqual(summary['highUnarchivedCount'], 0)
        self.assertTrue(summary['observedAt'])
        self.assertEqual(summary['timezone'], 'UTC')

    def test_unknown_perspective_is_rejected(self):
        for filters in ({'state': 'everything'}, {'view': 'low'}):
            with self.subTest(filters=filters):
                with self.assertRaises(Exception):
                    self.repo.query_contents(**filters)

    def test_rpc_exposes_summary_and_perspective_lists(self):
        self.seed('a')
        self.seed('f', priority='high', read=True)
        self.assertEqual(self.queries.reminder_summary()['pendingCount'], 1)
        self.assertEqual(self.queries.contents(state='pending', limit=10)['total'], 1)
        self.assertEqual(self.queries.contents(view='high_unarchived', limit=10)['total'], 1)


class ReminderRpcTests(unittest.IsolatedAsyncioTestCase):
    """经真实 RPC 分发器验证：Main 侧调得到，且没有进 Renderer 白名单的捷径。"""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.core = Core(Path(self.temp.name) / 'm17-rpc.sqlite3', gateway=ChannelGateway())
        self.rpc = Dispatcher(self.core, asyncio.Event().set)

    async def call(self, method, params=None):
        return await self.rpc.handle(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    async def hello(self):
        # JSON-RPC 约定先握手：未握手时任何方法都返回 -32001。
        response = await self.call("core.hello", {"protocol_version": "1.0"})
        self.assertIn("result", response)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def test_summary_and_perspective_lists_over_rpc(self):
        await self.hello()
        summary = (await self.call('reminder.summary'))['result']
        self.assertEqual(summary['pendingCount'], 0)
        self.assertEqual(summary['highUnarchivedCount'], 0)
        self.assertTrue(summary['observedAt'])

        pending = (await self.call('content.list', {'state': 'pending', 'limit': 10}))['result']
        high = (await self.call('content.list', {'view': 'high_unarchived', 'limit': 10}))['result']
        self.assertEqual(pending['total'], summary['pendingCount'])
        self.assertEqual(high['total'], summary['highUnarchivedCount'])

    async def test_unknown_perspective_is_rejected_at_the_boundary(self):
        await self.hello()
        for params in ({'state': 'everything'}, {'view': 'low'}):
            with self.subTest(params=params):
                response = await self.call('content.list', dict(limit=10, **params))
                self.assertIn('error', response)
                self.assertEqual(response['error']['code'], -32000, '入参错误必须如实回报')
                self.assertEqual(response['error']['data']['code'], 'INVALID_INPUT')


if __name__ == '__main__':
    unittest.main()

class ReminderStatePersistenceTests(unittest.TestCase):
    """提醒运行状态必须真的落到 SQLite，而不是一个空 persist 函数。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / 'm17-state.sqlite3')
        self.repo = Repository(self.db)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_state_round_trips_through_a_new_core_instance(self):
        self.assertIsNone(self.repo.load_reminder_state(), '首次运行没有记录')
        self.repo.save_reminder_state(signature='1:30', generation=2, next_check_at=1_800_000,
                                      last_handled_at=1_000, last_result='checked',
                                      notification_error='系统通知提交失败', backoff_index=1)
        reopened = Repository(Database(Path(self.temp.name) / 'm17-state.sqlite3'))
        saved = reopened.load_reminder_state()
        self.assertEqual(saved['signature'], '1:30')
        self.assertEqual(saved['nextCheckAt'], 1_800_000, '退出后仍要留有到期时间')
        self.assertEqual(saved['generation'], 2)
        self.assertEqual(saved['notificationError'], '系统通知提交失败')
        self.assertEqual(saved['backoffIndex'], 1)

    def test_missing_signature_is_rejected(self):
        with self.assertRaises(ChannelError):
            self.repo.save_reminder_state(signature='')

    def test_saving_twice_keeps_one_row(self):
        for index in range(3):
            self.repo.save_reminder_state(signature='1:60', generation=index, next_check_at=index)
        rows = self.db.connection.execute('SELECT count(*) FROM reminder_run_state').fetchone()[0]
        self.assertEqual(rows, 1)
        self.assertEqual(self.repo.load_reminder_state()['generation'], 2)


class ReminderStateRpcTests(unittest.IsolatedAsyncioTestCase):
    """经真实 Dispatcher 验证契约，不绕过 RPC 直接调 repository。"""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.core = Core(Path(self.temp.name) / 'm17-rpc.sqlite3', gateway=ChannelGateway())
        self.rpc = Dispatcher(self.core, asyncio.Event().set)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def call(self, method, params=None):
        return await self.rpc.handle(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})

    async def hello(self):
        self.assertIn("result", await self.call("core.hello", {"protocol_version": "1.0"}))

    async def save(self, **overrides):
        params = {"signature": "1:60", "generation": 1, "next_check_at": 3600000,
                  "last_handled_at": 1000, "last_result": "checked",
                  "notification_error": None, "backoff_index": 0}
        params.update(overrides)
        return await self.call("reminder.state.save", params)

    async def test_nullable_fields_are_accepted_over_rpc(self):
        await self.hello()
        # 停用/初始状态下这些字段本就是 null；以前会被精确类型校验直接拒掉。
        response = await self.save(next_check_at=None, last_handled_at=None,
                                   last_result=None, signature="0:60")
        self.assertIn("result", response, response)
        saved = (await self.call("reminder.state"))["result"]
        self.assertIsNone(saved["nextCheckAt"])
        self.assertIsNone(saved["lastResult"])
        self.assertEqual(saved["signature"], "0:60")

    async def test_stale_generation_cannot_overwrite_newer_state(self):
        await self.hello()
        await self.save(generation=5, next_check_at=999, last_result="checked")
        # 迟到写入：代际更旧，必须被拒绝且不改变已存状态。
        stale = await self.save(generation=3, next_check_at=1, last_result="checked")
        self.assertEqual(stale["error"]["data"]["code"], "CONFLICT")
        saved = (await self.call("reminder.state"))["result"]
        self.assertEqual(saved["generation"], 5)
        self.assertEqual(saved["nextCheckAt"], 999)

    async def test_disable_wins_over_later_inflight_success(self):
        # 场景：周期检查在途 → 用户停用（generation 4）→ 检查结果迟到（generation 3）
        await self.hello()
        await self.save(generation=4, next_check_at=None, last_result="disabled", signature="0:60")
        inflight = await self.save(generation=3, next_check_at=7777777, last_result="checked",
                                   signature="1:60")
        self.assertEqual(inflight["error"]["data"]["code"], "CONFLICT")
        saved = (await self.call("reminder.state"))["result"]
        self.assertIsNone(saved["nextCheckAt"], '停用不得被在途成功复活')
        self.assertEqual(saved["signature"], "0:60")

    async def test_same_generation_cannot_change_identity(self):
        await self.hello()
        await self.save(generation=2, signature="1:60")
        clash = await self.save(generation=2, signature="1:30")
        self.assertEqual(clash["error"]["data"]["code"], "CONFLICT")

    async def test_newer_generation_is_accepted_and_survives_new_core_instance(self):
        await self.hello()
        await self.save(generation=7, next_check_at=1234567890, last_result="checked", backoff_index=2)
        await self.save(generation=8, next_check_at=1234599999, backoff_index=3)
        # 换一个 Core 实例（新进程）读回，deadline 与退避档位必须还在。
        # 同一数据目录同时只允许一个 Core 持有租约，所以先关闭再重开。
        await self.core.close()
        reopened = Core(Path(self.temp.name) / 'm17-rpc.sqlite3', gateway=ChannelGateway())
        self.core = reopened
        try:
            rpc2 = Dispatcher(reopened, asyncio.Event().set)
            await rpc2.handle({"jsonrpc": "2.0", "id": 0,
                               "method": "core.hello", "params": {"protocol_version": "1.0"}})
            saved = (await rpc2.handle({"jsonrpc": "2.0", "id": 1, "method": "reminder.state", "params": {}}))["result"]
            self.assertEqual(saved["nextCheckAt"], 1234599999, '重启后到期时间必须保留')
            self.assertEqual(saved["generation"], 8)
            self.assertEqual(saved["backoffIndex"], 3, '重启后退避档位必须保留')
        finally:
            await reopened.close()

    async def test_invalid_generation_still_rejected(self):
        await self.hello()
        bad = await self.call("reminder.state.save", {"signature": "1:60", "generation": "x"})
        self.assertIn("error", bad)
