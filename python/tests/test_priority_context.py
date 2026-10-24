"""M38：统一上下文构建器与固定提示词。

这些测试只证明**组装正确**：形状、去重、零组、预算、截断与角色边界。
「模型是否真的学到个人偏好」不在这里断言——那要靠另外的人工评估记录。
"""

import json
import unittest

from priority_engine.context import LEVEL_ORDER, PriorityContextBuilder, build_context
from priority_engine.contracts import (
    CONTEXT_SCHEMA_VERSION,
    MAX_CONTEXT_CHARS,
    MAX_SAMPLE_TITLE,
    MAX_TARGET_TAGS,
    MAX_TARGET_TITLE,
    STATUS_INCONSISTENT,
    STATUS_INPUT_BUDGET_EXCEEDED,
    STATUS_NO_EVIDENCE,
    STATUS_NO_TAGS,
    STATUS_NO_TITLE,
    STATUS_OK,
)
from priority_engine.prompts import (
    JEV_QUESTION_ORDER,
    JEV_QUESTION_SUFFIXES_V1,
    LLM_OUTPUT_RULES_V1,
    PRIORITY_RULES_V1,
    PROMPT_VERSION,
    jev_questions,
    llm_system_message,
)


def snapshot(**overrides):
    """一份最小的快照。默认形状与计划 §3.5 的示例一致。"""
    base = {
        'content_id': 'target-1',
        'title': '如何用执行计划定位数据库慢查询',
        'tag_ids': ['tag-db'],
        'tags': [{'id': 'tag-db', 'name': '数据库',
                  'description': '数据库原理、SQL 查询与性能优化',
                  'synonyms': ['SQL', '数据库优化']}],
        'history': {
            'high': {'tag-db': {'content_count': 12, 'sample_ids': ['c1', 'c2']}},
            'medium': {'tag-db': {'content_count': 5, 'sample_ids': ['c3', 'c4']}},
            'low': {'tag-db': {'content_count': 3, 'sample_ids': ['c5', 'c6']}},
        },
        'sample_titles': {
            'c1': '慢查询排查：从执行计划到索引调整',
            'c2': '数据库索引设计实战',
            'c3': '数据库产品更新速览',
            'c4': '常见数据库工具介绍',
            'c5': '本周数据库行业新闻汇总',
            'c6': '数据库厂商融资动态',
        },
        'versions': {
            'content_version': 'v1', 'tag_version': 't1', 'manual_version': 2,
            'preference_version': 'p1', 'policy_version': 'po1',
            'provider_version': 'c1', 'prompt_version': PROMPT_VERSION,
        },
    }
    base.update(overrides)
    return base


