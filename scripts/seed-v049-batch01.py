"""0.4.9 batch-01 的离线种子数据（M19 + M20）。

只写隔离的临时库，不触网、不登录、不碰真实凭据与日常数据。
GitHub 适配器注册的是一个「一请求就报错」的传输：万一回归到真实抓取，
这里会立刻失败，而不是悄悄联网取回真数据。

种子覆盖两件事：
- M19：GitHub 来源与内容，用来检查平台标识在界面各处怎么画。
- M20：一个默认优先级为「高」的来源，加上被单独改成中／低的内容，
  用来检查改名后历史优先级、来源继承与统计口径都不受影响。
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.github.adapter import GithubTrendingAdapter
from subscribe_flow.contracts import ChannelError, ContentItem, FetchPage, PublishedTime, Source

REPOS = [('morluto', 'rea', '1209966933'), ('NationalSecurityAgency', 'ghidra', '173228436'),
         ('affaan-m', 'ECC', '1122334455')]


class NoNetwork:
    async def get_html(self, url, context, operation):
        raise ChannelError('DEPENDENCY_UNAVAILABLE', operation, f'seed must not request {url}')


def repo_item(owner, name, repository_id, source, caption, moment):
    identity = Source('github', 'repo', repository_id, f'{owner}/{name}',
                      f'https://github.com/{owner}/{name}', True, None, caption)
    return ContentItem('github', 'repo', repository_id, source, f'{owner}/{name}',
                       identity.url, kind='repo',
                       published=PublishedTime(moment.isoformat(), 'minute', 'fetched_at',
                                               'Asia/Shanghai', caption),
                       summary=caption, acquisition_complete=True)


async def seed(folder):
    gateway = ChannelGateway()
    gateway.register(GithubTrendingAdapter(NoNetwork()))
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=gateway)
    try:
        day = await core.subscriptions.add('https://github.com/trending?since=daily',
                                           'github:default', confirmed=True)
        day_source = core.repository.source_for(day['id'])
        base = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)

        job, _ = core.repository.create_job(day['id'], 'refresh', progress_version='github-trending-1')
        core.repository.set_job_state(job['id'], 'running')
        core.repository.commit_page(job['id'], FetchPage(tuple(
            repo_item(*row, day_source, f'{row[0]}/{row[1]} 的趋势描述', base + timedelta(minutes=index))
            for index, row in enumerate(REPOS)), None, 'window_only',
            metrics={'profile_reads': 1, 'discovered': 3, 'skipped': 0, 'detail_requests': 0}))
        core.repository.finish_scan(job['id'], coverage='window_only')

        # 来源默认优先级为「高」：三条内容默认继承它。
        core.repository.set_source_priority(day['id'], 'high')
        # 第二、三条被单独设置：改名后这两条必须保持中／低。
        keys = [f'github:repo:{row[2]}' for row in REPOS]
        core.repository.update_content_state([keys[1]], {'priority': 'medium'})
        core.repository.update_content_state([keys[2]], {'priority': 'low'})
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-v049-'):
        raise SystemExit('Fixture requires a v049 batch-01 directory')
    asyncio.run(seed(folder))
