"""OpenAI 兼容聊天协议适配器。

只负责「把消息发出去、把文本取回来」：不内置任何业务 prompt，也不把输出
解析成业务结构。调用方（打标、总结）自己组织消息与提示词。
"""

from __future__ import annotations

from ..contracts import (
    ERROR_INVALID_RESPONSE, PROTOCOL_OPENAI_CHAT, AiError, ChatMessage, ChatResult,
)


class OpenAiChatAdapter:
    """`POST {endpoint}/chat/completions` 的最小实现。"""

    protocol = PROTOCOL_OPENAI_CHAT

    def __init__(self, *, endpoint: str, model: str, api_key: str, transport=None,
                 timeout: float | None = None, max_tokens: int = 512):
        self.endpoint = (endpoint or '').rstrip('/')
        self.model = model or ''
        self.api_key = api_key or ''
        self.timeout = timeout
        self.max_tokens = max_tokens
        self._transport = transport

    def transport(self):
        if self._transport is None:
            from ..transport import HttpTransport
            self._transport = HttpTransport(self.timeout or 30.0)
        return self._transport

    def chat(self, messages, max_tokens: int | None = None) -> ChatResult:
        """发一轮对话，返回文本。消息是 (role, content) 序列。"""
        payload = {
            'model': self.model,
            'max_tokens': max_tokens or self.max_tokens,
            'messages': [{'role': role, 'content': content} for role, content in messages],
        }
        _, body = self.transport().post_json(f'{self.endpoint}/chat/completions', payload,
                                            {'Authorization': f'Bearer {self.api_key}'}, self.timeout)
        return ChatResult(text=self._content(body), model=self._model(body), usage=self._usage(body),
                          provider=self.protocol)

    # ------------------------------------------------------------ 响应解析

    @staticmethod
    def _content(body: dict) -> str:
        choices = body.get('choices')
        if not isinstance(choices, list) or not choices:
            raise AiError(ERROR_INVALID_RESPONSE, '模型服务没有返回 choices')
        message = choices[0].get('message') if isinstance(choices[0], dict) else None
        if not isinstance(message, dict):
            raise AiError(ERROR_INVALID_RESPONSE, '模型服务返回的 message 结构不符合约定')
        content = message.get('content')
        if not isinstance(content, str) or not content.strip():
            raise AiError(ERROR_INVALID_RESPONSE, '模型服务返回了空内容')
        return content

    @staticmethod
    def _model(body: dict) -> str | None:
        value = body.get('model')
        return value if isinstance(value, str) and value else None

    @staticmethod
    def _usage(body: dict) -> dict | None:
        usage = body.get('usage')
        # 服务给了什么就记什么，没给就留空，不编造用量与价格。
        return usage if isinstance(usage, dict) and usage else None


__all__ = ['OpenAiChatAdapter']
