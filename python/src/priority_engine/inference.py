"""M39 优先级判断：两条协议路径的拼装、解析与收敛。

这一层只做三件事：把统一上下文按协议拼成请求、把回答解析成一个业务决策、
把执行失败映射成独立状态。它不认识数据库、不认识界面，也不自己发网络请求——
调用走注入进来的公共 AI 网关。

三条纪律：

- **解析严格**。LLM 的回答必须是「只有一个 priority 字段、值是四选一之一」的
  JSON 对象。重复键、额外字段、错误类型、非法枚举、非 JSON、截断输出，
  一律算非法响应：状态 ``invalid_response``，业务结果 ``unknown``。
  协议失败不冒充一次有效的模型「无法判断」。
- **收敛规则集中**。Jev 的四问按明确阈值收敛，常量只在这里维护，
  不散落到前端或公共 AI 网关。边界比较留了一点浮点余量，
  避免本应差 0.2 的分值被误拒。
- **不借用标签引擎的低分强取**。打标那套「低于阈值也挑一个最像的」逻辑
  在这里没有意义：优先级宁可判不出来，也不能猜错。
"""

from __future__ import annotations

import json
import math
import re

from .contracts import (
    DECISION_PRIORITIES,
    PRIORITY_HIGH,
    PRIORITY_LOW,
    PRIORITY_MEDIUM,
    PRIORITY_UNKNOWN,
    STATUS_INVALID_RESPONSE,
    STATUS_MODEL_UNKNOWN,
    STATUS_NETWORK_FAILED,
    STATUS_NOT_CONFIGURED,
    STATUS_OK,
    STATUS_TIMEOUT,
    STATUS_CANCELLED,
    PriorityContextSnapshot,
    PriorityDecision,
)
from .prompts import PROMPT_VERSION, jev_questions, llm_system_message

#: Jev 四问的固定顺序。
JEV_OPTIONS = ('high', 'medium', 'low', 'unknown')

#: 采纳某一档所需的最低分值。
JEV_ACCEPT_THRESHOLD = 0.8
#: 采纳某一档所需的与次高选项的最小差距。
JEV_MIN_MARGIN = 0.2
#: unknown 分值达到这个值就直接判为无法判断。
JEV_UNKNOWN_FLOOR = 0.5
#: 浮点余量：0.8 - 0.6 这类差值在二进制浮点里不精确，边界要留一点。
BOUNDARY_EPSILON = 1e-9

#: 单次回答的 token 预算。计划里的示意值是 64，但推理型模型会把预算先花在
#: 思考块上：64 token 只会得到一段被截断的思考，回答本身根本没生成。
#: 1024 足够放下一段思考加一个 JSON 对象。判断规则与解析的严格程度不受影响。
DEFAULT_MAX_TOKENS = 1024

#: 公共 AI 层的错误分类 → 本模块的执行状态。协议失败的分类在这一层统一收口。
ERROR_STATUS = {
    'not_configured': STATUS_NOT_CONFIGURED,
    'invalid_input': STATUS_NOT_CONFIGURED,
    'auth_failed': STATUS_NOT_CONFIGURED,
    'timeout': STATUS_TIMEOUT,
    'network_failed': STATUS_NETWORK_FAILED,
    'rate_limited': STATUS_NETWORK_FAILED,
    'cancelled': STATUS_CANCELLED,
    'invalid_response': STATUS_INVALID_RESPONSE,
}


class _DuplicateKey(ValueError):
    """JSON 对象里有重复键。"""


#: 推理型模型会在回答前给一段思考；判断规则要求它只输出 JSON 对象，
#: 但思考块与代码围栏是**传输层的包装**，不是业务内容。剥掉包装之后
#: 仍然按严格规则解析对象本身：多字段、重复键、错类型、非法枚举一律无效。
_THINK_BLOCK = re.compile(r'<think>.*?</think>', re.DOTALL | re.IGNORECASE)
_CODE_FENCE = re.compile(r'^```[a-zA-Z0-9_-]*\s*(.*?)\s*```$', re.DOTALL)


def _unwrap(text: str) -> str:
    """剥掉思考块与代码围栏，只留下可能的 JSON 本体。"""
    stripped = _THINK_BLOCK.sub('', text).strip()
    match = _CODE_FENCE.match(stripped)
    if match:
        stripped = match.group(1).strip()
    return stripped


def _object_without_duplicates(pairs):
    """json 的 object_pairs_hook：重复键直接判为无效。"""
    result = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def parse_priority_json(text) -> tuple[str, str]:
    """严格解析 LLM 的单字段 JSON。返回 (业务决策, 执行状态)。

    合法回答 ``{"priority":"high"}`` → ``('high', 'ok')``；
    合法但表示无法判断 → ``('unknown', 'model_unknown')``；
    其余一律 ``('unknown', 'invalid_response')``。
    """
    if not isinstance(text, str) or not text.strip():
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    try:
        payload = json.loads(_unwrap(text), object_pairs_hook=_object_without_duplicates)
    except (ValueError, TypeError):
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    if not isinstance(payload, dict) or set(payload) != {'priority'}:
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    value = payload['priority']
    if isinstance(value, bool) or not isinstance(value, str):
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    if value not in DECISION_PRIORITIES:
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    if value == PRIORITY_UNKNOWN:
        return PRIORITY_UNKNOWN, STATUS_MODEL_UNKNOWN
    return value, STATUS_OK


