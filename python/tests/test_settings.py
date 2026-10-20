"""M15 设置与凭据桥接的验收测试。

覆盖四期计划 S02（保存／取消／错误）与 S03（凭据）中属于 Core 的部分：
按页保存、配置校验、生效边界、版本递增、重启后仍在，
以及凭据只在内存、按引用取用、撤销即不可用。

这里不碰真实 safeStorage——加密与保护能力判断由 electron/main/credentials.cjs
负责，并有 tests/settings-credentials.test.cjs 与实机验收覆盖。
"""

import json
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.application.credentials import CredentialBroker
from subscribe_flow.application.settings import SettingsService
from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage, Source
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
from subscribe_flow.storage.settings import SettingsStore


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'settings.sqlite3'
        self.db = Database(self.path)
        self.service = SettingsService(SettingsStore(self.db))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    # ------------------------------------------------------------ 读取

    def test_defaults_are_closed_and_persisted_as_nothing(self):
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['version'], 0)
        self.assertIsNone(snapshot['updatedAt'])
        self.assertFalse(snapshot['tagging']['enabled'])
        self.assertFalse(snapshot['reminder']['enabled'])
        self.assertEqual(snapshot['reminder']['intervalMinutes'], 60)
        self.assertEqual(snapshot['reminder']['preset'], '60')
        self.assertFalse(snapshot['tagging']['providers']['jev']['configured'])

    # ------------------------------------------------------------ 提醒

    def test_reminder_saves_and_survives_restart(self):
        self.service.update('reminder', {'enabled': True, 'intervalMinutes': 30})
        reopened = SettingsService(SettingsStore(Database(self.path)))
        self.assertEqual(reopened.snapshot()['reminder'], {'enabled': True, 'intervalMinutes': 30, 'preset': '30'})

    def test_reminder_rejects_out_of_range_and_wrong_types(self):
        for value in (4, 1441, 0, -60, '60', 60.0, True, None):
            with self.subTest(value=value):
                with self.assertRaises(ChannelError) as caught:
                    self.service.update('reminder', {'intervalMinutes': value})
                self.assertEqual(caught.exception.scope_key, 'intervalMinutes')

    def test_reminder_accepts_range_bounds(self):
        self.service.update('reminder', {'intervalMinutes': 5})
        self.assertEqual(self.service.snapshot()['reminder']['intervalMinutes'], 5)
        self.service.update('reminder', {'intervalMinutes': 1440})
        self.assertEqual(self.service.snapshot()['reminder']['preset'], 'custom')

    def test_reminder_rejects_credential_references(self):
        with self.assertRaises(ChannelError):
            self.service.update('reminder', {'enabled': True}, {'jev': 'jev-abc'})

    # ------------------------------------------------------------ 自动打标

    def provider_patch(self, endpoint='https://api.typesafe.ai/v1/systemone', model='jev-latest'):
        return {'mode': 'jev', 'providers': {'jev': {'endpoint': endpoint, 'model': model}}}

    def test_enabling_requires_complete_configuration(self):
        with self.assertRaises(ChannelError) as caught:
            self.service.update('tagging', {'enabled': True, **self.provider_patch(endpoint='', model='')})
        message = caught.exception.message
        self.assertIn('Jev', message)
        for missing in ('接口地址', '模型标识', 'API Key'):
            self.assertIn(missing, message)

    def test_one_save_can_supply_fields_and_credential_together(self):
        self.service.update('tagging', self.provider_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'enabled': True})
        snapshot = self.service.snapshot()
        self.assertTrue(snapshot['tagging']['enabled'])
        self.assertTrue(snapshot['tagging']['providers']['jev']['configured'])

    def test_switching_mode_keeps_the_other_configuration(self):
        self.service.update('tagging', self.provider_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'enabled': True})
        self.service.update('tagging', {
            'mode': 'llm',
            'providers': {'llm': {'endpoint': 'https://api.example.com/v1', 'model': 'demo'}},
        }, {'llm': 'llm-xyz'})
        providers = self.service.snapshot()['tagging']['providers']
        self.assertTrue(providers['jev']['configured'], '切换模式不能丢掉另一种方式的配置')
        self.assertTrue(providers['llm']['configured'])
        self.assertEqual(providers['llm']['endpoint'], 'https://api.example.com/v1')

    def test_switching_to_unconfigured_mode_while_enabled_is_refused(self):
        self.service.update('tagging', self.provider_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'enabled': True})
        with self.assertRaises(ChannelError) as caught:
            self.service.update('tagging', {'mode': 'llm'})
        self.assertIn('切换', caught.exception.message)
        self.assertEqual(self.service.snapshot()['tagging']['mode'], 'jev')

    def test_enabled_boundary_is_recorded_and_cleared(self):
        self.service.update('tagging', self.provider_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'enabled': True})
        started = self.service.snapshot()['tagging']['enabledSince']
        self.assertIsNotNone(started)
        self.service.update('tagging', {'enabled': False})
        self.assertIsNone(self.service.snapshot()['tagging']['enabledSince'])
        self.service.update('tagging', {'enabled': True})
        self.assertIsNotNone(self.service.snapshot()['tagging']['enabledSince'])

    def test_rejects_bad_fields_and_secret_bearing_keys(self):
        for patch in ({'mode': 'other'}, {'enabled': 'yes'}, {'unknown': 1},
                      {'providers': {'llm': {'apiKey': 'sk-leak'}}},
                      {'providers': {'other': {'endpoint': 'https://x.dev/v1'}}},
                      {'providers': {'jev': {'endpoint': 'ftp://x', 'model': 'm'}}},
                      {'providers': {'jev': {'model': 'has space'}}}):
            with self.subTest(patch=patch):
                with self.assertRaises(ChannelError):
                    self.service.update('tagging', patch)

    def test_field_errors_name_the_exact_input(self):
        with self.assertRaises(ChannelError) as caught:
            self.service.update('tagging', {'providers': {'llm': {'model': 'has space'}}})
        self.assertEqual(caught.exception.scope, 'field')
        self.assertEqual(caught.exception.scope_key, 'llm.model')

    def test_model_identifiers_may_contain_provider_namespaces(self):
        for model in ('vendor/model-name', 'org/model:revision', 'plain-model'):
            self.service.update('tagging', {'providers': {'llm': {'model': model}}})
            self.assertEqual(self.service.snapshot()['tagging']['providers']['llm']['model'], model)

    def test_provider_field_types_and_malformed_urls_are_field_errors(self):
        for field, values in {
            'model': [0, False, None, {}, ['model'], 'bad\x00model'],
            'endpoint': [0, False, None, {}, ['https://example.com'], 'https://[broken',
                         'https://example.com:bad', 'https://user:secret@example.com', 'https://host name/v1'],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ChannelError) as caught:
                        self.service.update('tagging', {'providers': {'llm': {field: value}}})
                    self.assertEqual(caught.exception.scope_key, 'llm.' + field)

    def test_secrets_never_reach_storage(self):
        self.service.update('tagging', self.provider_patch(), {'jev': 'jev-abc'})
        raw = self.db.connection.execute('SELECT payload FROM app_settings').fetchone()[0]
        self.assertNotIn('sk-', raw)
        self.assertNotIn('apikey_', raw)
        self.assertNotIn('secret', raw)

    def test_version_increases_on_every_save(self):
        versions = [self.service.snapshot()['version']]
        for section, patch, refs in (('tagging', self.provider_patch(), {'jev': 'jev-abc'}),
                                     ('reminder', {'enabled': True}, None)):
            self.service.update(section, patch, refs)
            versions.append(self.service.snapshot()['version'])
        self.assertEqual(versions, [0, 1, 2])

    def test_unknown_stored_fields_are_ignored(self):
        self.service.update('reminder', {'enabled': True})
        # 模拟未来版本写入的 payload：未知字段不能让读取报错，也不能被带出去。
        self.service.store.db.execute(
            'UPDATE app_settings SET payload=? WHERE id=1',
            ('{"tagging":{"enabled":true,"future":1},"reminder":{"intervalMinutes":45,"later":2}}',))
        snapshot = self.service.snapshot()
        self.assertTrue(snapshot['tagging']['enabled'])
        self.assertEqual(snapshot['reminder']['intervalMinutes'], 45)
        self.assertNotIn('future', json.dumps(snapshot, ensure_ascii=False))


