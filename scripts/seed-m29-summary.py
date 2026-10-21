"""M29 AI 总结的离线种子。

隔离临时库：一段正文内容、一条已配置的文本生成连接（凭据明文不进库，
真实密钥由验收脚本在主进程里注入内存凭据容器）、以及一条总结策略。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

PROVIDER_ID = 'provider-llm'


def make_item():
    source = Source(channel='zhihu', kind='author', external_id='m29-source',
                    name='知乎 种子来源', url='https://example.invalid/m29-source')
    return ContentItem(channel='zhihu', namespace='feed', external_id='m29-1',
                       source=source, title='一篇讲倒排索引的长文',
                       url='https://example.invalid/m29-1', kind='article',
                       summary='这是已保存的正文：讲了倒排索引怎么落地，以及召回与精排的取舍。',
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


async def seed(folder):
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=ChannelGateway())
    try:
        core.repository.save_manual(make_item())
        # 凭据引用由 Core 生成并存进设置；密钥明文只在内存里，
        # 因此真实密钥由验收脚本在主进程注入。
        core.settings.update('ai', {'providers': {PROVIDER_ID: {
            'name': '总结用连接', 'protocol': 'openai_chat',
            'endpoint': 'https://api.test.invalid/v1', 'model': 'demo-model',
            'enabled': True}}}, {PROVIDER_ID: 'sk-seed-m29'})
        # 另一条连接：用来验证「改无关的连接不该作废一次总结」。
        core.settings.update('ai', {'providers': {'provider-other': {
            'name': '另一条连接', 'protocol': 'openai_chat',
            'endpoint': 'https://other.test.invalid/v1', 'model': 'other-model',
            'enabled': True}}})
        core.settings.update('summarization', {'enabled': True, 'providerId': PROVIDER_ID,
                                               'length': 'brief', 'language': 'zh-CN'})
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-m29-'):
        raise SystemExit('Fixture requires an m29 directory')
    asyncio.run(seed(folder))
