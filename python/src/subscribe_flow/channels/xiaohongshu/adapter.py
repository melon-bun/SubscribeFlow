import re
from datetime import date, datetime, timezone
from urllib.parse import urlparse, parse_qs

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, ContentItem, ContentPatch,
    FetchPage, ItemError, OperationCapability, PublishedTime, Readiness, Source, SourcePage)

CHANNEL = "xiaohongshu"
BACKEND = "electron-session"
VERSION = "xhs-page-3"
ID = re.compile(r"^[a-f0-9]{24}$")


def source_from_locator(locator):
    if not isinstance(locator, str):
        raise ChannelError("INVALID_INPUT", "resolve_source", "请输入作者 ID 或完整主页")
    value = locator.strip().lower()
    if not ID.fullmatch(value):
        parsed = urlparse(locator.strip())
        match = re.fullmatch(r"/user/profile/([a-fA-F0-9]{24})/?", parsed.path)
        if parsed.scheme != "https" or parsed.netloc != "www.xiaohongshu.com" or not match:
            raise ChannelError("INVALID_INPUT", "resolve_source", "请输入完整的小红书作者主页，或使用昵称搜索后确认作者")
        value = match[1].lower()
    return Source(CHANNEL, "author", value, f"作者 {value}", f"https://www.xiaohongshu.com/user/profile/{value}")


