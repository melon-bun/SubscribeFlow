"""M45 付费渠道（wxrank）冻结契约。

本模块是本期唯一的协议事实来源：请求形状、业务码、身份规则与计费口径都写在这里，
transport / service / adapter 与测试只引用本模块，不各自抄一份。

真实付费响应不进入仓库：仓库内只有脱敏样本（channels/wxrank/fixtures.py），
它们不含任何密钥、真实公众号身份或真实文章地址。

三处必须保持一致的规则：
1. 身份：缓存键、来源定位地址与内容身份使用同一份规范 biz。
2. 计费：只有 code=0 的调用记为已确认消费；网络未决一律记「结果未知」，
   不得为了界面好看而写成零消费。
3. 密钥：运行时密钥只出现在请求体的 ``key`` 字段里，不进 URL、日志与账本。
"""

from __future__ import annotations

import base64
import binascii
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit

from subscribe_flow.contracts import PublishedTime

CHANNEL = "wxrank"
BACKEND = "paid-http"
ADAPTER_VERSION = "wxrank-1"
PARSER_VERSION = "wxrank-1"
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

#: 服务端游标的保守有效期（秒）。
#: 原记录提到「游标 24 小时有效」，但那只是有限样本的观察，未归档复验。
#: 这里按保守方向取值：宁可当成过期后从头重扫（多花一次钱），
#: 也不要用一个可能已经失效的游标把中间的历史整段跳过。
CURSOR_TTL_SECONDS = 24 * 3600

#: 上游业务码。0 为成功；其余为业务失败，服务端已明确答复。
CODE_OK = 0
CODE_KEY_INVALID = 1000       # 密钥无效或积分不足
CODE_TIMEOUT = 1005           # 上游超时

#: 账本里的扣费判定。只有这三种，不引入第四种「大概没扣」。
CHARGE_CONFIRMED = "confirmed"      # 已确认消费（code=0）
CHARGE_NOT_CHARGED = "not_charged"  # 服务端明确拒绝，未消费
CHARGE_UNKNOWN = "unknown"          # 结果未知：可能已扣费

#: 公众号文章官方域名。文章链接只接受这里的域名。
ARTICLE_HOSTS = ("mp.weixin.qq.com",)

#: 内部定位用的公众号主页地址。它不是官方主页，只用于本应用内部定位来源。
SOURCE_URL_TEMPLATE = "https://mp.weixin.qq.com/s?__biz={biz}"

_BIZ_ALLOWED = re.compile(r"^[A-Za-z0-9+/=_-]+$")
_URLSAFE_TO_STANDARD = str.maketrans("-_", "+/")
_BALANCE_PATTERN = re.compile(r"剩余\s*([0-9]+)\s*积分")
_SHANGHAI = timezone(timedelta(hours=8))

_MAX_BIZ = 128


