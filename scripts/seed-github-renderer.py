"""Offline GitHub Trending fixture for the renderer smoke.

Runs against an isolated temporary database only. No network is touched: the
adapter is registered with a transport that would fail loudly if used, so a
regression that starts requesting the live site is caught here rather than
silently passing.

The seed reproduces the case the channel exists for: one repository ranked on
both the day and the week board, so the inbox must show it once.
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.github.adapter import GithubTrendingAdapter
from subscribe_flow.contracts import (ChannelError, ContentItem, FetchPage, PublishedTime, Source)

# Real identities measured from github.com/trending on 2026-10-16.
SHARED = [('morluto', 'rea', '1209966933'), ('NationalSecurityAgency', 'ghidra', '173228436')]
DAY_ONLY = [('affaan-m', 'ECC', '1122334455')]
WEEK_ONLY = [('cursor', 'plugins', '9988776655')]


class NoNetwork:
    async def get_html(self, url, context, operation):
        raise ChannelError('DEPENDENCY_UNAVAILABLE', operation, f'seed must not request {url}')


def repo_source(row_id):
    return None


def item(owner, name, repository_id, source, caption, moment):
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
        week = await core.subscriptions.add('https://github.com/trending?since=weekly',
                                            'github:default', confirmed=True)
        day_source = core.repository.source_for(day['id'])
        week_source = core.repository.source_for(week['id'])
        base = datetime(2026, 10, 16, 9, 0, tzinfo=timezone.utc)

        # Day board first, then the week board carrying the same two repositories.
        job, _ = core.repository.create_job(day['id'], 'refresh', progress_version='github-trending-1')
        core.repository.set_job_state(job['id'], 'running')
        core.repository.commit_page(job['id'], FetchPage(tuple(
            item(*row, day_source, f'{row[0]}/{row[1]} 的趋势描述', base + timedelta(minutes=index))
            for index, row in enumerate(SHARED + DAY_ONLY)), None, 'window_only',
            metrics={'profile_reads': 1, 'discovered': 3, 'skipped': 0, 'detail_requests': 0}))
        core.repository.finish_scan(job['id'], coverage='window_only')

        job, _ = core.repository.create_job(week['id'], 'refresh', progress_version='github-trending-1')
        core.repository.set_job_state(job['id'], 'running')
        core.repository.commit_page(job['id'], FetchPage(tuple(
            item(*row, week_source, f'{row[0]}/{row[1]} 的趋势描述', base + timedelta(minutes=index))
            for index, row in enumerate(SHARED + WEEK_ONLY)), None, 'window_only',
            metrics={'profile_reads': 1, 'discovered': 3, 'skipped': 2, 'detail_requests': 0}))
        core.repository.finish_scan(job['id'], coverage='window_only')
    finally:
        await core.close()


if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-github-'):
        raise SystemExit('Fixture requires a github renderer smoke directory')
    asyncio.run(seed(folder))
