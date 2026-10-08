"""Zhihu's private page transport mapped to the existing public contracts."""
import re
from datetime import date, datetime, timezone
from urllib.parse import urlparse

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, ContentItem, ContentPatch,
    ContentReference, FetchPage, ItemError, OperationCapability, PublishedTime, Readiness, Source, SourcePage)

CHANNEL, BACKEND, VERSION = "zhihu", "electron-session", "zhihu-page-1"
AUTHOR = re.compile(r"^[a-f0-9]{32}$")
PIN = re.compile(r"^\d{1,30}$")
TOKEN = re.compile(r"^[A-Za-z0-9_.~-]{1,100}$")


def author_locator(value):
    if isinstance(value, str) and TOKEN.fullmatch(value) and value not in {'.', '..'}:
        return value
    try:
        u = urlparse(value)
        match = re.fullmatch(r'/people/([A-Za-z0-9_.~-]{1,100})/?', u.path)
        if (u.scheme == 'https' and u.netloc == 'www.zhihu.com' and match
                and match[1] not in {'.', '..'}):
            return match[1]
    except (TypeError, ValueError):
        pass
    raise ChannelError('INVALID_INPUT', 'resolve_source', '请输入知乎作者 ID、完整主页，或通过昵称搜索')


def image_url(value):
    try:
        u = urlparse(value)
        if (isinstance(value, str) and len(value) <= 4096 and u.scheme == 'https' and not u.username
                and not u.password and u.port is None and u.hostname and
                (u.hostname == 'zhimg.com' or u.hostname.endswith('.zhimg.com'))):
            return value
    except (TypeError, ValueError):
        pass
    return None


def source_from_row(row):
    if (not isinstance(row, dict) or not isinstance(row.get('id'), str) or not AUTHOR.fullmatch(row['id']) or
            not isinstance(row.get('name'), str) or not row['name'].strip()):
        raise ValueError('invalid author identity')
    token = author_locator(row['url'])
    if token != row['token']:
        raise ValueError('invalid author locator')
    return Source(CHANNEL, 'author', row['id'], row['name'].strip()[:200],
                  f'https://www.zhihu.com/people/{token}', True, image_url(row.get('avatar')),
                  str(row.get('description') or '')[:350] or None)


def publication(raw):
    if not isinstance(raw, dict) or raw.get('precision') not in {'unknown', 'date', 'minute', 'second'}:
        raise ValueError('invalid publication precision')
    value, precision = raw.get('value'), raw['precision']
    if (precision == 'unknown') != (value is None):
        raise ValueError('inconsistent publication')
    if value is not None:
        if not isinstance(value, str):
            raise ValueError('invalid publication')
        if precision == 'date':
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
                raise ValueError('invalid date')
            date.fromisoformat(value)
        elif datetime.fromisoformat(value.replace('Z', '+00:00')).tzinfo is None:
            raise ValueError('missing timezone')
    return PublishedTime(value, precision, str(raw.get('provenance') or 'unavailable')[:100],
                         'Asia/Shanghai', str(raw.get('raw_label') or '')[:200] or None)


def item_from_row(row, source=None):
    if (not isinstance(row, dict) or not isinstance(row.get('id'), str) or not PIN.fullmatch(row['id']) or
            row.get('acquisition_complete') is not True or not isinstance(row.get('title'), str)
            or not row['title'].strip() or not isinstance(row.get('content'), str)
            or not isinstance(row.get('images'), list)
            or row.get('url') != f"https://www.zhihu.com/pin/{row['id']}"):
        raise ValueError('invalid pin identity/content')
    actual = source_from_row(row['author'])
    if source and actual.key != source.key:
        raise ValueError('pin does not belong to author')
    return ContentItem(CHANNEL, 'pin', row['id'], actual, row['title'].strip()[:1000], row['url'],
        kind='pin', published=publication(row['published']), summary=row['content'],
        thumbnail=next((image_url(url) for url in row.get('images', []) if image_url(url)), None),
        acquisition_complete=True)


def item_link(raw):
    try:
        u = urlparse(raw)
        if (u.scheme not in {'http', 'https'} or u.hostname not in {'www.zhihu.com', 'zhihu.com'}
                or u.username or u.password or u.port not in {None, 80 if u.scheme == 'http' else 443}
                or len(raw) > 2000 or any(c.isspace() or ord(c) < 32 for c in raw)):
            return None
        match = re.fullmatch(r'/pin/(\d{1,30})/?', u.path)
        if match:
            return match[1], f'https://www.zhihu.com/pin/{match[1]}'
    except (TypeError, ValueError):
        pass
    return None


