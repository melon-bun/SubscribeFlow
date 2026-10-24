"""M36–M38 智能优先级包。

边界与 ``tagging_engine`` 一致：

- 不导入 ``subscribe_flow``、SQLite、渠道模块、Electron 或 RPC；
- 只有自身契约、上下文构建与提示词；
- 读取数据库与模型调用都在外层，这个包自己不发请求也不读磁盘。

拿掉这个包，采集、内容查询、人工标签与来源兜底都照常工作。
"""

from .context import PriorityContextBuilder, build_context
from .contracts import (
    ASSIGNED_PRIORITIES,
    CONTEXT_SCHEMA_VERSION,
    DECISION_PRIORITIES,
    DECISION_STATUSES,
    MANUAL_PRIORITIES,
    ORIGIN_MANUAL,
    ORIGIN_NONE,
    ORIGIN_SMART,
    ORIGIN_SOURCE,
    PRIORITY_ORIGINS,
    ContextSample,
    HistoryGroup,
    PriorityContextResult,
    PriorityContextSnapshot,
    PriorityContextV1,
    PriorityDecision,
    ResolvedPriority,
    TagCatalogEntry,
    resolve_priority,
)
from .inference import (
    PriorityInference,
    parse_priority_json,
    resolve_jev_priority,
)
from .prompts import (
    JEV_QUESTION_ORDER,
    JEV_QUESTION_SUFFIXES_V1,
    LLM_OUTPUT_RULES_V1,
    PRIORITY_RULES_V1,
    PROMPT_VERSION,
    jev_questions,
    llm_system_message,
)

__all__ = [
    'ASSIGNED_PRIORITIES', 'CONTEXT_SCHEMA_VERSION', 'DECISION_PRIORITIES', 'DECISION_STATUSES',
    'MANUAL_PRIORITIES', 'ORIGIN_MANUAL', 'ORIGIN_NONE', 'ORIGIN_SMART', 'ORIGIN_SOURCE',
    'PRIORITY_ORIGINS', 'ContextSample', 'HistoryGroup', 'PriorityContextResult',
    'PriorityContextSnapshot', 'PriorityContextV1', 'PriorityDecision', 'ResolvedPriority',
    'TagCatalogEntry', 'resolve_priority',
    'PriorityContextBuilder', 'build_context',
    'PriorityInference', 'parse_priority_json', 'resolve_jev_priority',
    'PROMPT_VERSION', 'PRIORITY_RULES_V1', 'LLM_OUTPUT_RULES_V1',
    'JEV_QUESTION_SUFFIXES_V1', 'JEV_QUESTION_ORDER', 'llm_system_message', 'jev_questions',
]
