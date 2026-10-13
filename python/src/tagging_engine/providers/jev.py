"""Jev（TypeSafe System One）识别方式。

只从候选目录里挑，不新建标签（计划 §3.3）。每个候选标签问一个独立的
Noul 问题，按概率门槛筛选后取数量上限。

容易踩的点写在这里：
- `questions` 必须是对象而不是数组，否则服务端按 422 拒；
- Noul 没有独立的 confidence 字段，答案里的 `noul` 就是 0–1 的成立概率，
  记分时必须标注口径，不能和 LLM 自报的置信度混用；
- 答案必须与问题一一对应。缺项、类型不符、概率越界都是**非法响应**，
  不能悄悄当成「没匹配」——那会让一次失败的调用看起来像一次成功的判断。
"""

from __future__ import annotations

import math

from ..contracts import (
    STATUS_INSUFFICIENT_TEXT, STATUS_MATCHED, STATUS_NO_MATCH,
    Candidate, RecognitionError, RecognitionRequest, RecognitionResult,
)
from ..transport import validate_timeout

DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
DEFAULT_MODEL = 'jev-latest'
DEFAULT_THRESHOLD = 0.8
# 单次请求的问题数量上限：标签多时按预算分批，不能静默丢掉后面的候选。
DEFAULT_BATCH = 20
MAX_BATCH = 200


