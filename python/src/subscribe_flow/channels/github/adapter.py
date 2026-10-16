"""GitHub Trending as a first-class channel: three fixed boards, one stable key.

The channel is deliberately small. ``github.com/trending`` is one page with no
history and no pagination, so the interesting work is *identity*, not scanning:

* A board is identified by the ``since`` parameter the request itself declares.
  All three full-site boards share one ``<title>``, so a source can never be
  confirmed from the response body - ``resolve_source`` is a local whitelist
  check that performs no network I/O.
* A repository is identified by its numeric ``repository_id``. Never by
  ``owner/name``: repositories get renamed, and a renamed repository under an
  ``owner/name`` key would be re-inserted as new content. When the id cannot be
  read the row is rejected with ``SCHEMA_CHANGED`` rather than silently falling
  back to a path.

Parsing anchors on meaning, never on tooling classes. GitHub rotates its A/B
utility prefixes (``tmp-pr-4``, ``tmp-mr-3``), so only stable anchors are read:
the row boundary, the ``<h2>`` anchor and its ``data-hydro-click`` payload, the
``col-9`` description paragraph, ``itemprop="programmingLanguage"``, the
``/stargazers`` link and the period star line.
"""
import json
import re
from datetime import datetime, timezone
from html import unescape
from urllib.parse import parse_qsl, urlsplit

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.github.transport import GithubTransport, allowed
from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, ContentItem,
    ContentReference, FetchPage, OperationCapability, PublishedTime, Readiness, Source, SourcePage)

CHANNEL, BACKEND, VERSION = "github", "direct-http", "github-trending-1"
HOSTS = {"github.com", "www.github.com"}

# 唯一的来源集合：日/周/月三张全站榜。不做语言榜、不做关键词。
SINCE = {"day": "daily", "week": "weekly", "month": "monthly"}
# 等价写法。只接受这一组，不接受 python:weekly 之类。
# board id 与 GitHub 的 since 参数互为别名，两者都映射回同一个 board id。
ALIASES = {board: board for board in SINCE}
ALIASES.update({since: board for board, since in SINCE.items()})
BOARDS = {
    "day": ("GitHub 趋势 · 日榜", "GitHub 全站 · 本周期新增 star 排名（今日）"),
    "week": ("GitHub 趋势 · 周榜", "GitHub 全站 · 本周期新增 star 排名（本周）"),
    "month": ("GitHub 趋势 · 月榜", "GitHub 全站 · 本周期新增 star 排名（本月）"),
}
# 实测 11–22 行；25 为结构异常的上限，不是行数假设。
ITEM_BUDGET = 25
# 单条读取与来源解析不做连通性探测：这些操作本来就要读页面。
NO_PROBE = {"match_item_url", "resolve_item", "read_item"}
PATH = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
# GitHub 保留的一级路径：这些前缀下永远不是仓库，收录界面必须显式排除。
RESERVED = {"about", "collections", "contact", "explore", "features", "issues", "join",
            "login", "marketplace", "notifications", "orgs", "pricing", "pulls", "search",
            "settings", "site", "sponsors", "topics", "trending"}

ROW = re.compile(r'<article class="Box-row">.*?</article>', re.S)
HEADING = re.compile(r"<h2\b[^>]*>(.*?)</h2>", re.S)
# 行内第一个带 data-hydro-click 的锚点就是仓库标题链接，其 href 形如 /owner/repo。
HEADING_LINK = re.compile(r'<a\b[^>]*?data-hydro-click="([^"]*)"[^>]*?href="(/[^"?#]+)"', re.S)
# 登录按钮锚点的 payload 里 GitHub 自己叫 repository_id；用于交叉校验标题锚点的 record_id。
REPO_ID_ANY = re.compile(r'data-hydro-click="[^"]*?&quot;repository_id&quot;:(\d{1,20})')
DESCRIPTION = re.compile(r'<p class="col-9[^"]*"[^>]*>(.*?)</p>', re.S)
LANGUAGE = re.compile(r'itemprop="programmingLanguage"[^>]*>(.*?)</span>', re.S)
STARS = re.compile(r'<a\b[^>]*href="/[^"]*/stargazers"[^>]*>(.*?)</a>', re.S)
PERIOD_STARS = re.compile(r"([\d,]+)\s*stars?\s+(today|this week|this month)", re.S | re.I)
TITLE = re.compile(r"<title>(.*?)</title>", re.S | re.I)
OCTOLYTICS_ID = re.compile(r'<meta name="octolytics-dimension-repository_id" content="(\d{1,20})"')
OCTOLYTICS_NWO = re.compile(r'<meta name="octolytics-dimension-repository_nwo" content="([^"]{1,200})"')
OG_DESCRIPTION = re.compile(r'<meta property="og:description" content="([^"]*)"')
OG_IMAGE = re.compile(r'<meta property="og:image" content="([^"]*)"')
TAGS = re.compile(r"<[^>]+>")


