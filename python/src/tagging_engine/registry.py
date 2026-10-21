"""Provider 接口与组装注册。

换模型只改这里的选择逻辑，不触碰采集与内容查询（计划 §3.1）。
"""

from __future__ import annotations

from .contracts import ERROR_NOT_CONFIGURED, RecognitionError
from .providers.jev import JevProvider
from .providers.llm import LlmProvider


class Provider:
    """识别提供者的最小接口：拿到请求，产出结果。"""

    name = ''

    def recognize(self, request):
        raise NotImplementedError


def build_provider(mode: str, *, endpoint: str = '', model: str = '', api_key: str | None = None,
                   threshold: float | None = None, batch: int | None = None,
                   transport=None, timeout: float | None = None, adapter=None) -> Provider:
    """按识别方式组装 Provider。

    `adapter` 是公共 AI 层已经组装好凭据的协议适配器：给了就直接用，
    不给就按老参数自己造一个（CLI 与既有调用方仍走这条路）。

    配置不完整时不在这里造一个「会失败」的假实例——直接抛出 NOT_CONFIGURED，
    让调用方把「用户还没配好」和「调用失败」区分开。
    """
    if mode == 'jev':
        if adapter is None and not (endpoint and model and api_key):
            raise RecognitionError(ERROR_NOT_CONFIGURED, 'Jev 识别尚未配置完整')
        options = {'endpoint': endpoint, 'model': model, 'api_key': api_key, 'transport': transport,
                   'timeout': timeout, 'adapter': adapter}
        if threshold is not None:
            options['threshold'] = threshold
        if batch is not None:
            options['batch'] = batch
        return JevProvider(**options)
    if mode == 'llm':
        if adapter is None and not (endpoint and model and api_key):
            raise RecognitionError(ERROR_NOT_CONFIGURED, 'LLM 识别尚未配置完整')
        return LlmProvider(endpoint=endpoint, model=model, api_key=api_key,
                           transport=transport, timeout=timeout, adapter=adapter)
    raise RecognitionError(ERROR_NOT_CONFIGURED, f'不支持的识别方式：{mode}')


__all__ = ['Provider', 'build_provider', 'JevProvider', 'LlmProvider']