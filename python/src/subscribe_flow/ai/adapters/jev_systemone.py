"""Jev（TypeSafe System One）候选分类协议适配器。

只负责协议本身：把问题发出去，把答案里的成立概率取回来。
问题怎么问（描述、别名、业务口径）是调用方的责任，适配器不内置。
"""

from __future__ import annotations

import math

from ..contracts import (
    ERROR_INVALID_RESPONSE, PROTOCOL_JEV_SYSTEMONE, AiError, ClassificationResult,
)


class JevSystemOneAdapter:
    """`POST {endpoint}` 的 noul 问题协议。"""

    protocol = PROTOCOL_JEV_SYSTEMONE

    def __init__(self, *, endpoint: str, model: str, api_key: str, transport=None,
                 timeout: float | None = None):
        self.endpoint = endpoint or ''
        self.model = model or ''
        self.api_key = api_key or ''
        self.timeout = timeout
        self._transport = transport

    def transport(self):
        if self._transport is None:
            from ..transport import HttpTransport
            self._transport = HttpTransport(self.timeout or 30.0)
        return self._transport

    def classify(self, state: str, questions: dict) -> ClassificationResult:
        """问一组问题，返回每个问题的成立概率。

        `questions` 是 {问题 ID: 问题文本}。答案必须与问题一一对应：缺项、
        类型不符、概率越界都是非法响应，不能悄悄当成「没匹配」。
        """
        payload = {
            'model': self.model,
            'state': state,
            'questions': {qid: {'type': 'noul', 'instructions': text} for qid, text in questions.items()},
        }
        _, body = self.transport().post_json(self.endpoint, payload,
                                            {'Authorization': f'Bearer {self.api_key}'}, self.timeout)
        return ClassificationResult(probabilities=self._probabilities(body, questions),
                                   model=self._model(body), usage=self._usage(body),
                                   provider=self.protocol)

    # ------------------------------------------------------------ 响应解析

    @classmethod
    def _probabilities(cls, body: dict, questions: dict) -> dict:
        answers = body.get('answers')
        if not isinstance(answers, dict):
            raise AiError(ERROR_INVALID_RESPONSE, '模型服务没有返回 answers 对象')
        expected = set(questions)
        missing = expected - set(answers)
        if missing:
            raise AiError(ERROR_INVALID_RESPONSE,
                          f'缺少 {len(missing)} 个问题的答案（问题 ID 与请求不一致）')
        unexpected = set(answers) - expected
        if unexpected:
            raise AiError(ERROR_INVALID_RESPONSE,
                          f'返回了 {len(unexpected)} 个本次未提问的答案')
        return {qid: cls._probability(answers, qid) for qid in questions}

    @staticmethod
    def _probability(answers: dict, question_id: str) -> float:
        """取一个合法概率；任何不合法的答案都让整次分类失败。

        之前这里返回 None 并跳过，等于把「服务给了坏数据」记成「没有匹配」。
        """
        answer = answers.get(question_id)
        if not isinstance(answer, dict):
            raise AiError(ERROR_INVALID_RESPONSE, f'问题 {question_id} 的答案不是对象')
        kind = answer.get('type')
        if kind != 'noul':
            raise AiError(ERROR_INVALID_RESPONSE, f'问题 {question_id} 的答案类型是 {kind!r}，应为 noul')
        value = answer.get('noul')
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise AiError(ERROR_INVALID_RESPONSE, f'问题 {question_id} 的 noul 值缺失或不是数值')
        value = float(value)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise AiError(ERROR_INVALID_RESPONSE, f'问题 {question_id} 的 noul 值超出 0 到 1')
        return value

    @staticmethod
    def _model(body: dict) -> str | None:
        value = body.get('model')
        return value if isinstance(value, str) and value else None

    @staticmethod
    def _usage(body: dict) -> dict | None:
        usage = body.get('usage')
        return usage if isinstance(usage, dict) and usage else None


__all__ = ['JevSystemOneAdapter']
