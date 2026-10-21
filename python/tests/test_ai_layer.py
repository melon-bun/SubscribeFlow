"""M25 公共 AI 层的契约测试。

覆盖三件事：
- 连接资源：能力由协议派生、版本只在调用配置变化时前进、迁移幂等且不丢凭据引用；
- 网关：凭据只在调用这一刻组装、协议最小探针不产生业务任务；
- 适配器：请求与响应的形状，以及坏响应的处理。
"""

import json
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.ai.adapters.jev_systemone import JevSystemOneAdapter
from subscribe_flow.ai.adapters.openai_chat import OpenAiChatAdapter
from subscribe_flow.ai.contracts import (
    CAPABILITY_CANDIDATE_CLASSIFICATION, CAPABILITY_TEXT_GENERATION, PROTOCOL_JEV_SYSTEMONE,
    PROTOCOL_OPENAI_CHAT, AiError, ProviderConfig,
)
from subscribe_flow.ai.gateway import AiGateway
from subscribe_flow.ai.registry import (
    call_changed, capabilities_of, migrate_providers, normalize_providers, references,
)
from subscribe_flow.application.credentials import CredentialBroker
from subscribe_flow.application.settings import SettingsService
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.settings import SettingsStore


class FakeTransport:
    """按 URL 返回预设响应，并记录收到的请求。"""

    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def post_json(self, url, payload, headers=None, timeout=None):
        self.calls.append({'url': url, 'payload': payload, 'headers': headers or {}})
        for suffix, body in self.responses.items():
            if url.endswith(suffix):
                return 200, body
        raise AiError('invalid_response', f'没有为 {url} 准备响应')


class ProviderConfigTests(unittest.TestCase):
    def test_capabilities_come_from_the_protocol(self):
        chat = ProviderConfig(id='p1', protocol=PROTOCOL_OPENAI_CHAT)
        classify = ProviderConfig(id='p2', protocol=PROTOCOL_JEV_SYSTEMONE)
        self.assertTrue(chat.supports(CAPABILITY_TEXT_GENERATION))
        self.assertFalse(chat.supports(CAPABILITY_CANDIDATE_CLASSIFICATION))
        self.assertTrue(classify.supports(CAPABILITY_CANDIDATE_CLASSIFICATION))
        self.assertFalse(classify.supports(CAPABILITY_TEXT_GENERATION))

    def test_call_signature_excludes_the_display_name(self):
        provider = ProviderConfig(id='p1', name='改个名字', endpoint='https://a/v1', model='m')
        self.assertNotIn('name', provider.call_signature())
        self.assertFalse(call_changed(provider.to_dict(), {'name': '另一个名字'}))
        self.assertTrue(call_changed(provider.to_dict(), {'endpoint': 'https://b/v1'}))
        self.assertTrue(call_changed(provider.to_dict(), {'enabled': False}))

    def test_unknown_protocol_is_rejected(self):
        with self.assertRaises(ValueError):
            ProviderConfig.from_dict({'id': 'p1', 'protocol': 'made-up'})

    def test_capabilities_lookup_is_closed(self):
        self.assertEqual(capabilities_of('made-up'), ())


