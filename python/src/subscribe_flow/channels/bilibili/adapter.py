from subscribe_flow.contracts import ChannelError, FetchPage
from .manifest import descriptor
from .parsers import parse_detail, parse_sources, parse_videos, source_from_locator, video_id


class BilibiliAdapter:
    def __init__(self, backend):
        self.backend = backend

    def describe(self):
        return descriptor()

    async def resolve_source(self, locator, context):
        context.check("resolve_source")
        return source_from_locator(locator)

    async def check_readiness(self, operation, context):
        return await self.backend.check_readiness(operation, context)

    async def fetch_page(self, source, request, context):
        limit = min(request.limit, 50)
        page = 1
        if request.cursor:
            cursor = request.cursor
            if (cursor.get("backend") != "opencli" or cursor.get("version") != "1" or
                    cursor.get("source") != source.key or cursor.get("limit") != limit or
                    type(cursor.get("page")) is not int or not 1 <= cursor["page"] <= 100000):
                raise ChannelError("INVALID_CURSOR", "list_items", "分页位置不兼容，请从头安全重扫")
            page = cursor["page"]
        payload = await self.backend.call(["user-videos", source.external_id, "--page", str(page),
                                           "--limit", str(limit), "--order", "pubdate"], context, "list_items")
        items, errors = parse_videos(payload, source)
        # Even a short page is not proof of termination with the installed CLI.
        cursor = {"backend": "opencli", "version": "1", "source": source.key, "limit": limit, "page": page + 1}
        return FetchPage(items, cursor, "possible_gaps" if errors else "window_only", item_errors=errors)

    async def search_sources(self, query, request, context):
        if not isinstance(query, str) or not query.strip() or len(query) > 200 or query.startswith("-"):
            raise ChannelError("INVALID_INPUT", "search_sources", "搜索词不能为空、以减号开头或超过 200 字符")
        if request.cursor:
            raise ChannelError("UNSUPPORTED_OPERATION", "search_sources", "作者搜索暂只提供第一页候选")
        payload = await self.backend.call(["search", query.strip(), "--type", "user", "--limit", str(min(request.limit, 20))], context, "search_sources")
        return parse_sources(payload)

    async def get_item_detail(self, item_ref, context):
        bvid = video_id(item_ref.removeprefix("bilibili:video:"))
        payload = await self.backend.call(["video", bvid], context, "get_item_detail")
        return parse_detail(payload, bvid)
