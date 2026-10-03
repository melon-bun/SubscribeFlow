import re
from datetime import date, datetime
from urllib.parse import urlsplit

from subscribe_flow.contracts import ChannelError, ContentItem, ContentPatch, ItemError, PublishedTime, Source, SourcePage


def source_from_locator(locator: str) -> Source:
    raw = locator.strip()
    uid = raw
    if not re.fullmatch(r"[0-9]{1,20}", raw):
        try:
            url = urlsplit(raw)
            match = re.fullmatch(r"/([0-9]{1,20})(?:/(?:video|upload/video))?/?", url.path)
            if url.scheme not in {"http", "https"} or url.hostname != "space.bilibili.com" or url.username or url.password or url.port or not match:
                raise ValueError()
            uid = match[1]
        except ValueError as exc:
            raise ChannelError("INVALID_INPUT", "resolve_source", "请输入 B站 UID 或合法作者主页链接") from exc
    if int(uid) <= 0:
        raise ChannelError("INVALID_INPUT", "resolve_source", "UID 必须是正整数")
    uid = str(int(uid))
    return Source("bilibili", "author", uid, f"UID {uid}", f"https://space.bilibili.com/{uid}", False)


def video_id(value: str) -> str:
    if re.fullmatch(r"BV[0-9A-Za-z]{10}", value):
        return value
    try:
        url = urlsplit(value)
        match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", url.path)
        if url.scheme not in {"https", "http"} or url.hostname not in {"www.bilibili.com", "bilibili.com", "m.bilibili.com"} or url.username or url.password or url.port or not match:
            raise ValueError()
        return match[1]
    except ValueError as exc:
        raise ChannelError("INVALID_INPUT", "get_item_detail", "请输入 BVID 或 B站视频链接；当前不支持 AV 号输入") from exc


def rows(payload, operation: str) -> list:
    if not isinstance(payload, list):
        raise ChannelError("SCHEMA_CHANGED", operation, "OpenCLI 输出结构不兼容", scope="backend", scope_key="bilibili:opencli")
    # OpenCLI 1.8.8 maps API errors or missing list fields to []. There is no
    # envelope left to distinguish a genuinely empty source from access failure.
    if not payload:
        raise ChannelError("UNVERIFIED_EMPTY", operation, "工具返回空数组，但未提供有效空结果或末页证据；请检查连接后重试")
    return payload


def parse_videos(payload, source: Source):
    items, errors = [], []
    for index, row in enumerate(rows(payload, "list_items")):
        try:
            if not isinstance(row, dict) or not isinstance(row.get("title"), str) or not row["title"].strip():
                raise ValueError("missing title")
            bvid = video_id(row.get("url", ""))
            published = PublishedTime()
            raw_date = row.get("date")
            if raw_date not in (None, "", "-", "--", "N/A"):
                if not isinstance(raw_date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_date):
                    raise ValueError("invalid date")
                date.fromisoformat(raw_date)
                published = PublishedTime(raw_date, "date", "opencli-1.8.8:created-utc-date", "UTC")
            items.append(ContentItem("bilibili", "video", bvid, source, row["title"].strip(),
                                     f"https://www.bilibili.com/video/{bvid}", published=published))
        except (ValueError, TypeError, AttributeError, ChannelError):
            errors.append(ItemError(index, "INVALID_ITEM", "条目缺少有效标题、BVID 或日期"))
    if not items:
        raise ChannelError("SCHEMA_CHANGED", "list_items", "整页没有可解析的投稿条目", scope="backend", scope_key="bilibili:opencli")
    return tuple(items), tuple(errors)


def parse_sources(payload) -> SourcePage:
    result = []
    for row in rows(payload, "search_sources"):
        try:
            source = source_from_locator(row["url"])
            name = row["title"].strip()
            if not name:
                raise ValueError()
            result.append(Source(source.channel, source.kind, source.external_id, name, source.url, True))
        except (KeyError, TypeError, AttributeError, ValueError, ChannelError) as exc:
            raise ChannelError("SCHEMA_CHANGED", "search_sources", "作者搜索缺少有效名称或稳定 UID") from exc
    return SourcePage(tuple(result))


def parse_detail(payload, expected_bvid: str) -> ContentPatch:
    data = {}
    for row in rows(payload, "get_item_detail"):
        if not isinstance(row, dict) or not isinstance(row.get("field"), str) or "value" not in row or row["field"] in data:
            raise ChannelError("SCHEMA_CHANGED", "get_item_detail", "详情字段结构不兼容")
        data[row["field"]] = row["value"]
    if data.get("bvid") != expected_bvid or not isinstance(data.get("title"), str) or not data["title"].strip():
        raise ChannelError("SCHEMA_CHANGED", "get_item_detail", "详情身份或标题不匹配")
    fields = {"title": data["title"]}
    for raw, target in (("description", "summary"), ("thumbnail", "thumbnail")):
        if isinstance(data.get(raw), str) and data[raw]:
            fields[target] = data[raw]
    if data.get("publish_time"):
        try:
            value = datetime.strptime(data["publish_time"], "%Y-%m-%d %H:%M")
            fields["published"] = PublishedTime(value.isoformat(timespec="minutes") + "+00:00", "minute", "opencli-1.8.8:pubdate-utc-minute", "UTC")
        except (ValueError, TypeError) as exc:
            raise ChannelError("SCHEMA_CHANGED", "get_item_detail", "详情时间格式已变化") from exc
    if match := re.search(r"\((\d+)s\)$", str(data.get("duration", ""))):
        fields["duration_seconds"] = int(match[1])
    return ContentPatch(f"bilibili:video:{expected_bvid}", fields)