class MigrationTests(unittest.TestCase):
    def test_legacy_slots_become_two_connections_with_the_same_key(self):
        stored = {
            'ai': {'providers': {
                'llm': {'endpoint': 'https://llm/v1', 'model': 'm1', 'credentialRef': 'key-llm'},
                'jev': {'endpoint': 'https://jev/v1', 'model': 'm2', 'credentialRef': 'key-jev'},
            }},
        }
        migrated = migrate_providers(stored)
        self.assertEqual(set(migrated), {'provider-llm', 'provider-jev'})
        self.assertEqual(migrated['provider-llm']['endpoint'], 'https://llm/v1')
        self.assertEqual(migrated['provider-llm']['credentialRef'], 'key-llm')
        self.assertEqual(migrated['provider-jev']['credentialRef'], 'key-jev')
        self.assertEqual(migrated['provider-llm']['protocol'], PROTOCOL_OPENAI_CHAT)
        self.assertEqual(migrated['provider-jev']['protocol'], PROTOCOL_JEV_SYSTEMONE)

    def test_older_tagging_providers_are_read_too(self):
        stored = {'tagging': {'providers': {
            'llm': {'endpoint': 'https://llm/v1', 'model': 'm1', 'credentialRef': 'key-llm'},
        }}}
        migrated = migrate_providers(stored)
        self.assertEqual(migrated['provider-llm']['credentialRef'], 'key-llm')

    def test_modern_structure_wins_over_the_legacy_one(self):
        stored = {
            'ai': {'formatVersion': 2, 'providers': {
                'provider-llm': {'id': 'provider-llm', 'name': '新', 'protocol': PROTOCOL_OPENAI_CHAT,
                                 'endpoint': 'https://new/v1', 'model': 'new', 'credentialRef': 'key-new'},
            }},
            'tagging': {'providers': {'llm': {'endpoint': 'https://old/v1', 'credentialRef': 'key-old'}}},
        }
        migrated = migrate_providers(stored)
        self.assertEqual(migrated['provider-llm']['endpoint'], 'https://new/v1')
        self.assertEqual(migrated['provider-llm']['credentialRef'], 'key-new')

    def test_migration_is_idempotent(self):
        stored = {'ai': {'providers': {'llm': {'endpoint': 'https://llm/v1', 'model': 'm'}}}}
        once = migrate_providers(stored)
        twice = migrate_providers({'ai': {'formatVersion': 2, 'providers': once}})
        self.assertEqual(twice, once)

    def test_broken_entries_are_skipped_not_fatal(self):
        providers = normalize_providers({'ok': {'id': 'ok', 'protocol': PROTOCOL_OPENAI_CHAT},
                                         'bad': {'id': 'bad', 'protocol': 'nope'}})
        self.assertEqual(list(providers), ['ok'])

    def test_legacy_slot_only_fills_the_missing_fields(self):
        """混合旧结构：现代显式写的优先，现代没写的才用旧值补。"""
        stored = {
            'ai': {'providers': {'llm': {'endpoint': 'https://new/v1'}}},
            'tagging': {'providers': {'llm': {'endpoint': 'https://old/v1', 'model': 'old-model',
                                             'credentialRef': 'old-ref'}}},
        }
        migrated = migrate_providers(stored)
        self.assertEqual(migrated['provider-llm']['endpoint'], 'https://new/v1', '现代显式的地址优先')
        self.assertEqual(migrated['provider-llm']['model'], 'old-model', '现代没写的模型要用旧值补上')
        self.assertEqual(migrated['provider-llm']['credentialRef'], 'old-ref', '凭据引用要补回来')

    def test_explicit_clear_is_not_revived_by_the_legacy_value(self):
        """用户显式清空的字段不能被旧值复活。"""
        stored = {
            'ai': {'providers': {'llm': {'endpoint': 'https://new/v1', 'model': '',
                                         'credentialRef': None}}},
            'tagging': {'providers': {'llm': {'model': 'old-model', 'credentialRef': 'old-ref'}}},
        }
        migrated = migrate_providers(stored)
        self.assertEqual(migrated['provider-llm']['model'], '', '显式清空的模型不能被旧值复活')
        self.assertIsNone(migrated['provider-llm']['credentialRef'], '显式清空的凭据引用不能被旧值复活')

    def test_mixed_structures_stay_idempotent(self):
        stored = {
            'ai': {'providers': {'llm': {'endpoint': 'https://new/v1'}}},
            'tagging': {'providers': {'llm': {'model': 'old-model', 'credentialRef': 'old-ref'}}},
        }
        once = migrate_providers(stored)
        twice = migrate_providers({'ai': {'formatVersion': 2, 'providers': once}})
        self.assertEqual(twice, once)

    def test_modern_structure_does_not_resurrect_deleted_connections(self):
        """新结构是权威的：删光连接后，旧槽位不能把它们补回来。"""
        stored = {
            'ai': {'formatVersion': 2, 'providers': {}},
            'tagging': {'providers': {'llm': {'endpoint': 'https://old/v1', 'model': 'old-model'}}},
        }
        self.assertEqual(migrate_providers(stored), {})


class ReferenceTests(unittest.TestCase):
    def test_users_of_a_provider_are_named(self):
        payload = {
            'tagging': {'providerIds': {'llm': 'p-text', 'jev': 'p-classify'}},
            'summarization': {'providerId': 'p-text'},
        }
        self.assertEqual(references(payload, 'p-text'), ['标签管理·llm 识别', 'AI 总结'])
        self.assertEqual(references(payload, 'p-classify'), ['标签管理·jev 识别'])
        self.assertEqual(references(payload, 'p-none'), [])


