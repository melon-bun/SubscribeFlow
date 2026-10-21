"""M25 公共 AI 层。

能力注册、协议适配器、通用生成／候选分类与受保护凭据组装都在这里。
这一层不依赖内容、标签、笔记或任何业务任务表：拿掉它，采集、内容查询与
人工标签照常工作；接上它，打标、总结与将来的服务可以共用同一批连接。
"""

from .contracts import (
    CAPABILITY_CANDIDATE_CLASSIFICATION, CAPABILITY_TEXT_GENERATION, PROTOCOL_JEV_SYSTEMONE,
    PROTOCOL_OPENAI_CHAT, PROTOCOLS, AiError, ChatResult, ClassificationResult, ProviderConfig,
)
from .gateway import AiGateway
from .registry import (
    capabilities_of, call_changed, migrate_providers, normalize_providers, references,
)

__all__ = [
    'AiError', 'AiGateway', 'ProviderConfig', 'ChatResult', 'ClassificationResult',
    'PROTOCOLS', 'PROTOCOL_OPENAI_CHAT', 'PROTOCOL_JEV_SYSTEMONE',
    'CAPABILITY_TEXT_GENERATION', 'CAPABILITY_CANDIDATE_CLASSIFICATION',
    'normalize_providers', 'migrate_providers', 'capabilities_of', 'call_changed', 'references',
]
