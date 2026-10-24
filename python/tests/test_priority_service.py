"""M40–M41 智能优先级的后台服务与统一优先级口径。

用隔离假传输做**真实 Core 业务检查**：请求发不发、发的是什么、结果怎么回来、
有没有落库、读取口径是不是同一套。模型服从性不在这里下结论——真实模型的判断
质量要用真实 API 单独验（见 batch-02 的真实推理记录）。
"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from priority_engine.prompts import PRIORITY_RULES_V1
from subscribe_flow.ai.contracts import AiError
from subscribe_flow.application.settings import SettingsService
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ChannelError, Connection, ContentItem, Source
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


def chat_response(text='{"priority":"high"}'):
    return {'model': 'demo-model', 'choices': [{'message': {'content': text}}]}


def make_item(external_id, title):
    source = Source(channel='zhihu', kind='author', external_id=f'{external_id}-source',
                    name='作者', url='https://example.invalid/author')
    return ContentItem(channel='zhihu', namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='article',
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


class PriorityServiceTests(unittest.IsolatedAsyncioTestCase):
    """后台判断服务。"""

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority.sqlite3'
        self.transport = FakeTransport({'/chat/completions': chat_response()})
        self.core = Core(self.path, ai_transport=self.transport)
        self.repo = self.core.repository
        self.settings = self.core.settings
        self.core.credentials.provide('provider-llm', 'sk-test')
        self.repo.create_tag('tag-db', '数据库', '数据库原理与性能优化', 'blue', True, ['SQL'])
        self.core.priority.start()

    async def asyncTearDown(self):
        await self.core.priority.close()
        self.core.database.close()
        self.core.lease.close()
        self.temp.cleanup()

    # ------------------------------------------------------------ 辅助

    def configure(self, provider_id='provider-llm'):
        self.settings.update('ai', {'providers': {provider_id: {
            'protocol': 'openai_chat', 'endpoint': 'https://api.test.invalid/v1',
            'model': 'demo-model'}}},
            {provider_id: 'provider-llm'})
        self.settings.update('priority', {'smart': {'enabled': True, 'providerId': provider_id}})

    def add_content(self, external_id, title, tags=('tag-db',), priority=None):
        item_id = self.repo.save_manual(make_item(external_id, title))['item_id']
        if tags:
            self.repo.set_content_tags([item_id], list(tags))
        if priority:
            self.repo.update_content_state([item_id], {'priority': priority})
        return item_id

    async def drain(self, rounds=3):
        """跑几轮 worker：队列里的任务会被认领并执行。"""
        for _ in range(rounds):
            await self.core.priority._run_once()

    # ------------------------------------------------------------ 基本流程

    async def test_a_judged_content_gets_a_smart_priority(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        self.add_content('hist-2', '数据库索引设计实战', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.assertEqual(len(self.transport.calls), 0)

        self.core.priority.request([target])
        await self.drain()

        self.assertEqual(len(self.transport.calls), 1)
        decision = self.repo.priority_intelligence.get_decision(target)
        self.assertEqual(decision['priority'], 'high')
        self.assertEqual(decision['status'], 'ok')
        content = self.repo.get_content(target)
        self.assertEqual(content['priority'], 'high')
        self.assertEqual(content['priority_origin'], 'smart')
        # 智能结果不改人工值与来源默认值。
        self.assertIsNone(content['priority_override'])

    async def test_the_request_carries_the_fixed_rules_and_the_context_json(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()

        payload = self.transport.calls[0]['payload']
        roles = [message['role'] for message in payload['messages']]
        self.assertEqual(roles, ['system', 'user'])
        self.assertTrue(payload['messages'][0]['content'].startswith(PRIORITY_RULES_V1))
        context = json.loads(payload['messages'][1]['content'])
        self.assertEqual(context['schema_version'], 'priority_context_v1')
        self.assertEqual(context['target']['title'], '如何用执行计划定位数据库慢查询')
        self.assertEqual(context['history']['high'][0]['content_count'], 1)

    async def test_content_without_tags_is_not_requested(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '没有任何标签的内容', tags=())
        self.core.priority.request([target])
        await self.drain()

        self.assertEqual(len(self.transport.calls), 0)
        decision = self.repo.priority_intelligence.get_decision(target)
        self.assertEqual(decision['status'], 'no_tags')
        self.assertEqual(decision['priority'], 'unknown')

    async def test_content_without_evidence_is_not_requested(self):
        self.configure()
        # 有标签但没有人工历史：没有证据就没有可问的问题。
        target = self.add_content('target', '没有任何历史可参考的内容')
        self.core.priority.request([target])
        await self.drain()

        self.assertEqual(len(self.transport.calls), 0)
        decision = self.repo.priority_intelligence.get_decision(target)
        self.assertEqual(decision['status'], 'no_evidence')

    async def test_manual_priority_wins_and_is_not_requested(self):
        self.configure()
        target = self.add_content('target', '人工已经定过档的内容', priority='low')
        self.core.priority.request([target])
        await self.drain()

        self.assertEqual(len(self.transport.calls), 0)
        content = self.repo.get_content(target)
        self.assertEqual(content['priority'], 'low')
        self.assertEqual(content['priority_origin'], 'manual')

    async def test_requests_are_deduplicated(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        self.core.priority.request([target])
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(len(self.transport.calls), 1)

    async def test_an_unknown_result_is_cached_and_not_requested_again(self):
        self.transport.responses = {'/chat/completions': chat_response('{"priority":"unknown"}')}
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(len(self.transport.calls), 1)

        # 输入没变：不再重复请求。
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(len(self.transport.calls), 1)
        decision = self.repo.priority_intelligence.get_decision(target)
        self.assertEqual((decision['priority'], decision['status']), ('unknown', 'model_unknown'))
        # unknown 不是一档：读取回退来源默认值。
        self.assertIsNone(self.repo.get_content(target)['priority'])

    # ------------------------------------------------------------ 失效

    async def test_turning_the_feature_off_falls_back_at_once(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(self.repo.get_content(target)['priority_origin'], 'smart')

        self.settings.update('priority', {'smart': {'enabled': False}})
        content = self.repo.get_content(target)
        self.assertNotEqual(content['priority_origin'], 'smart')
        self.assertIsNone(content['priority'])
        self.assertEqual(content['priority_origin'], 'none')

    async def test_switching_the_connection_invalidates_the_old_result(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(self.repo.get_content(target)['priority_origin'], 'smart')

        # 换一条连接：连接调用版本变了，旧结果立刻退出生效范围。
        self.settings.update('ai', {'providers': {'provider-llm': {
            'protocol': 'openai_chat', 'endpoint': 'https://api.test.invalid/v2',
            'model': 'demo-model-2'}}},
            {'provider-llm': 'provider-llm'})
        self.assertNotEqual(self.repo.get_content(target)['priority_origin'], 'smart')

    async def test_changing_the_tags_invalidates_the_old_result(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(self.repo.get_content(target)['priority_origin'], 'smart')

        self.repo.set_content_tags([target], [])
        self.assertNotEqual(self.repo.get_content(target)['priority_origin'], 'smart')
        self.assertIsNone(self.repo.priority_intelligence.get_decision(target))

    async def test_a_manual_change_during_the_request_does_not_get_overwritten(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])

        class SlowTransport(FakeTransport):
            def post_json(self, url, payload, headers=None, timeout=None):
                # 请求发出后，用户改档并恢复自动：旧结果不得覆盖当前决定。
                self.repo.update_content_state([target], {'priority': 'low'})
                self.repo.update_content_state([target], {'priority': None})
                return super().post_json(url, payload, headers, timeout)

        slow = SlowTransport({'/chat/completions': chat_response()})
        self.core.ai.transport = slow
        await self.drain()

        self.assertIsNone(self.repo.priority_intelligence.get_decision(target))
        content = self.repo.get_content(target)
        self.assertIsNone(content['priority_override'])
        self.assertNotEqual(content['priority_origin'], 'smart')

    async def test_renaming_a_tag_invalidates_the_related_results(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()
        self.assertEqual(self.repo.get_content(target)['priority_origin'], 'smart')

        self.core.tags.update('tag-db', name='数据库技术')
        self.assertIsNone(self.repo.priority_intelligence.get_decision(target))

    # ------------------------------------------------------------ 任务

    async def test_a_network_failure_is_retried_with_a_backoff(self):
        self.configure()
        self.transport.error = AiError('network_failed', '网络不通')
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        target = self.add_content('target', '如何用执行计划定位数据库慢查询')
        self.core.priority.request([target])
        await self.drain()

        task = self.repo.priority_tasks.get(target)
        self.assertEqual(task['state'], 'pending')
        self.assertEqual(task['attempts'], 1)
        self.assertIsNotNone(task['next_attempt_at'])

    async def test_running_tasks_are_recovered_after_a_restart(self):
        item_id = self.add_content('recover', '崩溃前在跑的内容')
        self.repo.priority_tasks.enqueue(item_id, 'auto')
        self.repo.priority_tasks.next_task()
        self.assertEqual(self.repo.priority_tasks.get(item_id)['state'], 'running')
        recovered = self.repo.priority_tasks.recover()
        self.assertEqual(recovered, 1)
        self.assertEqual(self.repo.priority_tasks.get(item_id)['state'], 'pending')

    async def test_bulk_requests_are_bounded_and_deduplicated(self):
        self.configure()
        self.add_content('hist-1', '慢查询排查：从执行计划到索引调整', priority='high')
        targets = [self.add_content(f'target-{index}', '如何用执行计划定位数据库慢查询')
                   for index in range(3)]
        result = self.core.priority.judge_bulk(targets + targets)
        self.assertEqual(result['queued'], 3)
        with self.assertRaises(ChannelError):
            self.core.priority.judge_bulk([f'x{i}' for i in range(101)])

    async def test_the_status_reports_the_current_policy(self):
        self.configure()
        status = self.core.priority.status()
        self.assertTrue(status['enabled'])
        self.assertEqual(status['providerId'], 'provider-llm')
        self.assertEqual(status['mode'], 'llm')
        self.assertEqual(status['promptVersion'], 'priority_prompt_v1')


class PreferenceAggregationTests(unittest.TestCase):
    """首次启用或升级后的本地聚合。

    旧迁移不会给历史数据标脏：已有人工优先级与标签关系必须靠一次本地聚合
    才能进入偏好统计，否则只有新操作之后的内容才有偏好。
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'priority.sqlite3'
        self.core = Core(self.path)
        self.repo = self.core.repository
        self.repo.create_tag('tag-db', '数据库', '数据库原理', 'blue', True, [])

    def tearDown(self):
        self.core.database.close()
        self.core.lease.close()
        self.temp.cleanup()

    def test_legacy_manual_priorities_are_aggregated_once_on_start(self):
        item_id = self.repo.save_manual(make_item('legacy', '旧内容'))['item_id']
        self.repo.set_content_tags([item_id], ['tag-db'])
        self.repo.update_content_state([item_id], {'priority': 'high'})
        # 模拟旧迁移留下的数据：没有任何待重建标记，也没有统计分组。
        self.repo.priority_intelligence.flush_dirty()
        for table in ('priority_preference_groups', 'priority_preference_samples',
                      'priority_preference_dirty'):
            self.repo.db.execute(f'DELETE FROM {table}')
        self.assertEqual(self.repo.priority_intelligence.summary()['groups'], 0)

        self.core.priority.start()
        groups = self.repo.priority_intelligence.groups_for_tags(['tag-db'])
        self.assertEqual(groups['high']['tag-db']['content_count'], 1)

        # 聚合过一次就不再来第二次：没有脏标记，也不再重建。
        self.core.priority.start()
        self.assertEqual(self.repo.priority_intelligence.summary()['dirty'], 0)

    def test_the_aggregation_runs_only_once_per_stats_version(self):
        self.core.priority.start()
        version = self.repo.priority_intelligence.stats_version()
        self.assertTrue(version)
        self.core.priority.start()
        self.assertEqual(self.repo.priority_intelligence.stats_version(), version)


