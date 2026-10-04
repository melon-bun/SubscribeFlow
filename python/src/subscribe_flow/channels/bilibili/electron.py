"""Bilibili web API envelopes from the desktop-owned Chromium session."""
import html
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, ContentItem, ContentPatch,
                                     FetchPage, ItemError, OperationCapability, PublishedTime, Readiness,
                                     Source, SourcePage)
from .parsers import source_from_locator, video_id

BACKEND = "electron-session"


def envelope(payload, operation):
    if not isinstance(payload, dict) or type(payload.get("code")) is not int:
        raise ChannelError("SCHEMA_CHANGED", operation, "B站响应缺少有效状态码")
    code = payload["code"]
    if code:
        mapped = {-101: ("AUTH_REQUIRED", "请在应用内登录 B站后重试"),
                  -352: ("INTERACTION_REQUIRED", "B站要求访问验证，请打开应用内 B站页面检查"),
                  -412: ("INTERACTION_REQUIRED", "B站暂时限制此会话，请在应用内检查，勿连续重试"),
                  -509: ("RATE_LIMITED", "B站请求过于频繁，请稍后重试"),
                  -404: ("NOT_FOUND", "作者或视频不存在或不可访问")}
        name, message = mapped.get(code, ("ACCESS_FAILED", "B站拒绝了本次请求"))
        raise ChannelError(name, operation, f"{message}（平台码 {code}）",
                           scope="connection" if name in {"AUTH_REQUIRED", "INTERACTION_REQUIRED", "RATE_LIMITED"} else "operation",
                           retryable=name == "RATE_LIMITED", retry_after=300 if name == "RATE_LIMITED" else None)
    if not isinstance(payload.get("data"), dict):
        raise ChannelError("SCHEMA_CHANGED", operation, "B站成功响应缺少数据")
    return payload["data"]


def published(value):
    if type(value) not in {int, float} or not 0 < value < 253402300799:
        return PublishedTime()
    return PublishedTime(datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
                         "second", "bilibili-api:unix", "UTC")


def picture(value):
    if not isinstance(value, str):
        return None
    value = "https:" + value if value.startswith("//") else value
    if value.startswith("http://"):
        value = "https://" + value[7:]
    parsed = urlparse(value)
    if parsed.scheme == "https" and not parsed.username and not parsed.password and parsed.hostname and parsed.hostname.endswith(".hdslb.com"):
        return value
    return None


