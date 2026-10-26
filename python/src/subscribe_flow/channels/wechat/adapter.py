"""One WeChat adapter for subscription collection and single-article intake.

The adapter selects its private paid-list or page implementation by operation.
Core, Gateway and storage consume the same WeChat source/content identities.
"""
import re
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit, urlunsplit

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, ContentItem,
    ContentReference, OperationCapability, PublishedTime, Readiness, Source)

from .identity import CHANNEL, content_external_id, normalize_biz, source_url, split_article_id

BACKEND, VERSION = "electron-session", "wechat-article-1"
HOSTS = {"mp.weixin.qq.com"}
BIZ = re.compile(r"^[A-Za-z0-9+/=_-]{4,64}$")
DIGITS = re.compile(r"^\d{1,30}$")
ARTICLE_ID = re.compile(r"^[A-Za-z0-9+/_=-]{1,120}$")
# 公众号头像与封面：只用官方图片域，且不接受凭据、端口或非 HTTPS。
# mmbiz 图片常带 ?wx_fmt= 之类的处理参数，路径后缀不能作为判定条件。
IMAGE_HOSTS = ("mmbiz.qpic.cn", "wx.qlogo.cn", "mmbiz.qlogo.cn")


def _clean_url(value, *, images=False):
    """Validate an official URL. Nothing but a declared WeChat host survives."""
    if not isinstance(value, str) or not value or len(value) > 4096 or any(c.isspace() or ord(c) < 32 for c in value):
        return None
    # 官方页面仍以 http 提供头像与封面；统一升到 HTTPS，不保留明文地址。
    if images and value.startswith("http://"):
        value = "https://" + value[len("http://"):]
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port is not None:
        return None
    host = parsed.hostname
    if images:
        return value if host and any(host == allowed or host.endswith("." + allowed) for allowed in IMAGE_HOSTS) else None
    if host != "mp.weixin.qq.com":
        return None
    return urlunsplit(("https", host, parsed.path, parsed.query, ""))


def article_link(raw):
    """Return the canonical locator for an official article link, else None.

    Accepts the short /s/<locator> form and the /s?__biz&mid&idx form. Both are
    only *candidates* here: the stable article key always comes from the page,
    never from the parameters a share link happens to carry.
    """
    if not isinstance(raw, str) or len(raw) > 2000 or any(c.isspace() or ord(c) < 32 for c in raw):
        return None
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return None
    if (parsed.scheme not in {"http", "https"} or parsed.hostname not in HOSTS or parsed.username
            or parsed.password or parsed.port not in {None, 80 if parsed.scheme == "http" else 443}):
        return None
    if parsed.path == "/s":
        params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        if BIZ.fullmatch(params.get("__biz", "")) and DIGITS.fullmatch(params.get("mid", "")) and DIGITS.fullmatch(params.get("idx", "")):
            return {"form": "params", "url": urlunsplit(("https", "mp.weixin.qq.com", "/s", parsed.query, ""))}
        # 分享参数（scene/chksm/…）不参与身份，但不能在请求前删掉：微信据此签名。
        return None
    match = re.fullmatch(r"/s/([A-Za-z0-9_-]{16,64})/?", parsed.path)
    if match:
        return {"form": "short", "url": f"https://mp.weixin.qq.com/s/{match[1]}"}
    return None


def account_row(row):
    """The publishing account: a real page-confirmed identity, never the byline."""
    if not isinstance(row, dict) or not ARTICLE_ID.fullmatch(str(row.get("id") or "")):
        raise ValueError("invalid account identity")
    if not isinstance(row.get("name"), str) or not row["name"].strip():
        raise ValueError("invalid account name")
    url = _clean_url(row.get("url"))
    if not url:
        raise ValueError("invalid account link")
    return Source(CHANNEL, "account", normalize_biz(row["id"]), row["name"].strip()[:200],
                  source_url(row["id"]), True,
                  _clean_url(row.get("avatar"), images=True), str(row.get("description") or "")[:350] or None)


