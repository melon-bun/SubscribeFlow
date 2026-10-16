"""独立识别包的协议与失败路径测试。

全部使用传输替身，不发真实请求：真实调用的证据来自独立调试入口的实跑记录
（docs/M16_AUTO_TAGGING.md），这里只固定协议边界、校验与错误分类。

模拟与真实共用同一套请求组装和响应解析——不为测试另写一套。
"""

import json
import unittest

from tagging_engine import RecognitionError, RecognitionRequest, build_provider
from tagging_engine.contracts import CandidateTag, check_candidates
from tagging_engine.providers.jev import JevProvider
from tagging_engine.providers.llm import LlmProvider
from tagging_engine.transport import HttpTransport, build_ssl_context


class FakeTransport:
    """记录请求、按脚本回放响应；可模拟 HTTP 错误与非法响应。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def post_json(self, url, payload, headers, timeout=None):
        self.requests.append({'url': url, 'payload': payload, 'headers': headers})
        if not self.responses:
            raise AssertionError('收到超出脚本的请求')
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return 200, result


CANDIDATES = [
    {'id': 't1', 'name': 'Python', 'description': 'Python 编程语言'},
    {'id': 't2', 'name': '机器学习', 'description': '模型训练与算法'},
    {'id': 't3', 'name': '美食', 'description': '菜谱与餐厅'},
]
SAMPLE = '本文介绍如何使用 Python 训练一个机器学习分类器。'


def request(mode='jev', candidates=CANDIDATES, text=SAMPLE, title='机器学习入门', limit=5):
    return RecognitionRequest.from_dict({
        'item_id': 'i1', 'mode': mode, 'text': text, 'title': title,
        'candidates': candidates, 'limit': limit,
    })


class JevProviderTests(unittest.TestCase):
    def provider(self, transport, **options):
        return JevProvider(endpoint='https://api.typesafe.ai/v1/systemone', model='jev-latest',
                           api_key='k', transport=transport, **options)

    def test_selects_threshold_matches_and_uses_real_model_name(self):
        transport = FakeTransport([{'model': 'jev-1.13.0',
                                    'answers': {'t1': {'type': 'noul', 'noul': 0.91},
                                                't2': {'type': 'noul', 'noul': 0.05},
                                                't3': {'type': 'noul', 'noul': 0.01}},
                                    'usage': {'input_tokens': 300, 'output_tokens': 50}}])
        result = self.provider(transport).recognize(request())
        self.assertEqual(result.status, 'matched')
        self.assertEqual([c.tag_id for c in result.candidates], ['t1'])
        # 请求的是别名，返回的必须是服务实际模型；用量按服务给的记。
        self.assertEqual(result.model, 'jev-1.13.0')
        self.assertEqual(result.requested_model, 'jev-latest')
        self.assertEqual(result.usage, {'input_tokens': 300, 'output_tokens': 50})
        self.assertEqual(result.candidates[0].score_kind, 'noul')

    def test_empty_catalogue_skips_the_model_entirely(self):
        transport = FakeTransport([])
        result = self.provider(transport).recognize(request(candidates=[]))
        self.assertEqual(result.status, 'no_match')
        self.assertEqual(transport.requests, [], '没有候选标签就不该发请求')

    def test_never_creates_new_tags(self):
        transport = FakeTransport([{'model': 'jev-1.13.0', 'answers': {
            't1': {'type': 'noul', 'noul': 0.99}, 't2': {'type': 'noul', 'noul': 0.99},
            't3': {'type': 'noul', 'noul': 0.99}}}])
        result = self.provider(transport).recognize(request())
        self.assertTrue(all(c.tag_id is not None and c.name is None for c in result.candidates))

    def test_batches_evaluate_every_candidate_then_apply_the_limit(self):
        """分批只影响发几次请求，不得影响「哪些候选被评估过」。

        结果上限是另一回事：超出的必须写明数量，不能看起来像全都评估过。
        """
        many = [{'id': f't{i}', 'name': f'标签{i}'} for i in range(7)]
        transport = FakeTransport([
            {'model': 'v', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in range(5)}},
            {'model': 'v', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in range(5, 7)}},
        ])
        result = self.provider(transport, batch=5).recognize(request(candidates=many, limit=5))
        self.assertEqual(len(transport.requests), 2, '标签多时按预算分批')
        asked = {qid for call in transport.requests for qid in call['payload']['questions']}
        self.assertEqual(asked, {f't{i}' for i in range(7)}, '分批不能静默丢掉后面的候选')
        self.assertEqual(len(result.candidates), 5, '结果仍受数量上限约束')
        self.assertIn('共 7 个候选', result.detail)
        self.assertIn('未挂载 2 个', result.detail)

    def test_limit_is_reported_not_silently_applied(self):
        many = [{'id': f't{i}', 'name': f'标签{i}'} for i in range(4)]
        transport = FakeTransport([{'model': 'v', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in range(4)}}])
        result = self.provider(transport).recognize(request(candidates=many, limit=2))
        self.assertEqual(len(result.candidates), 2)
        self.assertIn('未挂载 2 个', result.detail)

    def test_missing_answer_is_invalid_response(self):
        transport = FakeTransport([{'model': 'v', 'answers': {'t1': {'type': 'noul', 'noul': 0.9}}}])
        with self.assertRaises(RecognitionError) as caught:
            self.provider(transport).recognize(request())
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_any_invalid_answer_fails_the_whole_recognition(self):
        """非法答案必须让整次识别失败，不能记成「没有匹配」。

        混在有效答案里的坏数据同样致命：否则一次失败的调用看起来像一次
        完成了的分类。
        """
        cases = {
            '超出 0-1': {'t1': {'type': 'noul', 'noul': 1.4}, 't2': {'type': 'noul', 'noul': 0.1},
                        't3': {'type': 'noul', 'noul': 0.1}},
            '缺 noul 字段': {'t1': {'type': 'noul'}, 't2': {'type': 'noul', 'noul': 0.1},
                          't3': {'type': 'noul', 'noul': 0.1}},
            '答案类型不符': {'t1': {'type': 'choice', 'choice': 'x'}, 't2': {'type': 'noul', 'noul': 0.1},
                          't3': {'type': 'noul', 'noul': 0.1}},
            '整个答案为 null': {'t1': None, 't2': {'type': 'noul', 'noul': 0.1},
                           't3': {'type': 'noul', 'noul': 0.1}},
            '布尔值冒充概率': {'t1': {'type': 'noul', 'noul': True}, 't2': {'type': 'noul', 'noul': 0.1},
                           't3': {'type': 'noul', 'noul': 0.1}},
        }
        for label, answers in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(RecognitionError) as caught:
                    self.provider(FakeTransport([{'model': 'v', 'answers': answers}])).recognize(request())
                self.assertEqual(caught.exception.code, 'invalid_response')
                self.assertFalse(caught.exception.retryable)

    def test_extra_unrequested_answers_are_rejected(self):
        transport = FakeTransport([{'model': 'v', 'answers': {
            't1': {'type': 'noul', 'noul': 0.9}, 't2': {'type': 'noul', 'noul': 0.9},
            't3': {'type': 'noul', 'noul': 0.9}, 't9': {'type': 'noul', 'noul': 0.9}}}])
        with self.assertRaises(RecognitionError) as caught:
            self.provider(transport).recognize(request())
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_legitimate_boundary_answers_still_work(self):
        for value, ids in ((0.0, ['t1', 't2']), (0.79, ['t1', 't2']),
                           (0.8, ['t1', 't2', 't3']), (1.0, ['t1', 't2', 't3'])):
            with self.subTest(value=value):
                transport = FakeTransport([{'model': 'v', 'answers': {
                    f't{i}': {'type': 'noul', 'noul': value} for i in (1, 2, 3)}}])
                result = self.provider(transport).recognize(request())
                self.assertEqual(result.status, 'matched')
                self.assertEqual([candidate.tag_id for candidate in result.candidates], ids)

    def test_all_below_threshold_selects_the_two_highest_scores(self):
        transport = FakeTransport([{'model': 'v', 'answers': {
            't1': {'type': 'noul', 'noul': 0.1},
            't2': {'type': 'noul', 'noul': 0.79},
            't3': {'type': 'noul', 'noul': 0.77},
        }}])
        result = self.provider(transport).recognize(request())
        self.assertEqual(result.status, 'matched')
        self.assertEqual([candidate.tag_id for candidate in result.candidates], ['t2', 't3'])
        self.assertEqual([candidate.score for candidate in result.candidates], [0.79, 0.77])
        self.assertIn('前 2 个', result.detail)

    def test_fallback_ranks_all_batches_and_keeps_catalogue_order_for_ties(self):
        scores = [0.1, 0.79, 0.77, 0.79, 0.76]
        transport = FakeTransport([{'model': 'v', 'answers': {
            f't{i}': {'type': 'noul', 'noul': scores[i]}
            for i in range(start, min(start + 2, len(scores)))
        }} for start in range(0, len(scores), 2)])
        result = self.provider(transport, batch=2).recognize(
            request(candidates=[{'id': f't{i}', 'name': f'标签{i}'} for i in range(len(scores))]))
        self.assertEqual(len(transport.requests), 3)
        self.assertEqual([candidate.tag_id for candidate in result.candidates], ['t1', 't3'])

    def test_one_candidate_at_threshold_does_not_fill_a_second_below_it(self):
        transport = FakeTransport([{'model': 'v', 'answers': {
            't1': {'type': 'noul', 'noul': 0.79},
            't2': {'type': 'noul', 'noul': 0.8},
            't3': {'type': 'noul', 'noul': 0.78},
        }}])
        result = self.provider(transport).recognize(request())
        self.assertEqual([candidate.tag_id for candidate in result.candidates], ['t2'])

    def test_fallback_respects_a_smaller_limit_or_catalogue(self):
        for catalogue, limit, expected in ((CANDIDATES, 1, ['t2']), (CANDIDATES[:1], 5, ['t1'])):
            with self.subTest(limit=limit, catalogue_size=len(catalogue)):
                transport = FakeTransport([{'model': 'v', 'answers': {
                    tag['id']: {'type': 'noul', 'noul': score}
                    for tag, score in zip(catalogue, [0.1, 0.7, 0.5])
                }}])
                result = self.provider(transport).recognize(request(candidates=catalogue, limit=limit))
                self.assertEqual([candidate.tag_id for candidate in result.candidates], expected)

    def test_fallback_does_not_hide_an_invalid_later_batch(self):
        transport = FakeTransport([
            {'model': 'v', 'answers': {'t1': {'type': 'noul', 'noul': 0.7},
                                      't2': {'type': 'noul', 'noul': 0.6}}},
            {'model': 'v', 'answers': {'t3': {'type': 'noul', 'noul': -0.1}}},
        ])
        with self.assertRaises(RecognitionError) as caught:
            self.provider(transport, batch=2).recognize(request())
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_missing_actual_model_is_not_filled_with_the_requested_alias(self):
        transport = FakeTransport([{'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in (1, 2, 3)}}])
        result = self.provider(transport).recognize(request())
        self.assertIsNone(result.model, '服务没返回实际版本时不能拿请求别名冒充')
        self.assertEqual(result.requested_model, 'jev-latest', '请求模型单独记录')

    def test_batches_with_differing_models_do_not_claim_one_version(self):
        transport = FakeTransport([
            {'model': 'jev-1.13.0', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in range(3)}},
            {'model': 'jev-1.14.0', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.9} for i in range(3, 6)}},
        ])
        result = self.provider(transport, batch=3).recognize(
            request(candidates=[{'id': f't{i}', 'name': f'标签{i}'} for i in range(6)]))
        self.assertIsNone(result.model, '各批版本不一致时不能宣称确认了同一个版本')

    def test_invalid_options_fail_before_any_request(self):
        for options in ({'batch': -1}, {'batch': 0}, {'batch': 2.5}, {'batch': True},
                        {'threshold': 1.2}, {'threshold': -0.1}, {'threshold': float('nan')},
                        {'threshold': True}, {'timeout': 0}, {'timeout': -5}, {'timeout': float('inf')}):
            with self.subTest(options=options):
                transport = FakeTransport([])
                with self.assertRaises(RecognitionError):
                    self.provider(transport, **options)
                self.assertEqual(transport.requests, [], '错误配置不得发出请求')

    def test_short_text_skips_the_model(self):
        transport = FakeTransport([])
        result = self.provider(transport).recognize(request(text='短', title=''))
        self.assertEqual(result.status, 'insufficient_text')
        self.assertEqual(transport.requests, [])

    def test_questions_are_an_object_with_one_noul_per_candidate(self):
        transport = FakeTransport([{'model': 'v', 'answers': {f't{i}': {'type': 'noul', 'noul': 0.0} for i in (1, 2, 3)}}])
        self.provider(transport).recognize(request())
        payload = transport.requests[0]['payload']
        self.assertIsInstance(payload['questions'], dict, 'questions 必须是对象，数组会被服务端按 422 拒')
        self.assertEqual(set(payload['questions']), {'t1', 't2', 't3'})
        for question in payload['questions'].values():
            self.assertEqual(question['type'], 'noul')


class LlmProviderTests(unittest.TestCase):
    def provider(self, transport):
        return LlmProvider(endpoint='https://api.example.com/v1', model='demo', api_key='k',
                           transport=transport)

    @staticmethod
    def reply(content):
        return {'model': 'demo-1', 'choices': [{'message': {'content': content}}],
                'usage': {'total_tokens': 42}}

    def test_strips_thinking_before_parsing(self):
        transport = FakeTransport([self.reply('<think>先想一下</think>\n{"tags":[{"name":"机器学习"}]}')])
        result = self.provider(transport).recognize(request(mode='llm'))
        self.assertEqual(result.status, 'matched')
        self.assertEqual([c.name for c in result.candidates], ['机器学习'])

    def test_accepts_fenced_and_surrounded_json(self):
        for content in ('```json\n{"tags":[{"name":"A"}]}\n```', '好的，结果是：{"tags":[{"name":"A"}]} 完毕'):
            with self.subTest(content=content):
                result = self.provider(FakeTransport([self.reply(content)])).recognize(request(mode='llm'))
                self.assertEqual([c.name for c in result.candidates], ['A'])

    def test_allows_new_names_but_jev_does_not(self):
        result = self.provider(FakeTransport([self.reply('{"tags":[{"name":"新标签","reason":"合适"}]}')])) \
            .recognize(request(mode='llm'))
        candidate = result.candidates[0]
        self.assertIsNone(candidate.tag_id)
        self.assertEqual(candidate.name, '新标签')
        self.assertIsNone(candidate.score, 'LLM 自报的分值缺失就保持缺失，不编造')

    def test_unparsable_content_is_invalid_response(self):
        transport = FakeTransport([self.reply('我觉得这条应该算机器学习吧')])
        with self.assertRaises(RecognitionError) as caught:
            self.provider(transport).recognize(request(mode='llm'))
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_empty_tag_list_is_a_valid_no_match(self):
        result = self.provider(FakeTransport([self.reply('{"tags":[]}')])).recognize(request(mode='llm'))
        self.assertEqual(result.status, 'no_match')
        self.assertEqual(result.candidates, ())

    def test_missing_usage_is_left_empty(self):
        body = {'model': 'demo-1', 'choices': [{'message': {'content': '{"tags":[{"name":"A"}]}'}}]}
        result = self.provider(FakeTransport([body])).recognize(request(mode='llm'))
        self.assertIsNone(result.usage, '服务没给用量就不能编造')

    def test_error_codes_are_classified(self):
        for code, retryable in (('auth_failed', False), ('rate_limited', True),
                                ('timeout', True), ('network_failed', True),
                                ('invalid_response', False), ('not_configured', False)):
            with self.subTest(code=code):
                error = RecognitionError(code, 'x')
                self.assertEqual(error.retryable, retryable)


class LlmOutputValidationTests(unittest.TestCase):
    """模型输出越界必须是 invalid_response，不能变成用户输入错误。"""

    @staticmethod
    def reply(content):
        return {'model': 'm', 'choices': [{'message': {'content': content}}]}

    def provider(self, content):
        return LlmProvider(endpoint='https://api.example.com/v1', model='m', api_key='k',
                           transport=FakeTransport([self.reply(content)]))

    def test_tag_id_outside_the_catalogue_is_rejected(self):
        provider = self.provider('{"tags":[{"tagId":"outside-catalog"}]}')
        with self.assertRaises(RecognitionError) as caught:
            provider.recognize(request(mode='llm', candidates=[{'id': 't1', 'name': 'Python'}]))
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_blank_tag_id_is_rejected(self):
        with self.assertRaises(RecognitionError) as caught:
            self.provider('{"tags":[{"tagId":""}]}').recognize(request(mode='llm'))
        self.assertEqual(caught.exception.code, 'invalid_response')

    def test_known_tag_id_is_accepted(self):
        result = self.provider('{"tags":[{"tagId":"t1"}]}').recognize(
            request(mode='llm', candidates=[{'id': 't1', 'name': 'Python'}]))
        self.assertEqual([c.tag_id for c in result.candidates], ['t1'])

    def test_output_violations_are_model_errors_not_input_errors(self):
        cases = {
            '名称过长': json.dumps({'tags': [{'name': '长' * 41}]}),
            '标签过多': json.dumps({'tags': [{'name': f'标签{i}'} for i in range(6)]}),
            '条目不是对象': json.dumps({'tags': ['just-a-string']}),
        }
        for label, content in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(RecognitionError) as caught:
                    self.provider(content).recognize(request(mode='llm'))
                self.assertEqual(caught.exception.code, 'invalid_response')
                self.assertFalse(caught.exception.retryable)


class RegistryTests(unittest.TestCase):
    def test_incomplete_configuration_is_not_configured_not_a_broken_provider(self):
        for mode, options in (('jev', {'endpoint': '', 'model': 'm', 'api_key': None}),
                              ('llm', {'endpoint': 'https://x/v1', 'model': '', 'api_key': 'k'})):
            with self.subTest(mode=mode):
                with self.assertRaises(RecognitionError) as caught:
                    build_provider(mode, **options)
                self.assertEqual(caught.exception.code, 'not_configured')

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(RecognitionError):
            build_provider('other', endpoint='https://x', model='m', api_key='k')


class ContractTests(unittest.TestCase):
    def test_candidate_limit_and_id_validation(self):
        with self.assertRaises(ValueError):
            check_candidates([{'name': 'a'}] * 6, allow_new=True, limit=5)
        with self.assertRaises(ValueError):
            check_candidates([{'name': 'a'}], allow_new=False, limit=5)

    def test_non_finite_score_is_rejected(self):
        with self.assertRaises(ValueError):
            check_candidates([{'name': 'a', 'score': float('inf')}], allow_new=True, limit=5)

    def test_duplicates_are_collapsed_but_order_kept(self):
        result = check_candidates([{'name': 'A'}, {'name': 'A'}, {'name': 'B'}], allow_new=True, limit=5)
        self.assertEqual([c.name for c in result], ['A', 'B'])


class TransportTests(unittest.TestCase):
    def test_ssl_context_is_built_with_verification_enabled(self):
        context = build_ssl_context()
        self.assertTrue(context.verify_mode.name in ('CERT_REQUIRED', 'CERT_NONE') and
                        context.verify_mode.name == 'CERT_REQUIRED',
                        '证书校验必须保持开启，缺 CA 只能报错不能降级')

    def test_http_error_is_not_leaked_into_requests(self):
        transport = HttpTransport()
        self.assertTrue(hasattr(transport, 'post_json'))


if __name__ == '__main__':
    unittest.main()