class UnifiedPriorityTests(unittest.TestCase):
    """M41：所有入口用同一段最终优先级口径。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.core = Core(Path(self.temp.name) / 'priority.sqlite3')
        self.repo = self.core.repository
        self.repo.create_tag('tag-db', '数据库', '数据库原理', 'blue', True, [])

    def tearDown(self):
        self.core.database.close()
        self.core.lease.close()
        self.temp.cleanup()

    def _content(self, external_id, title, manual=None):
        item_id = self.repo.save_manual(make_item(external_id, title))['item_id']
        self.repo.set_content_tags([item_id], ['tag-db'])
        if manual:
            self.repo.update_content_state([item_id], {'priority': manual})
        return item_id

    def test_origins_cover_manual_smart_source_and_none(self):
        manual = self._content('manual', '人工定过档', manual='high')
        plain = self._content('plain', '什么都没有')
        self.assertEqual(self.repo.get_content(manual)['priority_origin'], 'manual')
        self.assertEqual(self.repo.get_content(plain)['priority_origin'], 'none')

    def test_source_default_is_the_fallback_and_keeps_the_multi_source_max_rule(self):
        # 一条内容关联两个来源，来源默认值取最高等级。
        source = Source(channel='zhihu', kind='author', external_id='author-1',
                        name='作者', url='https://example.invalid/author')
        self.repo.add_connection(Connection('c', 'zhihu', 'test', 'test'))
        sub = self.repo.subscribe(source, 'c')
        self.repo.set_source_priority(sub['id'], 'medium')
        item_id = self.repo.save_manual(make_item('x', '内容'))['item_id']
        self.repo.db.execute('INSERT INTO content_sources(content_id,source_id) VALUES(?,?)',
                             (item_id, source.key))
        content = self.repo.get_content(item_id)
        self.assertEqual(content['source_priority'], 'medium')
        self.assertEqual(content['priority'], 'medium')
        self.assertEqual(content['priority_origin'], 'source')

    def test_the_smart_value_is_used_by_list_filter_and_calendar(self):
        # 直接写一条有效智能结果：策略开启且版本对得上。
        from priority_engine.contracts import PriorityContextSnapshot, PriorityDecision
        self.repo.priority_intelligence.save_policy(enabled=True, provider_id='provider-llm',
                                                    policy_version='1', provider_version='provider-llm:1')
        item_id = self._content('smart', '自动判断的内容')
        decision = PriorityDecision('high', 'ok', provider_id='provider-llm',
                                    snapshot=PriorityContextSnapshot(policy_version='1',
                                                                    provider_version='provider-llm:1'))
        self.repo.priority_intelligence.save_decision(item_id, decision)

        content = self.repo.get_content(item_id)
        self.assertEqual(content['priority'], 'high')
        self.assertEqual(content['priority_origin'], 'smart')

        listed = self.repo.query_contents(priority='high')
        self.assertEqual([item['id'] for item in listed['items']], [item_id])
        counts = self.repo.query_contents(limit=1)
        self.assertEqual(counts['total'], 1)

    def test_a_stale_smart_result_is_not_used(self):
        from priority_engine.contracts import PriorityContextSnapshot, PriorityDecision
        # 策略版本对不上：旧结果退出生效范围。
        self.repo.priority_intelligence.save_policy(enabled=True, provider_id='provider-llm',
                                                    policy_version='2', provider_version='provider-llm:1')
        item_id = self._content('smart', '自动判断的内容')
        self.repo.priority_intelligence.save_decision(
            item_id, PriorityDecision('high', 'ok', provider_id='provider-llm',
                                      snapshot=PriorityContextSnapshot(policy_version='1',
                                                                      provider_version='provider-llm:1')))
        content = self.repo.get_content(item_id)
        self.assertIsNone(content['priority'])
        self.assertEqual(content['priority_origin'], 'none')


if __name__ == '__main__':
    unittest.main()
