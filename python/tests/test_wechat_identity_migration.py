"""Offline v15/v2 upgrade fixtures for BUG-143; no application data is opened."""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from subscribe_flow.storage.database import Database
from subscribe_flow.storage import wechat_identity_migration


BIZ = 'MzI4NTEyMzQ1Ng=='
EXTERNAL = BIZ + '_1000000001_1'
CANONICAL = 'wechat:article:' + EXTERNAL
SOURCE = 'wechat:account:' + BIZ
OLD_CONTENT = 'wxrank:article:' + EXTERNAL
OLD_SOURCE = 'wxrank:account:gh_demo0001'
FIRST = '2026-10-20T00:00:00.000+00:00'
LATER = '2026-10-21T00:00:00.000+00:00'
MIGRATIONS = Path(__file__).parents[1] / 'src/subscribe_flow/storage/migrations'


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def insert(db, table, **row):
    db.execute(f"INSERT INTO {table}({','.join(row)}) VALUES({','.join('?' for _ in row)})", tuple(row.values()))


class WechatIdentityMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'legacy.db'
        self.db = self.legacy(15)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def legacy(self, version):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        for migration in sorted(MIGRATIONS.glob('[0-9]*.sql')):
            if int(migration.name.split('_')[0]) <= version:
                db.executescript(migration.read_text())
        db.execute(f'PRAGMA user_version={version}')
        return db

    def seed(self, channel, *, biz=BIZ, stamp=FIRST):
        paid = channel == 'wxrank'
        upstream = 'gh_demo0001' if paid else biz
        source_id = f'{channel}:account:{upstream}'
        content_id = f'{channel}:article:{biz}_1000000001_1'
        connection = f'{channel}:default'
        url = f'https://mp.weixin.qq.com/s?__biz={biz}&mid=1000000001&idx=1'
        insert(self.db, 'connections', id=connection, channel=channel,
               backend='paid-http' if paid else 'electron-session',
               resource_key='http:wxrank' if paid else 'browser:electron-wechat', version=4 if paid else 2)
        insert(self.db, 'sources', id=source_id, channel=channel, kind='account',
               external_id=upstream, name='同一个公众号', url=url, confirmed=not paid)
        payload = {'channel': channel, 'namespace': 'article', 'external_id': f'{biz}_1000000001_1',
                   'source': {'channel': channel, 'kind': 'account', 'external_id': upstream,
                              'name': '同一个公众号', 'url': url, 'confirmed': not paid},
                   'title': '同一篇文章', 'url': url, 'kind': 'article',
                   'published': {'value': '2026-10-19T12:00:00+08:00', 'precision': 'second'},
                   'summary': None if paid else '已有完整正文', 'acquisition_complete': True}
        insert(self.db, 'contents', id=content_id, channel=channel, namespace='article',
               external_id=payload['external_id'], title=payload['title'],
               published_at=payload['published']['value'], payload=encode(payload),
               first_seen_at=stamp, updated_at=stamp,
               intake_method='subscription' if paid else 'manual', manual_added_at=None if paid else stamp)
        insert(self.db, 'content_states', content_id=content_id, updated_at=stamp,
               archived=int(paid), read=int(not paid), priority_override='high' if paid else None,
               manual_priority_version=int(paid))
        insert(self.db, 'content_sources', content_id=content_id, source_id=source_id)
        return content_id, source_id, connection

    def seed_subscription(self):
        insert(self.db, 'subscriptions', id='sub', source_id=OLD_SOURCE, connection_id='wxrank:default',
               status='active', version=7, interval_seconds=3600, created_at=FIRST, updated_at=FIRST,
               sync_mode='automatic')
        snapshot = {'subscription_version': 7, 'connection_id': 'wxrank:default',
                    'connection_version': 4, 'backend': 'paid-http',
                    'progress_version': 'wxrank-1', 'content_range': 'videos'}
        error = {'code': 'DEPENDENCY_UNAVAILABLE', 'scope': 'connection',
                 'scope_key': 'wxrank:default', 'operation': 'list_items', 'message': '结果未知'}
        insert(self.db, 'jobs', id='job', subscription_id='sub', mode='backfill', state='waiting',
               snapshot=encode(snapshot), item_key=OLD_CONTENT, created_at=FIRST, updated_at=FIRST,
               error=encode(error))
        insert(self.db, 'schedules', subscription_id='sub', version=7, next_due=1234., failures=3,
               last_job_id='job', last_state='waiting', retry_job_id='job', reason='结果未知')
        insert(self.db, 'schedule_blocks', scope='connection', scope_key='wxrank:default',
               operation='list_items', error=encode(error))
        insert(self.db, 'schedule_blocks', scope='backend', scope_key='wxrank:paid-http',
               operation='list_items', error=encode({**error, 'scope': 'backend', 'scope_key': 'wxrank:paid-http'}))
        insert(self.db, 'paid_channel_checkpoints', id='checkpoint', source_id=OLD_SOURCE,
               connection_id='wxrank:default', cursor=encode({'cursor': 'opaque-page-8'}),
               obtained_at=FIRST, expires_at='2099-01-01T00:00:00+00:00', credential_version=11,
               parser_version='wxrank-2', progress_version='wxrank-1')
        insert(self.db, 'sync_progress', subscription_id='sub', backend='paid-http',
               progress_version='wxrank-1', content_range='videos', mode='backfill',
               connection_version=4, subscription_version=7, payload=encode({'source': OLD_SOURCE}), updated_at=FIRST)
        insert(self.db, 'paid_channel_sources', biz=BIZ, gh_id='gh_demo0001', name='同一个公众号',
               source_id=OLD_SOURCE, parser_version='wxrank-2', resolved_at=FIRST)
        insert(self.db, 'paid_channel_attempts', id='attempt', channel='wxrank',
               connection_id='wxrank:default', operation='list_items', started_at=FIRST,
               status='unknown', charge_state='unknown', confirmed_credits=0, credential_version=11)

    def upgrade(self):
        self.db.commit()
        self.db.close()
        upgraded = Database(self.path)
        self.db = upgraded.connection
        return upgraded

    def test_paid_upgrade_preserves_cursor_schedule_blocks_and_supplier_history(self):
        self.seed('wxrank')
        self.seed_subscription()
        upgraded = self.upgrade()
        db = upgraded.connection
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 16)
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(db.execute('SELECT id,channel,backend FROM connections').fetchall()[0][:],
                         ('wechat:default', 'wechat', 'electron-session'))
        sub = dict(db.execute('SELECT * FROM subscriptions').fetchone())
        self.assertEqual((sub['id'], sub['source_id'], sub['connection_id'], sub['version']),
                         ('sub', SOURCE, 'wechat:default', 7))
        schedule = dict(db.execute('SELECT * FROM schedules').fetchone())
        self.assertEqual((schedule['next_due'], schedule['failures'], schedule['retry_job_id']), (1234., 3, 'job'))
        checkpoint = dict(db.execute('SELECT * FROM paid_channel_checkpoints').fetchone())
        self.assertEqual((checkpoint['source_id'], checkpoint['connection_id'], checkpoint['cursor']),
                         (SOURCE, 'wechat:default', encode({'cursor': 'opaque-page-8'})))
        self.assertEqual((checkpoint['credential_version'], checkpoint['parser_version'], checkpoint['progress_version']),
                         (11, 'wxrank-2', 'wxrank-1'))
        snapshot = json.loads(db.execute('SELECT snapshot FROM jobs').fetchone()[0])
        self.assertEqual((snapshot['connection_id'], snapshot['backend'], snapshot['connection_version']),
                         ('wechat:default', 'electron-session', 4))
        blocks = [dict(row) for row in db.execute('SELECT * FROM schedule_blocks')]
        self.assertEqual({row['scope_key'] for row in blocks}, {'wechat:default', 'wechat:electron-session'})
        self.assertTrue(all(json.loads(row['error'])['scope_key'] == row['scope_key'] for row in blocks))
        attempt = dict(db.execute('SELECT * FROM paid_channel_attempts').fetchone())
        self.assertEqual((attempt['channel'], attempt['connection_id'], attempt['charge_state']),
                         ('wxrank', 'wechat:default', 'unknown'))
        db.execute('DELETE FROM paid_channel_sources')
        self.assertEqual(db.execute('SELECT provider_id,biz,upstream_id FROM wechat_backend_identities').fetchone()[:],
                         ('wxrank', BIZ, 'gh_demo0001'))

    def test_both_duplicate_orders_merge_body_first_intake_notes_and_manual_tag_decisions(self):
        for paid_first in (True, False):
            with self.subTest(paid_first=paid_first):
                # Each case has its own v15 database.
                self.db.close()
                self.path.unlink()
                self.db = self.legacy(15)
                self.seed('wxrank', stamp=FIRST if paid_first else LATER)
                self.seed('wechat', stamp=LATER if paid_first else FIRST)
                insert(self.db, 'tags', id='tag', name='标签', color='blue', created_at=FIRST, updated_at=FIRST)
                insert(self.db, 'content_tags', content_id=OLD_CONTENT, tag_id='tag', origin='suggested', created_at=FIRST)
                insert(self.db, 'content_tag_blocks', content_id=CANONICAL, tag_id='tag', created_at=LATER)
                for content, stamp, text in ((OLD_CONTENT, FIRST, '旧笔记'), (CANONICAL, LATER, '新笔记')):
                    insert(self.db, 'content_notes', content_id=content, template='general', summary=text,
                           summary_origin='manual', takeaway='收获', version=text, created_at=stamp, updated_at=stamp)
                    insert(self.db, 'content_events', name='content.created', content_id=content,
                           content_version=stamp, created_at=stamp,
                           consumed_at=stamp if content == OLD_CONTENT else None,
                           consumed_by='tagger' if content == OLD_CONTENT else None)
                upgraded = self.upgrade()
                row = dict(self.db.execute('SELECT * FROM contents').fetchone())
                self.assertEqual(self.db.execute('SELECT count(*) FROM contents').fetchone()[0], 1)
                self.assertEqual(self.db.execute('SELECT count(*) FROM sources').fetchone()[0], 1)
                self.assertEqual(row['id'], CANONICAL)
                self.assertEqual((row['first_seen_at'], row['intake_method']),
                                 (FIRST, 'subscription' if paid_first else 'manual'))
                self.assertEqual(json.loads(row['payload'])['summary'], '已有完整正文')
                self.assertEqual(json.loads(row['payload'])['body_state'], 'full')
                state = self.db.execute('SELECT read,archived,deferred,priority_override FROM content_states').fetchone()
                self.assertEqual(state[:3], (1, 0, 0) if paid_first else (0, 1, 0))
                self.assertEqual(state[3], 'high')
                self.assertEqual(self.db.execute('SELECT summary FROM content_notes').fetchone()[0], '新笔记')
                self.assertEqual(self.db.execute('SELECT count(*) FROM content_tags').fetchone()[0], 0)
                self.assertEqual(self.db.execute('SELECT count(*) FROM content_tag_blocks').fetchone()[0], 1)
                events = self.db.execute('SELECT consumed_at FROM content_events').fetchall()
                self.assertEqual(len(events), 1)
                self.assertIsNotNone(events[0][0])
                archive = json.loads(self.db.execute("SELECT originals FROM wechat_identity_migration_archive WHERE kind='content'").fetchone()[0])
                self.assertEqual({row['summary'] for row in archive['content_notes']}, {'旧笔记', '新笔记'})
                self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])
                self.db.commit()

    def test_manual_only_normalizes_biz_without_creating_subscription_or_supplier_binding(self):
        raw_biz = BIZ.rstrip('=')
        self.seed('wechat', biz=raw_biz)
        self.upgrade()
        self.assertEqual(self.db.execute('SELECT id FROM contents').fetchone()[0], CANONICAL)
        self.assertEqual(self.db.execute('SELECT id FROM sources').fetchone()[0], SOURCE)
        self.assertEqual(self.db.execute('SELECT count(*) FROM subscriptions').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM wechat_backend_identities').fetchone()[0], 0)

    def test_ai_references_are_reconnected_without_replaying_consumed_events_or_duplicate_work(self):
        self.seed('wxrank')
        self.seed('wechat', stamp=LATER)
        insert(self.db, 'tags', id='tag', name='标签', color='blue', created_at=FIRST, updated_at=FIRST)
        insert(self.db, 'priority_preference_groups', priority='high', tag_id='tag',
               content_count=2, revision=3, updated_at=FIRST)
        insert(self.db, 'priority_preference_samples', priority='high', tag_id='tag', sample_order=1,
               content_id=OLD_CONTENT, first_seen_at=FIRST, title='旧样本')
        for number, content, stamp in ((1, OLD_CONTENT, FIRST), (2, CANONICAL, LATER)):
            insert(self.db, 'tagging_tasks', id=f'task-{number}', content_id=content,
                   content_version=stamp, config_version=1, catalog_version='1', mode='llm',
                   state='queued', dedupe_key=f'{content}:{stamp}:1:1:auto:1', created_at=stamp, updated_at=stamp)
            insert(self.db, 'priority_tasks', content_id=content, state='succeeded', created_at=stamp, updated_at=stamp)
            insert(self.db, 'content_priority_decisions', content_id=content, priority='high',
                   status='ok', created_at=stamp, updated_at=stamp)
        self.upgrade()
        tasks = [dict(row) for row in self.db.execute('SELECT * FROM tagging_tasks ORDER BY id')]
        self.assertEqual(len(tasks), 2)
        self.assertTrue(all(row['content_id'] == CANONICAL for row in tasks))
        self.assertTrue(all(row['dedupe_key'].startswith(CANONICAL + ':') for row in tasks))
        self.assertEqual([row['state'] for row in tasks], ['cancelled', 'queued'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM priority_tasks').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM content_priority_decisions').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM content_events').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT priority,tag_id FROM priority_preference_dirty').fetchone()[:], ('high', 'tag'))
        archive = json.loads(self.db.execute("SELECT originals FROM wechat_identity_migration_archive WHERE kind='content'").fetchone()[0])
        self.assertEqual(len(archive['content_priority_decisions']), 2)
        self.assertEqual(self.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_disabled_paid_connection_stays_disabled_and_credential_reference_is_preserved(self):
        self.seed('wxrank')
        self.seed('wechat')
        self.db.execute("UPDATE connections SET enabled=0 WHERE id='wxrank:default'")
        payload = {'channels': {'wxrank': {'credentialRef': 'protected-ref', 'revision': 9, 'enabled': True}},
                   'ai': {'unrelated': 'keep'}}
        insert(self.db, 'app_settings', id=1, version=3, payload=encode(payload), updated_at=FIRST)
        self.upgrade()
        setting = self.db.execute('SELECT version,payload FROM app_settings').fetchone()
        preserved = json.loads(setting['payload'])
        self.assertEqual(setting['version'], 3)
        self.assertEqual(preserved['channels']['wxrank'],
                         {'credentialRef': 'protected-ref', 'revision': 9, 'enabled': False})
        self.assertEqual(preserved['ai'], {'unrelated': 'keep'})
        self.assertEqual(self.db.execute('SELECT enabled FROM connections').fetchone()[0], 1)
        original = json.loads(self.db.execute("SELECT originals FROM wechat_identity_migration_archive WHERE kind='connections'").fetchone()[0])
        self.assertEqual({row['id']: row['enabled'] for row in original}, {'wechat:default': 1, 'wxrank:default': 0})

    def test_reopening_does_not_repeat_migration_or_make_another_backup(self):
        self.seed('wxrank')
        self.seed_subscription()
        upgraded = self.upgrade()
        before = self.db.execute('SELECT count(*) FROM wechat_identity_migration_archive').fetchone()[0]
        upgraded.close()
        reopened = Database(self.path)
        self.db = reopened.connection
        self.assertEqual(self.db.execute('SELECT count(*) FROM wechat_identity_migration_archive').fetchone()[0], before)
        self.assertEqual(len(list(self.path.parent.glob('*.backup'))), 1)

    def test_failed_data_upgrade_rolls_back_schema_rows_and_keeps_unique_backup(self):
        self.seed('wxrank')
        self.db.commit()
        self.db.close()
        real_migrate = wechat_identity_migration.migrate

        def fail_after_rebuild(db):
            real_migrate(db)
            raise RuntimeError('injected upgrade failure')

        with patch.object(wechat_identity_migration, 'migrate', fail_after_rebuild):
            with self.assertRaisesRegex(RuntimeError, 'injected'):
                Database(self.path)
        old = sqlite3.connect(self.path)
        self.assertEqual(old.execute('PRAGMA user_version').fetchone()[0], 15)
        self.assertEqual(old.execute('SELECT id FROM contents').fetchone()[0], OLD_CONTENT)
        self.assertEqual(old.execute("SELECT count(*) FROM sqlite_master WHERE name='wechat_backend_identities'").fetchone()[0], 0)
        old.close()
        upgraded = Database(self.path)
        self.db = upgraded.connection
        self.assertEqual(len(list(self.path.parent.glob('*.backup'))), 2)
        with closing(sqlite3.connect(self.path.with_suffix('.before-v16.backup'))) as backup:
            self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 15)
            self.assertEqual(backup.execute('SELECT id FROM contents').fetchone()[0], OLD_CONTENT)

    def test_inconsistent_biz_and_upstream_mapping_is_rejected_without_network_or_partial_changes(self):
        self.seed('wxrank')
        insert(self.db, 'paid_channel_sources', biz=BIZ, gh_id='gh_wrong', name='错误映射',
               source_id=OLD_SOURCE, parser_version='wxrank-2', resolved_at=FIRST)
        self.db.commit()
        self.db.close()
        with self.assertRaisesRegex(ValueError, 'conflicting upstream'):
            Database(self.path)
        self.db = sqlite3.connect(self.path)
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 15)
        self.assertEqual(self.db.execute('SELECT id FROM sources').fetchone()[0], OLD_SOURCE)

    def test_v2_to_v16_preserves_unrelated_content_and_creates_before_v16_backup(self):
        self.db.close()
        self.path.unlink()
        self.db = self.legacy(2)
        insert(self.db, 'contents', id='legacy', channel='test', namespace='article', external_id='legacy',
               title='保留内容', payload='{}', first_seen_at=FIRST, updated_at=FIRST)
        insert(self.db, 'content_states', content_id='legacy', updated_at=FIRST, archived=1)
        self.upgrade()
        self.assertEqual(self.db.execute('SELECT id,title,intake_method FROM contents').fetchone()[:],
                         ('legacy', '保留内容', 'subscription'))
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 16)
        with closing(sqlite3.connect(self.path.with_suffix('.before-v16.backup'))) as backup:
            self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 2)


if __name__ == '__main__':
    unittest.main()