class AdapterTests(unittest.TestCase):
    def test_chat_adapter_sends_messages_and_returns_text(self):
        transport = FakeTransport({'/chat/completions': {
            'model': 'demo', 'usage': {'total_tokens': 12},
            'choices': [{'message': {'content': ' 你好 '}}],
        }})
        adapter = OpenAiChatAdapter(endpoint='https://api/v1', model='m', api_key='k', transport=transport)
        result = adapter.chat([('system', '规则'), ('user', '内容')])
        self.assertEqual(result.text, ' 你好 ')
        self.assertEqual(result.model, 'demo')
        call = transport.calls[0]
        self.assertEqual(call['url'], 'https://api/v1/chat/completions')
        self.assertEqual(call['payload']['messages'], [{'role': 'system', 'content': '规则'},
                                                      {'role': 'user', 'content': '内容'}])
        self.assertEqual(call['headers']['Authorization'], 'Bearer k')

    def test_chat_adapter_rejects_a_malformed_response(self):
        for body in ({}, {'choices': []}, {'choices': [{'message': {'content': '  '}}]}):
            with self.subTest(body=body):
                transport = FakeTransport({'/chat/completions': body})
                adapter = OpenAiChatAdapter(endpoint='https://api/v1', model='m', api_key='k', transport=transport)
                with self.assertRaises(AiError) as caught:
                    adapter.chat([('user', 'x')])
                self.assertEqual(caught.exception.code, 'invalid_response')

    def test_jev_adapter_returns_probabilities_for_the_asked_questions(self):
        transport = FakeTransport({'': {
            'model': 'demo',
            'answers': {'q1': {'type': 'noul', 'noul': 0.8}, 'q2': {'type': 'noul', 'noul': 0.2}},
        }})
        adapter = JevSystemOneAdapter(endpoint='https://api', model='m', api_key='k', transport=transport)
        result = adapter.classify('一段内容', {'q1': '是不是甲', 'q2': '是不是乙'})
        self.assertEqual(result.probabilities, {'q1': 0.8, 'q2': 0.2})
        payload = transport.calls[0]['payload']
        self.assertEqual(payload['questions']['q1'], {'type': 'noul', 'instructions': '是不是甲'})

    def test_jev_adapter_rejects_missing_or_bad_answers(self):
        cases = [
            {},
            {'answers': {'q1': {'type': 'noul', 'noul': 0.5}}},          # 少一个
            {'answers': {'q1': {'type': 'noul', 'noul': 0.5},
                         'q2': {'type': 'noul', 'noul': 0.5},
                         'q3': {'type': 'noul', 'noul': 0.5}}},          # 多一个
            {'answers': {'q1': {'type': 'other', 'noul': 0.5},
                         'q2': {'type': 'noul', 'noul': 0.5}}},          # 类型不对
            {'answers': {'q1': {'type': 'noul', 'noul': 1.5},
                         'q2': {'type': 'noul', 'noul': 0.5}}},          # 越界
            {'answers': {'q1': {'type': 'noul', 'noul': 'x'},
                         'q2': {'type': 'noul', 'noul': 0.5}}},          # 不是数值
        ]
        for body in cases:
            with self.subTest(body=body):
                transport = FakeTransport({'': body})
                adapter = JevSystemOneAdapter(endpoint='https://api', model='m', api_key='k', transport=transport)
                with self.assertRaises(AiError) as caught:
                    adapter.classify('内容', {'q1': 'a', 'q2': 'b'})
                self.assertEqual(caught.exception.code, 'invalid_response')


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ai.sqlite3'
        self.db = Database(self.path)
        self.settings = SettingsService(SettingsStore(self.db))
        self.credentials = CredentialBroker()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def configure(self, providers, refs=None):
        """写入连接配置：providers 是 {连接 ID: 字段}，refs 是 {连接 ID: 凭据引用}。"""
        self.settings.update('ai', {'providers': providers}, refs or {})

    def test_providers_expose_capabilities_without_secrets(self):
        self.configure(
            {'provider-text': {'name': '文本', 'protocol': PROTOCOL_OPENAI_CHAT,
                               'endpoint': 'https://api/v1', 'model': 'm'}},
            {'provider-text': 'key-text'})
        gateway = AiGateway(settings=self.settings, credentials=self.credentials)
        providers = gateway.providers()
        by_id = {p['id']: p for p in providers}
        # 新装时自带两条默认连接，用户再加一条：连接数量不固定。
        self.assertIn('provider-text', by_id)
        self.assertIn(CAPABILITY_TEXT_GENERATION, by_id['provider-text']['capabilities'])
        self.assertFalse(by_id['provider-text']['configured'], 'Core 里没有密钥时不能算已配置')
        self.assertNotIn('credentialRef', json.dumps(providers))

    def test_chat_requires_a_configured_connection(self):
        self.configure(
            {'provider-text': {'protocol': PROTOCOL_OPENAI_CHAT, 'endpoint': '', 'model': ''}})
        gateway = AiGateway(settings=self.settings, credentials=self.credentials)
        with self.assertRaises(AiError) as caught:
            gateway.chat('provider-text', [('user', 'x')])
        self.assertEqual(caught.exception.code, 'not_configured')

    def test_chat_refuses_a_provider_without_the_capability(self):
        self.configure(
            {'provider-classify': {'protocol': PROTOCOL_JEV_SYSTEMONE, 'endpoint': 'https://api',
                                  'model': 'm'}},
            {'provider-classify': 'key'})
        self.credentials.provide('key', 'secret')
        gateway = AiGateway(settings=self.settings, credentials=self.credentials)
        with self.assertRaises(AiError) as caught:
            gateway.chat('provider-classify', [('user', 'x')])
        self.assertEqual(caught.exception.code, 'not_configured')

    def test_probe_uses_the_minimal_protocol_request(self):
        self.configure(
            {'provider-text': {'protocol': PROTOCOL_OPENAI_CHAT, 'endpoint': 'https://api/v1', 'model': 'm'}},
            {'provider-text': 'key'})
        self.credentials.provide('key', 'secret')
        transport = FakeTransport({'/chat/completions': {
            'model': 'demo', 'choices': [{'message': {'content': 'ok'}}]}})
        gateway = AiGateway(settings=self.settings, credentials=self.credentials, transport=transport)
        outcome = gateway.test_connection('provider-text')
        self.assertTrue(outcome['ok'], outcome)
        self.assertEqual(len(transport.calls), 1, '探针只发一次请求')
        payload = transport.calls[0]['payload']
        self.assertEqual(payload['messages'], [{'role': 'user', 'content': '连接测试。'}])
        self.assertNotIn('候选', json.dumps(payload, ensure_ascii=False),
                         '探针不携带任何业务内容')

    def test_probe_reports_a_broken_connection_without_raising(self):
        self.configure(
            {'provider-text': {'protocol': PROTOCOL_OPENAI_CHAT, 'endpoint': 'https://api/v1', 'model': 'm'}},
            {'provider-text': 'key'})
        self.credentials.provide('key', 'secret')
        transport = FakeTransport({'/chat/completions': {'choices': []}})
        gateway = AiGateway(settings=self.settings, credentials=self.credentials, transport=transport)
        outcome = gateway.test_connection('provider-text')
        self.assertFalse(outcome['ok'])
        self.assertEqual(outcome['code'], 'invalid_response')