# --------------------------------------------------------------------------
# 身份：biz 归一
# --------------------------------------------------------------------------
def normalize_biz(value: str) -> str:
    """把任意书写形式的 biz 归一成标准 base64（标准字母表 + 正确填充）。

    规则：
    - 去掉首尾空白；空值、超长值与 base64 字母表以外的字符一律无效；
    - 只允许结尾出现 ``=``，且填充不超过 2 个；
    - 去掉已有填充后按长度补齐（可能补 0／1／2 个），长度 % 4 == 1 视为无效；
    - 归一后必须能严格解码并重新编码成同一串，否则视为无效。

    归一后的串是缓存键、来源定位地址与内容身份的共同基础，
    同一个公众号无论用哪种写法传进来都必须得到同一个结果。
    """
    if not isinstance(value, str):
        raise ValueError("公众号标识必须是文本")
    text = value.strip()
    if not text or len(text) > _MAX_BIZ:
        raise ValueError("公众号标识长度非法")
    if not _BIZ_ALLOWED.match(text):
        raise ValueError("公众号标识含有非 base64 字符")
    body = text.rstrip("=")
    padding = len(text) - len(body)
    if padding > 2:
        raise ValueError("公众号标识填充位过多")
    if not body or len(body) % 4 == 1:
        raise ValueError("公众号标识长度非法")
    padded = body + "=" * ((4 - len(body) % 4) % 4)
    try:
        raw = base64.b64decode(padded.translate(_URLSAFE_TO_STANDARD), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("公众号标识不是合法的 base64") from None
    return base64.b64encode(raw).decode("ascii")


def extract_biz(locator: str) -> str:
    """从输入中提取规范 biz。

    输入可以是裸 biz、公众号主页地址，或带 ``__biz`` 的公众号文章地址。
    裸 biz 优先按 base64 判定；判定不通过时再按地址解析，避免把
    含 ``/`` 的 base64 误当成路径。
    """
    text = (locator or "").strip()
    if not text:
        raise ValueError("缺少公众号标识")
    try:
        return normalize_biz(text)
    except ValueError:
        pass
    parts = urlsplit(text if "://" in text else "https://" + text)
    query = parse_qs(parts.query)
    for key in ("__biz", "biz"):
        for value in query.get(key) or []:
            if value:
                return normalize_biz(value)
    raise ValueError("无法从输入中识别公众号标识")


def source_url(biz: str) -> str:
    """来源的内部定位地址。同一 biz 永远得到同一个地址。"""
    canonical = normalize_biz(biz)
    return SOURCE_URL_TEMPLATE.format(biz=quote(canonical, safe=""))


def source_external_id(gh_id: str) -> str:
    """来源的稳定外部 ID：上游给出的公众号原始 ID。"""
    text = (gh_id or "").strip()
    if not text:
        raise ValueError("公众号原始 ID 缺失")
    return text


# --------------------------------------------------------------------------
# 身份：文章链接与内容键
# --------------------------------------------------------------------------
def normalize_article_url(url: str) -> str:
    """规范化文章地址：只接受官方域名，统一 https，去掉片段，保留查询参数。

    查询参数必须保留：``sn`` 等参数是官方文章地址的一部分，去掉后链接会失效。
    """
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ("http", "https"):
        raise ValueError("文章链接协议非法")
    host = (parts.hostname or "").lower()
    if host not in ARTICLE_HOSTS:
        raise ValueError("文章链接不是公众号官方域名")
    return urlunsplit(("https", host, parts.path, parts.query, ""))


def article_identity(url: str) -> tuple[str, str, str]:
    """从文章地址提取 ``(biz, mid, idx)``。内容身份由这三项派生。"""
    parts = urlsplit((url or "").strip())
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


def content_external_id(biz: str, mid: str, idx: str) -> str:
    """内容稳定 ID：``{biz}_{mid}_{idx}``，与来源使用同一份规范 biz。"""
    canonical = normalize_biz(biz)
    if not str(mid).isdigit() or not str(idx).isdigit():
        raise ValueError("文章身份缺少 mid 或 idx")
    return f"{canonical}_{mid}_{idx}"


def content_key(biz: str, mid: str, idx: str) -> str:
    """内容键：``wxrank:article:{biz}_{mid}_{idx}``。"""
    return f"{CHANNEL}:article:{content_external_id(biz, mid, idx)}"


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
    上游真实字段名需要在 M45.6 用真实样本再确认一次；这里不猜造字段，
    猜不到就报结构变化。
    """
    if not isinstance(data, dict):
        raise ValueError("公众号信息不是对象")
    gh_id = _first(data, ("user_name", "username", "wxid", "gh_id", "fakeid"))
    if not gh_id or not isinstance(gh_id, str):
        raise ValueError("公众号信息缺少稳定 ID")
    name = _first(data, ("name", "nickname", "title", "account_name"))
    avatar = _first(data, ("avatar", "headimg", "head_img", "avatar_url", "portrait"))
    description = _first(data, ("description", "desc", "intro", "signature"))
    return {
        "gh_id": gh_id.strip(),
        "name": name.strip() if isinstance(name, str) and name.strip() else gh_id.strip(),
        "avatar": avatar.strip() if isinstance(avatar, str) and avatar.strip() else None,
        "description": description.strip() if isinstance(description, str) and description.strip() else None,
    }


def parse_list(data) -> dict:
    """解析文章列表响应。

    返回 ``{"items": [...], "wxid": str | None, "cursor": str | None}``。
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
        url = _first(row, ("url", "link", "link_url", "app_msg_link", "article_url", "content_url"))
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
            "cover": cover.strip() if isinstance(cover, str) and cover.strip() else None,
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
    """
    if code == CODE_KEY_INVALID:
        return ("AUTH_REQUIRED", "付费密钥无效或积分不足，请更换密钥或充值", False)
    if code == CODE_TIMEOUT:
        return ("DEPENDENCY_UNAVAILABLE", "上游服务超时，未自动重放以免重复扣费", False)
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