class PriorityNameSettingsTests(unittest.TestCase):
    """M20：三级优先级的显示名。

    名称只影响显示：等级、顺序、来源继承、内容统计都不能被改名影响，
    也不能让在跑的打标任务失效或动提醒计时。
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority-names.sqlite3'
        self.db = Database(self.path)
        self.service = SettingsService(SettingsStore(self.db))
        self.repo = Repository(self.db)
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.item = ContentItem('test', 'video', 'a', self.source, 'Title', 'https://example.com/a')
        self.job, _ = self.repo.create_job(self.sub['id'], 'refresh')
        self.repo.set_job_state(self.job['id'], 'running')
        self.repo.commit_page(self.job['id'], FetchPage((self.item,), None, 'window_only'))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_default_names_are_returned_when_nothing_is_stored(self):
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['priority']['names'],
                         {'high': '高优先级', 'medium': '中优先级', 'low': '低优先级'})

    def test_old_config_without_the_section_falls_back_to_defaults(self):
        # 旧库里没有这一项，读取不能报错，也不能给出半截名字。
        self.service.store.db.execute(
            'INSERT INTO app_settings(id,version,payload,updated_at) VALUES(1,3,?,?)',
            ('{"tagging":{"enabled":false},"reminder":{"enabled":false,"intervalMinutes":60}}', '2026-10-21'))
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['version'], 3)
        self.assertEqual(snapshot['priority']['names'],
                         {'high': '高优先级', 'medium': '中优先级', 'low': '低优先级'})

    def test_names_are_trimmed_persisted_and_survive_restart(self):
        self.service.update('priority', {'names': {'high': '  今天看  ', 'medium': '有空看', 'low': '以后再说'}})
        self.assertEqual(self.service.snapshot()['priority']['names'],
                         {'high': '今天看', 'medium': '有空看', 'low': '以后再说'})
        reopened = SettingsService(SettingsStore(Database(self.path)))
        self.assertEqual(reopened.snapshot()['priority']['names'],
                         {'high': '今天看', 'medium': '有空看', 'low': '以后再说'})

    def test_invalid_names_are_refused_with_the_exact_field(self):
        cases = [
            ({'names': {'high': '   '}}, 'names.high'),
            ({'names': {'high': 'x' * 13}}, 'names.high'),
            ({'names': {'medium': '未设置'}}, 'names.medium'),
        ]
        for patch, expected_key in cases:
            with self.subTest(patch=patch):
                with self.assertRaises(ChannelError) as caught:
                    self.service.update('priority', patch)
                self.assertEqual(caught.exception.scope, 'field')
                self.assertEqual(caught.exception.scope_key, expected_key)

    def test_a_single_valid_name_keeps_the_other_two(self):
        self.service.update('priority', {'names': {'low': '同一'}})
        self.assertEqual(self.service.snapshot()['priority']['names'],
                         {'high': '高优先级', 'medium': '中优先级', 'low': '同一'})

    def test_duplicated_names_are_refused(self):
        with self.assertRaises(ChannelError) as caught:
            self.service.update('priority', {'names': {'high': '重要', 'medium': '重要'}})
        self.assertEqual(caught.exception.scope_key, 'names.medium')

    def test_unknown_levels_cannot_be_added_or_removed(self):
        for patch in ({'names': {'urgent': '紧急'}}, {'names': {'none': '无'}},
                      {'names': {'high': '重要', 'medium': '中', 'low': '低', 'extra': '多'}}):
            with self.subTest(patch=patch):
                with self.assertRaises(ChannelError):
                    self.service.update('priority', patch)

    def test_rename_does_not_change_content_source_inheritance_or_counts(self):
        before = self.repo.get_content(self.item.key)
        counts_before = {level: self.repo.query_contents(priority=level)['total']
                         for level in ('high', 'medium', 'low', 'none')}
        self.service.update('priority', {'names': {'high': '今天看'}})
        after = self.repo.get_content(self.item.key)
        self.assertEqual(after['priority'], before['priority'])
        self.assertEqual(after['source_priority'], before['source_priority'])
        counts_after = {level: self.repo.query_contents(priority=level)['total']
                        for level in ('high', 'medium', 'low', 'none')}
        self.assertEqual(counts_after, counts_before)

    def test_rename_does_not_bump_version_or_disturb_tagging_and_reminder(self):
        self.service.update('tagging', {'mode': 'jev',
                                         'providers': {'jev': {'endpoint': 'https://api.example.com/v1',
                                                               'model': 'jev-latest'}},
                                         'enabled': True},
                            {'jev': 'jev-abc'})
        self.service.update('reminder', {'enabled': True, 'intervalMinutes': 30})
        before = self.service.snapshot()
        self.service.update('priority', {'names': {'high': '今天看'}})
        after = self.service.snapshot()
        # 版本是自动打标判断自己是否过期的依据：只改显示名不能动它。
        self.assertEqual(after['version'], before['version'])
        self.assertEqual(after['tagging']['enabledSince'], before['tagging']['enabledSince'])
        self.assertEqual(after['reminder'], before['reminder'])
        # 其它分区照旧递增版本。
        self.service.update('reminder', {'intervalMinutes': 45})
        self.assertEqual(self.service.snapshot()['version'], before['version'] + 1)


class CredentialBrokerTests(unittest.TestCase):
    def test_secret_is_available_only_by_reference(self):
        broker = CredentialBroker()
        broker.provide('jev-abc', 'apikey_value')
        self.assertEqual(broker.secret_for('jev-abc'), 'apikey_value')
        self.assertIsNone(broker.secret_for('jev-other'))
        self.assertIsNone(broker.secret_for(None))
        self.assertEqual(broker.references(), ['jev-abc'])

    def test_revoke_removes_immediately(self):
        broker = CredentialBroker()
        broker.provide('llm-1', 'value')
        broker.revoke('llm-1')
        self.assertIsNone(broker.secret_for('llm-1'))

    def test_restart_empties_the_broker(self):
        broker = CredentialBroker()
        broker.provide('jev-abc', 'value')
        # Core 重启后内存清空，主进程需要按当前设置重新推送。
        self.assertEqual(CredentialBroker().references(), [])

    def test_invalid_provide_is_rejected(self):
        broker = CredentialBroker()
        for reference, secret in (('', 'v'), ('x' * 100, 'v'), ('ok', ''), ('ok', 'v' * 5000)):
            with self.subTest(reference=reference, secret=secret[:8]):
                with self.assertRaises(ChannelError):
                    broker.provide(reference, secret)

    def test_broker_is_bounded(self):
        broker = CredentialBroker(limit=2)
        for index in range(4):
            broker.provide(f'ref-{index}', 'value')
        self.assertEqual(broker.references(), ['ref-2', 'ref-3'])


if __name__ == '__main__':
    unittest.main()