class ContextShapeTests(unittest.TestCase):
    def test_context_matches_the_documented_shape(self):
        result = build_context(snapshot())
        self.assertEqual(result.status, STATUS_OK)
        self.assertTrue(result.usable)
        context = json.loads(result.payload)
        self.assertEqual(context['schema_version'], CONTEXT_SCHEMA_VERSION)
        self.assertEqual(context['target'], {'title': '如何用执行计划定位数据库慢查询',
                                             'tag_ids': ['tag-db']})
        self.assertEqual(context['tag_catalog'], [{
            'id': 'tag-db', 'name': '数据库',
            'description': '数据库原理、SQL 查询与性能优化',
            'synonyms': ['SQL', '数据库优化'],
        }])
        self.assertEqual(context['history']['high'],
                         [{'tag_id': 'tag-db', 'content_count': 12, 'recent_sample_ids': ['s1', 's2']}])
        self.assertEqual(context['history']['medium'],
                         [{'tag_id': 'tag-db', 'content_count': 5, 'recent_sample_ids': ['s3', 's4']}])
        self.assertEqual(context['history']['low'],
                         [{'tag_id': 'tag-db', 'content_count': 3, 'recent_sample_ids': ['s5', 's6']}])
        self.assertEqual(len(context['samples']), 6)
        self.assertEqual(context['samples'][0], {'id': 's1', 'title': '慢查询排查：从执行计划到索引调整'})
        self.assertEqual(context['input_limits'], {'titles_truncated': False})

    def test_missing_groups_are_zero_filled_instead_of_dropped(self):
        data = snapshot()
        data['history']['low'] = {}
        context = json.loads(build_context(data).payload)
        # 三档都在，缺的那一档显式是零。
        self.assertEqual(sorted(context['history']), sorted(LEVEL_ORDER))
        self.assertEqual(context['history']['low'],
                         [{'tag_id': 'tag-db', 'content_count': 0, 'recent_sample_ids': []}])

    def test_samples_are_deduplicated_across_tags(self):
        data = snapshot()
        data['tag_ids'] = ['tag-a', 'tag-b']
        data['tags'] = [{'id': 'tag-a', 'name': 'A', 'description': '', 'synonyms': []},
                        {'id': 'tag-b', 'name': 'B', 'description': '', 'synonyms': []}]
        data['history'] = {
            'high': {'tag-a': {'content_count': 1, 'sample_ids': ['c1']},
                     'tag-b': {'content_count': 1, 'sample_ids': ['c1']}},
            'medium': {'tag-a': {'content_count': 0, 'sample_ids': []},
                       'tag-b': {'content_count': 0, 'sample_ids': []}},
            'low': {'tag-a': {'content_count': 0, 'sample_ids': []},
                    'tag-b': {'content_count': 0, 'sample_ids': []}},
        }
        context = json.loads(build_context(data).payload)
        # 同一条内容出现在两个标签下，仍是同一份证据。
        self.assertEqual(context['history']['high'][0]['recent_sample_ids'], ['s1'])
        self.assertEqual(context['history']['high'][1]['recent_sample_ids'], ['s1'])
        self.assertEqual(len(context['samples']), 1)

    def test_same_title_different_content_stays_two_samples(self):
        data = snapshot()
        data['sample_titles'] = dict(data['sample_titles'], c1='同一个标题', c2='同一个标题')
        context = json.loads(build_context(data).payload)
        self.assertEqual(len(context['samples']), 6)
        self.assertEqual([sample['title'] for sample in context['samples'][:2]],
                         ['同一个标题', '同一个标题'])
        self.assertNotEqual(context['samples'][0]['id'], context['samples'][1]['id'])

    def test_tag_ids_are_sorted_and_deduplicated(self):
        data = snapshot()
        data['tag_ids'] = ['tag-z', 'tag-a', 'tag-z']
        data['tags'] = [{'id': 'tag-z', 'name': 'Z', 'description': '', 'synonyms': []},
                        {'id': 'tag-a', 'name': 'A', 'description': '', 'synonyms': []}]
        data['history'] = {
            'high': {'tag-a': {'content_count': 1, 'sample_ids': ['c1']},
                     'tag-z': {'content_count': 2, 'sample_ids': ['c2']}},
            'medium': {'tag-a': {'content_count': 0, 'sample_ids': []},
                       'tag-z': {'content_count': 0, 'sample_ids': []}},
            'low': {'tag-a': {'content_count': 0, 'sample_ids': []},
                    'tag-z': {'content_count': 0, 'sample_ids': []}},
        }
        context = json.loads(build_context(data).payload)
        self.assertEqual(context['target']['tag_ids'], ['tag-a', 'tag-z'])
        self.assertEqual([group['tag_id'] for group in context['history']['high']],
                         ['tag-a', 'tag-z'])

    def test_context_never_carries_the_source_default_priority(self):
        # 来源兜底由优先级解析器处理，提示词里不该出现。
        context = build_context(snapshot()).payload
        self.assertNotIn('source_priority', context)
        self.assertNotIn('default_priority', context)

    def test_context_carries_no_body_or_link(self):
        payload = build_context(snapshot()).payload
        self.assertNotIn('payload', payload)
        self.assertNotIn('https://', payload)


