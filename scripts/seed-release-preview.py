"""Public README screenshots: synthetic data, isolated folder, no network or credentials."""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import Connection, ContentItem, FetchPage, PublishedTime, Source

ROWS = [
    ('bilibili', '影像实验室', [
        ('用光线讲故事：一盏灯的三种布光方法', '从方向、软硬和色温入手，理解光线如何改变画面的情绪。'),
        ('把一段旅行剪成完整的故事', '先整理人物与事件，再安排节奏，让素材之间产生联系。'),
        ('桌面工作流：让创作少一点重复操作', '从文件命名、素材归档到快捷操作，建立顺手的创作流程。')]),
    ('zhihu', '读与写', [
        ('如何建立一个真正会回看的知识库', '收藏只是开始。用自己的话写下一句总结，记录这条信息会用在哪里。'),
        ('检索系统设计：从关键词到上下文', '结合关键词与语义检索，把召回质量和阅读体验放在一起考虑。'),
        ('注意力有限，怎样安排每周的阅读', '给内容分配优先级，也为暂时不读的内容保留一个明确去处。')]),
    ('github', 'GitHub 趋势 · 日榜', [
        ('example / local-reader', '一个面向个人知识管理的本地阅读工具，支持结构化整理与离线检索。'),
        ('example / tiny-search', '轻量的全文检索实验，用少量代码理解索引、排序与结果呈现。'),
        ('example / focus-board', '用清晰的优先级看板安排工作，把想法转成下一步行动。')]),
    ('xiaohongshu', '城市漫步手记', [
        ('周末散步路线：沿着河边走一走', '一条适合慢慢走的路线，记录沿途的书店、咖啡馆和傍晚的光。'),
        ('给工作台留一点空白', '收起不常用的东西，让桌面只留下正在使用的工具。')]),
]


async def seed(folder):
    core = Core(folder / 'subscribe-flow.sqlite3', gateway=ChannelGateway())
    try:
        tags = [core.tags.create(name, color=color)['id'] for name, color in
                [('阅读方法', 'cyan'), ('创作灵感', 'amber'), ('开发工具', 'blue')]]
        saved = []
        for si, (platform, name, rows) in enumerate(ROWS):
            connection_id = platform + ':default'
            core.repository.add_connection(Connection(connection_id, platform, 'electron-session', 'release-preview'))
            source = Source(platform, 'author', 'preview-author-' + str(si), name,
                            'https://example.invalid/author/' + str(si), True)
            sub = core.repository.subscribe(source, connection_id)
            core.repository.set_source_priority(sub['id'], ['high', 'medium', 'high', 'low'][si])
            job, _ = core.repository.create_job(sub['id'], 'refresh')
            core.repository.set_job_state(job['id'], 'running')
            items = tuple(ContentItem(platform, 'feed', 'preview-' + str(si) + '-' + str(i), source,
                title, 'https://example.invalid/content/' + str(si) + '-' + str(i),
                kind='repo' if platform=='github' else 'video' if platform=='bilibili' else 'pin' if platform=='zhihu' else 'note',
                summary=summary, published=PublishedTime('2026-10-' + str(24-i-si).zfill(2) + 'T09:00:00+09:00',
                    'minute', 'release-preview', 'Asia/Tokyo'),
                acquisition_complete=True) for i,(title,summary) in enumerate(rows))
            core.repository.commit_page(job['id'], FetchPage(items, None, 'window_only'))
            core.repository.finish_scan(job['id'], coverage='window_only')
            for i,item in enumerate(items):
                core.tags.set_content(item.key, [tags[si % 3]])
                saved.append(item)
        core.notes.save(saved[0].key, template='general', summary='光线的方向决定形体，软硬决定情绪。',
            summary_origin='manual', takeaway='下次拍摄先用一盏灯尝试三种方向，再决定是否添加辅助光。')
        core.notes.save(saved[3].key, template='general', summary='用个人判断把收藏变成可再次使用的知识。',
            summary_origin='manual', takeaway='每周回顾一次笔记，把值得实践的内容放进优先级看板。')
        core.notes.save(saved[6].key, template='project', summary='把本地阅读、个人笔记和全文检索放在同一个工作流。',
            summary_origin='manual', takeaway='先体验离线检索，再评估是否适合自己的资料整理方式。', verdict='watching')
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-release-preview-'):
        raise SystemExit('Screenshots require an isolated preview folder')
    asyncio.run(seed(folder))
