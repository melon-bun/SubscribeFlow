"""Jev（TypeSafe System One）识别方式。

只从候选目录里挑，不新建标签（计划 §3.3）。每个候选标签问一个独立的
Noul 问题，按概率门槛筛选后取数量上限。

两个容易踩的点写在这里：
- `questions` 必须是对象而不是数组，否则服务端按 422 拒；
- Noul 没有独立的 confidence 字段，答案里的 `noul` 就是 0–1 的成立概率，
  记分时必须标注口径，不能和 LLM 自报的置信度混用。
"""

from __future__ import annotations

from ..contracts import (
    STATUS_INSUFFICIENT_TEXT, STATUS_MATCHED, STATUS_NO_MATCH,
    Candidate, RecognitionError, RecognitionRequest, RecognitionResult,
)

DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
DEFAULT_MODEL = 'jev-latest'
DEFAULT_THRESHOLD = 0.8
# 单次请求的问题数量上限：标签多时按预算分批，不能静默丢掉后面的候选。
DEFAULT_BATCH = 20


class JevProvider:
    name = 'jev'

    def __init__(self, *, endpoint: str, model: str = DEFAULT_MODEL, api_key: str,
                 threshold: float = DEFAULT_THRESHOLD, batch: int = DEFAULT_BATCH,
                 transport=None, timeout: float | None = None):
        self.endpoint, self.model, self.api_key = endpoint, model, api_key
        self.threshold, self.batch, self.timeout = threshold, batch, timeout
        self._transport = transport

    def transport(self):
        if self._transport is None:
            from ..transport import HttpTransport
            self._transport = HttpTransport()
        return self._transport

    def recognize(self, request: RecognitionRequest) -> RecognitionResult:
        if not request.has_enough_text():
            return RecognitionResult(self.name, STATUS_INSUFFICIENT_TEXT, detail='可用文本过短，未调用模型')
        if not request.candidates:
            # 空目录直接跳过，不调用也不生成新标签：Jev 不负责造标签。
            return RecognitionResult(self.name, STATUS_NO_MATCH, detail='没有可用的已启用标签，未调用模型')
        state = request.state_text()
        candidates, threshold = [], self.threshold
        answered, resolved = [], self.model
        for start in range(0, len(request.candidates), self.batch):
            batch = request.candidates[start:start + self.batch]
            body = self._ask(state, batch)
            # 记服务实际返回的模型标识：请求里的别名不是已确认的底层版本。
            resolved = body.get('model') if isinstance(body.get('model'), str) and body.get('model') else resolved
            answers = self._answers(body, batch)
            answered.append(body.get('usage') if isinstance(body.get('usage'), dict) else None)
            for tag in batch:
                probability = self._probability(answers, tag.id)
                if probability is not None and probability >= threshold:
                    candidates.append(Candidate(tag.id, None, probability, 'noul', f'与「{tag.name}」的成立概率 {probability}'))
        # 概率高的先挂，并按 limit 截断；被截断的数量要说明，不能假装全都评估过。
        candidates.sort(key=lambda c: -(c.score or 0))
        kept, dropped = candidates[:request.limit], max(0, len(candidates) - request.limit)
        detail = None
        if dropped:
            detail = f'共 {len(candidates)} 个候选超过门槛，按上限保留 {len(kept)} 个，未挂载 {dropped} 个'
        usage = self._merge_usage(answered)
        return RecognitionResult(self.name, STATUS_MATCHED if kept else STATUS_NO_MATCH,
                                 tuple(kept), resolved, usage, detail)

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
        return answers

    @staticmethod
    def _probability(answers: dict, question_id: str) -> float | None:
        answer = answers.get(question_id)
        if not isinstance(answer, dict) or answer.get('type') != 'noul':
            return None
        value = answer.get('noul')
        # 缺项或越界都视为非法响应，而不是悄悄当成 0。
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not 0.0 <= float(value) <= 1.0:
            return None
        return float(value)