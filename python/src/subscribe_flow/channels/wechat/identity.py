"""Stable WeChat business identities shared by all acquisition methods."""
import base64
import binascii
import re
from urllib.parse import parse_qs, quote, urlsplit

CHANNEL = "wechat"
SOURCE_URL_TEMPLATE = "https://mp.weixin.qq.com/s?__biz={biz}"
_BIZ_ALLOWED = re.compile(r"^[A-Za-z0-9+/=_-]+$")
_URLSAFE_TO_STANDARD = str.maketrans("-_", "+/")
_MAX_BIZ = 128


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


def content_external_id(biz: str, mid: str, idx: str) -> str:
    canonical = normalize_biz(biz)
    if not re.fullmatch(r"[0-9]{1,30}", str(mid)) or not re.fullmatch(r"[0-9]{1,30}", str(idx)):
        raise ValueError("文章身份缺少 mid 或 idx")
    return f"{canonical}_{mid}_{idx}"


def split_article_id(value: str) -> tuple[str, str, str]:
    if not isinstance(value, str):
        raise ValueError("文章身份无效")
    try:
        biz, mid, idx = value.rsplit("_", 2)
    except ValueError:
        raise ValueError("文章身份缺少 biz、mid 或 idx") from None
    canonical = content_external_id(biz, mid, idx)
    return canonical.rsplit("_", 2)


def content_key(biz: str, mid: str, idx: str) -> str:
    return f"{CHANNEL}:article:{content_external_id(biz, mid, idx)}"
