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
        self.assertFalse(snapshot['ai']['providers']['jev']['configured'])

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

    # ------------------------------------------------------------ AI API 与识别策略

    def api_patch(self, mode='jev', endpoint='https://api.typesafe.ai/v1/systemone', model='jev-latest'):
        """M21：连接参数走独立的 ai 分区。"""
        return {'providers': {mode: {'endpoint': endpoint, 'model': model}}}

    def test_enabling_requires_complete_configuration(self):
        self.service.update('ai', self.api_patch(endpoint='', model=''), {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
        with self.assertRaises(ChannelError) as caught:
            self.service.update('tagging', {'enabled': True})
        message = caught.exception.message
        self.assertIn('Jev', message)
        for missing in ('接口地址', '模型标识'):
            self.assertIn(missing, message)

    def test_one_save_can_supply_fields_and_credential_together(self):
        self.service.update('ai', self.api_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
        self.service.update('tagging', {'enabled': True})
        snapshot = self.service.snapshot()
        self.assertTrue(snapshot['tagging']['enabled'])
        self.assertTrue(snapshot['ai']['providers']['jev']['configured'])

    def test_api_can_be_saved_incomplete(self):
        # M21：允许先保存没填齐的参数，不必等另一类 API 配完。
        self.service.update('ai', self.api_patch(mode='llm', endpoint='https://api.example.com/v1', model=''))
        snapshot = self.service.snapshot()
        self.assertFalse(snapshot['ai']['providers']['llm']['configured'])
        self.assertIn('模型标识', snapshot['ai']['providers']['llm']['missing'])

    def test_switching_mode_keeps_the_other_configuration(self):
        self.service.update('ai', self.api_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
        self.service.update('tagging', {'enabled': True})
        self.service.update('ai', self.api_patch(mode='llm', endpoint='https://api.example.com/v1', model='demo'),
                            {'llm': 'llm-xyz'})
        self.service.update('tagging', {'mode': 'llm'})
        providers = self.service.snapshot()['ai']['providers']
        self.assertTrue(providers['jev']['configured'], '切换模式不能丢掉另一种方式的配置')
        self.assertTrue(providers['llm']['configured'])
        self.assertEqual(providers['llm']['endpoint'], 'https://api.example.com/v1')

    def test_switching_to_unconfigured_mode_while_enabled_is_refused(self):
        self.service.update('ai', self.api_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
        self.service.update('tagging', {'enabled': True})
        with self.assertRaises(ChannelError) as caught:
            self.service.update('tagging', {'mode': 'llm'})
        self.assertIn('切换', caught.exception.message)
        self.assertEqual(self.service.snapshot()['tagging']['mode'], 'jev')

    def test_enabled_boundary_is_recorded_and_cleared(self):
        self.service.update('ai', self.api_patch(), {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
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
                    self.service.update('ai', patch)
        for patch in ({'mode': 'other'}, {'enabled': 'yes'}, {'unknown': 1},
                      {'providers': {'llm': {'endpoint': 'https://x.dev/v1'}}}):
            with self.subTest(patch=patch):
                with self.assertRaises(ChannelError):
                    self.service.update('tagging', patch)

    def test_field_errors_name_the_exact_input(self):
        with self.assertRaises(ChannelError) as caught:
            self.service.update('ai', {'providers': {'llm': {'model': 'has space'}}})
        self.assertEqual(caught.exception.scope, 'field')
        self.assertEqual(caught.exception.scope_key, 'llm.model')

    def test_model_identifiers_may_contain_provider_namespaces(self):
        for model in ('vendor/model-name', 'org/model:revision', 'plain-model'):
            self.service.update('ai', {'providers': {'llm': {'model': model}}})
            self.assertEqual(self.service.snapshot()['ai']['providers']['llm']['model'], model)

    def test_provider_field_types_and_malformed_urls_are_field_errors(self):
        for field, values in {
            'model': [0, False, None, {}, ['model'], 'bad\x00model'],
            'endpoint': [0, False, None, {}, ['https://example.com'], 'https://[broken',
                         'https://example.com:bad', 'https://user:secret@example.com', 'https://host name/v1'],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    with self.assertRaises(ChannelError) as caught:
                        self.service.update('ai', {'providers': {'llm': {field: value}}})
                    self.assertEqual(caught.exception.scope_key, 'llm.' + field)

    def test_secrets_never_reach_storage(self):
        self.service.update('ai', self.api_patch(), {'jev': 'jev-abc'})
        raw = self.db.connection.execute('SELECT payload FROM app_settings').fetchone()[0]
        self.assertNotIn('sk-', raw)
        self.assertNotIn('apikey_', raw)
        self.assertNotIn('secret', raw)

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
        self.service.update('ai', {'providers': {'jev': {'endpoint': 'https://api.example.com/v1',
                                                          'model': 'jev-latest'}}},
                            {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev'})
        self.service.update('tagging', {'enabled': True})
        self.service.update('reminder', {'enabled': True, 'intervalMinutes': 30})
        before = self.service.snapshot()
        self.service.update('priority', {'names': {'high': '今天看'}})
        after = self.service.snapshot()
        # 版本是自动打标判断自己是否过期的依据：只改显示名不能动它。
        self.assertEqual(after['version'], before['version'])
        self.assertEqual(after['tagging']['enabledSince'], before['tagging']['enabledSince'])
        self.assertEqual(after['reminder'], before['reminder'])
        # 其它分区照旧只影响自己的内容。
        self.service.update('reminder', {'intervalMinutes': 45})
        self.assertEqual(self.service.snapshot()['reminder']['intervalMinutes'], 45)
        self.assertEqual(self.service.snapshot()['version'], before['version'],
                         'M21 起提醒保存同样不推进识别版本')


class AiStrategySeparationTests(unittest.TestCase):
    """M21：AI API 配置与识别策略分开。

    连接参数在 ai.providers，识别策略在 tagging。两页各自保存，互不覆盖；
    旧结构 tagging.providers 仍然读得出来，转换幂等，不重置开关与启用时间。
    配置版本只在当前生效的识别配置真的变了时才前进。
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ai-strategy.sqlite3'
        self.db = Database(self.path)
        self.service = SettingsService(SettingsStore(self.db))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def write_raw(self, payload, version=3):
        self.service.store.db.execute(
            'INSERT OR REPLACE INTO app_settings(id,version,payload,updated_at) VALUES(1,?,?,?)',
            (version, payload, '2026-10-21'))

    def test_old_tagging_providers_are_read_into_the_new_section(self):
        self.write_raw(json.dumps({
            'tagging': {'enabled': True, 'mode': 'jev', 'enabledSince': '2026-10-01T00:00:00+00:00',
                        'providers': {'jev': {'endpoint': 'https://old.example.com/v1', 'model': 'old-model',
                                              'credentialRef': 'jev-old'},
                                      'llm': {'endpoint': 'https://llm.example.com/v1', 'model': 'llm-old',
                                              'credentialRef': 'llm-old'}}},
            'reminder': {'enabled': True, 'intervalMinutes': 30},
        }))
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['ai']['providers']['jev']['endpoint'], 'https://old.example.com/v1')
        self.assertEqual(snapshot['ai']['providers']['jev']['model'], 'old-model')
        self.assertEqual(snapshot['ai']['providers']['jev']['credentialRef'], 'jev-old')
        self.assertEqual(snapshot['ai']['providers']['llm']['endpoint'], 'https://llm.example.com/v1')
        # 策略也必须原样读出：开关、方式与启用时间都不能被升级重置。
        self.assertTrue(snapshot['tagging']['enabled'])
        self.assertEqual(snapshot['tagging']['mode'], 'jev')
        self.assertEqual(snapshot['tagging']['enabledSince'], '2026-10-01T00:00:00+00:00')
        self.assertEqual(snapshot['reminder']['intervalMinutes'], 30)

    def test_conversion_is_idempotent_and_keeps_the_key(self):
        self.write_raw(json.dumps({
            'tagging': {'enabled': True, 'mode': 'jev', 'enabledSince': '2026-10-01T00:00:00+00:00',
                        'providers': {'jev': {'endpoint': 'https://old.example.com/v1', 'model': 'old-model',
                                              'credentialRef': 'jev-old'}}}}))
        before = self.service.snapshot()
        # 升级后的第一次保存：把旧结构转成新结构，值不能变。
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-new'}}})
        after = self.service.snapshot()
        self.assertEqual(after['ai']['providers']['jev'], before['ai']['providers']['jev'])
        self.assertTrue(after['tagging']['enabled'])
        self.assertEqual(after['tagging']['enabledSince'], before['tagging']['enabledSince'])
        # 再存一次结果相同：转换是幂等的。
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-new'}}})
        self.assertEqual(self.service.snapshot()['ai']['providers'], after['ai']['providers'])
        raw = self.db.connection.execute('SELECT payload FROM app_settings').fetchone()[0]
        self.assertIn('jev-old', raw, '凭据引用不能因为结构迁移丢掉')

    def test_new_structure_wins_over_the_legacy_one(self):
        self.write_raw(json.dumps({
            'ai': {'providers': {'jev': {'endpoint': 'https://new.example.com/v1', 'model': 'new-model',
                                         'credentialRef': 'jev-new'}}},
            'tagging': {'enabled': True, 'mode': 'jev',
                        'providers': {'jev': {'endpoint': 'https://old.example.com/v1', 'model': 'old-model',
                                              'credentialRef': 'jev-old'}}}}))
        provider = self.service.snapshot()['ai']['providers']['jev']
        self.assertEqual(provider['endpoint'], 'https://new.example.com/v1')
        self.assertEqual(provider['credentialRef'], 'jev-new')

    def test_api_save_does_not_touch_the_strategy(self):
        self.service.update('ai', {'providers': {'jev': {'endpoint': 'https://api.example.com/v1',
                                                          'model': 'jev-model'}}}, {'jev': 'jev-abc'})
        self.service.update('tagging', {'mode': 'jev', 'enabled': True})
        before = self.service.snapshot()['tagging']
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-model'}}})
        after = self.service.snapshot()['tagging']
        self.assertEqual(after['enabled'], before['enabled'])
        self.assertEqual(after['mode'], before['mode'])
        self.assertEqual(after['enabledSince'], before['enabledSince'])

    def test_strategy_save_does_not_touch_the_api(self):
        self.service.update('ai', {'providers': {'jev': {'endpoint': 'https://api.example.com/v1',
                                                          'model': 'jev-model'}}}, {'jev': 'jev-abc'})
        before = self.service.snapshot()['ai']['providers']
        self.service.update('tagging', {'mode': 'jev', 'enabled': True})
        self.assertEqual(self.service.snapshot()['ai']['providers'], before)

    def test_tagging_section_refuses_credential_references(self):
        with self.assertRaises(ChannelError):
            self.service.update('tagging', {'mode': 'jev'}, {'jev': 'jev-abc'})

    def test_version_does_not_move_for_unrelated_saves(self):
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-model'}}}, {'llm': 'llm-abc'})
        version = self.service.snapshot()['version']
        # 当前方式仍是 llm：改 jev 的 API、改进级别名、改提醒都不该动识别版本。
        self.service.update('ai', {'providers': {'jev': {'endpoint': 'https://jev.example.com/v1',
                                                          'model': 'jev-model'}}})
        self.service.update('priority', {'names': {'high': '今天看'}})
        self.service.update('reminder', {'enabled': True, 'intervalMinutes': 30})
        self.assertEqual(self.service.snapshot()['version'], version,
                         '无关保存不该让在途的识别任务失效')

    def test_version_moves_when_the_active_api_changes(self):
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-model'}}}, {'llm': 'llm-abc'})
        version = self.service.snapshot()['version']
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm2.example.com/v1',
                                                          'model': 'llm-model'}}})
        self.assertEqual(self.service.snapshot()['version'], version + 1,
                         '当前方式所用的 API 变了，在途结果必须作废')

    def test_version_moves_when_the_mode_switches(self):
        self.service.update('ai', {'providers': {'jev': {'endpoint': 'https://jev.example.com/v1',
                                                          'model': 'jev-model'}}}, {'jev': 'jev-abc'})
        version = self.service.snapshot()['version']
        self.service.update('tagging', {'mode': 'jev'})
        self.assertEqual(self.service.snapshot()['version'], version + 1,
                         '切换识别方式必须让旧结果作废')

    def test_version_moves_when_recognition_is_switched_off(self):
        self.service.update('ai', {'providers': {'llm': {'endpoint': 'https://llm.example.com/v1',
                                                          'model': 'llm-model'}}}, {'llm': 'llm-abc'})
        self.service.update('tagging', {'enabled': True})
        version = self.service.snapshot()['version']
        self.service.update('tagging', {'enabled': False})
        self.assertEqual(self.service.snapshot()['version'], version + 1)


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