def _text(fragment):
    """Plain text from an HTML fragment: tags out, entities in, whitespace folded."""
    return " ".join(unescape(TAGS.sub(" ", fragment)).split())


def _payload(click):
    """Decode one ``data-hydro-click`` attribute into its JSON payload."""
    try:
        data = json.loads(unescape(click))
    except (ValueError, TypeError):
        raise ValueError("unreadable data-hydro-click") from None
    payload = data.get("payload") if isinstance(data, dict) else None
    if not isinstance(payload, dict):
        raise ValueError("missing click payload")
    return payload


def _numeric_id(value):
    if type(value) is not int or not 0 < value < 10 ** 15:
        return None
    return str(value)


def _rows(document):
    """Every trending row, or a rejection when the page is not a trending board."""
    heading = TITLE.search(document)
    if not heading or "trending" not in heading.group(1).lower() or "repositories" not in heading.group(1).lower():
        raise ValueError("not a trending repositories page")
    return ROW.findall(document)


def row_from_html(row, *, captured_at):
    """One board row into a validated dict. Raises ValueError on any missing anchor."""
    heading = HEADING.search(row)
    link = HEADING_LINK.search(heading.group(1)) if heading else None
    if not link:
        raise ValueError("missing repository heading link")
    path = link.group(2).strip("/")
    segments = path.split("/")
    if len(segments) != 2 or not all(PATH.fullmatch(segment) for segment in segments):
        raise ValueError("unusable repository path")
    # 标题锚点用 record_id，登录按钮锚点用 repository_id。两者必须一致：
    # 不一致说明锚点语义变了，此时去重键不可信，宁可熔断也不写脏数据。
    record = _numeric_id(_payload(link.group(1)).get("record_id"))
    found = {_numeric_id(int(value)) for value in REPO_ID_ANY.findall(row)}
    found.discard(None)
    if record is None:
        if len(found) != 1:
            raise ValueError("missing stable repository id")
        record = found.pop()
    elif found and found != {record}:
        raise ValueError("conflicting repository ids")
    description = DESCRIPTION.search(row)
    language = LANGUAGE.search(row)
    stars = STARS.search(row)
    period = PERIOD_STARS.search(_text(row))
    return dict(repository_id=record, path=path,
                description=_text(description.group(1))[:600] if description else None,
                language=_text(language.group(1))[:60] if language else None,
                stars=_text(stars.group(1))[:20] if stars else None,
                period_stars=period.group(0).strip() if period else None,
                captured_at=captured_at)


def parse_board(document, *, captured_at):
    """Parse a whole trending board. Row count follows the page; it is not assumed."""
    return [_rows_or_raise(row, captured_at) for row in _rows(document)]


def _rows_or_raise(row, captured_at):
    return row_from_html(row, captured_at=captured_at)


def board_locator(value):
    """Resolve a locator to one of exactly three board ids, locally and idempotently.

    Accepts ``day``/``daily``/``https://github.com/trending?since=weekly``. Anything
    else is ``INVALID_INPUT`` - including extra query parameters, because silently
    ignoring ``?since=weekly&spoken_language_code=zh`` would let the user believe
    a filter took effect when it did not.
    """
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise ChannelError("INVALID_INPUT", "resolve_source", "请选择日榜、周榜或月榜")
    text = value.strip()
    if "/" not in text and "?" not in text:
        board = ALIASES.get(text.lower())
        if board:
            return board
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜只有日榜、周榜和月榜")
    if any(char.isspace() or ord(char) < 32 for char in text):
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜地址无效")
    try:
        parsed = urlsplit(text)
    except ValueError:
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜地址无效") from None
    if (parsed.scheme not in {"http", "https"} or parsed.hostname not in HOSTS
            or parsed.username or parsed.password or parsed.port not in {None, 80, 443}
            or parsed.path.rstrip("/") != "/trending"):
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜地址无效")
    params = {key: value for key, value in parse_qsl(parsed.query, keep_blank_values=True)}
    unknown = set(params) - {"since"}
    if unknown:
        raise ChannelError("INVALID_INPUT", "resolve_source",
                           "GitHub 趋势榜只支持 since 参数，其余筛选不会生效")
    board = ALIASES.get(params.get("since", "daily").lower())
    if not board:
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜只有日榜、周榜和月榜")
    return board


