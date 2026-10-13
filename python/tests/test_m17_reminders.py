"""M17 提醒统计与统一列表口径。

覆盖计划 §4.1（R01/R02）：两个数量出自同一次读取、与列表复用同一谓词、
按内容去重，且收件箱原有含义不变。

用的是真实 Core 存储与真实 SQL，不是替身——这里要防的正是「统计和列表
各写一套谓词」这种错误。
"""

import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.queries import QueryService
from subscribe_flow.contracts import Connection, ContentItem, PublishedTime, Source
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


if __name__ == '__main__':
    unittest.main()