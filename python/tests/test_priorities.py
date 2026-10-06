import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage, Source
from subscribe_flow.contracts.models import PublishedTime
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
import subscribe_flow.storage.database as database_module


class PriorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority.sqlite3'
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.item = ContentItem('test', 'video', 'a', self.source, 'Title', 'https://example.com/a')
        self.job, _ = self.repo.create_job(self.sub['id'], 'refresh')
        self.repo.set_job_state(self.job['id'], 'running')
        self.repo.commit_page(self.job['id'], FetchPage((self.item,), None, 'window_only'))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_inheritance_manual_override_refresh_and_restart(self):
        self.assertIsNone(self.repo.get_content(self.item.key)['priority'])
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.assertEqual(self.repo.snapshot(self.sub['id']), self.job['snapshot'])
        self.repo.update_content_state([self.item.key], {'priority': 'low', 'read': True})
        self.repo.set_source_priority(self.sub['id'], 'medium')
        self.repo.commit_page(self.job['id'], FetchPage((replace(self.item, title='New'),), None, 'window_only'))
        self.db.close()
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        item = self.repo.get_content(self.item.key)
        self.assertEqual((item['priority'], item['source_priority']), ('low', 'medium'))
        self.assertTrue(item['state']['read'])
        self.repo.update_content_state([self.item.key], {'priority': None})
        self.assertEqual(self.repo.get_content(self.item.key)['priority'], 'medium')
        self.repo.update_subscription(self.sub['id'], status='cancelled')
        self.assertEqual(self.repo.get_content(self.item.key)['priority'], 'medium')
        self.repo.set_source_priority(self.sub['id'], None)
        self.assertEqual(self.repo.query_contents(priority='none')['total'], 1)

    def test_atomic_bulk_validation_preserves_existing_processing(self):
        self.repo.update_content_state([self.item.key], {'archived': True})
        for bad in ('urgent', False, 1, [], {}):
            with self.assertRaises(ChannelError):
                self.repo.update_content_state([self.item.key], {'priority': bad})
            with self.assertRaises(ChannelError):
                self.repo.set_source_priority(self.sub['id'], bad)
        with self.assertRaises(ChannelError):
            self.repo.update_content_state([self.item.key, 'missing'], {'priority': 'high'})
        self.assertIsNone(self.repo.get_content(self.item.key)['priority'])
        self.assertTrue(self.repo.get_content(self.item.key)['state']['archived'])
        self.repo.update_content_state([self.item.key, self.item.key], {'priority': 'high'})
        self.assertTrue(self.repo.get_content(self.item.key)['state']['archived'])

    def test_full_counts_stable_pages_combined_filters_and_unknown_dates(self):
        # 125 records exceed both UI and Core page sizes; counts must remain full.
        items = tuple(replace(self.item, external_id=str(i), published=PublishedTime('2026-10-06', 'date')) for i in range(124))
        self.repo.commit_page(self.job['id'], FetchPage(items, None, 'window_only'))
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.repo.update_content_state([items[0].key], {'priority':'low', 'read':True})
        seen = []
        offset = 0
        while offset is not None:
            page = self.repo.query_contents(priority='high', limit=20, offset=offset, source_id=self.source.key, channel='test', read=False, query='Title')
            self.assertEqual(page['total'],124)
            seen.extend(item['id'] for item in page['items'])
            offset = page['next_offset']
        self.assertEqual(len(seen),len(set(seen)))
        self.assertEqual(len(seen),124)
        self.assertEqual(self.repo.query_contents(priority='high', start='2026-10-06', end='2026-10-06T23:59:59Z')['total'],123)
        self.assertEqual(self.repo.query_contents(priority='low', read=True)['total'],1)
        with self.assertRaises(ChannelError):
            self.repo.query_contents(priority='invalid')

    def test_multiple_source_links_have_one_count_and_highest_default(self):
        other = replace(self.source, external_id='b')
        sub = self.repo.subscribe(other,'c')
        self.repo.set_source_priority(self.sub['id'],'low')
        self.repo.set_source_priority(sub['id'],'high')
        self.db.connection.execute('INSERT INTO content_sources VALUES(?,?)',(self.item.key,other.key))
        self.assertEqual(self.repo.query_contents(priority='high')['total'],1)
        self.assertEqual(self.repo.get_content(self.item.key)['priority'],'high')
        self.repo.update_content_state([self.item.key],{'priority':'medium'})
        self.assertEqual(self.repo.query_contents(priority='medium')['total'],1)

    def test_v4_upgrade_preserves_collection_and_processing_with_backup(self):
        old = Path(self.temp.name)/'v4.sqlite3'
        migrations = Path(database_module.__file__).parent/'migrations'
        with sqlite3.connect(old) as db:
            for file in sorted(migrations.glob('00[1-4]_*.sql')):
                db.executescript(file.read_text())
            db.execute('PRAGMA user_version=4')
            db.execute("INSERT INTO connections(id,channel,backend,resource_key) VALUES('c','test','test','test')")
            db.execute("INSERT INTO sources VALUES('s','test','author','a','Author','https://example.com',1)")
            db.execute("INSERT INTO subscriptions(id,source_id,connection_id,status,interval_seconds,created_at,updated_at,collect_items) VALUES('sub','s','c','active',86400,'old','old',35)")
            db.execute("INSERT INTO contents VALUES('one','test','video','one','Title',NULL,'{}','old','old')")
            db.execute("INSERT INTO content_states VALUES('one',0,1,0,'old')")
        upgraded = Database(old)
        try:
            item=Repository(upgraded).get_content('one')
            self.assertEqual(Repository(upgraded).get_subscription('sub')['collect_items'],35)
            self.assertIsNone(item['priority'])
            self.assertTrue(item['state']['archived'])
            self.assertEqual(upgraded.connection.execute('PRAGMA user_version').fetchone()[0],5)
            with sqlite3.connect(old.with_suffix('.before-v5.backup')) as backup:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],4)
        finally:
            upgraded.close()
