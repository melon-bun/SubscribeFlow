"""0.4.9 batch-02 的离线种子（M21）。

只写隔离的临时库，不触网、不登录、不碰真实凭据与日常数据。

种子写的是 **M21 之前的旧结构**：连接参数放在 ``tagging.providers``，
识别策略放在 ``tagging``。验收脚本据此确认：
- 旧结构读得出来，且被搬到新的 ``ai.providers``；
- 开关、识别方式与原启用时间原样保留；
- 转换幂等，升级不重置任何东西。

端点用不可解析的假地址：即使有任务也不会真的发请求。
库里没有内容，因此不会产生任何自动打标任务。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway

LEGACY_PAYLOAD = {
    "tagging": {
        "enabled": True,
        "mode": "jev",
        "enabledSince": "2026-10-01T00:00:00+00:00",
        "providers": {
            "jev": {"endpoint": "https://api.example.invalid/v1", "model": "jev-legacy",
                    "credentialRef": None},
            "llm": {"endpoint": "", "model": "", "credentialRef": None},
        },
    },
    "reminder": {"enabled": False, "intervalMinutes": 60},
}


async def seed(folder):
    gateway = ChannelGateway()
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=gateway)
    try:
        # 旧结构 + 非零版本：读出来应当等价于新结构的同一份配置。
        core.settings.store.save(LEGACY_PAYLOAD, version=3)
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-v049b2-'):
        raise SystemExit('Fixture requires a v049 batch-02 directory')
    asyncio.run(seed(folder))
