import tempfile
import unittest
import sqlite3
from unittest.mock import patch
from dataclasses import replace
from pathlib import Path

from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage, ItemError, Source
from subscribe_flow.storage.database import Database
import subscribe_flow.storage.database as database_module
from subscribe_flow.storage.repositories import Repository


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / "test.sqlite3")
        self.repo = Repository(self.db)
        self.repo.add_connection(Connection("c", "test", "test", "browser:shared"))
        self.source = Source("test", "author", "1", "Author", "https://example.com", True)
        self.sub = self.repo.subscribe(self.source, "c")
        self.item = ContentItem("test", "video", "1", self.source, "Title", "https://example.com/video")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def job(self, mode="refresh"):
        job, _ = self.repo.create_job(self.sub["id"], mode)
        return self.repo.set_job_state(job["id"], "running")

    def page(self, *items, **kwargs):
        return FetchPage(items or (self.item,), kwargs.get("cursor"), "window_only", item_errors=kwargs.get("errors", ()))

    def test_idempotence_state_separation_and_unsubscribe_retention(self):
        job = self.job()
        self.repo.commit_page(job["id"], self.page())
        self.repo.update_content_state([self.item.key], {"archived": True})
        self.repo.commit_page(job["id"], self.page(replace(self.item, title="Updated")))
        result = self.repo.query_contents()
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["title"], "Updated")
        self.assertEqual(result["items"][0]["state"], {"read":False,"archived":True,"deferred":False})
        self.assertEqual(self.repo.get_job(job["id"])["new_items"], 1)
        self.repo.update_subscription(self.sub["id"], status="cancelled")
        self.assertEqual(self.repo.query_contents()["total"], 1)
        self.assertEqual(self.repo.subscribe(self.source, "c")["id"], self.sub["id"])

    def test_page_failure_rolls_back_contents_counts_and_cursor(self):
        job = self.job("backfill")
        bad = replace(self.item, external_id="2", title="")
        with self.assertRaises(ValueError):
            self.repo.commit_page(job["id"], self.page(self.item, bad, cursor={"page": 2}))
        self.assertEqual(self.repo.query_contents()["total"], 0)
        self.assertEqual(self.repo.get_job(job["id"])["pages"], 0)
        self.assertEqual(self.repo.get_progress(self.sub["id"]), [])

    def test_scan_progress_isolation_and_incomplete_checkpoint(self):
        refresh = self.job()
        self.repo.commit_page(refresh["id"], FetchPage((self.item,), None, "history_end", True, "verified test end"))
        self.repo.finish_scan(refresh["id"], coverage="history_end", complete=True, checkpoint={"boundary": "a"})
        backfill = self.job("backfill")
        self.repo.commit_page(backfill["id"], self.page(cursor={"page": 2}))
        progress = {row["mode"]: row["payload"] for row in self.repo.get_progress(self.sub["id"])}
        self.assertEqual(progress["refresh"]["checkpoint"], {"boundary": "a"})
        self.assertFalse(progress["backfill"]["complete"])
        self.repo.commit_page(backfill["id"], self.page(errors=(ItemError(1, "INVALID_ITEM", "bad"),)))
        with self.assertRaises(ValueError):
            self.repo.finish_scan(backfill["id"], coverage="history_end", complete=True)
        self.assertEqual(self.repo.get_job(backfill["id"])["state"], "running")

    def test_stale_connection_or_subscription_rejects_commit(self):
        job = self.job()
        self.repo.update_connection("c", resource_key="browser:new")
        with self.assertRaises(ChannelError) as error:
            self.repo.commit_page(job["id"], self.page())
        self.assertEqual(error.exception.code, "STALE_CONFIG")
        self.assertEqual(self.repo.query_contents()["total"], 0)

    def test_backup_restores_committed_wal_and_restart_interrupts_jobs(self):
        job = self.job()
        self.repo.commit_page(job["id"], self.page())
        backup = Path(self.temp.name) / "backup.sqlite3"
        self.db.backup(backup)
        restored = Database(backup)
        try:
            repo = Repository(restored)
            self.assertEqual(repo.query_contents()["total"], 1)
            repo.recover_interrupted()
            self.assertEqual(repo.get_job(job["id"])["state"], "interrupted")
            self.assertEqual(restored.connection.execute("PRAGMA user_version").fetchone()[0], 4)
        finally:
            restored.close()

    def test_bulk_state_updates_are_atomic_and_query_is_parameterized(self):
        job = self.job()
        self.repo.commit_page(job["id"], self.page())
        with self.assertRaises(ChannelError):
            self.repo.update_content_state([self.item.key, "missing"], {"read": True})
        self.assertFalse(self.repo.get_content(self.item.key)["state"]["read"])
        self.assertEqual(self.repo.query_contents(query="' OR 1=1 --")["total"], 0)

    def test_same_millisecond_jobs_use_insertion_order_instead_of_random_ids(self):
        with patch('subscribe_flow.storage.repositories.now', return_value='2026-10-05T00:00:00.000+00:00'):
            with patch('subscribe_flow.storage.repositories.uuid.uuid4') as identifier:
                identifier.return_value.hex = 'z-first'
                first = self.job()
                self.repo.set_job_state(first['id'], 'cancelled')
                identifier.return_value.hex = 'a-second'
                second = self.job()
        self.assertEqual([row['id'] for row in self.repo.list_jobs()], [second['id'], first['id']])

    def test_v1_migration_defaults_to_manual_and_preserves_data_and_backup(self):
        legacy_path = Path(self.temp.name) / 'legacy.sqlite3'
        schema = Path(database_module.__file__).parent/'migrations/001_initial.sql'
        with sqlite3.connect(legacy_path) as legacy:
            legacy.executescript(schema.read_text() + '\nPRAGMA user_version=1;')
            legacy.execute("INSERT INTO connections VALUES('old','test','test','browser:old',1,1,NULL)")
            legacy.execute("INSERT INTO sources VALUES('source','test','author','1','Author','https://example.com',1)")
            legacy.execute("INSERT INTO subscriptions VALUES('sub','source','old','active',1,3600,'2026-10-05','2026-10-05')")
            legacy.execute("INSERT INTO contents VALUES('item','test','video','1','Title',NULL,'{}','2026-10-05','2026-10-05')")
            legacy.execute("INSERT INTO content_states VALUES('item',1,0,1,'2026-10-05')")
        migrated = Database(legacy_path)
        try:
            repo = Repository(migrated)
            sub = repo.get_subscription('sub')
            self.assertEqual((sub['sync_mode'],sub['interval_seconds']), ('manual',86400))
            self.assertFalse(repo.get_content('item')['state']['read'])
            self.assertTrue(repo.get_content('item')['state']['deferred'])
            with sqlite3.connect(legacy_path.with_suffix('.before-v4.backup')) as backup:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],1)
                self.assertEqual(backup.execute('SELECT interval_seconds FROM subscriptions').fetchone()[0],3600)
        finally:
            migrated.close()

    def test_processing_states_replace_each_other_atomically_for_single_and_bulk(self):
        job = self.job()
        second = replace(self.item, external_id='2')
        self.repo.commit_page(job['id'], self.page(self.item, second))
        for field in ('read', 'deferred', 'archived', 'read'):
            self.repo.update_content_state([self.item.key, second.key], {field:True})
            expected = {key:key == field for key in ('read','archived','deferred')}
            for item in (self.item, second):
                self.assertEqual(self.repo.get_content(item.key)['state'], expected)
        with self.assertRaises(ChannelError):
            self.repo.update_content_state([self.item.key, second.key], {'read':True,'archived':True})
        with self.assertRaises(ChannelError):
            self.repo.update_content_state([self.item.key, 'missing'], {'archived':True})
        self.assertTrue(self.repo.get_content(self.item.key)['state']['read'])
        self.repo.update_content_state([self.item.key], {'archived':False})
        self.assertTrue(self.repo.get_content(self.item.key)['state']['read'])
        self.repo.update_content_state([self.item.key], {'read':False})
        self.assertFalse(any(self.repo.get_content(self.item.key)['state'].values()))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.connection.execute('UPDATE content_states SET read=1,archived=1 WHERE content_id=?', (self.item.key,))

    def test_v2_migration_normalizes_all_combinations_and_keeps_original_in_backup(self):
        legacy_path = Path(self.temp.name) / 'legacy-v2.sqlite3'
        migrations = Path(database_module.__file__).parent/'migrations'
        combinations = [(r,a,d) for r in (0,1) for a in (0,1) for d in (0,1)]
        with sqlite3.connect(legacy_path) as legacy:
            legacy.executescript((migrations/'001_initial.sql').read_text() + (migrations/'002_scheduling.sql').read_text() + '\nPRAGMA user_version=2;')
            for i, (read, archived, deferred) in enumerate(combinations):
                legacy.execute("INSERT INTO contents VALUES(?,?,?,?,?,NULL,'{}','2026-10-05','2026-10-05')", (str(i),'test','video',str(i),'Title'))
                legacy.execute('INSERT INTO content_states VALUES(?,?,?,?,?)', (str(i),read,archived,deferred,'2026-10-05'))
        migrated = Database(legacy_path)
        try:
            repo = Repository(migrated)
            self.assertEqual(repo.query_contents()['total'],8)
            for i, (read, archived, deferred) in enumerate(combinations):
                self.assertEqual(repo.get_content(str(i))['state'], {
                    'read':bool(read and not archived and not deferred), 'archived':bool(archived), 'deferred':bool(deferred and not archived)})
            with sqlite3.connect(legacy_path.with_suffix('.before-v4.backup')) as backup:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],2)
                self.assertEqual(backup.execute('SELECT read,archived,deferred FROM content_states ORDER BY CAST(content_id AS INTEGER)').fetchall(),combinations)
        finally:
            migrated.close()

    def test_failed_multi_version_upgrade_rolls_back_and_retry_preserves_first_backup(self):
        legacy_path = Path(self.temp.name) / 'failed-upgrade.sqlite3'
        schema = Path(database_module.__file__).parent/'migrations/001_initial.sql'
        with sqlite3.connect(legacy_path) as legacy:
            legacy.executescript(schema.read_text() + '\nPRAGMA user_version=1;')
            legacy.execute("INSERT INTO contents VALUES('one','test','video','one','Original',NULL,'{}','old','old')")
            legacy.execute("INSERT INTO content_states VALUES('one',1,1,1,'old')")
        original_read = Path.read_text
        def broken_migration(path, *args, **kwargs):
            text = original_read(path, *args, **kwargs)
            return text + '\nINSERT INTO missing_table VALUES(1);' if path.name.startswith('003_') else text
        with patch.object(Path, 'read_text', broken_migration):
            with self.assertRaises(sqlite3.OperationalError):
                Database(legacy_path)
        with sqlite3.connect(legacy_path) as unchanged:
            self.assertEqual(unchanged.execute('PRAGMA user_version').fetchone()[0], 1)
            self.assertEqual(unchanged.execute('SELECT read,archived,deferred FROM content_states').fetchone(), (1,1,1))
            self.assertIsNone(unchanged.execute("SELECT 1 FROM sqlite_master WHERE name='schedules'").fetchone())
            unchanged.execute("UPDATE contents SET title='After failed upgrade'")
        migrated = Database(legacy_path)
        migrated.close()
        with sqlite3.connect(legacy_path.with_suffix('.before-v4.backup')) as backup:
            self.assertEqual(backup.execute('SELECT title FROM contents').fetchone()[0], 'Original')
            self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 1)
        self.assertEqual(len(list(legacy_path.parent.glob('failed-upgrade.before-v4.*.backup'))), 1)
