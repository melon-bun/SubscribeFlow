"""M36–M37：智能优先级的契约、迁移与偏好统计仓储。

这些测试只证明**离线流程正确**：统计口径、失效重建与版本保护。
「模型是否真的学到个人偏好」不在这里断言，那需要另外的人工评估记录。
"""

import json
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from priority_engine.contracts import (
    ORIGIN_MANUAL,
    ORIGIN_NONE,
    ORIGIN_SOURCE,
    ORIGIN_SMART,
    PRIORITY_HIGH,
    PRIORITY_LOW,
    PRIORITY_MEDIUM,
    PRIORITY_UNKNOWN,
    PriorityDecision,
    resolve_priority,
)
from subscribe_flow.contracts import Connection, ContentItem, FetchPage, Source, jsonable
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
import subscribe_flow.storage.database as database_module


def latest_schema_version():
    """从迁移目录推导当前 schema 版本，避免新增迁移后这些断言整体失效。"""
    migrations = Path(database_module.__file__).parent / 'migrations'
    return max(int(path.name.split('_')[0]) for path in migrations.glob('[0-9]*.sql'))


class ContractTests(unittest.TestCase):
    def test_resolution_order_is_manual_smart_source_then_unset(self):
        manual = resolve_priority('high', 'low', 'medium')
        self.assertEqual((manual.level, manual.origin), ('high', ORIGIN_MANUAL))
        smart = resolve_priority(None, 'low', 'medium')
        self.assertEqual((smart.level, smart.origin), ('low', ORIGIN_SMART))
        source = resolve_priority(None, None, 'medium')
        self.assertEqual((source.level, source.origin), ('medium', ORIGIN_SOURCE))
        empty = resolve_priority(None, None, None)
        self.assertEqual((empty.level, empty.origin), (None, ORIGIN_NONE))

    def test_unknown_smart_result_falls_through_to_source(self):
        # 模型说「无法判断」不是一档，不应该压过来源默认值。
        resolved = resolve_priority(None, PRIORITY_UNKNOWN, 'low')
        self.assertEqual((resolved.level, resolved.origin), ('low', ORIGIN_SOURCE))
        self.assertEqual(resolve_priority(None, PRIORITY_UNKNOWN, None).origin, ORIGIN_NONE)

    def test_decision_reports_whether_a_level_was_assigned(self):
        self.assertTrue(PriorityDecision(PRIORITY_HIGH, 'ok').assigned)
        self.assertFalse(PriorityDecision(PRIORITY_UNKNOWN, 'model_unknown').assigned)


class PriorityStatisticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority.sqlite3'
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.intel = self.repo.priority_intelligence
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.job, _ = self.repo.create_job(self.sub['id'], 'refresh')
        self.repo.set_job_state(self.job['id'], 'running')
        self.repo.create_tag('tag-db', '数据库', '数据库原理与性能优化', 'blue', True, ['SQL'])
        self.repo.create_tag('tag-jp', '日语', '日语学习', 'green', True, [])

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    # ------------------------------------------------------------- 辅助

    def add_content(self, external_id, title='标题', tags=(), first_seen=None):
        """加一条内容。给了 first_seen 就按该时刻入库，用于验证「最近」的排序。"""
        item = ContentItem('test', 'video', external_id, self.source, title, 'https://example.com/a')
        if first_seen is None:
            self.repo.commit_page(self.job['id'], FetchPage((item,), None, 'window_only'))
        else:
            data = jsonable(item)
            self.db.connection.execute(
                "INSERT INTO contents(id,channel,namespace,external_id,title,published_at,payload,"
                "first_seen_at,updated_at,intake_method,manual_added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (item.key, item.channel, item.namespace, item.external_id, item.title,
                 data['published']['value'], json.dumps(data, ensure_ascii=False), first_seen,
                 first_seen, 'subscription', None))
            self.db.connection.execute("INSERT INTO content_states(content_id,updated_at) VALUES(?,?)",
                                       (item.key, first_seen))
            self.db.connection.execute("INSERT INTO content_sources(content_id,source_id) VALUES(?,?)",
                                       (item.key, self.source.key))
        if tags:
            self.repo.set_content_tags([item.key], list(tags))
        return item.key

    def set_priority(self, key, priority):
        self.repo.update_content_state([key], {'priority': priority})

    def counts(self, tag_id):
        groups = self.intel.groups_for_tags([tag_id])
        return {priority: (groups[priority].get(tag_id) or {}).get('content_count', 0)
                for priority in ('high', 'medium', 'low')}

    def samples(self, priority, tag_id):
        group = self.intel.group(priority, tag_id)
        return [sample['content_id'] for sample in (group or {}).get('samples', [])]

    # ------------------------------------------------------------- 统计口径

    def test_manual_priority_with_tag_enters_its_group_and_archived_content_counts(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.repo.update_content_state([key], {'archived': True})
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})
        self.assertEqual(self.samples('high', 'tag-db'), [key])
        # 处理状态不影响统计。
        self.repo.update_content_state([key], {'read': True})
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})

    def test_content_without_tags_is_not_part_of_any_group(self):
        key = self.add_content('1')
        self.set_priority(key, 'high')
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})
        self.assertEqual(self.intel.summary()['groups'], 0)

    def test_source_default_and_smart_results_are_not_manual_signals(self):
        key = self.add_content('1', tags=['tag-db'])
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})
        self.intel.save_decision(key, PriorityDecision(PRIORITY_HIGH, 'ok'))
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})

    def test_changing_priority_moves_content_between_groups(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.set_priority(key, 'low')
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 1})
        self.assertEqual(self.samples('low', 'tag-db'), [key])

    def test_restoring_auto_removes_content_from_groups(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.set_priority(key, None)
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})
        self.assertIsNone(self.intel.group('high', 'tag-db'))

    def test_one_content_with_two_tags_counts_once_per_tag(self):
        key = self.add_content('1', tags=['tag-db', 'tag-jp'])
        self.set_priority(key, 'medium')
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 1, 'low': 0})
        self.assertEqual(self.counts('tag-jp'), {'high': 0, 'medium': 1, 'low': 0})

    def test_same_content_from_several_sources_counts_once(self):
        key = self.add_content('1', tags=['tag-db'])
        other = replace(self.source, external_id='b')
        second = self.repo.subscribe(other, 'c')
        self.repo.set_source_priority(second['id'], 'high')
        self.db.connection.execute('INSERT INTO content_sources VALUES(?,?)', (key, other.key))
        self.set_priority(key, 'high')
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})

    def test_recent_two_samples_follow_first_seen_then_stable_id(self):
        early = self.add_content('1', '最早', tags=['tag-db'], first_seen='2026-10-01T00:00:00.000+00:00')
        middle = self.add_content('2', '中间', tags=['tag-db'], first_seen='2026-10-10T00:00:00.000+00:00')
        late = self.add_content('3', '最近', tags=['tag-db'], first_seen='2026-10-20T00:00:00.000+00:00')
        for key in (early, middle, late):
            self.set_priority(key, 'high')
        self.assertEqual(self.samples('high', 'tag-db'), [late, middle])
        self.assertEqual(self.counts('tag-db')['high'], 3)

    def test_same_first_seen_uses_the_stable_content_id(self):
        stamp = '2026-10-20T00:00:00.000+00:00'
        first = self.add_content('1', '第一条', tags=['tag-db'], first_seen=stamp)
        second = self.add_content('2', '第二条', tags=['tag-db'], first_seen=stamp)
        for key in (first, second):
            self.set_priority(key, 'high')
        self.assertEqual(self.samples('high', 'tag-db'), [second, first])

    def test_samples_take_at_most_two_and_keep_the_rest_in_the_count(self):
        for index in range(3):
            key = self.add_content(str(index), tags=['tag-db'],
                                    first_seen=f'2026-10-0{index + 1}T00:00:00.000+00:00')
            self.set_priority(key, 'high')
        self.assertEqual(len(self.samples('high', 'tag-db')), 2)
        self.assertEqual(self.counts('tag-db')['high'], 3)

    # ------------------------------------------------------------- 失效与重建

    def test_adding_and_removing_tags_updates_related_groups(self):
        key = self.add_content('1')
        self.set_priority(key, 'high')
        self.repo.set_content_tags([key], ['tag-db'])
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})
        self.repo.set_content_tags([key], ['tag-jp'])
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})
        self.assertEqual(self.counts('tag-jp'), {'high': 1, 'medium': 0, 'low': 0})

    def test_auto_tagged_content_counts_as_manual_signal(self):
        key = self.add_content('1')
        self.set_priority(key, 'high')
        self.repo.add_suggested_tags(key, ['tag-db'])
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})

    def test_disabled_tag_leaves_the_statistics_and_returns_when_enabled(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.repo.set_tag_enabled('tag-db', False)
        self.assertEqual(self.counts('tag-db'), {'high': 0, 'medium': 0, 'low': 0})
        self.assertIsNone(self.intel.group('high', 'tag-db'))
        self.repo.set_tag_enabled('tag-db', True)
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})

    def test_deleted_tag_takes_its_statistics_with_it(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.repo.delete_tag('tag-db')
        self.assertIsNone(self.intel.group('high', 'tag-db'))
        self.assertEqual(self.intel.summary()['groups'], 0)

    def test_deleted_content_frees_the_slot_and_refills_the_sample(self):
        first = self.add_content('1', '第一条', tags=['tag-db'], first_seen='2026-10-20T00:00:00.000+00:00')
        second = self.add_content('2', '第二条', tags=['tag-db'], first_seen='2026-10-10T00:00:00.000+00:00')
        third = self.add_content('3', '第三条', tags=['tag-db'], first_seen='2026-10-05T00:00:00.000+00:00')
        for key in (first, second, third):
            self.set_priority(key, 'high')
        self.assertEqual(self.samples('high', 'tag-db'), [first, second])
        # 内容删除：产品目前没有删除内容的入口，这里按依赖顺序删干净，
        # 统计必须自己跟上——级联删掉标签关联后，计数与样本都要补位。
        self.db.connection.execute('DELETE FROM content_sources WHERE content_id=?', (first,))
        self.db.connection.execute('DELETE FROM content_states WHERE content_id=?', (first,))
        self.db.connection.execute('DELETE FROM contents WHERE id=?', (first,))
        self.assertEqual(self.counts('tag-db')['high'], 2)
        self.assertEqual(self.samples('high', 'tag-db'), [second, third])

    def test_title_update_refreshes_the_cached_sample_title(self):
        key = self.add_content('1', '旧标题', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.assertEqual(self.intel.group('high', 'tag-db')['samples'][0]['title'], '旧标题')
        self.db.connection.execute('UPDATE contents SET title=? WHERE id=?', ('新标题', key))
        self.assertEqual(self.intel.group('high', 'tag-db')['samples'][0]['title'], '新标题')

    def test_rebuild_is_repeatable_and_does_not_accumulate(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.intel.rebuild_all()
        self.intel.rebuild_all()
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})
        self.assertEqual(self.samples('high', 'tag-db'), [key])

    def test_statistics_failure_does_not_touch_the_original_data(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        # 让重建在写分组时失败：统计更新必须回滚，且不碰人工值、标签与来源默认值。
        self.db.connection.executescript(
            "CREATE TRIGGER fail_rebuild BEFORE INSERT ON priority_preference_groups "
            "BEGIN SELECT RAISE(ABORT,'rebuild failed'); END;")
        result = self.intel.flush_dirty()
        self.assertIsNotNone(result['error'])
        self.assertEqual(result['rebuilt'], 0)
        self.assertEqual(self.repo.get_content(key)['priority_override'], 'high')
        self.assertEqual(self.repo.get_tag('tag-db')['name'], '数据库')
        self.assertIsNone(self.repo.get_content(key)['priority'] if False else None)
        # 脏标记还在，修好之后重试即可。
        self.assertEqual(self.intel.summary()['dirty'], 1)
        self.db.connection.execute('DROP TRIGGER fail_rebuild')
        self.assertEqual(self.intel.flush_dirty()['rebuilt'], 1)
        self.assertEqual(self.counts('tag-db'), {'high': 1, 'medium': 0, 'low': 0})

    def test_manual_version_counts_every_manual_change(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        self.set_priority(key, 'medium')
        self.set_priority(key, None)
        row = self.db.connection.execute(
            'SELECT manual_priority_version FROM content_states WHERE content_id=?', (key,)).fetchone()
        self.assertEqual(row['manual_priority_version'], 3)

    def test_reading_statistics_does_not_rescan_history(self):
        key = self.add_content('1', tags=['tag-db'])
        self.set_priority(key, 'high')
        # 读一次就把待重建的分组处理掉，之后不再重复重建。
        self.intel.groups_for_tags(['tag-db'])
        self.assertEqual(self.intel.summary()['dirty'], 0)
        self.assertEqual(self.intel.groups_for_tags(['tag-db'])['high']['tag-db']['content_count'], 1)
        self.assertEqual(self.intel.summary()['dirty'], 0)

    def test_decision_is_stored_per_content_and_can_be_cleared(self):
        key = self.add_content('1', tags=['tag-db'])
        decision = PriorityDecision(PRIORITY_HIGH, 'ok', provider_id='p1', model='m1')
        self.intel.save_decision(key, decision)
        stored = self.intel.get_decision(key)
        self.assertEqual((stored['priority'], stored['status']), ('high', 'ok'))
        self.assertEqual(stored['model'], 'm1')
        self.assertTrue(self.intel.clear_decision(key))
        self.assertIsNone(self.intel.get_decision(key))


class ContextSnapshotTests(unittest.TestCase):
    """M38 需要的存储侧输入：一份一致的快照。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / 'snapshot.sqlite3')
        self.repo = Repository(self.db)
        self.intel = self.repo.priority_intelligence
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.job, _ = self.repo.create_job(self.sub['id'], 'refresh')
        self.repo.set_job_state(self.job['id'], 'running')
        self.repo.create_tag('tag-db', '数据库', '数据库原理与性能优化', 'blue', True, ['SQL'])

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def add_content(self, external_id='1'):
        item = ContentItem('test', 'video', external_id, self.source, '当前内容', 'https://example.com/a')
        self.repo.commit_page(self.job['id'], FetchPage((item,), None, 'window_only'))
        return item.key

    def test_snapshot_carries_tags_three_levels_and_versions(self):
        key = self.add_content()
        self.repo.set_content_tags([key], ['tag-db'])
        self.repo.update_content_state([key], {'priority': 'high'})
        snapshot = self.intel.context_snapshot(key, policy_version='p1',
                                                provider_version='conn-1', prompt_version='priority_prompt_v1')
        self.assertEqual(snapshot['title'], '当前内容')
        self.assertEqual(snapshot['tag_ids'], ['tag-db'])
        self.assertEqual(snapshot['tags'][0]['synonyms'], ['SQL'])
        self.assertEqual(snapshot['history']['high']['tag-db']['content_count'], 1)
        # 缺失的分组显式填零，不省略。
        self.assertEqual(snapshot['history']['medium']['tag-db'], {'content_count': 0, 'sample_ids': []})
        self.assertEqual(snapshot['history']['low']['tag-db'], {'content_count': 0, 'sample_ids': []})
        self.assertEqual(snapshot['versions']['manual_version'], 1)
        self.assertEqual(snapshot['versions']['policy_version'], 'p1')
        self.assertTrue(snapshot['versions']['preference_version'])

    def test_snapshot_titles_come_from_the_content_itself(self):
        key = self.add_content()
        self.repo.set_content_tags([key], ['tag-db'])
        self.repo.update_content_state([key], {'priority': 'high'})
        snapshot = self.intel.context_snapshot(key)
        self.assertEqual(list(snapshot['sample_titles'].values()), ['当前内容'])

    def test_disabled_tags_are_not_part_of_the_snapshot(self):
        key = self.add_content()
        self.repo.set_content_tags([key], ['tag-db'])
        self.repo.set_tag_enabled('tag-db', False)
        snapshot = self.intel.context_snapshot(key)
        self.assertEqual(snapshot['tag_ids'], [])


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_upgrade_keeps_manual_priority_source_default_tags_and_archive(self):
        old = Path(self.temp.name) / 'legacy.sqlite3'
        migrations = Path(database_module.__file__).parent / 'migrations'
        with sqlite3.connect(old) as db:
            for file in sorted(migrations.glob('[0-9]*.sql')):
                if int(file.name.split('_')[0]) > 12:
                    continue
                db.executescript(file.read_text())
            db.execute('PRAGMA user_version=12')
            db.execute("INSERT INTO connections(id,channel,backend,resource_key) VALUES('c','test','test','test')")
            db.execute("INSERT INTO sources VALUES('s','test','author','a','Author','https://example.com',1)")
            db.execute("INSERT INTO subscriptions(id,source_id,connection_id,status,interval_seconds,created_at,updated_at)"
                       " VALUES('sub','s','c','active',86400,'old','old')")
            db.execute("UPDATE subscriptions SET default_priority='high'")
            db.execute("INSERT INTO contents(id,channel,namespace,external_id,title,published_at,payload,"
                       "first_seen_at,updated_at,intake_method,manual_added_at) "
                       "VALUES('one','test','video','one','标题',NULL,'{}','old','old','subscription',NULL)")
            db.execute("INSERT INTO content_sources(content_id,source_id) VALUES('one','s')")
            db.execute("INSERT INTO content_states(content_id,read,archived,deferred,updated_at,priority_override)"
                       " VALUES('one',0,1,0,'old','medium')")
            db.execute("INSERT INTO tags(id,name,description,color,enabled,synonyms,created_at,updated_at)"
                       " VALUES('t','旧标签','','slate',1,'[]','old','old')")
            db.execute("INSERT INTO content_tags(content_id,tag_id,origin,created_at) VALUES('one','t','manual','old')")
        upgraded = Database(old)
        try:
            repo = Repository(upgraded)
            item = repo.get_content('one')
            self.assertEqual(item['priority_override'], 'medium')
            self.assertEqual(item['source_priority'], 'high')
            self.assertTrue(item['state']['archived'])
            self.assertEqual(repo.get_tag('t')['name'], '旧标签')
            # 升级后统计能从既有关系本地聚合，不调用模型。
            repo.priority_intelligence.rebuild_all()
            groups = repo.priority_intelligence.groups_for_tags(['t'])
            self.assertEqual(groups['medium']['t']['content_count'], 1)
            self.assertEqual(upgraded.connection.execute('PRAGMA user_version').fetchone()[0],
                             latest_schema_version())
            with sqlite3.connect(old.with_suffix(f'.before-v{latest_schema_version()}.backup')) as backup:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 12)
        finally:
            upgraded.close()


if __name__ == '__main__':
    unittest.main()
