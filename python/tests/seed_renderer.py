"""Offline renderer smoke fixture. Only called with an isolated temporary database."""
import asyncio
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ContentItem, FetchPage, PublishedTime, ChannelError

async def seed(folder, day):
    from subscribe_flow.rpc.browser import BrowserBridge
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', browser_bridge=BrowserBridge())
    try:
        # 自给自足：空库里先建连接、来源与订阅。
        # 此前直接 list_subscriptions()[0]，在没有任何订阅的隔离目录上会 IndexError，
        # 导致依赖它的 smoke 拿不到任何样例数据。
        subs = core.repository.list_subscriptions()
        if subs:
            sub = subs[0]
            source = core.repository.source_for(sub['id'])
        else:
            from subscribe_flow.contracts import Connection, Source
            core.repository.add_connection(Connection('bilibili:default', 'bilibili', 'electron-session', 'offline-fixture'))
            source = Source('bilibili', 'offline-fixture', 'offline-author', '离线验收来源',
                            'https://example.com/offline-fixture', True)
            core.repository.remember_sources([source])
            sub = core.repository.subscribe(source, 'bilibili:default')
        job, _ = core.repository.create_job(sub['id'], 'refresh', progress_version='electron-1')
        core.repository.set_job_state(job['id'], 'running')
        items = tuple(ContentItem('bilibili', 'video', f'offline-{i}', source,
            f'离线验收样本 {i:02d} · 长标题与真实存储分页验证', 'https://example.com/offline-fixture',
            published=PublishedTime(day, 'date', 'offline-smoke', 'UTC') if i else PublishedTime(),
            summary='仅用于隔离数据库的离线验收，不是平台采集结果。') for i in range(25))
        core.repository.commit_page(job['id'], FetchPage(items, None, 'window_only'))
        core.repository.finish_scan(job['id'], coverage='window_only')
        partial, _ = core.repository.create_job(sub['id'], 'backfill', progress_version='electron-1')
        core.repository.set_job_state(partial['id'], 'running')
        core.repository.commit_page(partial['id'], FetchPage((items[1],), {'page': 2}, 'window_only'))
        core.repository.set_job_state(partial['id'], 'partial', coverage='possible_gaps',
            error=ChannelError('TIMEOUT', 'list_items', '离线验收：第 2 页读取超时，已提交内容保留').to_dict())
    finally:
        await core.close()

if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-renderer-'):
        raise SystemExit('Fixture requires a renderer smoke directory')
    day = sys.argv[2]
    date.fromisoformat(day)
    asyncio.run(seed(folder, day))
