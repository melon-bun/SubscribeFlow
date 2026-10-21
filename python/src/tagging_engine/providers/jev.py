"""Jev（TypeSafe System One）识别方式。

只从候选目录里挑，不新建标签（计划 §3.3）。每个候选标签问一个独立的
Noul 问题；优先选取达到门槛的标签，全部低于门槛时取分数最高的两个，
最后服从调用方的数量上限。

容易踩的点写在这里：
- `questions` 必须是对象而不是数组，否则服务端按 422 拒；
- Noul 没有独立的 confidence 字段，答案里的 `noul` 就是 0–1 的成立概率，
  记分时必须标注口径，不能和 LLM 自报的置信度混用；
- 答案必须与问题一一对应。缺项、类型不符、概率越界都是**非法响应**，
  不能悄悄当成「没匹配」——那会让一次失败的调用看起来像一次成功的判断。
"""

from __future__ import annotations

import math

from subscribe_flow.ai.adapters.jev_systemone import JevSystemOneAdapter

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

    def __init__(self, *, endpoint: str = '', model: str = '', api_key: str = '',
                 threshold: float = DEFAULT_THRESHOLD, batch: int = DEFAULT_BATCH,
                 transport=None, timeout: float | None = None, adapter=None):
        if adapter is None and not (endpoint and model and api_key):
            raise RecognitionError('not_configured', 'Jev 识别尚未配置完整')
        self.endpoint, self.model, self.api_key = endpoint, model, api_key
        # 配置错误必须在发请求之前失败：负 batch 会让 range 为空，
        # 结果就是一次请求都没发却返回「没有匹配」。
        self.threshold = validate_threshold(threshold)
        self.batch = validate_batch(batch)
        self.timeout = validate_timeout(timeout, 'timeout') if timeout is not None else None
        self._transport = transport
        # 协议往返交给公共 AI 层：这里只保留打标签需要的门槛与取二规则。
        # 适配器可以由公共 AI 层注入（那边已经组装好凭据）；不给就自己造一个。
        self._adapter = adapter or JevSystemOneAdapter(endpoint=endpoint, model=model, api_key=api_key,
                                                      transport=transport, timeout=self.timeout)

    def transport(self):
        return self._adapter.transport()

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
            answer = self._ask(state, batch)
            served = answer.model
            if isinstance(served, str) and served:
                served_models.add(served)
            usages.append(answer.usage)
            for tag in batch:
                probability = answer.probabilities[tag.id]
                candidates.append(Candidate(tag.id, None, probability, 'noul',
                                            f'与「{tag.name}」的成立概率 {probability}'))
        resolved = self._resolved_model(served_models)
        # 全部批次校验后统一排序；同分保持原候选顺序，不在各批次分别兜底。
        candidates.sort(key=lambda c: -(c.score or 0))
        qualified = [candidate for candidate in candidates if candidate.score >= self.threshold]
        fallback = not qualified
        candidates = candidates[:2] if fallback else qualified
        kept, dropped = candidates[:request.limit], max(0, len(candidates) - request.limit)
        detail = None
        if fallback:
            detail = f'所有候选均低于门槛 {self.threshold}，按分数及数量上限选择前 {len(kept)} 个标签'
        elif dropped:
            detail = f'共 {len(candidates)} 个候选超过门槛，按上限保留 {len(kept)} 个，未挂载 {dropped} 个'
        return RecognitionResult(self.name, STATUS_MATCHED if kept else STATUS_NO_MATCH,
                                 candidates=tuple(kept), model=resolved,
                                 requested_model=self.model, usage=self._merge_usage(usages), detail=detail)

    def _ask(self, state: str, batch):
        questions = {tag.id: self._instruction(tag) for tag in batch}
        return self._adapter.classify(state, questions)

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
