"""M39 优先级判断的解析与收敛。

这些是纯函数测试：不连网络、不碰数据库。模型服从性不在这里下结论——
真实模型的判断质量要用真实 API 单独验（见 batch-02 的真实推理记录）。
"""

import unittest

from priority_engine.inference import (
    JEV_ACCEPT_THRESHOLD,
    JEV_MIN_MARGIN,
    PriorityInference,
    parse_priority_json,
    resolve_jev_priority,
)
from priority_engine.prompts import (
    JEV_QUESTION_ORDER,
    PRIORITY_RULES_V1,
    PROMPT_VERSION,
    jev_questions,
    llm_system_message,
)


class ParsePriorityJsonTests(unittest.TestCase):
    def test_valid_object_gives_a_level(self):
        self.assertEqual(parse_priority_json('{"priority":"high"}'), ('high', 'ok'))
        self.assertEqual(parse_priority_json('{"priority":"medium"}'), ('medium', 'ok'))
        self.assertEqual(parse_priority_json('{"priority":"low"}'), ('low', 'ok'))
        self.assertEqual(parse_priority_json('  {"priority":"low"}\n'), ('low', 'ok'))

    def test_unknown_is_a_valid_business_result(self):
        # 模型明确说无法判断：业务结果是 unknown，状态是 model_unknown。
        # 它和「协议失败」必须分开。
        self.assertEqual(parse_priority_json('{"priority":"unknown"}'), ('unknown', 'model_unknown'))

    def test_extra_fields_are_rejected(self):
        self.assertEqual(parse_priority_json('{"priority":"high","reason":"因为"}')[1], 'invalid_response')

    def test_duplicate_keys_are_rejected(self):
        self.assertEqual(parse_priority_json('{"priority":"high","priority":"low"}')[1], 'invalid_response')

    def test_wrong_types_are_rejected(self):
        for text in ('{"priority":true}', '{"priority":null}', '{"priority":1}', '{"priority":["high"]}',
                     '{"priority":{"value":"high"}}'):
            self.assertEqual(parse_priority_json(text), ('unknown', 'invalid_response'), text)

    def test_illegal_enum_is_rejected(self):
        for text in ('{"priority":"HIGH"}', '{"priority":"urgent"}', '{"priority":""}',
                     '{"priority":"中"}'):
            self.assertEqual(parse_priority_json(text), ('unknown', 'invalid_response'), text)

    def test_non_json_is_rejected(self):
        # 代码围栏属于传输层包装，单独在「剥离」那组用例里断言。
        for text in ('', '   ', 'not json', 'null', '[]', '"high"', 'high'):
            self.assertEqual(parse_priority_json(text), ('unknown', 'invalid_response'), text)

    def test_truncated_output_is_not_guessed(self):
        # 截断的输出不能猜成某一档。
        self.assertEqual(parse_priority_json('{"priority":"hi')[1], 'invalid_response')
        self.assertEqual(parse_priority_json('{"priority"')[1], 'invalid_response')

    def test_thinking_blocks_and_code_fences_are_unwrapped(self):
        # 推理型模型会先给一段思考再给 JSON；判断规则要求的是 JSON 对象，
        # 思考块与代码围栏只是传输层的包装。
        self.assertEqual(parse_priority_json('<think>先想想</think>{"priority":"high"}'),
                         ('high', 'ok'))
        self.assertEqual(parse_priority_json('```json\n{"priority":"low"}\n```'), ('low', 'ok'))
        self.assertEqual(parse_priority_json('<think>想想</think>\n\n```json\n{"priority":"low"}\n```'),
                         ('low', 'ok'))
        # 思考块里的诱饵不算数：只看最后那个 JSON 对象。
        self.assertEqual(parse_priority_json('<think>{"priority":"low"}</think>{"priority":"high"}'),
                         ('high', 'ok'))

    def test_unwrapping_does_not_loosen_the_object_rules(self):
        self.assertEqual(parse_priority_json('<think>x</think>{"priority":"high","reason":"y"}')[1],
                         'invalid_response')
        self.assertEqual(parse_priority_json('<think>x</think>{"priority":"high","priority":"low"}')[1],
                         'invalid_response')
        # 思考块没闭合：输出被截断，不能猜。
        self.assertEqual(parse_priority_json('<think>还没说完 {"priority":"high"}')[1],
                         'invalid_response')
        # 夹在散文里的 JSON 不是合法回答。
        self.assertEqual(parse_priority_json('好的，{"priority":"high"}')[1], 'invalid_response')


