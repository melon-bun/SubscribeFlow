"""公共 AI 网关：把「调用哪条连接」变成「拿到结果」。

这里是未来所有业务服务（打标、总结、将来的第三项）共用的入口：
业务只说「用哪条连接、做什么」，不接触协议细节，也不接触密钥。

三条边界：
- 不导入打标、笔记、总结等服务，也不认识内容、标签、任务表；
- 密钥只在调用这一刻从受保护凭据容器取用，不落库、不进日志、不返回给界面；
- 连接测试走协议最小固定探针，不执行业务任务，也不产生任何标签或笔记。
"""

from __future__ import annotations

from .adapters.jev_systemone import JevSystemOneAdapter
from .adapters.openai_chat import OpenAiChatAdapter
from .contracts import (
    CAPABILITY_CANDIDATE_CLASSIFICATION, CAPABILITY_TEXT_GENERATION, ERROR_INVALID_INPUT,
    ERROR_NOT_CONFIGURED, AiError, ChatResult, ClassificationResult, ProviderConfig,
)
from .registry import capabilities_of, normalize_providers

# 协议 → 适配器。新协议在这里登记，能力由适配器决定，不由调用方声明。
ADAPTERS = {
    'openai_chat': OpenAiChatAdapter,
    'jev_systemone': JevSystemOneAdapter,
}

# 最小探针：只验证协议通不通，不带任何业务内容。
PROBE_TEXT = '连接测试。'
PROBE_QUESTION = '这是一次连接测试，请只回答是否可用。'


class AiGateway:
    def __init__(self, *, settings, credentials, transport=None, clock=None):
        self.settings = settings
        self.credentials = credentials
        self.transport = transport
        self.clock = clock or (lambda: 0)

    # ------------------------------------------------------------ 读取

    def providers(self) -> list[dict]:
        """连接列表：给界面看的能力与可用状态，不含凭据引用。"""
        config = self.settings.snapshot()
        result = []
        for provider in self._providers(config).values():
            result.append({
                'id': provider.id,
                'name': provider.name,
                'protocol': provider.protocol,
                'endpoint': provider.endpoint,
                'model': provider.model,
                'enabled': bool(provider.enabled),
                'revision': int(provider.revision),
                'capabilities': list(capabilities_of(provider.protocol)),
                'missing': self.missing_items(provider),
                'configured': not self.missing_items(provider),
            })
        return result

    def provider(self, provider_id: str) -> ProviderConfig:
        config = self.settings.snapshot()
        providers = self._providers(config)
        provider = providers.get(provider_id)
        if provider is None:
            raise AiError(ERROR_INVALID_INPUT, '找不到这条 AI 连接。')
        return provider

    def missing_items(self, provider: ProviderConfig) -> list:
        missing = []
        if not provider.endpoint:
            missing.append('接口地址')
        if not provider.model:
            missing.append('模型标识')
        if not self._secret(provider):
            missing.append('API Key')
        if not provider.enabled:
            missing.append('已停用')
        return missing

    def _providers(self, config: dict) -> dict:
        ai = config.get('ai') or {}
        return normalize_providers(ai.get('providers'))

    def _secret(self, provider: ProviderConfig) -> str | None:
        reference = provider.credential_ref
        if not reference:
            return None
        return self.credentials.secret_for(reference)

    def adapter(self, provider_id: str):
        """按连接 ID 组装协议适配器（凭据在这一刻取用）。

        需要自己组织请求的业务（例如打标的标签提示词）可以从这里拿到适配器，
        不必自己碰密钥。
        """
        return self._adapter(self.provider(provider_id))

    def _adapter(self, provider: ProviderConfig):
        factory = ADAPTERS.get(provider.protocol)
        if factory is None:
            raise AiError(ERROR_NOT_CONFIGURED, f'暂不支持的协议：{provider.protocol}')
        secret = self._secret(provider)
        missing = []
        if not provider.endpoint:
            missing.append('接口地址')
        if not provider.model:
            missing.append('模型标识')
        if not secret:
            missing.append('API Key')
        if missing:
            raise AiError(ERROR_NOT_CONFIGURED, '连接尚未配置完整：' + '、'.join(missing))
        return factory(endpoint=provider.endpoint, model=provider.model, api_key=secret,
                       transport=self.transport, timeout=None)

    # ------------------------------------------------------------ 调用

    def chat(self, provider_id: str, messages, max_tokens: int | None = None) -> ChatResult:
        """通用文本生成。调用方自己组织消息与提示词。"""
        provider = self.provider(provider_id)
        if not provider.supports(CAPABILITY_TEXT_GENERATION):
            raise AiError(ERROR_NOT_CONFIGURED,
                          f'这条连接不支持文本生成（{provider.protocol}）。')
        adapter = self._adapter(provider)
        return adapter.chat(messages, max_tokens)

    def classify(self, provider_id: str, state: str, questions: dict) -> ClassificationResult:
        """候选分类。问题文本由调用方给，适配器只负责协议往返。"""
        provider = self.provider(provider_id)
        if not provider.supports(CAPABILITY_CANDIDATE_CLASSIFICATION):
            raise AiError(ERROR_NOT_CONFIGURED,
                          f'这条连接不支持候选分类（{provider.protocol}）。')
        adapter = self._adapter(provider)
        return adapter.classify(state, questions)

    # ------------------------------------------------------------ 探针

    def test_connection(self, provider_id: str) -> dict:
        """协议最小探针：只验证这条连接能不能通，不执行业务任务。"""
        provider = self.provider(provider_id)
        try:
            adapter = self._adapter(provider)
        except AiError as error:
            return {'ok': False, 'code': error.code, 'message': error.message, 'retryable': False}
        try:
            if provider.supports(CAPABILITY_TEXT_GENERATION):
                result = adapter.chat([('user', PROBE_TEXT)], max_tokens=16)
                return {'ok': True, 'provider': provider.protocol, 'model': result.model,
                        'message': '连接正常，协议可用。'}
            result = adapter.classify(PROBE_TEXT, {'probe': PROBE_QUESTION})
            return {'ok': True, 'provider': provider.protocol, 'model': result.model,
                    'message': '连接正常，协议可用。'}
        except AiError as error:
            return {'ok': False, 'code': error.code, 'message': error.message,
                    'retryable': error.retryable}
        except Exception:
            return {'ok': False, 'code': 'invalid_response',
                    'message': '接口返回了无法解析的结果。', 'retryable': False}


__all__ = ['AiGateway', 'ADAPTERS']
