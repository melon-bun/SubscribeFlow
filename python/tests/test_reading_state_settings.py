"""Reading state display names do not change the underlying content state."""

import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.settings import SettingsService
from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.settings import SettingsStore


class ReadingStateSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'settings.sqlite3'
        self.db = Database(self.path)
        self.store = SettingsStore(self.db)
        self.service = SettingsService(self.store)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_defaults_partial_save_restart_and_unrelated_revisions(self):
        before = self.service.snapshot()
        self.assertEqual(before['general']['readingStateNames'], {'read': '还会再看', 'archived': '看完了'})
        saved = self.service.update('general', {'readingStateNames': {'read': '  值得重温  '}})
        self.assertEqual(saved['general']['readingStateNames'], {'read': '值得重温', 'archived': '看完了'})
        self.assertEqual(saved['tagging']['revision'], before['tagging']['revision'])
        self.assertEqual(saved['priority']['smart']['revision'], before['priority']['smart']['revision'])
        self.assertEqual(saved['summarization']['revision'], before['summarization']['revision'])
        self.service.update('general', {'readingStateNames': {'archived': '<已结束>'}})
        second = Database(self.path)
        try:
            names = SettingsService(SettingsStore(second)).snapshot()['general']['readingStateNames']
            self.assertEqual(names, {'read': '值得重温', 'archived': '<已结束>'})
        finally:
            second.close()

    def test_validation_is_atomic_and_cannot_rename_fixed_states(self):
        invalid_names = ['', ' ' * 3, 'x' * 13, None, 3, 'a\nb', '\tx', 'x\x7f', 'a\u2028b',
                         '稍后阅读', '稍后处理', '稍后', '未处理', '未读', '收件箱']
        original = self.service.snapshot()
        for value in invalid_names:
            with self.subTest(value=value):
                with self.assertRaises(ChannelError) as caught:
                    self.service.update('general', {'readingStateNames': {'read': value, 'archived': '新名称'}})
                self.assertEqual(caught.exception.scope_key, 'readingStateNames.read')
                self.assertEqual(self.service.snapshot()['general'], original['general'])
                self.assertEqual(self.service.snapshot()['version'], original['version'])
        for patch in ({'readingStateNames': {}}, {'readingStateNames': {'deferred': '新名称'}},
                      {'readingStateNames': {'unread': '新名称'}}, {'anything': True}, {}):
            with self.subTest(patch=patch), self.assertRaises(ChannelError):
                self.service.update('general', patch)
        with self.assertRaises(ChannelError):
            self.service.update('general', {'readingStateNames': {'read': 'ABC', 'archived': 'abc'}})
        with self.assertRaises(ChannelError):
            self.service.update('general', {'readingStateNames': {'read': '有效名称'}}, {})
        self.assertEqual(self.service.snapshot()['version'], original['version'])
        accepted = self.service.update('general', {'readingStateNames': {'read': '😀' * 12}})
        self.assertEqual(accepted['general']['readingStateNames']['read'], '😀' * 12)
        accepted = self.service.update('general', {'readingStateNames': {'read': '\ufeff  值得重温 \ufeff'}})
        self.assertEqual(accepted['general']['readingStateNames']['read'], '值得重温')
        accepted = self.service.update('general', {'readingStateNames': {'read': '已读', 'archived': '归档'}})
        self.assertEqual(accepted['general']['readingStateNames'], {'read': '已读', 'archived': '归档'})

    def test_legacy_or_invalid_saved_names_fall_back_without_writing(self):
        cases = [
            ({}, {'read': '还会再看', 'archived': '看完了'}),
            ({'general': None}, {'read': '还会再看', 'archived': '看完了'}),
            ({'general': {'readingStateNames': 'bad'}}, {'read': '还会再看', 'archived': '看完了'}),
            ({'general': {'readingStateNames': {'read': '', 'archived': '完成'}}}, {'read': '还会再看', 'archived': '完成'}),
            ({'general': {'readingStateNames': {'read': '看完了'}}}, {'read': '还会再看', 'archived': '看完了'}),
            ({'general': {'readingStateNames': {'read': 'Same', 'archived': 'same'}}}, {'read': '还会再看', 'archived': '看完了'}),
            ({'general': {'readingStateNames': {'read': '新名称', 'deferred': '非法'}}}, {'read': '新名称', 'archived': '看完了'}),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                self.store.save(payload)
                prior = self.store.load()
                self.assertEqual(self.service.snapshot()['general']['readingStateNames'], expected)
                self.assertEqual(self.store.load(), prior)


if __name__ == '__main__':
    unittest.main()