class ResolveJevPriorityTests(unittest.TestCase):
    def test_clear_winner_is_accepted(self):
        self.assertEqual(
            resolve_jev_priority({'high': 0.95, 'medium': 0.02, 'low': 0.01, 'unknown': 0.02}),
            ('high', 'ok'))

    def test_unknown_floor_wins(self):
        self.assertEqual(
            resolve_jev_priority({'high': 0.9, 'medium': 0.1, 'low': 0.1, 'unknown': 0.5}),
            ('unknown', 'model_unknown'))

    def test_margin_boundary_is_not_rejected_by_float_error(self):
        # 0.8 - 0.6 恰好差 0.2，二进制浮点里是 0.19999999999999996。
        self.assertEqual(
            resolve_jev_priority({'high': 0.8, 'medium': 0.6, 'low': 0.1, 'unknown': 0.1}),
            ('high', 'ok'))

    def test_below_threshold_falls_back_to_unknown(self):
        self.assertEqual(
            resolve_jev_priority({'high': JEV_ACCEPT_THRESHOLD - 0.01, 'medium': 0.1,
                                  'low': 0.1, 'unknown': 0.1}),
            ('unknown', 'model_unknown'))

    def test_small_margin_falls_back_to_unknown(self):
        # 两档同时高分：差距不够，不能挑一个。
        self.assertEqual(
            resolve_jev_priority({'high': 0.9, 'medium': 0.85, 'low': 0.1, 'unknown': 0.1}),
            ('unknown', 'model_unknown'))

    def test_tie_falls_back_to_unknown(self):
        self.assertEqual(
            resolve_jev_priority({'high': 0.9, 'medium': 0.9, 'low': 0.1, 'unknown': 0.1}),
            ('unknown', 'model_unknown'))

    def test_missing_or_extra_answers_are_invalid(self):
        self.assertEqual(resolve_jev_priority({'high': 0.9, 'medium': 0.1, 'low': 0.1})[1],
                         'invalid_response')
        self.assertEqual(resolve_jev_priority({'high': 0.9, 'medium': 0.1, 'low': 0.1,
                                               'unknown': 0.1, 'other': 0.0})[1],
                         'invalid_response')
        self.assertEqual(resolve_jev_priority({})[1], 'invalid_response')
        self.assertEqual(resolve_jev_priority(None)[1], 'invalid_response')

    def test_booleans_are_not_valid_numbers(self):
        self.assertEqual(resolve_jev_priority({'high': True, 'medium': 0.1, 'low': 0.1,
                                               'unknown': 0.1})[1], 'invalid_response')

    def test_out_of_range_and_non_finite_are_invalid(self):
        for value in (1.5, -0.1, float('inf'), float('nan'), '0.9', None):
            self.assertEqual(
                resolve_jev_priority({'high': value, 'medium': 0.1, 'low': 0.1, 'unknown': 0.1})[1],
                'invalid_response', value)


