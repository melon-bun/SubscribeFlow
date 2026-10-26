"""M45 付费渠道（wxrank）冻结契约。

本模块保存供应商请求形状、业务码与计费口径，业务身份统一复用 wechat.identity。
transport、service 与测试引用同一协议，供应商不作为独立业务渠道。

真实付费响应不进入仓库：仓库内只有脱敏样本（channels/wxrank/fixtures.py），
它们不含任何密钥、真实公众号身份或真实文章地址。

三处必须保持一致的规则：
1. 身份：缓存键、来源定位地址与内容身份使用同一份规范 biz。
2. 计费：只有 code=0 的调用记为已确认消费；网络未决一律记「结果未知」，
   不得为了界面好看而写成零消费。
3. 密钥：运行时密钥只出现在请求体的 ``key`` 字段里，不进 URL、日志与账本。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from subscribe_flow.contracts import PublishedTime

from subscribe_flow.channels.wechat.identity import (CHANNEL, content_external_id,
    content_key, extract_biz, normalize_biz, source_url)

PROVIDER_ID = "wxrank"
BACKEND = "electron-session"
ADAPTER_VERSION = "wxrank-1"
#: 解析版本。2026-10-25 用真实上游样本核对后升到 2。
#: 变化点：上游真实字段是 ``art_url``／``pic_url``／``hd_head_img``，
#: 且文章地址带一层 HTML 转义（参数之间是 ``&amp;``）。旧解析器取不到
#: mid／idx，会把真实响应当成结构变化，因此旧检查点必须作废、从头重扫。
PARSER_VERSION = "wxrank-2"
PROGRESS_VERSION = "wxrank-1"

#: 上游固定入口。只允许这两个路径，其它一律不请求。
API_ROOT = "https://data.wxrank.com"
PATH_INFO = "/weixin/getinfo"
PATH_LIST = "/weixin/getps"
ALLOWED_PATHS = (PATH_INFO, PATH_LIST)

#: 一次成功调用的积分口径。2026-10-25 样本观察值为 5 积分／次。
#: 观察值不等于上游承诺，所以只有 code=0 的调用才记为已确认消费，
#: 且这个数字不参与任何本地拦截（本期不做余额预算）。
CREDITS_PER_CALL = 5

#: 单页条数。原实测样本每页约 9～10 篇，因此按 10 条推导页数与费用；
#: 上游真的返回更多时按 limit 截断，不因此多算页数或多报费用。
PAGE_SIZE = 10

#: 单页最多保留多少条目。上游一页是「10 次推送 × 每次最多 8 篇」，
#: 真实页可能多于 10 条；付费页是原子的，条目按页保留，不按估算条数丢弃。
#: 这个上限只用来给内存兜底。
MAX_PAGE_ITEMS = 100

#: 服务端游标的保守有效期（秒）。
#: 原记录提到「游标 24 小时有效」，但那只是有限样本的观察，未归档复验。
#: 这里按保守方向取值：宁可当成过期后从头重扫（多花一次钱），
#: 也不要用一个可能已经失效的游标把中间的历史整段跳过。
CURSOR_TTL_SECONDS = 24 * 3600

#: 上游业务码。0 为成功；其余为业务失败，服务端已明确答复。
#: 这张表来自上游文档与真实样本；``code≠0`` 一律不扣费。
CODE_OK = 0
CODE_KEY_INVALID = 1000       # 积分不足或密钥无效（msg 带剩余余额）
CODE_MISSING_WXID = 1001      # 缺少 wxid
CODE_WXID_REJECTED = 1002      # wxid 校验失败
CODE_CURSOR_REJECTED = 1003   # cursor 校验失败（游标过期或非法）
CODE_REQUEST_FAILED = 1004    # 上游请求失败
CODE_TIMEOUT = 1005           # 上游超时
CODE_QPS_EXCEEDED = 9999      # QPS 超限（每秒最多 5 次）

#: 账本里的扣费判定。只有这三种，不引入第四种「大概没扣」。
CHARGE_CONFIRMED = "confirmed"      # 已确认消费（code=0）
CHARGE_NOT_CHARGED = "not_charged"  # 服务端明确拒绝，未消费
CHARGE_UNKNOWN = "unknown"          # 结果未知：可能已扣费

#: 公众号文章官方域名。文章链接只接受这里的域名。
ARTICLE_HOSTS = ("mp.weixin.qq.com",)

_BALANCE_PATTERN = re.compile(r"剩余\s*([0-9]+)\s*积分")
_SHANGHAI = timezone(timedelta(hours=8))


# --------------------------------------------------------------------------
# 身份：文章链接与内容键
# --------------------------------------------------------------------------
#: 只解这一组安全实体，而且只解一层。
#: ``&amp;`` 必须排在最后：先解它会把 ``&amp;lt;`` 变成 ``<``（解了两层）；
#: 反过来，``&lt;`` 这种要先解，否则 ``&amp;lt;`` 会留下一个假的 ``&lt;``。
#: 不能用 html.unescape：它认识 ``&times;``／``&timestamp`` 这类实体名，
#: 会把 ``&times=1`` 改成 ``×=1``，把文章地址改坏。
_SAFE_ENTITIES = (
    ("&#39;", "'"),
    ("&quot;", '"'),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&nbsp;", " "),
    ("&amp;", "&"),
)


def safe_unescape(text: str) -> str:
    """只解一层安全 HTML 实体。

    上游返回的 ``art_url`` 是 HTML 转义过的：参数之间是 ``&amp;`` 而不是 ``&``。
    不解开就取不到 ``mid``／``idx``，整页会被误判成结构变化。
    """
    out = str(text or "")
    for entity, char in _SAFE_ENTITIES:
        out = out.replace(entity, char)
    return out


def https_url(url: str) -> str:
    """把 http 地址统一升成 https。其它形态原样返回。"""
    text = str(url or "").strip()
    return "https://" + text[7:] if text.startswith("http://") else text


def normalize_article_url(url: str) -> str:
    """规范化文章地址：只接受官方域名，统一 https，去掉片段，保留查询参数。

    查询参数必须保留：``sn`` 等参数是官方文章地址的一部分，去掉后链接会失效。
    上游给的是转义过的 http 地址，因此先解一层实体再解析。
    """
    parts = urlsplit(safe_unescape((url or "").strip()))
    if parts.scheme not in ("http", "https"):
        raise ValueError("文章链接协议非法")
    host = (parts.hostname or "").lower()
    if host not in ARTICLE_HOSTS:
        raise ValueError("文章链接不是公众号官方域名")
    return urlunsplit(("https", host, parts.path, parts.query, ""))


def article_identity(url: str) -> tuple[str, str, str]:
    """从文章地址提取 ``(biz, mid, idx)``。内容身份由这三项派生。"""
    parts = urlsplit(safe_unescape((url or "").strip()))
    if parts.scheme not in ("http", "https"):
        raise ValueError("文章链接协议非法")
    host = (parts.hostname or "").lower()
    if host not in ARTICLE_HOSTS:
        raise ValueError("文章链接不是公众号官方域名")
    query = parse_qs(parts.query)
    biz = normalize_biz((query.get("__biz") or [""])[0])
    mid = (query.get("mid") or [""])[0].strip()
    idx = (query.get("idx") or [""])[0].strip()
    if not mid.isdigit() or not idx.isdigit():
        raise ValueError("文章链接缺少 mid 或 idx")
    return biz, mid, idx




# --------------------------------------------------------------------------
# 响应解析：脱敏样本所用的字段口径
# --------------------------------------------------------------------------
def _first(mapping: dict, names: tuple[str, ...]):
    for name in names:
        value = mapping.get(name)
        if value not in (None, ""):
            return value
    return None


def parse_account(data) -> dict:
    """解析公众号信息。

    字段名按「上游可能采用的几种写法」依次尝试，取到第一个非空值。
    真实上游的字段是 ``name``／``user_name``(gh_xxx)／``signature``／``hd_head_img``；
    猜不到就报结构变化，不猜造字段。
    """
    if not isinstance(data, dict):
        raise ValueError("公众号信息不是对象")
    gh_id = _first(data, ("user_name", "username", "wxid", "gh_id", "fakeid"))
    if not gh_id or not isinstance(gh_id, str):
        raise ValueError("公众号信息缺少稳定 ID")
    name = _first(data, ("name", "nickname", "title", "account_name"))
    avatar = _first(data, ("hd_head_img", "avatar", "headimg", "head_img",
                           "avatar_url", "portrait"))
    description = _first(data, ("description", "desc", "intro", "signature"))
    return {
        "gh_id": gh_id.strip(),
        "name": name.strip() if isinstance(name, str) and name.strip() else gh_id.strip(),
        "avatar": https_url(avatar) if isinstance(avatar, str) and avatar.strip() else None,
        "description": description.strip() if isinstance(description, str) and description.strip() else None,
    }


def parse_list(data) -> dict:
    """解析文章列表响应。

    返回 ``{"items": [...], "wxid": str | None, "cursor": str | None}``。
    真实上游的列表项字段是 ``art_url``／``title``／``pub_time``／``pic_url``／``sn``。
    列表项按「几种可能写法」取第一个非空值，取不到稳定身份的条目
    直接判为结构变化，不编造身份。
    """
    if not isinstance(data, dict):
        raise ValueError("文章列表不是对象")
    rows = _first(data, ("list", "items", "articles", "data"))
    if not isinstance(rows, list):
        raise ValueError("文章列表缺少 list 字段")
    wxid = _first(data, ("wxid", "user_name", "username", "gh_id"))
    cursor = _first(data, ("cursor", "next_cursor", "next", "offset", "page_token"))
    items = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("文章列表项不是对象")
        url = _first(row, ("art_url", "url", "link", "link_url", "app_msg_link",
                           "article_url", "content_url"))
        if not isinstance(url, str) or not url.strip():
            raise ValueError("文章列表项缺少地址")
        link = normalize_article_url(url)
        biz, mid, idx = article_identity(link)
        title = _first(row, ("title", "name", "subject"))
        cover = _first(row, ("cover", "cover_url", "thumb", "thumb_url", "pic_url", "image"))
        published = _first(row, ("pub_time", "publish_time", "create_time", "time", "date", "publish_date"))
        items.append({
            "url": link,
            "biz": biz,
            "mid": mid,
            "idx": idx,
            "title": title.strip() if isinstance(title, str) and title.strip() else "",
            "cover": https_url(safe_unescape(cover)) if isinstance(cover, str) and cover.strip() else None,
            "published_raw": published,
        })
    return {
        "items": items,
        "wxid": wxid.strip() if isinstance(wxid, str) and wxid.strip() else None,
        "cursor": str(cursor) if isinstance(cursor, (str, int)) and str(cursor).strip() else None,
    }


def parse_balance(message) -> int | None:
    """从业务文案里观察余额：``剩余N积分``。观察不到就返回 None。"""
    if not isinstance(message, str):
        return None
    found = _BALANCE_PATTERN.search(message)
    return int(found.group(1)) if found else None


def error_for_code(code: int, message: str) -> tuple[str, str, bool]:
    """业务码 → (错误码, 展示文案, 是否可重试)。

    业务失败一律不可重试：上游已经明确答复，再打一次只会再花钱。
    但每种失败要分开说清楚，用户才知道该换密钥、等余额还是从头重扫。
    """
    if code == CODE_KEY_INVALID:
        return ("AUTH_REQUIRED", "付费密钥无效或积分不足，请更换密钥或充值", False)
    if code == CODE_MISSING_WXID:
        return ("INVALID_INPUT", "上游要求提供公众号原始 ID（wxid），本次请求未带上", False)
    if code == CODE_WXID_REJECTED:
        return ("INVALID_RESULT", "上游拒绝了当前公众号原始 ID，请重新解析来源", False)
    if code == CODE_CURSOR_REJECTED:
        # 单独的错误码：业务层据此丢掉已经不可用的回溯检查点。
        return ("CURSOR_INVALID", "上游拒绝了当前游标（可能已过期），回溯将从头重扫", False)
    if code == CODE_REQUEST_FAILED:
        return ("DEPENDENCY_UNAVAILABLE", "上游答复请求失败，按上游规则本次未产生消费", False)
    if code == CODE_TIMEOUT:
        return ("DEPENDENCY_UNAVAILABLE", "上游服务超时，未自动重放以免重复扣费", False)
    if code == CODE_QPS_EXCEEDED:
        return ("RATE_LIMITED", "上游 QPS 超限（每秒最多 5 次），请稍后手动重试", False)
    detail = message.strip() if isinstance(message, str) and message.strip() else ""
    return ("DEPENDENCY_UNAVAILABLE", f"上游返回业务错误（code={code}）{detail}", False)


def published_time(raw) -> PublishedTime:
    """把上游的发布时间转成带精度的事实。

    约定：unix 秒／毫秒、或 ``YYYY-MM-DD HH:MM:SS`` 文本一律按 Asia/Shanghai 解释；
    只给日期就是日期精度；解析不出来就是未知，不编造日期。
    """
    if raw in (None, ""):
        return PublishedTime()
    if isinstance(raw, bool):
        return PublishedTime()
    if isinstance(raw, (int, float)):
        seconds = float(raw)
        if seconds > 1e11:      # 毫秒
            seconds /= 1000.0
        try:
            stamp = datetime.fromtimestamp(seconds, tz=_SHANGHAI)
        except (OverflowError, OSError, ValueError):
            return PublishedTime()
        return PublishedTime(stamp.isoformat(timespec="seconds"), "second", "reported", "Asia/Shanghai")
    if not isinstance(raw, str):
        return PublishedTime()
    text = raw.strip()
    if not text:
        return PublishedTime()
    if text.isdigit():
        return published_time(int(text))
    normalized = text.replace("/", "-").replace("T", " ").replace("Z", "")
    if len(normalized) == 10:
        try:
            stamp = datetime.strptime(normalized, "%Y-%m-%d")
        except ValueError:
            return PublishedTime(raw_label=text)
        return PublishedTime(stamp.date().isoformat(), "date", "reported", "Asia/Shanghai", text)
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %H"):
        try:
            stamp = datetime.strptime(normalized, pattern)
        except ValueError:
            continue
        precision = "second" if pattern.endswith("%S") else ("minute" if pattern.endswith("%M") else "hour")
        return PublishedTime(stamp.replace(tzinfo=_SHANGHAI).isoformat(timespec="seconds"),
                             precision, "reported", "Asia/Shanghai", text)
    return PublishedTime(raw_label=text)


def request_body(operation: str, secret: str, **fields) -> dict:
    """构造请求体。密钥只在这里出现，且只在请求体里。"""
    if not secret:
        raise ValueError("缺少运行时密钥")
    body = {"key": secret}
    body.update({name: value for name, value in fields.items() if value not in (None, "")})
    if operation == "resolve_source":
        body.setdefault("biz", "")
    return body


def list_request_fields(cursor: str | None) -> dict:
    """文章列表请求的字段。游标为空时不传，避免上游把空游标当成非法参数。"""
    fields = {}
    if cursor:
        fields["cursor"] = cursor
    return fields


def describe_endpoint(path: str) -> str:
    """给日志用的端点描述。不含任何请求参数，更不含密钥。"""
    return f"{API_ROOT}{path}" if path in ALLOWED_PATHS else "wxrank-endpoint"


def canonical_query(params: dict) -> str:
    """按稳定顺序生成查询串，用于缓存键等需要确定性文本的场景。"""
    return urlencode(sorted((key, str(value)) for key, value in params.items() if value not in (None, "")))
