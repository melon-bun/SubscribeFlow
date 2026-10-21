"""M25 公共 AI 层的契约。

这一层只回答三个问题：有哪些连接、这条连接能做什么、怎么调它。
它不认识内容、标签、笔记或任何后台任务表，也不导入应用层的业务服务。

三条边界，任何一条都不能靠「以后再说」绕过：
- 能力由协议适配器派生，调用方不能自己声明某个连接「能做总结」；
- 通用生成只返回文本，不内置任何业务的 prompt，也不把输出解析成业务结构；
- 错误分类在这一层统一，业务层只按 code 与 retryable 分流。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 协议。第一期只承诺这两种：现有 OpenAI 兼容聊天与现有 Jev 协议。
# 不暗示任意厂商原生协议都能直接用。
PROTOCOL_OPENAI_CHAT = 'openai_chat'
PROTOCOL_JEV_SYSTEMONE = 'jev_systemone'
PROTOCOLS = (PROTOCOL_OPENAI_CHAT, PROTOCOL_JEV_SYSTEMONE)

PROTOCOL_LABELS = {
    PROTOCOL_OPENAI_CHAT: 'OpenAI 兼容聊天',
    PROTOCOL_JEV_SYSTEMONE: 'Jev 候选分类',
}

# 能力。文本生成可供打标与总结调用；候选分类只服务于「在已有目录里挑」。
CAPABILITY_TEXT_GENERATION = 'text_generation'
CAPABILITY_CANDIDATE_CLASSIFICATION = 'candidate_classification'

PROTOCOL_CAPABILITIES = {
    PROTOCOL_OPENAI_CHAT: (CAPABILITY_TEXT_GENERATION,),
    PROTOCOL_JEV_SYSTEMONE: (CAPABILITY_CANDIDATE_CLASSIFICATION,),
}

# 错误分类。每类都带 retryable，调用方据此决定退避重试还是进入阻塞状态。
ERROR_NOT_CONFIGURED = 'not_configured'
ERROR_AUTH = 'auth_failed'
ERROR_RATE_LIMITED = 'rate_limited'
ERROR_TIMEOUT = 'timeout'
ERROR_NETWORK = 'network_failed'
ERROR_INVALID_RESPONSE = 'invalid_response'
ERROR_CANCELLED = 'cancelled'
ERROR_INVALID_INPUT = 'invalid_input'

ERROR_RETRYABLE = frozenset({ERROR_RATE_LIMITED, ERROR_TIMEOUT, ERROR_NETWORK})


class AiError(Exception):
    """AI 调用失败。message 只描述原因，不携带密钥、完整原文或响应正文。"""

    def __init__(self, code: str, message: str, *, retryable: bool | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = ERROR_RETRYABLE.__contains__(code) if retryable is None else bool(retryable)

    def to_dict(self) -> dict:
        return {'code': self.code, 'message': self.message, 'retryable': self.retryable}


@dataclass(frozen=True)
class ProviderConfig:
    """一条 AI 连接的调用配置。

    身份是稳定的资源 ID：业务服务按 ID 引用它，不按名字，也不按
    「打标用哪条、总结用哪条」这种固定槽位。它不保存任何业务的 prompt 或策略。
    """

    id: str
    name: str = ''
    protocol: str = PROTOCOL_OPENAI_CHAT
    endpoint: str = ''
    model: str = ''
    credential_ref: str | None = None
    enabled: bool = True
    # 调用配置版本：只在协议／地址／模型／凭据／启用状态变化时递增。
    # 改展示名不动它——改名不该让在途结果作废。
    revision: int = 1

    @property
    def capabilities(self) -> tuple[str, ...]:
        return PROTOCOL_CAPABILITIES.get(self.protocol, ())

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    def call_signature(self) -> dict:
        """参与「调用配置是否变化」判定的部分。不含名称。"""
        return {
            'protocol': self.protocol,
            'endpoint': self.endpoint,
            'model': self.model,
            'credentialRef': self.credential_ref or '',
            'enabled': bool(self.enabled),
        }

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'name': self.name,
            'protocol': self.protocol,
            'endpoint': self.endpoint,
            'model': self.model,
            'credentialRef': self.credential_ref,
            'enabled': bool(self.enabled),
            'revision': int(self.revision),
        }

    @staticmethod
    def from_dict(value: dict) -> 'ProviderConfig':
        if not isinstance(value, dict):
            raise ValueError('连接配置必须是对象')
        provider_id = value.get('id')
        if not isinstance(provider_id, str) or not provider_id:
            raise ValueError('连接配置缺少稳定 ID')
        protocol = value.get('protocol') or PROTOCOL_OPENAI_CHAT
        if protocol not in PROTOCOL_CAPABILITIES:
            raise ValueError('连接配置使用了不支持的协议')
        revision = value.get('revision', 1)
        if type(revision) is not int or revision < 1:
            raise ValueError('连接配置的版本号无效')
        return ProviderConfig(
            id=provider_id,
            name=value.get('name') or '',
            protocol=protocol,
            endpoint=value.get('endpoint') or '',
            model=value.get('model') or '',
            credential_ref=value.get('credentialRef'),
            enabled=bool(value.get('enabled', True)),
            revision=revision,
        )


@dataclass(frozen=True)
class ChatMessage:
    role: str
    content: str


@dataclass(frozen=True)
class ChatResult:
    """一次通用文本生成的结果。只给文本，不做业务解析。"""

    text: str
    model: str | None = None
    usage: dict | None = None
    provider: str = ''


@dataclass(frozen=True)
class ClassificationResult:
    """一次候选分类的结果。概率表由协议适配器给出，业务门槛由调用方判断。"""

    probabilities: dict = field(default_factory=dict)
    model: str | None = None
    usage: dict | None = None
    provider: str = ''


__all__ = [
    'AiError', 'ProviderConfig', 'ChatMessage', 'ChatResult', 'ClassificationResult',
    'PROTOCOL_OPENAI_CHAT', 'PROTOCOL_JEV_SYSTEMONE', 'PROTOCOLS', 'PROTOCOL_LABELS',
    'PROTOCOL_CAPABILITIES', 'CAPABILITY_TEXT_GENERATION', 'CAPABILITY_CANDIDATE_CLASSIFICATION',
    'ERROR_NOT_CONFIGURED', 'ERROR_AUTH', 'ERROR_RATE_LIMITED', 'ERROR_TIMEOUT',
    'ERROR_NETWORK', 'ERROR_INVALID_RESPONSE', 'ERROR_CANCELLED', 'ERROR_INVALID_INPUT',
    'ERROR_RETRYABLE',
]