class DisabledProviderTests(unittest.TestCase):
    """BUG-106：停用的连接在调用边界就要被拒绝，不发出请求。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'ai.sqlite3'
        self.db = Database(self.path)
        self.settings = SettingsService(SettingsStore(self.db))
        self.credentials = CredentialBroker()
        self.credentials.provide('key', 'secret')
        self.transport = FakeTransport({'/chat/completions': {
            'model': 'demo', 'choices': [{'message': {'content': 'ok'}}]}})
        self.settings.update('ai', {'providers': {
            'provider-text': {'protocol': PROTOCOL_OPENAI_CHAT, 'endpoint': 'https://api/v1',
                              'model': 'm', 'enabled': False}}},
            {'provider-text': 'key'})

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def gateway(self, settings=None):
        return AiGateway(settings=settings or self.settings, credentials=self.credentials,
                         transport=self.transport)

    def test_disabled_provider_is_refused_before_any_request(self):
        gateway = self.gateway()
        with self.assertRaises(AiError) as caught:
            gateway.chat('provider-text', [('user', 'x')])
        self.assertEqual(caught.exception.code, 'not_configured')
        self.assertIn('停用', caught.exception.message)
        self.assertEqual(self.transport.calls, [], '停用的连接不能发出请求')
        # 适配器与探针是同一条边界：同样拒绝，同样不请求。
        with self.assertRaises(AiError):
            gateway.adapter('provider-text')
        outcome = gateway.test_connection('provider-text')
        self.assertFalse(outcome['ok'])
        self.assertIn('停用', outcome['message'])
        self.assertEqual(self.transport.calls, [], '探针也不能发出请求')

    def test_classify_is_refused_for_a_disabled_provider(self):
        self.settings.update('ai', {'providers': {
            'provider-classify': {'protocol': PROTOCOL_JEV_SYSTEMONE, 'endpoint': 'https://api',
                                  'model': 'm', 'enabled': False}}},
            {'provider-classify': 'key'})
        gateway = self.gateway()
        with self.assertRaises(AiError) as caught:
            gateway.classify('provider-classify', '内容', {'q': '是不是甲'})
        self.assertEqual(caught.exception.code, 'not_configured')
        self.assertEqual(self.transport.calls, [], '停用的连接不能发出请求')

    def test_disabled_state_survives_a_restart_and_enabling_restores_the_call(self):
        # 换一个设置服务（相当于重启）：读的是存档，停用状态还在。
        restarted = SettingsService(SettingsStore(self.db))
        gateway = self.gateway(restarted)
        with self.assertRaises(AiError):
            gateway.chat('provider-text', [('user', 'x')])
        self.assertEqual(self.transport.calls, [], '重启后停用的连接依然不能调用')
        # 重新启用：立刻可用，不需要重配地址、模型或密钥。
        self.settings.update('ai', {'providers': {'provider-text': {'enabled': True}}})
        gateway.chat('provider-text', [('user', 'x')])
        self.assertEqual(len(self.transport.calls), 1)


if __name__ == '__main__':
    unittest.main()
