"""M42：优先级设置的统一保存。

三级名称、智能判断策略与来源默认优先级是同一个保存动作：
名称与策略进设置存档，来源默认值进 subscriptions 表，三者要么一起生效，
要么都不生效。
"""

import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.settings import SettingsService
from subscribe_flow.contracts import ChannelError, Connection, Source
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
from subscribe_flow.storage.settings import SettingsStore


class PrioritySettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority-settings.sqlite3'
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.service = SettingsService(SettingsStore(self.db), repository=self.repo)
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', '作者', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.other = self.repo.subscribe(
            Source('test', 'author', 'b', '另一个作者', 'https://example.com/b', True), 'c')

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def enable_llm(self):
        self.service.update('ai', {'providers': {'provider-llm': {
            'endpoint': 'https://api.example.com/v1', 'model': 'demo'}}}, {'provider-llm': 'llm-key'})

    def test_the_names_the_policy_and_the_source_defaults_are_saved_together(self):
        self.enable_llm()
        self.service.update('priority', {
            'names': {'high': '今天看', 'medium': '有空看', 'low': '以后再说'},
            'smart': {'enabled': True, 'providerId': 'provider-llm'},
            'sources': {self.sub['id']: 'medium', self.other['id']: 'low'},
        })
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['priority']['names']['high'], '今天看')
        self.assertTrue(snapshot['priority']['smart']['enabled'])
        self.assertEqual(snapshot['priority']['smart']['providerId'], 'provider-llm')
        self.assertEqual(self.repo.get_subscription(self.sub['id'])['default_priority'], 'medium')
        self.assertEqual(self.repo.get_subscription(self.other['id'])['default_priority'], 'low')

    def test_a_source_cancelled_during_the_draft_fails_the_whole_save(self):
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.repo.update_subscription(self.sub['id'], status='cancelled')
        with self.assertRaises(ChannelError) as caught:
            self.service.update('priority', {
                'names': {'high': '今天看'},
                'sources': {self.sub['id']: 'medium'},
            })
        self.assertEqual(caught.exception.scope, 'field')
        # 要么都成，要么都不成：名称没有落库，来源默认值也没动。
        self.assertEqual(self.service.snapshot()['priority']['names']['high'], '高优先级')
        self.assertEqual(self.repo.get_subscription(self.sub['id'])['default_priority'], 'high')

    def test_an_invalid_source_priority_is_refused_before_anything_is_written(self):
        with self.assertRaises(ChannelError) as caught:
            self.service.update('priority', {
                'names': {'high': '今天看'},
                'sources': {self.sub['id']: 'urgent'},
            })
        self.assertEqual(caught.exception.scope, 'field')
        self.assertEqual(caught.exception.scope_key, 'sources.' + self.sub['id'])
        self.assertEqual(self.service.snapshot()['priority']['names']['high'], '高优先级')

    def test_a_source_default_can_be_cleared(self):
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.service.update('priority', {'sources': {self.sub['id']: None}})
        self.assertIsNone(self.repo.get_subscription(self.sub['id'])['default_priority'])

    def test_renaming_does_not_bump_the_smart_revision(self):
        self.enable_llm()
        self.service.update('priority', {'smart': {'enabled': True, 'providerId': 'provider-llm'}})
        before = self.service.snapshot()['priority']['smart']['revision']
        self.service.update('priority', {'names': {'high': '今天看'}})
        # 改名只改显示：不得推进判断语义版本，否则在途结果会被白白作废。
        self.assertEqual(self.service.snapshot()['priority']['smart']['revision'], before)
        self.service.update('priority', {'smart': {'enabled': False}})
        self.assertGreater(self.service.snapshot()['priority']['smart']['revision'], before)

    def test_the_source_defaults_are_not_stored_in_the_settings_archive(self):
        self.service.update('priority', {'sources': {self.sub['id']: 'medium'}})
        stored = self.service.store.load()['payload']
        self.assertNotIn('sources', stored['priority'])
        self.assertEqual(self.repo.get_subscription(self.sub['id'])['default_priority'], 'medium')

    def test_the_save_survives_a_restart(self):
        self.enable_llm()
        self.service.update('priority', {
            'names': {'high': '今天看'},
            'smart': {'enabled': True, 'providerId': 'provider-llm'},
            'sources': {self.sub['id']: 'medium'},
        })
        reopened = SettingsService(SettingsStore(Database(self.path)), repository=Repository(Database(self.path)))
        snapshot = reopened.snapshot()
        self.assertEqual(snapshot['priority']['names']['high'], '今天看')
        self.assertTrue(snapshot['priority']['smart']['enabled'])
        self.assertEqual(snapshot['priority']['smart']['providerId'], 'provider-llm')
