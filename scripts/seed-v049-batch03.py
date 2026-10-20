"""0.4.9 batch-03 的离线种子（M22 + M23）。

只写隔离的临时库，不触网、不登录、不碰真实凭据与日常数据。

种子造两类数据：
- 60 个标签（标签-00 … 标签-59），足够把列表撑到需要滚动；
- 6 条内容，标签使用次数刻意做成「有并列、有零次、且与名称序错开」：
  标签-03 六次、标签-00 与 标签-01 各三次（并列，按名称再按 ID 打破平局）、
  标签-02 一次，标签-04 及其余全部 0 次。
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import Connection, ContentItem, FetchPage, Source

TAG_COUNT = 60
CONTENT_COUNT = 6


async def seed(folder):
    gateway = ChannelGateway()
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=gateway)
    try:
        core.repository.add_connection(Connection('c', 'test', 'test', 'test'))
        source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        sub = core.repository.subscribe(source, 'c')

        tags = [core.repository.create_tag('tag-%02d' % index, '标签-%02d' % index,
                                           '第 %d 个标签' % index, 'slate', True, [])
                for index in range(TAG_COUNT)]

        base = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)
        job, _ = core.repository.create_job(sub['id'], 'refresh')
        core.repository.set_job_state(job['id'], 'running')
        items = []
        for index in range(CONTENT_COUNT):
            item = ContentItem('test', 'video', 'v%d' % index, source, '内容 %d' % index,
                               'https://example.com/v%d' % index)
            items.append(item)
        core.repository.commit_page(job['id'], FetchPage(tuple(items), None, 'window_only'))
        core.repository.finish_scan(job['id'], coverage='window_only')

        # 次数刻意与名称序错开：名称序是 00、01、02、03…，
        # 次数序（从多到少）是 03、00、01、02…，两种顺序一眼能分开。
        # 标签-00 与 标签-01 并列三次（按名称再按 ID 打破平局），其余零次。
        plan = {
            'test:video:v0': ['tag-00', 'tag-01', 'tag-03'],
            'test:video:v1': ['tag-00', 'tag-01', 'tag-03'],
            'test:video:v2': ['tag-00', 'tag-01', 'tag-03'],
            'test:video:v3': ['tag-02', 'tag-03'],
            'test:video:v4': ['tag-03'],
            'test:video:v5': ['tag-03'],
        }
        for key, tag_ids in plan.items():
            core.repository.set_content_tags([key], tag_ids, origin='manual')
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-v049b3-'):
        raise SystemExit('Fixture requires a v049 batch-03 directory')
    asyncio.run(seed(folder))
