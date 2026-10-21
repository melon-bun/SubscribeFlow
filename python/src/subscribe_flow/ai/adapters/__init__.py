"""协议适配器。

能力由这里派生：OpenAI 兼容聊天只暴露文本生成，Jev 协议只暴露候选分类。
新增协议在这里登记，不在业务层加分支。
"""

from .jev_systemone import JevSystemOneAdapter
from .openai_chat import OpenAiChatAdapter

__all__ = ['OpenAiChatAdapter', 'JevSystemOneAdapter']
