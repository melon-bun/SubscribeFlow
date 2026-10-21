"""M26 笔记的离线种子。

只写隔离的临时库，不触网、不登录、不碰真实凭据与日常数据。
造几条内容（跨两个平台、带标签与来源），但**不写笔记**——
笔记由验收脚本通过真实 IPC 通道写进去，这样读写路径都是真的。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

ITEMS = [
    ('zhihu', 'note-1', '一篇讲异步编程的长文', 'zhihu-note-source', ['工程']),
    ('zhihu', 'note-2', '一条关于数据库设计的短帖', 'zhihu-note-source', ['数据库']),
    ('github', 'note-3', '一个命令行工具的仓库', 'github-note-source', ['工具']),
]


def make_item(channel, external_id, title, source_id):
    source = Source(channel=channel, kind='author', external_id=source_id,
                    name=f'{channel} 种子来源', url=f'https://example.invalid/{source_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='article', summary='种子简介',
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


async def seed(folder):
    gateway = ChannelGateway()
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=gateway)
    try:
        tags = {}
        for name in ('工程', '数据库', '工具'):
            tags[name] = core.tags.create(name)['id']
        for channel, external_id, title, source_id, tag_names in ITEMS:
            core.repository.save_manual(
                make_item(channel, external_id, title, source_id),
                tag_ids=[tags[name] for name in tag_names])
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith(('subscribe-flow-m26-', 'subscribe-flow-m27-')):
        raise SystemExit('Fixture requires an m26/m27 directory')
    asyncio.run(seed(folder))