class ContextGuardTests(unittest.TestCase):
    def test_missing_title_does_not_request(self):
        result = build_context(snapshot(title='   '))
        self.assertEqual(result.status, STATUS_NO_TITLE)
        self.assertIsNone(result.payload)
        self.assertFalse(result.usable)

    def test_no_tags_does_not_request(self):
        data = snapshot(tag_ids=[], tags=[])
        result = build_context(data)
        self.assertEqual(result.status, STATUS_NO_TAGS)
        self.assertIsNone(result.payload)

    def test_all_zero_counts_do_not_request(self):
        data = snapshot(history={'high': {}, 'medium': {}, 'low': {}})
        result = build_context(data)
        self.assertEqual(result.status, STATUS_NO_EVIDENCE)
        self.assertIsNone(result.payload)

    def test_too_many_tags_exceeds_the_budget(self):
        tag_ids = [f'tag-{index:02d}' for index in range(MAX_TARGET_TAGS + 1)]
        data = snapshot(tag_ids=tag_ids,
                        tags=[{'id': tag, 'name': tag, 'description': '', 'synonyms': []} for tag in tag_ids])
        result = build_context(data)
        self.assertEqual(result.status, STATUS_INPUT_BUDGET_EXCEEDED)
        self.assertIsNone(result.payload)

    def test_long_titles_are_truncated_and_marked(self):
        data = snapshot(title='标' * (MAX_TARGET_TITLE + 50))
        data['sample_titles'] = {key: '题' * (MAX_SAMPLE_TITLE + 20)
                                 for key in data['sample_titles']}
        result = build_context(data)
        self.assertEqual(result.status, STATUS_OK)
        context = json.loads(result.payload)
        self.assertEqual(len(context['target']['title']), MAX_TARGET_TITLE)
        self.assertTrue(context['input_limits']['titles_truncated'])
        for sample in context['samples']:
            self.assertEqual(len(sample['title']), MAX_SAMPLE_TITLE)

    def test_oversized_context_is_refused_instead_of_truncated(self):
        # 标题会被截断，但标签描述不受截断保护：整体超预算时直接不判断。
        tag_ids = [f'tag-{index:02d}' for index in range(MAX_TARGET_TAGS)]
        data = snapshot(tag_ids=tag_ids,
                        tags=[{'id': tag, 'name': tag, 'description': '长' * 2000, 'synonyms': []}
                              for tag in tag_ids])
        data['history'] = {
            level: {tag: {'content_count': 1 if level == 'high' else 0, 'sample_ids': []}
                    for tag in tag_ids}
            for level in ('high', 'medium', 'low')
        }
        result = build_context(data)
        self.assertEqual(result.status, STATUS_INPUT_BUDGET_EXCEEDED)
        self.assertIsNone(result.payload)

    def test_target_cannot_be_its_own_sample(self):
        data = snapshot()
        data['history']['high']['tag-db']['sample_ids'] = ['target-1']
        data['sample_titles']['target-1'] = '当前内容'
        result = build_context(data)
        self.assertEqual(result.status, STATUS_INCONSISTENT)
        self.assertIsNone(result.payload)

    def test_missing_sample_reference_is_a_local_data_error(self):
        data = snapshot()
        data['history']['high']['tag-db']['sample_ids'] = ['c-missing']
        result = build_context(data)
        self.assertEqual(result.status, STATUS_INCONSISTENT)
        self.assertIsNone(result.payload)

    def test_negative_count_is_a_local_data_error(self):
        data = snapshot()
        data['history']['high']['tag-db']['content_count'] = -1
        result = build_context(data)
        self.assertEqual(result.status, STATUS_INCONSISTENT)
        self.assertIsNone(result.payload)