def validate_threshold(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise RecognitionError('invalid_input', '概率门槛需为 0 到 1 之间的数值', retryable=False)
    if not 0.0 <= float(value) <= 1.0:
        raise RecognitionError('invalid_input', '概率门槛需为 0 到 1 之间的数值', retryable=False)
    return float(value)


def validate_batch(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > MAX_BATCH:
        raise RecognitionError('invalid_input', f'单批问题数需为 1 到 {MAX_BATCH} 的整数', retryable=False)
    return value


class JevProvider:
    name = 'jev'

    def __init__(self, *, endpoint: str, model: str, api_key: str,
                 threshold: float = DEFAULT_THRESHOLD, batch: int = DEFAULT_BATCH,
                 transport=None, timeout: float | None = None):
        if not (endpoint and model and api_key):
            raise RecognitionError('not_configured', 'Jev 识别尚未配置完整')
        self.endpoint, self.model, self.api_key = endpoint, model, api_key
        # 配置错误必须在发请求之前失败：负 batch 会让 range 为空，
        # 结果就是一次请求都没发却返回「没有匹配」。
        self.threshold = validate_threshold(threshold)
        self.batch = validate_batch(batch)
        self.timeout = validate_timeout(timeout, 'timeout') if timeout is not None else None
        self._transport = transport

    def transport(self):
        if self._transport is None:
            from ..transport import HttpTransport
            self._transport = HttpTransport(self.timeout or 30.0)
        return self._transport

    def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not request.has_enough_text():
            return RecognitionResult(self.name, STATUS_INSUFFICIENT_TEXT, detail='可用文本过短，未调用模型',
                                     requested_model=self.model)
        if not request.candidates:
            # 空目录直接跳过，不调用也不生成新标签：Jev 不负责造标签。
            return RecognitionResult(self.name, STATUS_NO_MATCH, detail='没有可用的已启用标签，未调用模型',
                                     requested_model=self.model)
        state = request.state_text()
        candidates = []
        served_models, usages = set(), []
        for start in range(0, len(request.candidates), self.batch):
            batch = request.candidates[start:start + self.batch]
            body = self._ask(state, batch)
            served = body.get('model')
            if isinstance(served, str) and served:
                served_models.add(served)
            usages.append(body.get('usage') if isinstance(body.get('usage'), dict) else None)
            answers = self._answers(body, batch)
            for tag in batch:
                probability = self._probability(answers, tag.id)
                if probability >= self.threshold:
                    candidates.append(Candidate(tag.id, None, probability, 'noul',
                                                f'与「{tag.name}」的成立概率 {probability}'))
        resolved = self._resolved_model(served_models)
        # 概率高的先挂，并按 limit 截断；被截断的数量要说明，不能假装全都评估过。
        candidates.sort(key=lambda c: -(c.score or 0))
        kept, dropped = candidates[:request.limit], max(0, len(candidates) - request.limit)
        detail = None
        if dropped:
            detail = f'共 {len(candidates)} 个候选超过门槛，按上限保留 {len(kept)} 个，未挂载 {dropped} 个'
        return RecognitionResult(self.name, STATUS_MATCHED if kept else STATUS_NO_MATCH,
                                 candidates=tuple(kept), model=resolved,
                                 requested_model=self.model, usage=self._merge_usage(usages), detail=detail)

    def _ask(self, state: str, batch) -> dict:
        payload = {
            'model': self.model,
            'state': state,
            'questions': {tag.id: {'type': 'noul', 'instructions': self._instruction(tag)} for tag in batch},
        }
        _, body = self.transport().post_json(self.endpoint, payload,
                                             {'Authorization': f'Bearer {self.api_key}'}, self.timeout)
        return body

    @staticmethod
    def _resolved_model(served_models: set) -> str | None:
        """只认服务返回的模型标识。

        分批请求时若各批返回的版本不一致，就无法宣称确认了同一个底层版本；
        服务没返回时也宁可留空，不用请求别名冒充。
        """
        if len(served_models) == 1:
            return next(iter(served_models))
        return None

    @staticmethod
    def _instruction(tag) -> str:
        # 描述定义边界，名称与别名只作辅助理解。
        parts = [f'这段内容是否属于「{tag.name}」这一类？']
        if tag.description:
            parts.append(f'这一类的范围是：{tag.description}')
        if tag.synonyms:
            parts.append('常见的其他说法：' + '、'.join(tag.synonyms))
        parts.append('只依据内容本身判断，不依据是否提到了这个词。')
        return ''.join(parts)

    @staticmethod
    def _answers(body: dict, batch) -> dict:
        answers = body.get('answers')
        if not isinstance(answers, dict):
            raise RecognitionError('invalid_response', '模型服务没有返回 answers 对象')
        expected = {tag.id for tag in batch}
        missing = expected - set(answers)
        if missing:
            raise RecognitionError('invalid_response',
                                   f'缺少 {len(missing)} 个问题的答案（问题 ID 与请求不一致）')
        unexpected = set(answers) - expected
        if unexpected:
            raise RecognitionError('invalid_response',
                                   f'返回了 {len(unexpected)} 个本次未提问的答案')
        return answers

    @staticmethod
    def _probability(answers: dict, question_id: str) -> float:
        """取一个合法概率；任何不合法的答案都让整次识别失败。

        之前这里返回 None 并跳过，等于把「服务给了坏数据」记成「没有匹配」。
        """
        answer = answers.get(question_id)
        if not isinstance(answer, dict):
            raise RecognitionError('invalid_response', f'问题 {question_id} 的答案不是对象')
        kind = answer.get('type')
        if kind != 'noul':
            raise RecognitionError('invalid_response', f'问题 {question_id} 的答案类型是 {kind!r}，应为 noul')
        value = answer.get('noul')
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RecognitionError('invalid_response', f'问题 {question_id} 的 noul 值缺失或不是数值')
        value = float(value)
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            raise RecognitionError('invalid_response', f'问题 {question_id} 的 noul 值超出 0 到 1')
        return value

    @staticmethod
    def _merge_usage(batches) -> dict | None:
        """分批请求的用量相加；服务没给就留空，不编造。"""
        totals: dict[str, int] = {}
        for usage in batches:
            if not usage:
                continue
            for key in ('input_tokens', 'output_tokens'):
                value = usage.get(key)
                if isinstance(value, int) and not isinstance(value, bool):
                    totals[key] = totals.get(key, 0) + value
        return totals or None