def title(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("missing title")
    cleaned = html.unescape(re.sub(r"<[^>]*>", "", value)).strip()
    if not cleaned:
        raise ValueError("empty title")
    return cleaned


class BilibiliElectronAdapter:
    def __init__(self, bridge):
        self.bridge = bridge
        self.resources = ResourceCoordinator()

    def describe(self):
        deps = ("electron-session",)
        return ChannelDescriptor("bilibili", "哔哩哔哩", BACKEND, {
            "resolve_source": OperationCapability(True, True, "not_required", notes="本地解析 UID/主页；不代表账号存在"),
            "search_sources": OperationCapability(True, dependencies=deps, notes="应用内会话；不读取外部 Chrome"),
            "list_items": OperationCapability(True, dependencies=deps, pagination="page_number",
                ordering="pubdate_requested_not_guaranteed", full_history=False,
                notes="保留状态码与总数证据；平台页码可变，当前不承诺全部历史"),
            "get_item_detail": OperationCapability(True, dependencies=deps, notes="应用内会话补充详情"),
        }, adapter_version="2", parser_version="2", progress_version="electron-1")

    async def call(self, action, context, **params):
        async with self.resources.acquire(context, action):
            return await self.bridge.call(params, context, action)

    async def resolve_source(self, locator, context):
        context.check("resolve_source")
        return source_from_locator(locator)

    async def check_readiness(self, operation, context):
        checked = datetime.now(timezone.utc).isoformat()
        try:
            data = envelope(await self.call(operation, context, operation="check"), operation)
            if type(data.get("authenticated")) is not bool:
                raise ChannelError("SCHEMA_CHANGED", operation, "B站会话检查数据无效")
            logged_in = data["authenticated"]
            return Readiness("ready" if logged_in else "degraded", operation,
                "应用内 B站会话已登录；具体采集结果以任务为准" if logged_in else "应用内 B站尚未登录；可尝试公开内容，受限时请先登录",
                "connection", context.connection.id, checked, () if logged_in else ("open_browser",),
                dependency="available", authentication="available" if logged_in else "required")
        except ChannelError as error:
            if error.code == "CANCELLED":
                raise
            return Readiness("blocked", operation, error.message, "connection", context.connection.id, checked,
                ("open_browser",) if error.code in {"AUTH_REQUIRED", "INTERACTION_REQUIRED"} else ("wait",) if error.code == "RATE_LIMITED" else ("retry",),
                dependency="unavailable" if error.code == "DEPENDENCY_UNAVAILABLE" else "unknown",
                authentication="required" if error.code == "AUTH_REQUIRED" else "unknown", retry_after=error.retry_after)

    async def search_sources(self, query, request, context):
        if not isinstance(query, str) or not query.strip() or len(query) > 200:
            raise ChannelError("INVALID_INPUT", "search_sources", "搜索词需为 1 到 200 字符")
        if request.cursor:
            raise ChannelError("UNSUPPORTED_OPERATION", "search_sources", "作者搜索暂只提供第一页")
        data = envelope(await self.call("search_sources", context, operation="search", query=query.strip(), limit=min(request.limit,20)), "search_sources")
        rows = data.get("result")
        if not isinstance(rows, list) or (not rows and data.get("numResults") != 0):
            raise ChannelError("SCHEMA_CHANGED", "search_sources", "作者搜索结果缺少有效列表或空结果证据")
        items = []
        try:
            for row in rows[:request.limit]:
                source = source_from_locator(str(row["mid"]))
                items.append(Source("bilibili", "author", source.external_id, title(row["uname"]), source.url, True))
        except (KeyError, TypeError, ValueError, ChannelError):
            raise ChannelError("SCHEMA_CHANGED", "search_sources", "作者搜索返回了无效身份信息") from None
        return SourcePage(tuple(items))

    async def fetch_page(self, source, request, context):
        operation = "list_items"
        limit, page = min(request.limit,50), 1
        if request.cursor:
            c = request.cursor
            if (c.get("backend") != BACKEND or c.get("version") != "electron-1" or c.get("source") != source.key or
                    c.get("limit") != limit or type(c.get("page")) is not int or not 1 <= c["page"] <= 100000):
                raise ChannelError("INVALID_CURSOR", operation, "分页位置已失效，请从头安全重扫")
            page = c["page"]
        data = envelope(await self.call(operation, context, operation="list", uid=source.external_id,page=page,limit=limit), operation)
        rows, info = data.get("list", {}).get("vlist") if isinstance(data.get("list"), dict) else None, data.get("page")
        if (not isinstance(rows, list) or not isinstance(info, dict) or
                any(type(info.get(k)) is not int for k in ("pn", "ps", "count")) or
                info["pn"] != page or info["ps"] != limit or info["count"] < 0 or len(rows) > limit):
            raise ChannelError("SCHEMA_CHANGED", operation, "投稿响应缺少匹配的分页与总数证据")
        expected = min(limit, max(0, info["count"] - (page-1)*limit))
        if len(rows) != expected:
            raise ChannelError("UNVERIFIED_EMPTY" if not rows else "SCHEMA_CHANGED", operation, "投稿列表与平台总数不一致，请稍后重新采集")
        items, errors = [], []
        for index, row in enumerate(rows):
            try:
                bvid = video_id(row["bvid"])
                if "mid" in row and str(row["mid"]) != source.external_id:
                    raise ValueError("source mismatch")
                items.append(ContentItem("bilibili", "video", bvid, source, title(row["title"]),
                    f"https://www.bilibili.com/video/{bvid}", published=published(row.get("created")),
                    summary=row.get("description") if isinstance(row.get("description"), str) else None,
                    thumbnail=picture(row.get("pic"))))
            except (KeyError, TypeError, ValueError, ChannelError):
                errors.append(ItemError(index, "SCHEMA_CHANGED", "视频条目缺少有效身份或标题"))
        if rows and not items:
            raise ChannelError("SCHEMA_CHANGED", operation, "投稿页所有条目均无效")
        terminal = page*limit >= info["count"]
        cursor = None if terminal else {"backend":BACKEND,"version":"electron-1","source":source.key,"limit":limit,"page":page+1}
        return FetchPage(tuple(items), cursor, "possible_gaps" if errors else "window_only", terminal,
                         f"api_count={info['count']};page={page};size={limit}" if terminal else None, item_errors=tuple(errors))

    async def get_item_detail(self, item_ref, context):
        bvid = video_id(item_ref.removeprefix("bilibili:video:"))
        data = envelope(await self.call("get_item_detail", context, operation="detail", bvid=bvid), "get_item_detail")
        try:
            if data["bvid"] != bvid:
                raise ValueError("identity mismatch")
            fields = {"title":title(data["title"])}
            if isinstance(data.get("desc"), str):
                fields["summary"] = data["desc"]
            if cover := picture(data.get("pic")):
                fields["thumbnail"] = cover
            if (date := published(data.get("pubdate"))).value:
                fields["published"] = date
            if type(data.get("duration")) is int and data["duration"] >= 0:
                fields["duration_seconds"] = data["duration"]
            return ContentPatch(f"bilibili:video:{bvid}", fields)
        except (KeyError, TypeError, ValueError):
            raise ChannelError("SCHEMA_CHANGED", "get_item_detail", "视频详情身份或标题无效") from None
