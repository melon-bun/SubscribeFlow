"""M36 智能优先级的固定契约。

这一层只回答「有哪些值、值之间是什么关系」。它不认识 SQLite、不认识模型、
不认识界面，也不发任何请求。四条边界：

- **业务决策与执行状态分开记**。模型说「无法判断」是一个合法的业务结果，
  调用失败是执行状态，两者不能互相冒充（计划 §3.4）。
- **人工、智能、来源三处取值各自保存**。最终优先级由 :func:`resolve_priority`
  按固定顺序解析，解析器不回写任何一处，也不做网络调用。
- **上下文结构定死形状**。缓存键、在途结果校验与提示词都依赖这份结构，
  改形状就等于改语义，必须提升版本。
- 这里不引入向量数据库、Embedding 或任何新依赖。第一版只用现有标签及其
  关联关系。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

# --------------------------------------------------------------- 优先级取值

PRIORITY_HIGH = 'high'
PRIORITY_MEDIUM = 'medium'
PRIORITY_LOW = 'low'
# unknown 是「模型无法判断」，属于业务结果的一种，不是第四个等级。
PRIORITY_UNKNOWN = 'unknown'

#: 业务决策的四选一。Jev 与 LLM 对业务层统一返回这四个值。
DECISION_PRIORITIES = (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW, PRIORITY_UNKNOWN)

#: 人工可以手动指定的档位。unknown 不能被人工指定。
MANUAL_PRIORITIES = (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)

#: 有意义的等级（不含 unknown），用于最终优先级。
ASSIGNED_PRIORITIES = (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)

# --------------------------------------------------------------- 来源标识

ORIGIN_MANUAL = 'manual'
ORIGIN_SMART = 'smart'
ORIGIN_SOURCE = 'source'
# none 表示既没有人工值，也没有智能结果，来源也没设默认值。
ORIGIN_NONE = 'none'

PRIORITY_ORIGINS = (ORIGIN_MANUAL, ORIGIN_SMART, ORIGIN_SOURCE, ORIGIN_NONE)

# --------------------------------------------------------------- 执行状态
#
# 状态是「这次判断为什么是这个结果」的有界原因集合。它与业务决策分开保存：
# unknown + model_unknown 表示模型明确说无法判断；unknown + invalid_response
# 表示协议没给出合法答案；两者都兜底，但不能混为一谈。

STATUS_OK = 'ok'
STATUS_MODEL_UNKNOWN = 'model_unknown'
STATUS_INVALID_RESPONSE = 'invalid_response'
STATUS_NOT_CONFIGURED = 'not_configured'
STATUS_TIMEOUT = 'timeout'
STATUS_NETWORK_FAILED = 'network_failed'
STATUS_CANCELLED = 'cancelled'
STATUS_INPUT_BUDGET_EXCEEDED = 'input_budget_exceeded'
STATUS_NO_TITLE = 'no_title'
STATUS_NO_TAGS = 'no_tags'
STATUS_NO_EVIDENCE = 'no_evidence'
STATUS_INCONSISTENT = 'inconsistent'

DECISION_STATUSES = (
    STATUS_OK, STATUS_MODEL_UNKNOWN, STATUS_INVALID_RESPONSE, STATUS_NOT_CONFIGURED,
    STATUS_TIMEOUT, STATUS_NETWORK_FAILED, STATUS_CANCELLED,
    STATUS_INPUT_BUDGET_EXCEEDED, STATUS_NO_TITLE, STATUS_NO_TAGS,
    STATUS_NO_EVIDENCE, STATUS_INCONSISTENT,
)

#: 这些状态表示「根本没有发出请求」，因此不计入模型调用次数。
LOCAL_ONLY_STATUSES = frozenset({
    STATUS_INPUT_BUDGET_EXCEEDED, STATUS_NO_TITLE, STATUS_NO_TAGS,
    STATUS_NO_EVIDENCE, STATUS_INCONSISTENT,
})

# --------------------------------------------------------------- 上下文契约

#: 上下文结构版本。形状变了就换版本号，并纳入缓存与在途结果校验。
CONTEXT_SCHEMA_VERSION = 'priority_context_v1'

#: 第一版输入预算（工程默认值，不是模型效果保证）。
MAX_TARGET_TAGS = 12
MAX_TARGET_TITLE = 240
MAX_SAMPLE_TITLE = 160
MAX_CONTEXT_CHARS = 24000

#: 每一档最多保留两个历史标题样本。
MAX_SAMPLES_PER_GROUP = 2


@dataclass(frozen=True)
class TagCatalogEntry:
    """标签目录里的一条：ID 用于关联，名称／描述／别名用于理解范围。"""

    id: str
    name: str
    description: str = ''
    synonyms: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {'id': self.id, 'name': self.name, 'description': self.description,
                'synonyms': list(self.synonyms)}


@dataclass(frozen=True)
class HistoryGroup:
    """某个「优先级 × 标签」分组的读取结果。

    分组不存在时用 ``content_count=0``、空样本表示。空组只说明没有证据，
    不等于低优先级（计划 §3.5 第 5 条）。
    """

    tag_id: str
    content_count: int
    recent_sample_ids: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {'tag_id': self.tag_id, 'content_count': int(self.content_count),
                'recent_sample_ids': list(self.recent_sample_ids)}


@dataclass(frozen=True)
class ContextSample:
    """一条历史内容的标题缓存。只有 ID 与标题，没有正文与链接。"""

    id: str
    title: str = ''

    def to_dict(self) -> dict:
        return {'id': self.id, 'title': self.title}


@dataclass(frozen=True)
class PriorityContextV1:
    """送进模型的统一上下文。LLM 与 Jev 必须拿到同一份。"""

    target_title: str
    target_tag_ids: tuple[str, ...] = ()
    tag_catalog: tuple[TagCatalogEntry, ...] = ()
    history: Mapping[str, tuple[HistoryGroup, ...]] = field(default_factory=dict)
    samples: tuple[ContextSample, ...] = ()
    titles_truncated: bool = False

    def to_dict(self) -> dict:
        return {
            'schema_version': CONTEXT_SCHEMA_VERSION,
            'target': {'title': self.target_title, 'tag_ids': list(self.target_tag_ids)},
            'tag_catalog': [entry.to_dict() for entry in self.tag_catalog],
            'history': {
                level: [group.to_dict() for group in groups]
                for level, groups in self.history.items()
            },
            'samples': [sample.to_dict() for sample in self.samples],
            'input_limits': {'titles_truncated': bool(self.titles_truncated)},
        }


@dataclass(frozen=True)
class PriorityContextSnapshot:
    """本地执行快照：用于缓存键与返回后的过期校验，不必发给模型。"""

    content_version: str = ''
    tag_version: str = ''
    manual_version: int = 0
    preference_version: str = ''
    policy_version: str = ''
    provider_version: str = ''
    prompt_version: str = ''

    def to_dict(self) -> dict:
        return {
            'contentVersion': self.content_version,
            'tagVersion': self.tag_version,
            'manualVersion': int(self.manual_version),
            'preferenceVersion': self.preference_version,
            'policyVersion': self.policy_version,
            'providerVersion': self.provider_version,
            'promptVersion': self.prompt_version,
        }


@dataclass(frozen=True)
class PriorityContextResult:
    """上下文构建结果。

    ``payload`` 为 None 表示这次不发请求，``status`` 给出有界原因。
    """

    status: str
    context: PriorityContextV1 | None = None
    payload: str | None = None
    fingerprint: str = ''
    snapshot: PriorityContextSnapshot = field(default_factory=PriorityContextSnapshot)

    @property
    def usable(self) -> bool:
        """是否可以拿去请求模型。"""
        return self.payload is not None and self.status == STATUS_OK


@dataclass(frozen=True)
class PriorityDecision:
    """一次智能判断的结果。

    ``priority`` 是业务决策（四选一），``status`` 是执行状态。两者分开保存，
    因此「模型说无法判断」与「调用失败」不会混成同一件事。
    """

    priority: str
    status: str = STATUS_OK
    provider_id: str | None = None
    model: str | None = None
    context_fingerprint: str = ''
    snapshot: PriorityContextSnapshot = field(default_factory=PriorityContextSnapshot)

    @property
    def assigned(self) -> bool:
        """是否给出了有效档位。unknown 不算。"""
        return self.priority in ASSIGNED_PRIORITIES

    def to_dict(self) -> dict:
        return {
            'priority': self.priority,
            'status': self.status,
            'providerId': self.provider_id,
            'model': self.model,
            'contextFingerprint': self.context_fingerprint,
            'versions': self.snapshot.to_dict(),
        }


@dataclass(frozen=True)
class ResolvedPriority:
    """最终优先级与它的来源。

    ``level`` 为 None 表示「未设置」：没有人工值、没有智能结果，来源也没默认值。
    """

    level: str | None
    origin: str

    def to_dict(self) -> dict:
        return {'level': self.level, 'origin': self.origin}


def resolve_priority(manual=None, smart=None, source_default=None) -> ResolvedPriority:
    """按固定顺序解析最终优先级（计划 §1）。

    顺序是：人工值 → 智能结果 → 来源默认值 → 未设置。
    ``smart`` 传入时必须是有效档位；unknown 等价于没有智能结果。
    这是一个纯函数：不查库、不发请求、不回写任何一处取值。
    """
    if manual in ASSIGNED_PRIORITIES:
        return ResolvedPriority(manual, ORIGIN_MANUAL)
    if smart in ASSIGNED_PRIORITIES:
        return ResolvedPriority(smart, ORIGIN_SMART)
    if source_default in ASSIGNED_PRIORITIES:
        return ResolvedPriority(source_default, ORIGIN_SOURCE)
    return ResolvedPriority(None, ORIGIN_NONE)


__all__ = [
    'PRIORITY_HIGH', 'PRIORITY_MEDIUM', 'PRIORITY_LOW', 'PRIORITY_UNKNOWN',
    'DECISION_PRIORITIES', 'MANUAL_PRIORITIES', 'ASSIGNED_PRIORITIES',
    'ORIGIN_MANUAL', 'ORIGIN_SMART', 'ORIGIN_SOURCE', 'ORIGIN_NONE', 'PRIORITY_ORIGINS',
    'STATUS_OK', 'STATUS_MODEL_UNKNOWN', 'STATUS_INVALID_RESPONSE', 'STATUS_NOT_CONFIGURED',
    'STATUS_TIMEOUT', 'STATUS_NETWORK_FAILED', 'STATUS_CANCELLED',
    'STATUS_INPUT_BUDGET_EXCEEDED', 'STATUS_NO_TITLE', 'STATUS_NO_TAGS',
    'STATUS_NO_EVIDENCE', 'STATUS_INCONSISTENT', 'DECISION_STATUSES', 'LOCAL_ONLY_STATUSES',
    'CONTEXT_SCHEMA_VERSION', 'MAX_TARGET_TAGS', 'MAX_TARGET_TITLE', 'MAX_SAMPLE_TITLE',
    'MAX_CONTEXT_CHARS', 'MAX_SAMPLES_PER_GROUP',
    'TagCatalogEntry', 'HistoryGroup', 'ContextSample', 'PriorityContextV1',
    'PriorityContextSnapshot', 'PriorityContextResult', 'PriorityDecision', 'ResolvedPriority',
    'resolve_priority',
]