def board_source(board):
    """The Source for one board. Identity comes from the request we will make."""
    if board not in BOARDS:
        raise ChannelError("INVALID_INPUT", "resolve_source", "GitHub 趋势榜只有日榜、周榜和月榜")
    name, description = BOARDS[board]
    return Source(CHANNEL, "trending_board", board, name,
                  f"https://github.com/trending?since={SINCE[board]}", True, None, description)


def repo_link(raw):
    """Canonical ``(owner, name)`` for a two-segment repository URL, else None."""
    if not isinstance(raw, str) or len(raw) > 2000 or any(c.isspace() or ord(c) < 32 for c in raw):
        return None
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return None
    if (parsed.scheme not in {"http", "https"} or parsed.hostname not in HOSTS or parsed.username
            or parsed.password or parsed.port not in {None, 80 if parsed.scheme == "http" else 443}):
        return None
    match = re.fullmatch(r"/([^/]+)/([^/?#]+)/?", parsed.path)
    if not match or not all(PATH.fullmatch(segment) for segment in match.groups()):
        return None
    if match.group(1).lower() in RESERVED:
        return None
    return match.group(1), match.group(2)


def repo_source(row, *, confirmed=True):
    """A repository is its own source: same key space as the content it carries."""
    repository_id = row.get("repository_id")
    owner, name = repo_link(f"https://github.com/{row['path']}")
    if not isinstance(repository_id, str) or not re.fullmatch(r"\d{1,15}", repository_id) or not owner:
        raise ValueError("invalid repository identity")
    return Source(CHANNEL, "repo", repository_id, f"{owner}/{name}",
                  f"https://github.com/{owner}/{name}", confirmed, None,
                  str(row.get("description") or "")[:350] or None)


def publication(row):
    """Trend boards publish no per-item time, so the fetch time is labelled as such.

    ``provenance='fetched_at'`` is mandatory: the renderer shows this as 收录时间,
    never as a publication date. Leaving it unknown would sink the whole channel
    to the bottom of the inbox, because SQLite sorts NULL last.
    """
    captured = row.get("captured_at")
    if not isinstance(captured, str):
        raise ValueError("missing capture time")
    moment = datetime.fromisoformat(captured.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("missing timezone")
    return PublishedTime(moment.isoformat(), "minute", "fetched_at", "Asia/Shanghai",
                         str(row.get("period_stars") or "")[:200] or None)


def item_from_row(row, source=None):
    """One board row (or repository page) into a ContentItem under a stable key.

    ``source`` is the board the row came from, when there is one. It becomes the
    item's source so that ``content_sources`` attributes the item to every board
    it appears on; the repository identity lives in ``external_id`` instead, and
    that is what keeps one repository on three boards down to one item.
    """
    if (not isinstance(row, dict) or row.get("acquisition_complete") is not True
            or not isinstance(row.get("path"), str) or not isinstance(row.get("title"), str)
            or not row["title"].strip()):
        raise ValueError("invalid repository identity/content")
    owner, name = repo_link(f"https://github.com/{row['path']}")
    if not owner or name is None or row["title"].strip() != f"{owner}/{name}":
        raise ValueError("invalid repository path")
    identity = repo_source(row)
    if source is None:
        # Pasted link: the repository is its own source, so it still groups in the UI.
        source = identity
    elif source.channel != CHANNEL or source.kind not in {"trending_board", "repo"}:
        raise ValueError("repository does not belong to source")
    return ContentItem(CHANNEL, "repo", identity.external_id, source, row["title"].strip()[:1000],
                       identity.url, kind="repo", published=publication(row),
                       summary=str(row.get("description") or "")[:600] or None,
                       thumbnail=row.get("thumbnail"), acquisition_complete=True)


def board_item(row, source, *, captured_at):
    """Board rows become complete items: the row *is* the content unit."""
    enriched = dict(row, title=row["path"], captured_at=captured_at, acquisition_complete=True)
    return item_from_row(enriched, source)


def parse_repository_page(document, *, captured_at):
    """Read a repository page for the same key the boards use.

    The page exposes ``octolytics-dimension-repository_id`` rather than
    ``data-hydro-click``; measured digit-for-digit against the board value for
    the same repository, so a pasted link and a board hit collapse onto one key.
    """
    identifier = OCTOLYTICS_ID.search(document)
    nwo = OCTOLYTICS_NWO.search(document)
    if not identifier:
        raise ValueError("missing repository id")
    owner_name = nwo.group(1).strip() if nwo else None
    if not owner_name or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}", owner_name):
        raise ValueError("missing repository name")
    description = OG_DESCRIPTION.search(document)
    image = OG_IMAGE.search(document)
    thumbnail = None
    if image:
        candidate = unescape(image.group(1))
        thumbnail = candidate if allowed(candidate) else None
    return dict(repository_id=identifier.group(1), path=owner_name, title=owner_name,
                description=_text(unescape(description.group(1)))[:600] if description else None,
                thumbnail=thumbnail, captured_at=captured_at, acquisition_complete=True)


