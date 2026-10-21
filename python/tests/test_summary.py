"""M29 AI 总结的验收。

用隔离假传输做**真实 Core 业务检查**：请求发不发、发的是什么、结果怎么回来、
有没有落库、状态有没有被改。模型服从性不在这里下结论——那要真实模型与人来看。
"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.ai.contracts import AiError
from subscribe_flow.ai.gate import ProviderGate
from subscribe_flow.application.settings import SettingsService
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ChannelError, ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.settings import SettingsStore


class FakeTransport:
    """按 URL 返回预设响应，并记录收到的请求。"""

    def __init__(self, responses=None, error=None):
        self.responses = responses or {}
        self.error = error
        self.calls = []

    def post_json(self, url, payload, headers=None, timeout=None):
        self.calls.append({'url': url, 'payload': payload, 'headers': headers or {},
                            'timeout': timeout})
        if self.error is not None:
            raise self.error
        for suffix, body in self.responses.items():
            if url.endswith(suffix):
                return 200, body
        raise AiError('invalid_response', f'没有为 {url} 准备响应')


def chat_response(text='这是一段总结。'):
    return {'model': 'demo-model', 'choices': [{'message': {'content': text}}]}


def make_item(channel, external_id, title, summary, kind='article'):
    source = Source(channel=channel, kind='author', external_id=f'{external_id}-source',
                    name=f'{channel} 来源', url=f'https://example.invalid/{external_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind=kind, summary=summary,
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


class _SummaryFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'summary.sqlite3'
        self.transport = FakeTransport({'/chat/completions': chat_response()})
        self.core = Core(self.path, ai_transport=self.transport)
        self.repo = self.core.repository
        self.settings = self.core.settings
        self.credentials = self.core.credentials
        self.credentials.provide('provider-llm', 'sk-test')
        self.item_id = self.repo.save_manual(make_item(
            'zhihu', 'sum-1', '一篇讲检索的文章', '这是已保存的正文，讲了倒排索引怎么落地。'))['item_id']
        self.repo.save_manual(make_item('github', 'sum-2', '一个仓库', '这是仓库简介。', kind='repo'))

    def tearDown(self):
        self.core.database.close()
        self.core.lease.close()
        self.temp.cleanup()

    def configure(self, **policy):
        patch = {'enabled': True, 'providerId': 'provider-llm', 'length': 'brief',
                 'language': 'zh-CN'}
        patch.update(policy)
        return self.settings.update('summarization', patch)

    def set_provider(self, provider_id='provider-llm', **fields):
        fields.setdefault('protocol', 'openai_chat')
        fields.setdefault('endpoint', 'https://api.test.invalid/v1')
        fields.setdefault('model', 'demo-model')
        self.settings.update('ai', {'providers': {provider_id: fields}},
                             {provider_id: 'provider-llm'} if provider_id == 'provider-llm' else None)


class SummarySettingsTests(_SummaryFixture, unittest.TestCase):
    """总结策略的保存与版本。"""

    def test_provider_only_save_is_allowed(self):
        self.set_provider()
        self.settings.update('summarization', {'providerId': 'provider-llm'})
        self.assertEqual(self.settings.snapshot()['summarization']['providerId'], 'provider-llm')

    def test_length_only_save_is_allowed(self):
        self.settings.update('summarization', {'length': 'detailed'})
        snapshot = self.settings.snapshot()['summarization']
        self.assertEqual(snapshot['length'], 'detailed')
        self.assertEqual(snapshot['providerId'], None)

    def test_clearing_the_reference_is_explicit_null_and_survives(self):
        self.set_provider()
        self.configure()
        self.settings.update('summarization', {'providerId': None})
        self.assertIsNone(self.settings.snapshot()['summarization']['providerId'])
        # 无关保存不会把它复活。
        self.settings.update('priority', {'names': {'high': '今天看'}})
        self.assertIsNone(self.settings.snapshot()['summarization']['providerId'])

    def test_incompatible_provider_is_refused(self):
        self.settings.update('ai', {'providers': {'provider-jev': {
            'protocol': 'jev_systemone', 'endpoint': 'https://api.test.invalid', 'model': 'm'}}})
        with self.assertRaises(ChannelError):
            self.settings.update('summarization', {'providerId': 'provider-jev'})

    def test_unknown_provider_is_refused(self):
        with self.assertRaises(ChannelError):
            self.settings.update('summarization', {'providerId': 'provider-nope'})

    def test_summary_revision_moves_only_with_the_policy(self):
        before = self.settings.snapshot()['summarization']['revision']
        self.settings.update('summarization', {'length': 'detailed'})
        after = self.settings.snapshot()['summarization']['revision']
        self.assertEqual(after, before + 1, '总结策略变了要前进')
        # 无关保存不动它。
        self.settings.update('priority', {'names': {'high': '今天看'}})
        self.assertEqual(self.settings.snapshot()['summarization']['revision'], after)

    def test_summary_settings_do_not_move_the_tagging_revision(self):
        self.set_provider()
        tagging_before = self.settings.snapshot()['tagging']['revision']
        self.configure()
        self.assertEqual(self.settings.snapshot()['tagging']['revision'], tagging_before,
                         '改总结不动打标版本')

    def test_settings_survive_a_restart(self):
        self.set_provider()
        self.configure(length='detailed', language='original')
        reopened = SettingsService(SettingsStore(Database(self.path)))
        snapshot = reopened.snapshot()['summarization']
        self.assertEqual(snapshot['length'], 'detailed')
        self.assertEqual(snapshot['language'], 'original')
        self.assertEqual(snapshot['providerId'], 'provider-llm')


class SummaryDraftTests(_SummaryFixture, unittest.IsolatedAsyncioTestCase):
    """生成总结草稿的业务行为。"""

    def setUp(self):
        super().setUp()
        self.set_provider()
        self.configure()

    async def test_summary_is_not_generated_without_a_click(self):
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertTrue(result['ok'])
        self.assertEqual(len(self.transport.calls), 1, '只有用户点了才发请求')

    async def test_the_draft_carries_the_scope_and_versions(self):
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertTrue(result['ok'])
        self.assertEqual(result['summary'], '这是一段总结。')
        self.assertEqual(result['scope'], '正文')
        self.assertEqual(result['request_id'], 'req-1')
        self.assertEqual(result['item_id'], self.item_id)
        self.assertTrue(result['content_version'])
        self.assertEqual(result['config_version'],
                         self.settings.snapshot()['summarization']['revision'])
        self.assertFalse(result['input_truncated'])
        self.assertEqual(result['provider']['id'], 'provider-llm')

    async def test_the_prompt_follows_the_length_and_language(self):
        self.configure(length='detailed', language='zh-CN')
        await self.core.summary.draft(self.item_id, 'req-1')
        messages = self.transport.calls[0]['payload']['messages']
        text = '\n'.join(m['content'] for m in messages)
        self.assertIn('300 字', text)
        self.assertIn('用中文回答', text)
        self.assertIn('这是已保存的正文', text)
        self.assertIn('材料结束', text)
        # 输出预算要够放 300 个中文字。
        self.assertGreaterEqual(self.transport.calls[0]['payload']['max_tokens'], 800)
        # 简略时是一句话，预算更小。
        self.configure(length='brief')
        self.transport.calls.clear()
        await self.core.summary.draft(self.item_id, 'req-2')
        brief_text = '\n'.join(m['content'] for m in self.transport.calls[0]['payload']['messages'])
        self.assertIn('一句话', brief_text)
        self.assertLess(self.transport.calls[0]['payload']['max_tokens'], 800)

    async def test_original_language_keeps_the_source_language(self):
        self.configure(language='original')
        await self.core.summary.draft(self.item_id, 'req-1')
        text = '\n'.join(m['content'] for m in self.transport.calls[0]['payload']['messages'])
        self.assertIn('用原文的语言回答', text)

    async def test_truncated_input_is_reported(self):
        long_text = '正文' * 5000
        item_id = self.repo.save_manual(make_item('zhihu', 'sum-long', '长文', long_text))['item_id']
        result = await self.core.summary.draft(item_id, 'req-1')
        self.assertTrue(result['ok'])
        self.assertTrue(result['input_truncated'])
        self.assertLess(result['input_chars'], result['input_total_chars'])
        self.assertLessEqual(result['input_chars'], 6000)

    async def test_repository_description_is_reported_as_summary_scope(self):
        result = await self.core.summary.draft('github:feed:sum-2', 'req-1')
        self.assertTrue(result['ok'])
        self.assertEqual(result['scope'], '简介', '仓库只有简介，不能假装读过 README')

    async def test_text_too_short_is_refused(self):
        item_id = self.repo.save_manual(make_item('zhihu', 'sum-empty', '空内容', ''))['item_id']
        result = await self.core.summary.draft(item_id, 'req-1')
        self.assertFalse(result['ok'])
        self.assertEqual(result['code'], 'insufficient_text')
        self.assertEqual(self.transport.calls, [], '文本不足不外发')

    async def test_disabled_or_unconfigured_states_explain_themselves(self):
        self.settings.update('summarization', {'enabled': False})
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertEqual(result['code'], 'disabled')
        self.settings.update('summarization', {'enabled': True, 'providerId': None})
        result = await self.core.summary.draft(self.item_id, 'req-2')
        self.assertEqual(result['code'], 'not_configured')
        self.assertEqual(self.transport.calls, [], '没配置不外发')

    async def test_a_disabled_provider_is_refused_without_a_request(self):
        self.settings.update('ai', {'providers': {'provider-llm': {'enabled': False}}})
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertFalse(result['ok'])
        self.assertIn('停用', result['message'])
        self.assertEqual(self.transport.calls, [], '停用的连接不外发')

    async def test_a_missing_key_is_refused_without_a_request(self):
        # 清掉密钥（凭据引用置 null），连接因此不完整。
        self.settings.update('ai', {'providers': {'provider-llm': {'enabled': True}}},
                             {'provider-llm': None})
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertFalse(result['ok'])
        self.assertIn('API Key', result['message'])
        self.assertEqual(self.transport.calls, [])

    async def test_an_incompatible_provider_is_refused(self):
        # 先选中一条文本生成连接，再把它的协议改成候选分类：
        # 此时引用还在，但能力已经对不上——如实说不兼容，不外发。
        self.settings.update('ai', {'providers': {'provider-llm': {
            'protocol': 'jev_systemone', 'endpoint': 'https://api.test.invalid', 'model': 'm'}}})
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertEqual(result['code'], 'incompatible')
        self.assertEqual(self.transport.calls, [])

    def test_selecting_an_incompatible_provider_is_refused_at_save_time(self):
        self.settings.update('ai', {'providers': {'provider-jev': {
            'protocol': 'jev_systemone', 'endpoint': 'https://api.test.invalid', 'model': 'm'}}})
        with self.assertRaises(ChannelError):
            self.settings.update('summarization', {'providerId': 'provider-jev'})

    async def test_generation_never_persists_or_touches_the_content(self):
        before_note = self.core.notes.get(self.item_id)
        before_content = self.repo.get_content(self.item_id)
        await self.core.summary.draft(self.item_id, 'req-1')
        self.assertIsNone(self.core.notes.get(self.item_id), '生成不写笔记')
        self.assertEqual(before_note, None)
        after = self.repo.get_content(self.item_id)
        self.assertEqual(after['state'], before_content['state'], '不改处理状态')
        self.assertEqual(after['updated_at'], before_content['updated_at'])
        self.assertEqual(self.repo.tagging.summary()['total'], 0, '不产生打标任务')

    async def test_failures_are_reported_with_distinct_states(self):
        cases = [
            (AiError('auth_failed', '模型服务拒绝了当前密钥（HTTP 401）'), 'auth_failed'),
            (AiError('rate_limited', '模型服务触发了限流（HTTP 429）'), 'rate_limited'),
            (AiError('timeout', '读取模型响应超时'), 'timeout'),
        ]
        for error, code in cases:
            self.transport.error = error
            result = await self.core.summary.draft(self.item_id, 'req-1')
            self.assertFalse(result['ok'])
            self.assertEqual(result['code'], code)
            self.assertTrue(result['message'])
        # 空响应：模型返回了但没有文字。
        self.transport.error = None
        self.transport.responses = {'/chat/completions': {'model': 'demo', 'choices': []}}
        result = await self.core.summary.draft(self.item_id, 'req-1')
        self.assertEqual(result['code'], 'empty_response')

    async def test_the_provider_gate_is_shared_with_the_tagging(self):
        self.assertIsInstance(self.core.ai.gate, ProviderGate)
        adapter = self.core.ai.adapter('provider-llm')
        self.assertIs(adapter.gate, self.core.ai.gate, '打标与总结共用同一个闸门')

    async def test_the_call_runs_off_the_event_loop(self):
        # 业务调用在执行器里跑：事件循环不会被网络请求卡住。
        task = asyncio.ensure_future(self.core.summary.draft(self.item_id, 'req-1'))
        await asyncio.sleep(0)
        self.assertFalse(task.done(), '请求还在路上时事件循环仍然可以调度')
        result = await task
        self.assertTrue(result['ok'])


if __name__ == '__main__':
    unittest.main()
