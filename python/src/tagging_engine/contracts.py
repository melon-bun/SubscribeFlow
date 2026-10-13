"""识别契约：输入、候选、结果与错误。

这一层只定义形状与校验，不认识数据库、标签表或界面。Core 在边界上把
自己的 RecognitionInput 映射进来，把 RecognitionResult 映射回 TagSuggestion。

字段命名在这里统一；供应商的原始响应不会穿过这一层。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

MODES = ('jev', 'llm')

# 结果状态。空匹配是正常结果，不是错误：明确的内容不该被硬塞一个标签。
STATUS_MATCHED = 'matched'
STATUS_NO_MATCH = 'no_match'
STATUS_INSUFFICIENT_TEXT = 'insufficient_text'

# 错误分类。每类都带 retryable，调用方据此决定退避重试还是进入阻塞状态。
ERROR_NOT_CONFIGURED = 'not_configured'
ERROR_AUTH = 'auth_failed'
ERROR_RATE_LIMITED = 'rate_limited'
ERROR_TIMEOUT = 'timeout'
ERROR_NETWORK = 'network_failed'
ERROR_INVALID_RESPONSE = 'invalid_response'
ERROR_CANCELLED = 'cancelled'

ERROR_RETRYABLE = frozenset({ERROR_RATE_LIMITED, ERROR_TIMEOUT, ERROR_NETWORK})

MIN_TEXT = 8
MAX_TEXT = 4000
MAX_CANDIDATES = 5
MAX_TAG_NAME = 40


class RecognitionError(Exception):
    """模型调用失败。message 只描述原因，不携带密钥或完整原文。"""

    def __init__(self, code: str, message: str, *, retryable: bool | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = ERROR_RETRYABLE.__contains__(code) if retryable is None else bool(retryable)

    def to_dict(self) -> dict:
        return {'code': self.code, 'message': self.message, 'retryable': self.retryable}


@dataclass(frozen=True)
class CandidateTag:
    """候选标签目录里的一项。

    description 定义分类边界（模型据此判断该不该选），
    synonyms 只是辅助理解；id 只用于稳定映射，不能用显示名替代身份。
    """

    id: str
    name: str
    description: str = ''
    synonyms: tuple[str, ...] = ()

    @staticmethod
    def from_dict(value: dict) -> 'CandidateTag':
        if not isinstance(value, dict):
            raise ValueError('候选标签必须是对象')
        tag_id, name = value.get('id'), value.get('name')
        if not isinstance(tag_id, str) or not tag_id:
            raise ValueError('候选标签缺少稳定 ID')
        if not isinstance(name, str) or not name.strip():
            raise ValueError('候选标签缺少名称')
        description = value.get('description') or ''
        if not isinstance(description, str):
            raise ValueError('候选标签描述必须是文本')
        synonyms = value.get('synonyms') or []
        if not isinstance(synonyms, list) or any(not isinstance(s, str) for s in synonyms):
            raise ValueError('候选标签别名必须是字符串列表')
        return CandidateTag(tag_id, name.strip(), description.strip(), tuple(s.strip() for s in synonyms if s.strip()))

    def label(self) -> str:
        parts = [self.name]
        if self.description:
            parts.append(f'（{self.description}）')
        if self.synonyms:
            parts.append('，也称 ' + '、'.join(self.synonyms))
        return ''.join(parts)


@dataclass(frozen=True)
class RecognitionRequest:
    """一次识别的输入。只使用已保存且实际存在的文本。"""

    item_id: str
    text: str
    title: str = ''
    mode: str = 'llm'
    candidates: tuple[CandidateTag, ...] = ()
    limit: int = MAX_CANDIDATES
    # 内容文本版本：调用方用它判断响应回来时内容是否已经变了。
    content_version: str | None = None

    @staticmethod
    def from_dict(value: dict) -> 'RecognitionRequest':
        if not isinstance(value, dict):
            raise ValueError('识别输入必须是对象')
        text, title = value.get('text'), value.get('title') or ''
        if not isinstance(text, str) or not isinstance(title, str):
            raise ValueError('正文与标题必须是文本')
        mode = value.get('mode', 'llm')
        if mode not in MODES:
            raise ValueError('不支持的识别方式')
        limit = value.get('limit', MAX_CANDIDATES)
        if type(limit) is not int or limit < 1 or limit > MAX_CANDIDATES:
            raise ValueError(f'结果数量上限需为 1 到 {MAX_CANDIDATES} 的整数')
        candidates = value.get('candidates') or []
        if not isinstance(candidates, list):
            raise ValueError('候选标签必须是列表')
        return RecognitionRequest(
            item_id=str(value.get('item_id') or ''),
            text=text,
            title=title,
            mode=mode,
            candidates=tuple(CandidateTag.from_dict(c) for c in candidates),
            limit=limit,
            content_version=value.get('content_version'),
        )

    def has_enough_text(self) -> bool:
        """标题加正文都太短时不调用模型：判断质量会明显下降，还会白花钱。"""
        return len((self.title + self.text).strip()) >= MIN_TEXT

    def state_text(self) -> str:
        """送给模型的正文。标题与正文合成一段，附带长度上限与截断标记。"""
        parts = []
        if self.title.strip():
            parts.append(self.title.strip())
        body = self.text.strip()
        if body:
            parts.append(body)
        joined = '\n'.join(parts)
        if len(joined) > MAX_TEXT:
            joined = joined[:MAX_TEXT] + '…（正文过长，已截断）'
        return joined


@dataclass(frozen=True)
class Candidate:
    """单个候选标签。

    tag_id 指向已有标签；为 None 且有 name 时表示「建议新建」。
    score 保留模型给出的原值，并记录它是什么口径的分值——Jev 的 Noul 概率
    与 LLM 自报的置信度不是同一种可靠性，不能混为一谈。
    """

    tag_id: str | None = None
    name: str | None = None
    score: float | None = None
    score_kind: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict:
        return {'tagId': self.tag_id, 'name': self.name, 'score': self.score,
                'scoreKind': self.score_kind, 'reason': self.reason}


@dataclass(frozen=True)
class RecognitionResult:
    """一次识别的结果。model 记录服务实际返回的模型标识，不做别名假设。"""

    provider: str
    status: str
    candidates: tuple[Candidate, ...] = ()
    model: str | None = None
    usage: dict | None = None
    detail: str | None = None
    error: dict | None = None

    def to_dict(self) -> dict:
        return {'provider': self.provider, 'status': self.status, 'model': self.model,
                'candidates': [c.to_dict() for c in self.candidates],
                'usage': self.usage, 'detail': self.detail, 'error': self.error}


def check_candidate(raw: dict, *, allow_new: bool) -> Candidate:
    """校验单个候选。任何越界都算非法响应，不做静默降级。"""
    if not isinstance(raw, dict):
        raise ValueError('候选必须是对象')
    tag_id = raw.get('tagId', raw.get('tag_id'))
    name = raw.get('name')
    if tag_id is not None and (not isinstance(tag_id, str) or not tag_id):
        raise ValueError('已有标签的 ID 无效')
    if tag_id is None:
        if not allow_new:
            raise ValueError('该识别方式不允许新建标签')
        if not isinstance(name, str) or not name.strip():
            raise ValueError('新标签缺少名称')
        if len(name.strip()) > MAX_TAG_NAME:
            raise ValueError(f'新标签名称需不超过 {MAX_TAG_NAME} 个字符')
        name = name.strip()
    else:
        name = name.strip() if isinstance(name, str) and name.strip() else None
    score = raw.get('score')
    if score is not None:
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
            raise ValueError('分值必须是有限数值')
        score = float(score)
    score_kind = raw.get('scoreKind', raw.get('score_kind'))
    if score_kind is not None and not isinstance(score_kind, str):
        raise ValueError('分值口径必须是文本')
    reason = raw.get('reason')
    if reason is not None and not isinstance(reason, str):
        raise ValueError('理由必须是文本')
    return Candidate(tag_id, name, score, score_kind, (reason or '').strip() or None)


def check_candidates(values, *, allow_new: bool, limit: int) -> tuple[Candidate, ...]:
    if not isinstance(values, list):
        raise ValueError('候选列表必须是数组')
    if len(values) > limit:
        raise ValueError(f'候选数量超过上限 {limit}')
    checked = tuple(check_candidate(v, allow_new=allow_new) for v in values)
    seen, unique = set(), []
    for candidate in checked:
        key = candidate.tag_id or (candidate.name or '').casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return tuple(unique)