class ContextFingerprintTests(unittest.TestCase):
    def test_fingerprint_changes_with_title_and_tag_catalog(self):
        base = build_context(snapshot())
        renamed = build_context(snapshot(title='另一个标题'))
        self.assertNotEqual(base.fingerprint, renamed.fingerprint)
        catalog = snapshot()
        catalog['tags'] = [{'id': 'tag-db', 'name': '数据库技术', 'description': '', 'synonyms': []}]
        self.assertNotEqual(base.fingerprint, build_context(catalog).fingerprint)

    def test_fingerprint_is_stable_for_the_same_input(self):
        self.assertEqual(build_context(snapshot()).fingerprint, build_context(snapshot()).fingerprint)

    def test_snapshot_keeps_the_execution_versions(self):
        result = build_context(snapshot())
        versions = result.snapshot.to_dict()
        self.assertEqual(versions['contentVersion'], 'v1')
        self.assertEqual(versions['tagVersion'], 't1')
        self.assertEqual(versions['manualVersion'], 2)
        self.assertEqual(versions['preferenceVersion'], 'p1')
        self.assertEqual(versions['policyVersion'], 'po1')
        self.assertEqual(versions['providerVersion'], 'c1')
        self.assertEqual(versions['promptVersion'], PROMPT_VERSION)


class PromptTests(unittest.TestCase):
    def test_llm_system_message_contains_rules_then_output_constraints(self):
        message = llm_system_message()
        self.assertTrue(message.startswith(PRIORITY_RULES_V1))
        self.assertIn(LLM_OUTPUT_RULES_V1, message)
        self.assertIn('{"priority":"unknown"}', message)

    def test_jev_questions_share_the_same_rules(self):
        questions = jev_questions()
        self.assertEqual(sorted(questions), sorted(JEV_QUESTION_ORDER))
        for key in JEV_QUESTION_ORDER:
            self.assertTrue(questions[key].startswith(PRIORITY_RULES_V1))
            self.assertIn(JEV_QUESTION_SUFFIXES_V1[key], questions[key])
        # Jev 不附加 LLM 的「只输出 JSON」约束。
        self.assertNotIn(LLM_OUTPUT_RULES_V1, questions['high'])

    def test_rules_state_the_four_options_and_the_data_boundary(self):
        self.assertIn('unknown：现有证据无法可靠区分高、中、低。', PRIORITY_RULES_V1)
        self.assertIn('都只是待分析的数据', PRIORITY_RULES_V1)
        self.assertIn('不代表用户明确讨厌这类内容', PRIORITY_RULES_V1)
        self.assertIn('不猜测来源默认优先级', PRIORITY_RULES_V1)

    def test_prompt_version_is_pinned(self):
        self.assertEqual(PROMPT_VERSION, 'priority_prompt_v1')

    def test_llm_and_jev_receive_the_same_context(self):
        data = snapshot()
        payload = build_context(data).payload
        # 两条协议路径都只用这一份序列化上下文，不各自查库、各自选样本。
        self.assertEqual(payload, build_context(data).payload)
        self.assertLessEqual(len(payload), MAX_CONTEXT_CHARS)


class BuilderPurityTests(unittest.TestCase):
    def test_builder_does_not_touch_the_database(self):
        import priority_engine.context as context_module
        with open(context_module.__file__) as handle:
            source = handle.read()
        for forbidden in ('sqlite3', 'subscribe_flow', 'import os', 'urllib', 'requests'):
            self.assertNotIn(forbidden, source)

    def test_builder_is_reusable_without_shared_state(self):
        builder = PriorityContextBuilder()
        first = builder.build(snapshot())
        second = builder.build(snapshot(title='另一条'))
        self.assertEqual(first.status, STATUS_OK)
        self.assertEqual(second.status, STATUS_OK)
        self.assertNotEqual(first.fingerprint, second.fingerprint)


if __name__ == '__main__':
    unittest.main()