class GithubTrendingAdapter:
    def __init__(self, transport=None):
        self.transport = transport if transport is not None else GithubTransport()
        self.resources = ResourceCoordinator()

    def describe(self):
        deps = ("direct-http",)
        board_note = ("只提供日榜、周榜、月榜三张全站榜；候选由本渠道本地给出，不请求 GitHub 搜索页")
        return ChannelDescriptor(CHANNEL, "GitHub 趋势", BACKEND, {
            'resolve_source': OperationCapability(True, dependencies=deps, authentication='not_required', notes=board_note + '；无需登录'),
            'search_sources': OperationCapability(True, dependencies=deps, authentication='not_required', notes='本地固定返回三张全站榜，调用期间不发任何网络请求'),
            'list_items': OperationCapability(True, dependencies=deps, authentication='not_required', pagination='none', ordering='period_star_delta', full_history=False, notes='单页即全榜，无翻页；行数以页面为准（实测 11–22 行）；榜单只反映当前在榜，不提供历史'),
            'get_item_detail': OperationCapability(False, notes='榜单行已是完整内容单元，不提供详情补全；如需 README 全文应作为独立内容类型'),
            'match_item_url': OperationCapability(True, True, 'not_required', notes='github.com 两段式仓库链接；不支持 issues、topics 等更深路径'),
            'resolve_item': OperationCapability(True, True, 'not_required', notes='本地解析仓库地址，再用页面确认稳定数字 ID'),
            'read_item': OperationCapability(True, deps, 'not_required', notes='读仓库页取稳定 repository_id 与摘要，与榜单共用同一去重键；公开仓库无需登录'),
        }, adapter_version='1', parser_version='1', progress_version=VERSION, content_types=('repo',),
           page_size=1, default_refresh_budget=12, default_backfill_budget=12,
           scan_overhead_budget=0, budget_unit='items')

    async def call(self, action, context, url):
        async with self.resources.acquire(context, action):
            context.check(action)
            return await self.transport.get_html(url, context, action)

    async def resolve_source(self, locator, context):
        # 纯本地判定：三张榜的 <title> 完全一致，无法也不能用响应确认身份。
        context.check('resolve_source')
        return board_source(board_locator(locator))

    async def check_readiness(self, operation, context):
        checked = datetime.now(timezone.utc).isoformat()
        # 单条读取与来源解析都不发探测请求：这些操作本来就必须读一次页面，
        # 再多发一次「检查连接」只会加倍请求。真实失败由那次读取自己带回原因。
        if operation in NO_PROBE:
            context.check(operation)
            return Readiness('ready', operation, 'GitHub 公开页面无需登录；是否可读以实际读取为准',
                             'connection', context.connection.id, checked,
                             dependency='available', authentication='not_required')
        try:
            document = await self.call(operation, context, f"https://github.com/trending?since={SINCE['day']}")
            if not isinstance(document, str) or not _rows(document):
                raise ChannelError('SCHEMA_CHANGED', operation, 'GitHub 趋势页结构已变化')
            return Readiness('ready', operation, 'GitHub 趋势页可正常直连读取，无需登录',
                             'connection', context.connection.id, checked,
                             dependency='available', authentication='not_required')
        except ChannelError as error:
            if error.code == 'CANCELLED':
                raise
            return Readiness('blocked', operation, error.message, 'connection', context.connection.id, checked,
                ({'RATE_LIMITED': ('wait',), 'TIMEOUT': ('retry',),
                  'SCHEMA_CHANGED': ('update_adapter',)}.get(error.code, ('retry',))),
                dependency='unavailable' if error.code == 'DEPENDENCY_UNAVAILABLE' else 'unknown',
                authentication='not_required',
                retry_after=error.retry_after)

    async def search_sources(self, query, request, context):
        # 三张榜是本渠道自己定义的固定集合；这里返回它们，绝不联网，也不碰 github.com/search。
        context.check('search_sources')
        if request.cursor:
            raise ChannelError('UNSUPPORTED_OPERATION', 'search_sources', 'GitHub 趋势榜只有三张固定来源')
        boards = [board_source(board) for board in BOARDS][:max(1, min(request.limit, 3))]
        return SourcePage(tuple(boards))

    async def fetch_page(self, source, request, context):
        if source.kind != 'trending_board' or source.external_id not in SINCE:
            raise ChannelError('INVALID_INPUT', 'list_items', '来源不是 GitHub 趋势榜')
        board = source.external_id
        document = await self.call('list_items', context, f"https://github.com/trending?since={SINCE[board]}")
        captured_at = datetime.now(timezone.utc).isoformat()
        try:
            rows = parse_board(document, captured_at=captured_at)
        except ValueError:
            raise ChannelError('SCHEMA_CHANGED', 'list_items', 'GitHub 趋势页结构已变化') from None
        if len(rows) > ITEM_BUDGET:
            raise ChannelError('SCHEMA_CHANGED', 'list_items', 'GitHub 趋势榜行数异常，请更新适配器')
        known = set(request.known_ids)
        items, skipped = [], 0
        try:
            for row in rows:
                item = board_item(row, source, captured_at=captured_at)
                if item.external_id in known:
                    skipped += 1
                items.append(item)
        except ValueError:
            raise ChannelError('SCHEMA_CHANGED', 'list_items', 'GitHub 趋势行的身份或归属无效') from None
        metrics = {'profile_reads': 1, 'discovered': len(rows), 'skipped': skipped, 'detail_requests': 0}
        return FetchPage(tuple(items), None, 'window_only', True, 'item_limit', metrics=metrics)

    def match_item_url(self, url):
        return repo_link(url) is not None

    async def resolve_item(self, url, context):
        # 必须读一次页面才能给出稳定的数字 ID：内容键是 github:repo:<repository_id>，
        # 而 owner/name 不是稳定键。读到 ID 后上层即可对已收录内容直接判重，不再多读一次。
        context.check('resolve_item')
        link = repo_link(url)
        if not link:
            raise ChannelError('INVALID_INPUT', 'resolve_item', 'GitHub 本期仅支持仓库链接')
        document = await self.call('resolve_item', context, f"https://github.com/{link[0]}/{link[1]}")
        try:
            row = parse_repository_page(document, captured_at=datetime.now(timezone.utc).isoformat())
            if repo_link(f"https://github.com/{row['path']}") != link:
                raise ValueError("different repository")
        except ValueError:
            raise ChannelError('SCHEMA_CHANGED', 'resolve_item', 'GitHub 仓库页未提供稳定的仓库身份') from None
        return ContentReference(CHANNEL, 'repo', row['repository_id'],
                                f"https://github.com/{link[0]}/{link[1]}")

    async def read_item(self, reference, context):
        link = repo_link(reference.url)
        if reference.channel != CHANNEL or reference.namespace != 'repo' or not link:
            raise ChannelError('INVALID_INPUT', 'read_item', '仓库身份或地址无效')
        document = await self.call('read_item', context, f"https://github.com/{link[0]}/{link[1]}")
        try:
            row = parse_repository_page(document, captured_at=datetime.now(timezone.utc).isoformat())
            if repo_link(f"https://github.com/{row['path']}") != link:
                raise ValueError("different repository")
            item = item_from_row(row)
        except ValueError:
            raise ChannelError('SCHEMA_CHANGED', 'read_item', 'GitHub 仓库页未提供稳定的仓库身份') from None
        if reference.external_id and item.external_id != reference.external_id:
            raise ChannelError('SCHEMA_CHANGED', 'read_item', '读取到的仓库与预览身份不一致')
        return item