class MessageShapeTests(unittest.TestCase):
    def test_llm_messages_are_system_then_user(self):
        inference = PriorityInference()
        messages = inference.build_llm_messages('{"target":{"title":"x"}}')
        self.assertEqual([role for role, _ in messages], ['system', 'user'])
        self.assertTrue(messages[0][1].startswith(PRIORITY_RULES_V1))
        self.assertIn('只输出一个 JSON 对象', messages[0][1])
        self.assertEqual(messages[1][1], '{"target":{"title":"x"}}')

    def test_jev_questions_share_the_rules_and_the_same_payload(self):
        questions = jev_questions()
        self.assertEqual(sorted(questions), sorted(JEV_QUESTION_ORDER))
        for key in JEV_QUESTION_ORDER:
            self.assertTrue(questions[key].startswith(PRIORITY_RULES_V1))
            self.assertIn('state', questions[key])
        # Jev 不附加 LLM 的「只输出 JSON」约束。
        self.assertNotIn('只输出一个 JSON 对象', questions['high'])

    def test_prompt_version_is_pinned(self):
        self.assertEqual(PROMPT_VERSION, 'priority_prompt_v1')


class JudgeTests(unittest.TestCase):
    """判断入口：网关的成功与失败都要变成有状态的结果，不抛异常。"""

    class _Gateway:
        def __init__(self, text=None, probabilities=None, error=None):
            self.text, self.probabilities, self.error = text, probabilities, error
            self.calls = []

        def chat(self, messages, max_tokens=None):
            self.calls.append({'messages': messages, 'max_tokens': max_tokens})

            class Result:
                pass
            if self.error is not None:
                raise self.error
            result = Result()
            result.text = self.text
            result.model = 'demo'
            return result

        def classify(self, state, questions):
            self.calls.append({'state': state, 'questions': questions})

            class Result:
                pass
            if self.error is not None:
                raise self.error
            result = Result()
            result.probabilities = self.probabilities
            result.model = 'demo'
            return result

    def test_llm_path_returns_a_level(self):
        gateway = self._Gateway(text='{"priority":"high"}')
        decision = PriorityInference().judge(caller=gateway, mode='llm', payload='{}')
        self.assertEqual((decision.priority, decision.status), ('high', 'ok'))
        self.assertEqual(decision.model, 'demo')
        self.assertEqual(gateway.calls[0]['messages'][1][1], '{}')

    def test_jev_path_converges(self):
        gateway = self._Gateway(probabilities={'high': 0.95, 'medium': 0.02, 'low': 0.01,
                                                'unknown': 0.02})
        decision = PriorityInference().judge(caller=gateway, mode='jev', payload='{}')
        self.assertEqual((decision.priority, decision.status), ('high', 'ok'))
        self.assertEqual(gateway.calls[0]['state'], '{}')
        self.assertEqual(sorted(gateway.calls[0]['questions']), sorted(JEV_QUESTION_ORDER))

    def test_invalid_response_is_not_a_valid_level(self):
        gateway = self._Gateway(text='{"priority":"high","reason":"x"}')
        decision = PriorityInference().judge(caller=gateway, mode='llm', payload='{}')
        self.assertEqual((decision.priority, decision.status), ('unknown', 'invalid_response'))
        self.assertFalse(decision.assigned)

    def test_error_codes_map_to_execution_status(self):
        class Failure(Exception):
            def __init__(self, code):
                super().__init__(code)
                self.code = code
        for code, expected in (('not_configured', 'not_configured'), ('timeout', 'timeout'),
                               ('network_failed', 'network_failed'), ('cancelled', 'cancelled'),
                               ('rate_limited', 'network_failed'), ('auth_failed', 'not_configured')):
            decision = PriorityInference().judge(
                caller=self._Gateway(error=Failure(code)), mode='llm', payload='{}')
            self.assertEqual((decision.priority, decision.status), ('unknown', expected), code)

    def test_unknown_error_is_a_network_failure(self):
        decision = PriorityInference().judge(
            caller=self._Gateway(error=RuntimeError('boom')), mode='llm', payload='{}')
        self.assertEqual((decision.priority, decision.status), ('unknown', 'network_failed'))


if __name__ == '__main__':
    unittest.main()