class ZhihuAdapter:
    def __init__(self, bridge):
        self.bridge, self.resources = bridge, ResourceCoordinator()

    def describe(self):
        deps = ('electron-session',)
        return ChannelDescriptor(CHANNEL, '知乎', BACKEND, {
            'resolve_source': OperationCapability(True, dependencies=deps, authentication='required', notes='确认主页 token 与平台稳定作者 ID'),
            'search_sources': OperationCapability(True, dependencies=deps, authentication='required', notes='昵称搜索，候选需人工确认；首批候选'),
            'list_items': OperationCapability(True, dependencies=deps, authentication='required', pagination='bounded_profile_scan', ordering='pinned_and_unordered', full_history=False, notes='仅作者发布的想法；前 N 条不同 ID，置顶及已收录也占名额；有界扫描不保证全部历史'),
            'get_item_detail': OperationCapability(True, dependencies=deps, authentication='required', notes='想法正文补全及作者归属验证'),
            'match_item_url': OperationCapability(True, True, 'not_required', notes='知乎官方 /pin/<ID> 链接；不支持回答、文章及短链'),
            'resolve_item': OperationCapability(True, True, 'not_required', notes='本地确认稳定想法 ID，先查重'),
            'read_item': OperationCapability(True, dependencies=deps, authentication='required', notes='读取真实想法与作者，不要求订阅'),
        }, adapter_version='1', parser_version='1', progress_version=VERSION, content_types=('pin',),
           page_size=1, default_refresh_budget=8, default_backfill_budget=30,
           scan_overhead_budget=13, budget_unit='items')

    async def call(self, action, context, **params):
        async with self.resources.acquire(context, action):
            data = await self.bridge.call(params, context, action)
        if not isinstance(data, dict):
            raise ChannelError('SCHEMA_CHANGED', action, '知乎采集响应无效')
        return data

    async def resolve_source(self, locator, context):
        token = author_locator(locator)
        data = await self.call('resolve_source', context, operation='author', locator=token)
        try:
            return source_from_row(data['author'])
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'resolve_source', '知乎作者稳定身份无效') from None

    async def check_readiness(self, operation, context):
        checked = datetime.now(timezone.utc).isoformat()
        if operation in {'match_item_url', 'resolve_item'}:
            context.check(operation)
            return Readiness('ready', operation, '本地确认想法链接身份，无需登录', 'connection', context.connection.id,
                             checked, dependency='available', authentication='not_required')
        try:
            data = await self.call(operation, context, operation='check')
            if type(data.get('authenticated')) is not bool:
                raise ChannelError('SCHEMA_CHANGED', operation, '知乎登录状态无效')
            if not data['authenticated']:
                raise ChannelError('AUTH_REQUIRED', operation, '请在应用内登录知乎，关闭窗口后检查连接')
            return Readiness('ready', operation, '知乎应用内会话已登录', 'connection', context.connection.id,
                             checked, dependency='available', authentication='available')
        except ChannelError as error:
            if error.code == 'CANCELLED':
                raise
            return Readiness('blocked', operation, error.message, 'connection', context.connection.id, checked,
                ({'AUTH_REQUIRED': ('open_browser',), 'AUTH_EXPIRED': ('open_browser',),
                  'INTERACTION_REQUIRED': ('open_browser',), 'RATE_LIMITED': ('wait',),
                  'SCHEMA_CHANGED': ('update_adapter',)}.get(error.code, ('retry',))),
                dependency='unavailable' if error.code == 'DEPENDENCY_UNAVAILABLE' else 'unknown',
                authentication='required' if error.code.startswith('AUTH_') or error.code == 'INTERACTION_REQUIRED' else 'unknown',
                retry_after=error.retry_after)

    async def search_sources(self, query, request, context):
        if not isinstance(query, str) or not query.strip() or len(query) > 100:
            raise ChannelError('INVALID_INPUT', 'search_sources', '请输入 1 到 100 字的昵称')
        if request.cursor:
            raise ChannelError('UNSUPPORTED_OPERATION', 'search_sources', '知乎搜索本期仅提供首批候选')
        data = await self.call('search_sources', context, operation='search', query=query.strip(), limit=min(request.limit, 50))
        try:
            if not isinstance(data.get('users'), list) or not data['users'] and data.get('empty') is not True:
                raise ValueError('missing search evidence')
            sources = tuple(source_from_row(row) for row in data['users'][:request.limit])
            return SourcePage(sources)
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'search_sources', '知乎候选作者身份或空结果证据无效') from None

    async def fetch_page(self, source, request, context):
        budget = request.item_budget or self.describe().default_refresh_budget
        if type(budget) is not int or not 1 <= budget <= 50:
            raise ChannelError('INVALID_INPUT', 'list_items', '知乎本轮采集条数需为 1 到 50')
        cursor = request.cursor
        if cursor and (cursor.get('version') != VERSION or cursor.get('source') != source.key or
                cursor.get('mode') != request.mode or cursor.get('limit') != budget or not isinstance(cursor.get('token'), str)):
            raise ChannelError('INVALID_CURSOR', 'list_items', '知乎扫描位置失效，请重新刷新')
        params = dict(operation='scan', uid=source.external_id, url=source.url, job_id=context.job_id,
                      cursor=cursor['token'] if cursor else None, limit=budget, mode=request.mode)
        if not cursor:
            params['known_ids'] = list(request.known_ids)
        data = await self.call('list_items', context, **params)
        try:
            if (not isinstance(data['items'], list) or len(data['items']) > 1 or not isinstance(data['errors'], list)
                    or type(data['terminal']) is not bool):
                raise ValueError('invalid scan')
            items = tuple(item_from_row(row, source) for row in data['items'])
            errors = tuple(ItemError(int(e['index']), str(e['code'])[:100], str(e['message'])[:500]) for e in data['errors'])
            metrics = data['metrics']
            if (set(metrics) != {'profile_reads', 'discovered', 'skipped', 'detail_requests'}
                    or any(type(v) is not int or v < 0 for v in metrics.values())
                    or metrics['profile_reads'] + metrics['detail_requests'] != 1
                    or metrics['skipped'] > metrics['discovered']
                    or len(items) + len(errors) != metrics['detail_requests']):
                raise ValueError('invalid scan metrics')
            next_cursor = None
            if data['terminal']:
                if data.get('cursor') is not None or data.get('end_evidence') not in {'item_limit', 'profile_end', 'scan_bound'}:
                    raise ValueError('missing end evidence')
            else:
                token = data['cursor']
                if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9-]{36}:\d{1,3}', token):
                    raise ValueError('invalid scan cursor')
                if cursor and token == cursor['token']:
                    raise ChannelError('NO_PROGRESS', 'list_items', '知乎扫描位置未推进')
                next_cursor = dict(version=VERSION, source=source.key, mode=request.mode, limit=budget, token=token)
        except (KeyError, TypeError, ValueError):
            raise ChannelError('SCHEMA_CHANGED', 'list_items', '知乎想法身份、归属、时间或扫描进度无效') from None
        return FetchPage(items, next_cursor, 'possible_gaps' if errors or data.get('end_evidence') == 'scan_bound' else 'window_only',
            data['terminal'], data.get('end_evidence'), item_errors=errors, scan_advanced=True, metrics=metrics)

    async def get_item_detail(self, item_ref, context):
        key = item_ref.removeprefix('zhihu:pin:')
        if not PIN.fullmatch(key) or not context.source or context.source.channel != CHANNEL:
            raise ChannelError('INVALID_INPUT', 'get_item_detail', '想法详情缺少稳定身份或作者')
        data = await self.call('get_item_detail', context, operation='detail', uid=context.source.external_id,
                               id=key, url=f'https://www.zhihu.com/pin/{key}')
        try:
            item = item_from_row(data['pin'], context.source)
            if item.external_id != key:
                raise ValueError('different pin')
            return ContentPatch(item.key, {name: getattr(item, name) for name in
                ('title', 'summary', 'thumbnail', 'published', 'url', 'acquisition_complete')})
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'get_item_detail', '想法详情或归属无效') from None

    def match_item_url(self, url):
        return item_link(url) is not None

    async def resolve_item(self, url, context):
        context.check('resolve_item')
        link = item_link(url)
        if not link:
            raise ChannelError('INVALID_INPUT', 'resolve_item', '知乎本期仅支持想法链接')
        return ContentReference(CHANNEL, 'pin', link[0], link[1])

    async def read_item(self, reference, context):
        link = item_link(reference.url)
        if reference.channel != CHANNEL or reference.namespace != 'pin' or not link or link[0] != reference.external_id:
            raise ChannelError('INVALID_INPUT', 'read_item', '想法身份或地址无效')
        data = await self.call('read_item', context, operation='read', id=link[0], url=link[1])
        try:
            item = item_from_row(data['pin'])
            if item.key != reference.key:
                raise ValueError('different pin')
            return item
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'read_item', '想法正文或真实作者身份无效') from None
