"""M16 独立识别包。

边界（开发方案 §3.1）：
- 不导入 subscribe_flow、SQLite、渠道模块、Electron 或 RPC；
- 只有自身契约、Provider 接口与错误类型；
- 连接配置与传输实现由外部注入，这个包自己不发请求也不读磁盘。

拿掉这个包，采集、内容查询与人工标签都照常工作；换模型只改 Provider
与组装注册，不在采集链路上增加任何模型分支。
"""

from .contracts import (
    Candidate, CandidateTag, RecognitionError, RecognitionRequest, RecognitionResult,
    ERROR_RETRYABLE, MODES,
)
from .registry import Provider, build_provider

__all__ = [
    'Candidate', 'CandidateTag', 'RecognitionError', 'RecognitionRequest', 'RecognitionResult',
    'ERROR_RETRYABLE', 'MODES', 'Provider', 'build_provider',
]