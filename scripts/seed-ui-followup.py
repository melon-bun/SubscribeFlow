"""UI 追加优化（AI 按钮着色 + 笔记页滚动）的离线种子。

隔离临时库：几条笔记，其中一条的原内容简介很长（用来验证阅读区确实要能滚到底）。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

LONG_SUMMARY = '这是一段很长的已保存简介。' * 120   # 约 1440 字，用来撑出阅读区的高度
PROVIDER_ID = 'provider-llm'


def make_item(channel, external_id, title, summary):
    source = Source(channel=channel, kind='author', external_id=f'{external_id}-source',
                    name=f'{channel} 种子来源', url=f'https://example.invalid/{external_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='article', summary=summary,
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


async def seed(folder):
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=ChannelGateway())
    try:
        long_id = core.repository.save_manual(
            make_item('zhihu', 'uifu-1', '一篇很长的内容', LONG_SUMMARY))['item_id']
        short_id = core.repository.save_manual(
            make_item('github', 'uifu-2', '一条短内容', '短简介。'))['item_id']
        core.notes.save(long_id, template='general', summary='这段总结也写得比较长。' * 40,
                        summary_origin='manual', takeaway='心得：' + '要点。' * 60)
        core.notes.save(short_id, template='project', summary='一句话总结。',
                        summary_origin='manual', takeaway='打算用它搭个内部工具。',
                        verdict='using')
        # 一条已配置的文本生成连接与总结策略：界面上要有「AI 总结」入口可看颜色。
        core.settings.update('ai', {'providers': {PROVIDER_ID: {
            'name': '总结用连接', 'protocol': 'openai_chat',
            'endpoint': 'https://api.test.invalid/v1', 'model': 'demo-model',
            'enabled': True}}}, {PROVIDER_ID: 'sk-seed-uifu'})
        core.settings.update('summarization', {'enabled': True, 'providerId': PROVIDER_ID,
                                               'length': 'brief', 'language': 'zh-CN'})
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-uifu-'):
        raise SystemExit('Fixture requires a uifu directory')
    asyncio.run(seed(folder))