def publication(raw):
    if not isinstance(raw, dict) or raw.get("precision") not in {"unknown", "date", "minute", "second"}:
        raise ValueError("invalid publication precision")
    value, precision = raw.get("value"), raw["precision"]
    if (precision == "unknown") != (value is None):
        raise ValueError("inconsistent publication")
    if value is not None:
        if not isinstance(value, str):
            raise ValueError("invalid publication")
        if precision == "date":
            datetime.strptime(value, "%Y-%m-%d")
        elif datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("missing timezone")
    return PublishedTime(value, precision, str(raw.get("provenance") or "unavailable")[:100],
                         "Asia/Shanghai", str(raw.get("raw_label") or "")[:200] or None)


def _cover(row):
    raw = row.get("cover")
    candidates = raw if isinstance(raw, list) else [raw]
    return next((image for image in (_clean_url(value, images=True) for value in candidates) if image), None)


def item_from_row(row, source=None):
    if (not isinstance(row, dict) or not ARTICLE_ID.fullmatch(str(row.get("id") or ""))
            or row.get("acquisition_complete") is not True or not isinstance(row.get("title"), str)
            or not row["title"].strip() or not isinstance(row.get("content"), str)
            or not isinstance(row.get("images"), list)
            or not _clean_url(row.get("url"))):
        raise ValueError("invalid article identity/content")
    actual = account_row(row["account"])
    if source and actual.key != source.key:
        raise ValueError("article does not belong to account")
    # 页面确认的原文地址才是保存用的链接；不保留粘贴时的分享参数。
    biz, mid, idx = split_article_id(row['id'])
    if biz != actual.external_id:
        raise ValueError('article does not belong to account')
    return ContentItem(CHANNEL, 'article', content_external_id(biz, mid, idx), actual, row["title"].strip()[:1000],
                       _clean_url(row["url"]), kind='article', published=publication(row["published"]),
                       summary=row["content"], thumbnail=_cover(row), acquisition_complete=True, body_state="full")