def resolve_jev_priority(probabilities) -> tuple[str, str]:
    """Jev 四问的收敛。返回 (业务决策, 执行状态)。

    规则（计划 §3.7）：

    1. 四个答案必须齐全且无额外答案，值必须为有限的 0～1 数值，布尔值不算；
    2. 任一答案不合法 → ``invalid_response``，业务结果 unknown；
    3. ``unknown`` 分值不低于 0.5 → unknown；
    4. high／medium／low 中最高分不低于 0.8，且比其余选项中的最高分至少高 0.2；
    5. 其余情况（同分、最高分不足、多档同时高分）→ unknown。
    """
    if not isinstance(probabilities, dict) or set(probabilities) != set(JEV_OPTIONS):
        return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
    scores = {}
    for key in JEV_OPTIONS:
        value = probabilities[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
        if not math.isfinite(value) or value < 0.0 or value > 1.0:
            return PRIORITY_UNKNOWN, STATUS_INVALID_RESPONSE
        scores[key] = float(value)
    if scores[PRIORITY_UNKNOWN] >= JEV_UNKNOWN_FLOOR - BOUNDARY_EPSILON:
        return PRIORITY_UNKNOWN, STATUS_MODEL_UNKNOWN
    candidates = {key: scores[key] for key in (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)}
    best = max(candidates, key=lambda key: (candidates[key], key))
    others = max(value for key, value in candidates.items() if key != best)
    if (candidates[best] >= JEV_ACCEPT_THRESHOLD - BOUNDARY_EPSILON
            and candidates[best] - others >= JEV_MIN_MARGIN - BOUNDARY_EPSILON):
        return best, STATUS_OK
    return PRIORITY_UNKNOWN, STATUS_MODEL_UNKNOWN


class PriorityInference:
    """按协议拼装请求并解析回答。

    ``caller`` 是协议适配器（公共 AI 网关按所选连接组装出来的那一个），
    它只需要有 ``chat`` 与 ``classify`` 两个方法。这一层因此不导入公共 AI 层，
    也不认识密钥与设置。
    """

    def __init__(self, *, prompt_version: str = PROMPT_VERSION, max_tokens: int = DEFAULT_MAX_TOKENS):
        self.prompt_version = prompt_version
        self.max_tokens = max_tokens

    # ------------------------------------------------------------ 拼装

    def build_llm_messages(self, payload: str) -> list:
        """LLM 的两条消息：system 是规则全文加输出约束，user 是上下文 JSON。"""
        return [('system', llm_system_message()), ('user', payload)]

    def build_jev_questions(self) -> dict:
        """Jev 的四问。每问都是共用规则全文加对应问题文本。"""
        return jev_questions()

    # ------------------------------------------------------------ 判断

    def judge(self, *, caller, mode: str, payload: str,
              context_fingerprint: str = '', snapshot: PriorityContextSnapshot | None = None) -> PriorityDecision:
        """请求一次判断。永不抛异常：失败也是一份有状态的结果。

        ``mode`` 是 ``'llm'`` 或 ``'jev'``，由调用方按适配器的协议决定。
        """
        snapshot = snapshot or PriorityContextSnapshot()
        try:
            if mode == 'jev':
                result = caller.classify(payload, self.build_jev_questions())
                priority, status = resolve_jev_priority(getattr(result, 'probabilities', None))
            else:
                result = caller.chat(self.build_llm_messages(payload), self.max_tokens)
                priority, status = parse_priority_json(getattr(result, 'text', ''))
        except Exception as error:
            code = str(getattr(error, 'code', '') or '')
            status = ERROR_STATUS.get(code, STATUS_NETWORK_FAILED)
            return PriorityDecision(PRIORITY_UNKNOWN, status,
                                    context_fingerprint=context_fingerprint, snapshot=snapshot)
        return PriorityDecision(priority, status, provider_id=getattr(caller, 'provider_id', None),
                                model=getattr(result, 'model', None),
                                context_fingerprint=context_fingerprint, snapshot=snapshot)


__all__ = [
    'PriorityInference', 'parse_priority_json', 'resolve_jev_priority',
    'JEV_OPTIONS', 'JEV_ACCEPT_THRESHOLD', 'JEV_MIN_MARGIN', 'JEV_UNKNOWN_FLOOR',
    'BOUNDARY_EPSILON', 'ERROR_STATUS', 'DEFAULT_MAX_TOKENS',
]