def image_url(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        return None
    u = urlparse(raw)
    if u.scheme == "https" and not u.username and not u.password and u.hostname and (u.hostname.endswith(".xhscdn.com") or u.hostname.endswith(".xiaohongshu.com")):
        return raw
    return None


def publication(row):
    p = row.get("published")
    if not isinstance(p, dict) or p.get("precision") not in {"second", "date", "unknown"}:
        raise ValueError("invalid publication")
    value = p.get("value")
    if value is not None:
        if not isinstance(value, str):
            raise ValueError("invalid timestamp")
        if p["precision"] == "date":
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError("invalid date")
            date.fromisoformat(value)
        elif datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("invalid timezone")
    if (p["precision"] == "unknown") != (value is None):
        raise ValueError("inconsistent publication")
    return PublishedTime(value, p["precision"], str(p.get("provenance", "unavailable"))[:100],
                         "Asia/Shanghai", str(p.get("raw_label") or "")[:200] or None)


def item_from_row(row, source):
    if (not isinstance(row, dict) or not ID.fullmatch(str(row.get("id", ""))) or
            row.get("authorId") != source.external_id or row.get("acquisition_complete") is not True or
            not isinstance(row.get("title"), str) or not row["title"].strip() or not isinstance(row.get("content"), str)):
        raise ValueError("invalid note identity or detail")
    url = row.get("url")
    parsed = urlparse(url) if isinstance(url, str) else None
    query = parse_qs(parsed.query) if parsed else {}
    if (not parsed or len(url) > 4096 or parsed.scheme != 'https' or parsed.netloc != 'www.xiaohongshu.com' or
            parsed.path != f"/discovery/item/{row['id']}" or query.get('source') != ['webshare'] or
            query.get('xsec_source') != ['pc_share'] or not query.get('xsec_token') or parsed.fragment):
        raise ValueError("invalid official share link")
    pictures = row.get("images") or []
    thumbnail = next((image_url(url) for url in pictures if image_url(url)), None)
    return ContentItem(CHANNEL, "note", row["id"], source, row["title"].strip()[:1000],
        url, kind="note", published=publication(row),
        summary=row["content"][:200000], thumbnail=thumbnail, acquisition_complete=True)


class XiaohongshuAdapter:
    """Maps the page backend to the shared contract, without accessing a database.

    Core supplies known identities and source context. A replacement backend can
    implement this same contract without changing subscriptions or local views.
    """
    def __init__(self, bridge):
        self.bridge = bridge
        self.resources = ResourceCoordinator()

    def describe(self):
        deps = ("electron-session",)
        return ChannelDescriptor(CHANNEL, "小红书", BACKEND, {
            "resolve_source": OperationCapability(True, True, "not_required", notes="本地解析作者主页；昵称由搜索候选确认"),
            "search_sources": OperationCapability(True, dependencies=deps, authentication="required", notes="昵称搜索，仅显示当前已加载的候选"),
            "list_items": OperationCapability(True, dependencies=deps, authentication="required", pagination="bounded_profile_scan",
                ordering="pinned_and_unordered", full_history=False, notes="按主页顺序检查限定条数，已收录也占名额；有界扫描不保证全部历史"),
            "get_item_detail": OperationCapability(True, dependencies=deps, authentication="required", notes="重新从作者主页取得访问链接后补充详情"),
        }, adapter_version="3", parser_version="2", progress_version=VERSION, content_types=("note",),
            page_size=1, default_refresh_budget=8, default_backfill_budget=30, scan_overhead_budget=13, budget_unit="items")

    async def call(self, action, context, **params):
        async with self.resources.acquire(context, action):
            data = await self.bridge.call(params, context, action)
        if not isinstance(data, dict):
            raise ChannelError("SCHEMA_CHANGED", action, "小红书采集响应无效")
        return data

    async def resolve_source(self, locator, context):
        context.check("resolve_source")
        return source_from_locator(locator)

    async def check_readiness(self, operation, context):
        checked = datetime.now(timezone.utc).isoformat()
        try:
            data = await self.call(operation, context, operation="check")
            if type(data.get("authenticated")) is not bool:
                raise ChannelError("SCHEMA_CHANGED", operation, "小红书连接状态无效")
            if not data["authenticated"]:
                raise ChannelError("AUTH_REQUIRED", operation, "请在应用内登录小红书，关闭窗口后检查连接")
            return Readiness("ready", operation, "小红书应用内会话已登录，搜索与采集在隐藏页面进行", "connection", context.connection.id,
                checked, dependency="available", authentication="available")
        except ChannelError as error:
            if error.code == "CANCELLED":
                raise
            return Readiness("blocked", operation, error.message, "connection", context.connection.id, checked,
                ("open_browser",) if error.code in {"AUTH_REQUIRED", "INTERACTION_REQUIRED"} else ("retry",),
                dependency="unavailable" if error.code == "DEPENDENCY_UNAVAILABLE" else "unknown",
                authentication="required" if error.code.startswith("AUTH_") else "unknown")

    async def search_sources(self, query, request, context):
        if not isinstance(query, str) or not query.strip() or len(query) > 100:
            raise ChannelError("INVALID_INPUT", "search_sources", "请输入 1 到 100 字的昵称")
        if request.cursor:
            raise ChannelError("UNSUPPORTED_OPERATION", "search_sources", "本期搜索仅提供当前已加载的候选")
        data = await self.call("search_sources", context, operation="search", query=query.strip(), limit=min(request.limit, 50))
        if not isinstance(data.get("users"), list) or not data["users"] and data.get("empty") is not True:
            raise ChannelError("SCHEMA_CHANGED", "search_sources", "搜索缺少候选或明确空结果证据")
        sources = []
        try:
            for row in data["users"][:request.limit]:
                source = source_from_locator(row["id"])
                if not isinstance(row["name"], str) or not row["name"].strip():
                    raise ValueError("invalid author")
                sources.append(Source(CHANNEL, "author", source.external_id, row["name"].strip()[:200], source.url, True,
                    image_url(row.get("avatar")), str(row.get("description") or "")[:350] or None))
        except (ValueError, TypeError, KeyError, ChannelError):
            raise ChannelError("SCHEMA_CHANGED", "search_sources", "搜索候选的作者身份无效") from None
        return SourcePage(tuple(sources))

    async def fetch_page(self, source, request, context):
        budget = request.item_budget or self.describe().default_refresh_budget
        if type(budget) is not int or not 1 <= budget <= 50:
            raise ChannelError("INVALID_INPUT", "list_items", "小红书本轮采集条数需为 1 到 50")
        cursor = request.cursor
        if cursor and (cursor.get("version") != VERSION or cursor.get("source") != source.key or
                       cursor.get("mode") != request.mode or cursor.get("limit") != budget or not isinstance(cursor.get("token"), str)):
            raise ChannelError("INVALID_CURSOR", "list_items", "小红书扫描位置已失效，请重新刷新")
        params = dict(operation="scan", uid=source.external_id, job_id=context.job_id, cursor=cursor["token"] if cursor else None,
                      limit=budget, mode=request.mode)
        if not cursor:
            params["known_ids"] = list(request.known_ids)
        data = await self.call("list_items", context, **params)
        if (not isinstance(data.get("items"), list) or len(data["items"]) > 1 or not isinstance(data.get("errors"), list) or
                type(data.get("terminal")) is not bool or not isinstance(data.get("metrics"), dict)):
            raise ChannelError("SCHEMA_CHANGED", "list_items", "小红书扫描结果缺少进度证据")
        items, errors = [], []
        try:
            for row in data["items"]:
                items.append(item_from_row(row, source))
            for e in data["errors"]:
                errors.append(ItemError(int(e["index"]), str(e["code"])[:100], str(e["message"])[:500]))
            metrics = data["metrics"]
            if set(metrics) != {"profile_reads", "discovered", "skipped", "detail_requests"} or any(type(v) is not int or v < 0 for v in metrics.values()):
                raise ValueError("invalid metrics")
            if metrics["detail_requests"] > 1 or metrics["profile_reads"] > 1 or metrics["skipped"] > metrics["discovered"]:
                raise ValueError("inconsistent metrics")
            if metrics["profile_reads"] + metrics["detail_requests"] != 1 or len(items) + len(errors) != metrics["detail_requests"]:
                raise ValueError("missing scan progress")
        except (KeyError, ValueError, TypeError):
            raise ChannelError("SCHEMA_CHANGED", "list_items", "小红书笔记身份、发布时间或扫描进度无效") from None
        next_cursor = None
        if not data["terminal"]:
            if not isinstance(data.get("cursor"), str) or not re.fullmatch(r"[a-f0-9-]{36}:\d{1,3}", data["cursor"]):
                raise ChannelError("SCHEMA_CHANGED", "list_items", "扫描未结束但缺少继续位置")
            next_cursor = dict(version=VERSION, source=source.key, mode=request.mode, limit=budget, token=data["cursor"])
            if cursor and next_cursor["token"] == cursor["token"]:
                raise ChannelError("NO_PROGRESS", "list_items", "小红书扫描位置未推进，保留已保存结果")
        elif data.get("cursor") is not None or not data.get("end_evidence"):
            raise ChannelError("SCHEMA_CHANGED", "list_items", "扫描结束缺少证据")
        return FetchPage(tuple(items), next_cursor, "possible_gaps" if errors or data.get("end_evidence") == "scan_bound" else "window_only",
            data["terminal"], data.get("end_evidence"), item_errors=tuple(errors), scan_advanced=True, metrics=metrics)

    async def get_item_detail(self, item_ref, context):
        key = item_ref.removeprefix("xiaohongshu:note:")
        if not ID.fullmatch(key) or not context.source or context.source.channel != CHANNEL:
            raise ChannelError("INVALID_INPUT", "get_item_detail", "详情缺少笔记身份或所属作者")
        data = await self.call("get_item_detail", context, operation="detail", uid=context.source.external_id, id=key)
        try:
            item = item_from_row(data["note"], context.source)
            if item.external_id != key:
                raise ValueError("different note")
            return ContentPatch(item.key, {"title":item.title, "summary":item.summary, "thumbnail":item.thumbnail,
                                          "published":item.published, "url":item.url, "acquisition_complete":True})
        except (ValueError, TypeError, KeyError):
            raise ChannelError("SCHEMA_CHANGED", "get_item_detail", "笔记详情身份或数据无效") from None
