"""M28 笔记页的离线种子。

只写隔离的临时库，不触网、不登录、不碰真实凭据与日常数据。

造几条内容与几条笔记：通用笔记一条、项目笔记一条（带结论），
另留一条**没有笔记**的内容，用来验证目录只显示有笔记的条目。
标签与来源都是合成的，平台名用测试里已有的那两个。
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
    ('zhihu', 'm28-1', '一篇讲检索设计的文章', 'zhihu-note-source', ['检索']),
    ('github', 'm28-2', 'local-rag / desktop-kit', 'github-note-source', ['工具', '检索']),
    ('zhihu', 'm28-3', '没有写笔记的一条内容', 'zhihu-note-source', ['工具']),
]

NOTES = {
    'm28-1': dict(template='general', summary='讲了倒排索引怎么落地。',
                  summary_origin='manual', takeaway='下次检索要按召回质量分层。'),
    'm28-2': dict(template='project', summary='本地文档检索加桌面壳。',
                  summary_origin='manual', takeaway='先做索引，再谈接入。', verdict='using'),
}

# 填充笔记：数量超过一页，用来验证分页与总数同源。
FILLER = 21


def make_item(channel, external_id, title, source_id):
    source = Source(channel=channel, kind='author', external_id=source_id,
                    name=f'{channel} 种子来源', url=f'https://example.invalid/{source_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='article', summary='已保存的简介：这条内容讲的是它自己的主题。',
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


async def seed(folder):
    gateway = ChannelGateway()
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=gateway)
    try:
        tags = {}
        for name in ('检索', '工具'):
            tags[name] = core.tags.create(name)['id']
        ids = {}
        for channel, external_id, title, source_id, tag_names in ITEMS:
            saved = core.repository.save_manual(
                make_item(channel, external_id, title, source_id),
                tag_ids=[tags[name] for name in tag_names])
            ids[external_id] = saved['item_id']
        # 填充笔记先写：按「最近更新」排序时，有名的那两条落在第一页。
        for index in range(FILLER):
            filler = make_item('bilibili', f'm28-fill-{index}', f'填充笔记 {index}',
                               'bilibili-note-source')
            filler_id = core.repository.save_manual(filler)['item_id']
            core.notes.save(filler_id, template='general', summary=f'填充总结 {index}',
                            summary_origin='manual', takeaway='')
        for external_id, note in NOTES.items():
            core.notes.save(ids[external_id], **note)
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-m28-'):
        raise SystemExit('Fixture requires an m28 directory')
    asyncio.run(seed(folder))
