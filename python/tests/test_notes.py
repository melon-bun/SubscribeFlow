"""M26 笔记存储与查询验收。

隔离数据库 + 合成内容：不联网、不碰日常库、不涉及真实模型。
覆盖：迁移与备份、笔记 CRUD 与清空、版本冲突、查询与 facets、
写笔记不牵动内容与打标、事件口径。
"""

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ChannelError, ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime
from subscribe_flow.storage import database as database_module
from subscribe_flow.storage.database import Database
from subscribe_flow.rpc import PROTOCOL_VERSION
from subscribe_flow.rpc.dispatcher import Dispatcher
from subscribe_flow.storage.repositories import Repository

MIGRATIONS = Path(database_module.__file__).parent / 'migrations'


def make_item(channel, external_id, title, summary='一段摘要', source_id='fixture-source'):
    source = Source(channel=channel, kind='user', external_id=source_id,
                    name=f'{channel} 夹具来源', url=f'https://example.invalid/{source_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='video', summary=summary,
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


def legacy_v11(path):
    """造一个 v11 的旧库：001–011 的迁移跑过，user_version 停在 11。"""
    files = sorted(p for p in MIGRATIONS.glob('[0-9]*.sql') if int(p.name.split('_')[0]) <= 11)
    assert files
    with sqlite3.connect(path) as legacy:
        legacy.executescript('\n'.join(p.read_text() for p in files) + '\nPRAGMA user_version=11;')
        legacy.execute("INSERT INTO contents(id,channel,namespace,external_id,title,published_at,payload,"
                        "first_seen_at,updated_at) VALUES('item','test','video','1','旧标题',NULL,'{}',"
                        "'2026-10-05','2026-10-05')")
        legacy.execute("INSERT INTO content_states(content_id,read,archived,deferred,updated_at) "
                        "VALUES('item',0,0,0,'2026-10-05')")
    return path


class NoteMigrationTests(unittest.TestCase):
    """迁移、备份与回退。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def test_v11_upgrade_adds_the_notes_table_and_keeps_the_first_backup(self):
        legacy_path = legacy_v11(Path(self.temp.name) / 'legacy-v11.sqlite3')
        migrated = Database(legacy_path)
        try:
            self.assertEqual(migrated.connection.execute('PRAGMA user_version').fetchone()[0], 12)
            tables = {row['name'] for row in migrated.connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('content_notes', tables)
            # 升级不为旧内容回填笔记：没写过的就是没写过。
            self.assertEqual(migrated.connection.execute(
                'SELECT count(*) FROM content_notes').fetchone()[0], 0)
            # 旧内容还在。
            self.assertEqual(migrated.connection.execute(
                'SELECT count(*) FROM contents').fetchone()[0], 1)
            backup = legacy_path.with_suffix('.before-v12.backup')
            self.assertTrue(backup.exists(), '升级前要有一次性备份')
            with sqlite3.connect(backup) as copy:
                self.assertEqual(copy.execute('PRAGMA user_version').fetchone()[0], 11)
                self.assertEqual(copy.execute('SELECT title FROM contents').fetchone()[0], '旧标题')
        finally:
            migrated.close()

    def test_a_second_upgrade_does_not_overwrite_the_first_backup(self):
        legacy_path = legacy_v11(Path(self.temp.name) / 'legacy-twice.sqlite3')
        migrated = Database(legacy_path)
        migrated.close()
        first = legacy_path.with_suffix('.before-v12.backup')
        self.assertTrue(first.exists())
        # 再来一次升级（模拟重试）：首份备份不被覆盖。
        with sqlite3.connect(legacy_path) as db:
            db.execute('PRAGMA user_version=11')
            db.execute('DROP TABLE content_notes')
        again = Database(legacy_path)
        try:
            self.assertTrue(first.exists())
            self.assertEqual(len(list(legacy_path.parent.glob('*.before-v12.*.backup'))), 1)
            with sqlite3.connect(first) as copy:
                self.assertEqual(copy.execute('PRAGMA user_version').fetchone()[0], 11)
        finally:
            again.close()

    def test_a_failed_upgrade_rolls_back_and_keeps_the_data(self):
        legacy_path = legacy_v11(Path(self.temp.name) / 'legacy-broken.sqlite3')
        original = Path.read_text

        def broken(path, *args, **kwargs):
            if path.name.startswith('012'):
                raise RuntimeError('迁移脚本坏了')
            return original(path, *args, **kwargs)

        with patch.object(Path, 'read_text', broken):
            with self.assertRaises(RuntimeError):
                Database(legacy_path)
        with sqlite3.connect(legacy_path) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 11, '失败的迁移不能留下半截结构')
            tables = {row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertNotIn('content_notes', tables)
            self.assertEqual(db.execute('SELECT count(*) FROM contents').fetchone()[0], 1)
        self.assertTrue(legacy_path.with_suffix('.before-v12.backup').exists())

    def test_a_newer_schema_is_refused(self):
        path = Path(self.temp.name) / 'future.sqlite3'
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA user_version=99')
        with self.assertRaises(RuntimeError):
            Database(path)


class _NoteFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'notes.sqlite3'

        class EmptyGateway:
            def describe(self):
                return []
        self.core = Core(self.path, gateway=EmptyGateway())
        self.repo = self.core.repository
        self.notes = self.core.notes
        self.events = []
        self.core.listeners.append(lambda event, data: self.events.append((event, data)))

    def tearDown(self):
        self.core.database.close()
        self.core.lease.close()
        self.temp.cleanup()

    def add(self, external_id='a-1', title='一条内容', channel='fixture', source_id='fixture-source'):
        item = make_item(channel, external_id, title, source_id=source_id)
        saved = self.repo.save_manual(item)
        return saved['item_id']


class NoteWriteTests(_NoteFixture, unittest.TestCase):
    """写入契约：全量替换、清空即删除、版本冲突。"""

    def test_save_creates_a_note_with_a_fresh_version_token(self):
        item_id = self.add()
        note = self.notes.save(item_id, template='general', summary='一段总结',
                               summary_origin='manual', takeaway='一点心得')
        self.assertEqual(note['content_id'], item_id)
        self.assertEqual(note['summary'], '一段总结')
        self.assertEqual(note['takeaway'], '一点心得')
        self.assertEqual(note['summary_origin'], 'manual')
        self.assertIsNone(note['verdict'])
        self.assertTrue(note['version'])
        self.assertEqual(self.notes.get(item_id)['version'], note['version'])

    def test_save_replaces_the_whole_note(self):
        item_id = self.add()
        first = self.notes.save(item_id, template='project', summary='旧总结',
                                summary_origin='manual', takeaway='旧心得', verdict='using')
        second = self.notes.save(item_id, expected_version=first['version'], template='project',
                                 summary='新总结', summary_origin='manual', takeaway='',
                                 verdict='watching')
        self.assertEqual(second['summary'], '新总结')
        self.assertEqual(second['takeaway'], '', '整体替换：没写的字段不留旧值')
        self.assertEqual(second['verdict'], 'watching')
        self.assertNotEqual(second['version'], first['version'], '每次真正写入换一个令牌')
        self.assertEqual(second['created_at'], first['created_at'], 'created_at 是第一次写入定下的')

    def test_an_empty_note_is_treated_as_no_note(self):
        item_id = self.add()
        note = self.notes.save(item_id, template='general', summary='先写点',
                               summary_origin='manual', takeaway='')
        cleared = self.notes.save(item_id, expected_version=note['version'], template='general',
                                  summary='   ', summary_origin='manual', takeaway='')
        self.assertIsNone(cleared, '空笔记就是没有笔记')
        self.assertIsNone(self.notes.get(item_id))
        rows = self.repo.db.execute('SELECT count(*) FROM content_notes').fetchone()[0]
        self.assertEqual(rows, 0, '不留 template=none 的空行')

    def test_clearing_the_summary_clears_its_origin(self):
        item_id = self.add()
        note = self.notes.save(item_id, template='general', summary='总结',
                               summary_origin='ai_edited', takeaway='心得')
        self.assertEqual(note['summary_origin'], 'ai_edited')
        cleared = self.notes.save(item_id, expected_version=note['version'], template='general',
                                  summary='', summary_origin='ai_edited', takeaway='心得')
        self.assertEqual(cleared['summary'], '')
        self.assertIsNone(cleared['summary_origin'], '总结没了，来路也没了')

    def test_a_general_template_cannot_hold_a_verdict(self):
        item_id = self.add()
        with self.assertRaises(ChannelError):
            self.notes.save(item_id, template='general', summary='总结', takeaway='',
                            verdict='using')

    def test_text_limits_are_enforced(self):
        item_id = self.add()
        with self.assertRaises(ChannelError):
            self.notes.save(item_id, template='general', summary='长' * 2001, takeaway='')
        with self.assertRaises(ChannelError):
            self.notes.save(item_id, template='general', summary='短', takeaway='长' * 20001)
        note = self.notes.save(item_id, template='general', summary='短', takeaway='长' * 20000)
        self.assertEqual(len(note['takeaway']), 20000)

    def test_conflicts_are_refused_and_return_the_current_note(self):
        item_id = self.add()
        first = self.notes.save(item_id, template='general', summary='第一版',
                                summary_origin='manual', takeaway='')
        # 新建却已经有笔记：冲突。
        with self.assertRaises(ChannelError) as caught:
            self.notes.save(item_id, template='general', summary='抢写', summary_origin='manual',
                            takeaway='')
        self.assertEqual(caught.exception.code, 'CONFLICT')
        self.assertEqual(caught.exception.details['current']['version'], first['version'])
        # 旧令牌：冲突，不写入。
        with self.assertRaises(ChannelError) as caught:
            self.notes.save(item_id, expected_version='stale-token', template='general',
                            summary='旧版本', summary_origin='manual', takeaway='')
        self.assertEqual(caught.exception.code, 'CONFLICT')
        self.assertEqual(self.notes.get(item_id)['summary'], '第一版', '冲突不能写入')

    def test_a_deleted_note_cannot_be_overwritten_by_an_old_token(self):
        item_id = self.add()
        note = self.notes.save(item_id, template='general', summary='第一版',
                               summary_origin='manual', takeaway='')
        self.notes.delete(item_id, expected_version=note['version'])
        self.assertIsNone(self.notes.get(item_id))
        # 拿着删除前的令牌来写：冲突，不能把笔记盖回来。
        with self.assertRaises(ChannelError) as caught:
            self.notes.save(item_id, expected_version=note['version'], template='general',
                            summary='复活', summary_origin='manual', takeaway='')
        self.assertEqual(caught.exception.code, 'CONFLICT')
        self.assertIsNone(self.notes.get(item_id))
        # 重新写是新的笔记、新的令牌。
        again = self.notes.save(item_id, template='general', summary='重来',
                                summary_origin='manual', takeaway='')
        self.assertNotEqual(again['version'], note['version'])

    def test_delete_needs_the_current_version(self):
        item_id = self.add()
        note = self.notes.save(item_id, template='general', summary='总结',
                               summary_origin='manual', takeaway='')
        with self.assertRaises(ChannelError):
            self.notes.delete(item_id)
        with self.assertRaises(ChannelError):
            self.notes.delete(item_id, expected_version='wrong')
        self.assertTrue(self.notes.delete(item_id, expected_version=note['version'])['ok'])
        self.assertIsNone(self.notes.get(item_id))

    def test_missing_content_and_missing_note_are_different(self):
        with self.assertRaises(ChannelError) as caught:
            self.notes.get('does-not-exist')
        self.assertEqual(caught.exception.code, 'NOT_FOUND')
        item_id = self.add()
        self.assertIsNone(self.notes.get(item_id), '内容在但没写笔记，不是错误')


class NoteIsolationTests(_NoteFixture, unittest.TestCase):
    """写笔记不牵动别的状态。"""

    def test_writing_a_note_leaves_the_content_untouched(self):
        item_id = self.add()
        before = self.repo.get_content(item_id)
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        after = self.repo.get_content(item_id)
        self.assertEqual(after['updated_at'], before['updated_at'], '笔记不改内容的更新时间')
        self.assertEqual(after['first_seen_at'], before['first_seen_at'])
        self.assertEqual(after['state'], before['state'], '已读／稍后／归档都不动')
        self.assertTrue(after['has_note'], '内容上要能看到有没有笔记')

    def test_archiving_or_unsubscribing_keeps_the_note(self):
        item_id = self.add()
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        self.repo.update_content_state([item_id], {'archived': True})
        self.assertIsNotNone(self.notes.get(item_id), '归档不是删除')
        self.repo.update_content_state([item_id], {'archived': False, 'read': True})
        self.assertIsNotNone(self.notes.get(item_id))

    def test_collecting_the_same_content_again_keeps_the_note(self):
        item_id = self.add()
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        # 同一内容换个来源再收一次（重复收录）。
        again = make_item('fixture', 'a-1', '一条内容', source_id='other-source')
        self.repo.save_manual(again)
        note = self.notes.get(item_id)
        self.assertIsNotNone(note, '采集不能覆盖笔记')
        self.assertEqual(note['summary'], '总结')

    def test_deleting_the_content_removes_the_note(self):
        item_id = self.add()
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        with self.repo.database.transaction() as db:
            # 先清掉别的外键（内容状态与来源），再删内容本身。
            db.execute('DELETE FROM content_sources WHERE content_id=?', (item_id,))
            db.execute('DELETE FROM content_states WHERE content_id=?', (item_id,))
            db.execute('DELETE FROM contents WHERE id=?', (item_id,))
        rows = self.repo.db.execute('SELECT count(*) FROM content_notes').fetchone()[0]
        self.assertEqual(rows, 0, '内容没了，笔记跟着没')

    def test_saving_a_note_does_not_touch_tagging(self):
        item_id = self.add()
        revision = self.core.settings.snapshot()['tagging']['revision']
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        self.assertEqual(self.core.settings.snapshot()['tagging']['revision'], revision,
                         '写笔记不推进打标的配置版本')
        tasks = self.repo.tagging.summary()
        self.assertEqual(tasks['total'], 0, '写笔记不产生打标任务')

    def test_saving_a_note_announces_a_content_change_and_nothing_else(self):
        item_id = self.add()
        self.events.clear()
        note = self.notes.save(item_id, template='general', summary='总结',
                               summary_origin='manual', takeaway='')
        names = [event for event, _ in self.events]
        self.assertEqual(names, ['content.changed'], '只有内容变化这一条事件')
        self.assertEqual(self.events[0][1], {'ids': [item_id]})
        self.events.clear()
        self.notes.delete(item_id, expected_version=note['version'])
        self.assertEqual([event for event, _ in self.events], ['content.changed'])


class NoteQueryTests(_NoteFixture, unittest.TestCase):
    """列表与 facets。"""

    def setUp(self):
        super().setUp()
        self.a = self.add('a-1', '甲内容', channel='zhihu', source_id='source-a')
        self.b = self.add('b-1', '乙内容', channel='github', source_id='source-b')
        self.tag_a = self.core.tags.create('甲标签')
        self.tag_b = self.core.tags.create('乙标签')
        self.repo.set_content_tags([self.a], [self.tag_a['id']])
        self.repo.set_content_tags([self.b], [self.tag_b['id']])
        self.notes.save(self.a, template='general', summary='关于甲的总结',
                        summary_origin='manual', takeaway='甲的心得')
        self.notes.save(self.b, template='project', summary='关于乙的总结',
                        summary_origin='manual', takeaway='乙的心得', verdict='using')
        sources = {row['name']: row['id'] for row in self.repo.list_content_sources()['items']}
        self.source_a = sources['zhihu 夹具来源']
        self.source_b = sources['github 夹具来源']

    def test_list_returns_the_title_directory_shape(self):
        result = self.notes.list_notes()
        self.assertEqual(result['total'], 2)
        # 5.1 期：目录条目多了平台、来源与结论／模板四个标量，
        # 外加一行**截断后**的摘要。完整正文仍然不返回——目录不画卡片墙。
        self.assertEqual(set(result['items'][0]), {'id', 'title', 'note_updated_at',
                                                   'platform', 'source_name', 'verdict', 'template',
                                                   'excerpt'})
        titles = sorted(item['title'] for item in result['items'])
        self.assertEqual(titles, ['乙内容', '甲内容'])

    def test_excerpt_prefers_summary_and_falls_back_to_takeaway(self):
        """目录摘要行：有总结用总结，没有总结才用收获。"""
        items = {item['title']: item for item in self.notes.list_notes()['items']}
        self.assertEqual(items['甲内容']['excerpt'], '关于甲的总结')
        self.assertEqual(items['乙内容']['excerpt'], '关于乙的总结')

        # 只有收获、没有总结时退回收获。
        self.notes.save(self.a, expected_version=self.notes.get(self.a)['version'],
                        template='general', summary='   ', summary_origin=None, takeaway='只剩心得')
        items = {item['title']: item for item in self.notes.list_notes()['items']}
        self.assertEqual(items['甲内容']['excerpt'], '只剩心得')

    def test_excerpt_is_truncated(self):
        """摘要行不能变成正文搬运：超长只给前 EXCERPT_CHARS 个字。"""
        from subscribe_flow.storage.notes import EXCERPT_CHARS
        self.notes.save(self.a, expected_version=self.notes.get(self.a)['version'],
                        template='general', summary='长' * 500, summary_origin='manual', takeaway='')
        items = {item['title']: item for item in self.notes.list_notes()['items']}
        self.assertEqual(len(items['甲内容']['excerpt']), EXCERPT_CHARS)

    def test_query_searches_title_summary_and_takeaway(self):
        self.assertEqual(self.notes.list_notes(query='甲')['total'], 1)
        self.assertEqual(self.notes.list_notes(query='乙的心得')['total'], 1)
        self.assertEqual(self.notes.list_notes(query='不存在')['total'], 0)

    def test_filters_by_channel_source_tag_and_verdict(self):
        self.assertEqual(self.notes.list_notes(channel='zhihu')['total'], 1)
        self.assertEqual(self.notes.list_notes(source_id=self.source_b)['total'], 1)
        self.assertEqual(self.notes.list_notes(tags=[self.tag_a['id']])['total'], 1)
        self.assertEqual(self.notes.list_notes(tags=[self.tag_a['id'], self.tag_b['id']],
                                               tag_mode='all')['total'], 0)
        self.assertEqual(self.notes.list_notes(tags=[self.tag_a['id'], self.tag_b['id']],
                                               tag_mode='any')['total'], 2)
        self.assertEqual(self.notes.list_notes(verdict='using')['total'], 1)
        self.assertEqual(self.notes.list_notes(verdict='dropped')['total'], 0)

    def test_pagination_shares_the_same_conditions(self):
        first = self.notes.list_notes(limit=1, offset=0)
        second = self.notes.list_notes(limit=1, offset=1)
        self.assertEqual(first['total'], 2)
        self.assertEqual(second['total'], 2)
        self.assertEqual(first['next_offset'], 1)
        self.assertIsNone(second['next_offset'])
        self.assertNotEqual(first['items'][0]['id'], second['items'][0]['id'])

    def test_sort_is_whitelisted(self):
        self.assertEqual(self.notes.list_notes(sort='title')['items'][0]['title'], '乙内容')
        with self.assertRaises(ChannelError):
            self.notes.list_notes(sort='; DROP TABLE contents')

    def test_facets_count_only_the_note_scope(self):
        self.add('c-1', '丙内容', channel='zhihu', source_id='source-c')
        facets = self.notes.facets()
        channels = {row['id']: row['count'] for row in facets['channels']}
        self.assertEqual(channels, {'zhihu': 1, 'github': 1}, '没写笔记的内容不计入')
        sources = {row['id']: row['count'] for row in facets['sources']}
        self.assertEqual(sources, {self.source_a: 1, self.source_b: 1})
        tags = {row['id']: row['count'] for row in facets['tags']}
        self.assertEqual(tags, {self.tag_a['id']: 1, self.tag_b['id']: 1},
                         '不是笔记的标签不当作笔记标签')

    def test_multiple_sources_or_tags_do_not_inflate_the_count(self):
        """同一条内容挂多个来源、带多个标签时，笔记列表只算它一次。"""
        item_id = self.add('multi-1', '多条来源的内容', channel='zhihu', source_id='source-a')
        # 采集把同一条内容挂到第二个来源上（手动收录不会重挂来源）。
        with self.repo.database.transaction() as db:
            db.execute("INSERT OR IGNORE INTO sources VALUES('zhihu:user:source-b','zhihu','user',"
                       "'source-b','另一个来源','https://example.invalid/source-b',1)")
            db.execute("INSERT OR IGNORE INTO content_sources(content_id,source_id) VALUES(?,?)",
                       (item_id, 'zhihu:user:source-b'))
        # 再加一个标签。
        second = self.core.tags.create('第二个标签')
        self.repo.set_content_tags([item_id], [self.tag_a['id'], second['id']])
        self.notes.save(item_id, template='general', summary='总结', summary_origin='manual',
                        takeaway='')
        listing = self.notes.list_notes()
        # 夹具里已经有两条笔记，这条是第三条：一条内容一条笔记，
        # 不因来源或标签变多而重复。
        self.assertEqual(listing['total'], 3)
        self.assertEqual([row['id'] for row in listing['items']].count(item_id), 1)
        facets = self.notes.facets()
        tags = {row['id']: row['count'] for row in facets['tags']}
        # 甲标签在两条有笔记的内容上（新加的那条与夹具里那条），各算一次；
        # 第二个标签只在新加的那条上。同一内容不会因为挂了多个标签而重复计数。
        self.assertEqual(tags[self.tag_a['id']], 2, '标签使用量按内容去重')
        self.assertEqual(tags[second['id']], 1)
        sources = {row['id']: row['count'] for row in facets['sources']}
        # 同一内容挂了多个来源，也不会在某个来源下被数两次。
        self.assertEqual(sources['zhihu:user:source-b'], 1)
        self.assertEqual(sorted(sources.values()), [1, 1, 2], '来源使用量按内容去重')

    def test_facets_and_list_share_the_same_scope(self):
        facets = self.notes.facets(channel='zhihu')
        self.assertEqual([row['id'] for row in facets['channels']], ['zhihu'])
        self.assertEqual(self.notes.list_notes(channel='zhihu')['total'], 1)


class NoteRpcTests(unittest.IsolatedAsyncioTestCase):
    """RPC 接线与参数校验。"""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()

        class EmptyGateway:
            def describe(self):
                return []
        self.core = Core(Path(self.temp.name) / 'rpc-notes.sqlite3', gateway=EmptyGateway())
        self.stopping = asyncio.Event()
        self.rpc = Dispatcher(self.core, self.stopping.set)
        self.item_id = self.core.repository.save_manual(
            make_item('fixture', 'rpc-1', 'RPC 内容'))['item_id']

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def call(self, method, params=None):
        return await self.rpc.handle({"jsonrpc": "2.0", "id": 1, "method": method,
                                      "params": params if params is not None else {}})

    async def hello(self):
        return await self.call("core.hello", {"protocol_version": PROTOCOL_VERSION})

    async def test_note_routes_round_trip(self):
        await self.hello()
        saved = (await self.call("note.save", {
            "item_id": self.item_id, "template": "general", "summary": "总结",
            "summary_origin": "manual", "takeaway": "心得"}))["result"]
        self.assertEqual(saved["summary"], "总结")
        got = (await self.call("note.get", {"item_id": self.item_id}))["result"]
        self.assertEqual(got["version"], saved["version"])
        listing = (await self.call("note.list", {"limit": 10}))["result"]
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["items"][0]["title"], "RPC 内容")
        facets = (await self.call("note.facets", {}))["result"]
        self.assertEqual([row["id"] for row in facets["channels"]], ["fixture"])
        deleted = (await self.call("note.delete", {
            "item_id": self.item_id, "expected_version": saved["version"]}))["result"]
        self.assertTrue(deleted["ok"])
        self.assertIsNone((await self.call("note.get", {"item_id": self.item_id}))["result"])

    async def test_conflict_is_reported_with_the_current_note(self):
        await self.hello()
        await self.call("note.save", {"item_id": self.item_id, "template": "general",
                                      "summary": "第一版", "summary_origin": "manual",
                                      "takeaway": ""})
        error = (await self.call("note.save", {"item_id": self.item_id, "template": "general",
                                                "summary": "抢写", "summary_origin": "manual",
                                                "takeaway": ""}))["error"]
        self.assertEqual(error["data"]["code"], "CONFLICT")
        self.assertEqual(error["data"]["details"]["current"]["summary"], "第一版")

    async def test_parameter_validation_is_per_route(self):
        await self.hello()
        base = {"item_id": self.item_id, "template": "general", "summary": "总结",
                "summary_origin": "manual", "takeaway": "心得"}
        # 未知字段与类型错误照旧被拒。
        self.assertEqual((await self.call("note.save", dict(base, unknown=1)))["error"]["code"], -32602)
        self.assertEqual((await self.call("note.save", dict(base, summary=1)))["error"]["code"], -32602)
        # 摘要与心得可以清空，版本与结论可以为空。
        ok = await self.call("note.save", dict(base, summary="", takeaway="",
                                               expected_version=None, verdict=None))
        self.assertNotIn("error", ok)
        # 长度上限只在这条路由上放宽：心得 20000，总结仍是 2000。
        self.assertEqual((await self.call("note.save", dict(base, takeaway="长" * 20001)))["error"]["code"], -32602)
        self.assertEqual((await self.call("note.save", dict(base, summary="长" * 2001)))["error"]["code"], -32602)
        # 其他路由不放宽：内容列表的关键词还是 2000 上限。
        self.assertEqual((await self.call("content.list", {"query": "长" * 2001}))["error"]["code"], -32602)


if __name__ == '__main__':
    unittest.main()