class WechatAdapter:
    def __init__(self, bridge=None, paid_service=None):
        self.bridge, self.paid_service = bridge, paid_service
        self.resources = ResourceCoordinator()

    def describe(self):
        from subscribe_flow.channels.wxrank import protocol
        page = self.bridge is not None
        paid = self.paid_service is not None
        deps = ("electron-session",)
        return ChannelDescriptor(CHANNEL, "微信公众号", BACKEND, {
            'resolve_source': OperationCapability(paid, dependencies=('paid-api',), authentication='not_required',
                notes='输入公众号 biz 或含 __biz 的链接；首次解析消耗一次付费调用，命中缓存不消耗'),
            'search_sources': OperationCapability(False, notes='本期不提供公众号搜索'),
            'list_items': OperationCapability(paid, dependencies=('paid-api',), authentication='not_required',
                pagination='cursor', ordering='server_cursor', full_history=False,
                notes='按页获取文章列表；每一页都是一次付费调用，游标由上游给出'),
            'get_item_detail': OperationCapability(False, notes='单篇读取通过人工添加；列表采集不提供正文补充'),
            'match_item_url': OperationCapability(page, verified=True, authentication='not_required',
                notes='官方 /s/<定位串> 与 /s?__biz&mid&idx 文章链接'),
            'resolve_item': OperationCapability(page, dependencies=deps, authentication='not_required',
                notes='读取官方页面确认稳定文章身份；公开文章无需登录'),
            'read_item': OperationCapability(page, dependencies=deps, authentication='not_required',
                notes='读取标题、公众号、正文、封面与原始发布时间；不要求订阅'),
        }, adapter_version='wechat-2', parser_version=protocol.PARSER_VERSION if paid else '1',
           progress_version=protocol.PROGRESS_VERSION if paid else VERSION, content_types=('article',),
           page_size=protocol.PAGE_SIZE if paid else 1, default_refresh_budget=1,
           default_backfill_budget=3 if paid else 1, scan_overhead_budget=0,
           budget_unit='pages' if paid else 'items', paid=paid, resumable=paid, source_homepage=False)

    async def resolve_source(self, locator, context):
        if self.paid_service is None:
            raise ChannelError('UNSUPPORTED_OPERATION', 'resolve_source', '公众号订阅采集实现不可用')
        return await self.paid_service.resolve_source(locator, context)

    async def fetch_page(self, source, request, context):
        if self.paid_service is None:
            raise ChannelError('UNSUPPORTED_OPERATION', 'list_items', '公众号订阅采集实现不可用')
        if source.channel != CHANNEL or source.kind != 'account':
            raise ChannelError('INVALID_INPUT', 'list_items', '来源不是公众号账号')
        return await self.paid_service.fetch_page(source, request, context)

    async def search_sources(self, query, request, context):
        raise ChannelError('UNSUPPORTED_OPERATION', 'search_sources', '本期不提供公众号搜索')

    async def get_item_detail(self, item_ref, context):
        raise ChannelError('UNSUPPORTED_OPERATION', 'get_item_detail', '列表采集不提供正文与详情补充')

    async def call(self, action, context, **params):
        async with self.resources.acquire(context, action):
            data = await self.bridge.call(params, context, action)
        if not isinstance(data, dict):
            raise ChannelError('SCHEMA_CHANGED', action, '微信公众号采集响应无效')
        return data

    async def check_readiness(self, operation, context):
        checked = datetime.now(timezone.utc).isoformat()
        context.check(operation)
        if operation in {'match_item_url', 'resolve_item', 'read_item'}:
            if self.bridge is None:
                return Readiness('blocked', operation, '文章页面读取实现不可用',
                    'operation', operation, checked, dependency='not_configured', authentication='not_required')
            return Readiness('ready', operation, '微信公众号单条文章读取无需登录；文章是否可读以实际读取为准',
                'operation', operation, checked, dependency='available', authentication='not_required')
        if operation not in {'resolve_source', 'list_items'} or self.paid_service is None:
            raise ChannelError('UNSUPPORTED_OPERATION', operation, '微信公众号不支持此操作')
        # The paid implementation's local configuration does not gate manual intake.
        from subscribe_flow.channels.wxrank import protocol
        entry = self.paid_service.settings.channel_credential(protocol.PROVIDER_ID) or {}
        if not entry.get('enabled', True):
            return Readiness('blocked', operation, '付费采集已停用',
                'operation', operation, checked, actions=('settings',),
                dependency='not_configured', authentication='configured')
        if not self.paid_service.configured():
            return Readiness('blocked', operation, '尚未配置付费采集密钥',
                'operation', operation, checked, actions=('settings',),
                dependency='not_configured', authentication='required')
        return Readiness('ready', operation, '已配置付费采集密钥，未联网验证',
            'operation', operation, checked, dependency='available', authentication='configured')

    def match_item_url(self, url):
        return article_link(url) is not None

    async def resolve_item(self, url, context):
        context.check('resolve_item')
        link = article_link(url)
        if not link:
            raise ChannelError('INVALID_INPUT', 'resolve_item', '请使用微信公众号文章的官方链接')
        data = await self.call('resolve_item', context, operation='resolve', url=link['url'])
        try:
            item_id = item_from_row(data['article'])
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'resolve_item', '未能从微信页面确认稳定的文章身份') from None
        return ContentReference(CHANNEL, 'article', item_id.external_id, item_id.url)

    async def read_item(self, reference, context):
        if reference.channel != CHANNEL or reference.namespace != 'article':
            raise ChannelError('INVALID_INPUT', 'read_item', '文章身份或地址无效')
        link = article_link(reference.url)
        if not link:
            raise ChannelError('INVALID_INPUT', 'read_item', '文章地址无效')
        data = await self.call('read_item', context, operation='read', url=link['url'], id=reference.external_id)
        try:
            item = item_from_row(data['article'])
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError('SCHEMA_CHANGED', 'read_item', '微信文章正文或公众号身份无效') from None
        if item.key != reference.key:
            raise ChannelError('SCHEMA_CHANGED', 'read_item', '读取到的文章与预览身份不一致')
        return item