import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage, ItemError, Source
from subscribe_flow.storage.database import Database
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
        self.repo.update_content_state([self.item.key], {"read": True, "archived": True})
        self.repo.commit_page(job["id"], self.page(replace(self.item, title="Updated")))
        result = self.repo.query_contents()
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["title"], "Updated")
        self.assertTrue(result["items"][0]["state"]["read"])
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
            self.assertEqual(restored.connection.execute("PRAGMA user_version").fetchone()[0], 1)
        finally:
            restored.close()

    def test_bulk_state_updates_are_atomic_and_query_is_parameterized(self):
        job = self.job()
        self.repo.commit_page(job["id"], self.page())
        with self.assertRaises(ChannelError):
            self.repo.update_content_state([self.item.key, "missing"], {"read": True})
        self.assertFalse(self.repo.get_content(self.item.key)["state"]["read"])
        self.assertEqual(self.repo.query_contents(query="' OR 1=1 --")["total"], 0)
