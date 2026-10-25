"""M45 付费渠道的离线替身传输。

只给「正式 Renderer 验收」用：把付费上游换成本仓库的脱敏样本，
这样 Main／Preload／Renderer／Core 整条链路可以在不花钱的前提下跑通。

由环境变量 ``SUBSCRIBE_FLOW_WXRANK_FIXTURE`` 选择档位：

- ``default``：正常样本。解析一次成功；列表分三页（前两页各 10 条，第三页空）。
- ``mismatch``：上游返回别的公众号（复现 BUG-129 的数据串来源）。
- ``network``：网络未决（复现「扣费结果未知」）。

它不是产品代码路径：生产启动不会设置这个环境变量，
那时用的是真正发网的 ``WxrankTransport``。
"""

from __future__ import annotations

from subscribe_flow.contracts import ChannelError

from . import protocol
from .fixtures import ACCOUNT_OK
from .transport import WxrankResponse

#: 样本公众号。
BIZ = "MzI4NTEyMzQ1Ng=="
GH_ID = "gh_demo0001"
NAME = "示例公众号"

#: 每页条数。与 ``protocol.PAGE_SIZE`` 一致：上游样本每页约 9～10 条。
PAGE_ITEMS = 10
PAGES = 3


def _item(page: int, index: int) -> dict:
    mid = 1000000000 + page * 100 + index
    url = (f"https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid={mid}"
           f"&idx=1&sn=demotoken{page}{index}")
    return {
        "url": url,
        "title": f"示例文章 {page}-{index + 1}",
        "pub_time": f"2026-10-{20 - page:02d} 09:30:00",
        "cover": f"https://mmbiz.qpic.cn/demo/cover-{page}-{index + 1}",
    }


class FixtureTransport:
    """按上游形状作答的假传输。"""

    def __init__(self, profile: str = "default"):
        self.profile = profile or "default"
        self.calls: list[tuple[str, str]] = []

    async def post(self, path: str, payload: dict, context, operation: str) -> WxrankResponse:
        context.check(operation)
        self.calls.append((path, operation))
        if self.profile == "network":
            raise ChannelError("TIMEOUT", operation, "上游请求超时，扣费结果未知")
        if path == protocol.PATH_INFO:
            if self.profile == "mismatch":
                data = dict(ACCOUNT_OK["data"])
                data["user_name"] = "gh_other0001"
                return WxrankResponse(0, "获取成功，剩余120积分", data)
            return WxrankResponse(0, "获取成功，剩余120积分", ACCOUNT_OK["data"])
        if path == protocol.PATH_LIST:
            cursor = payload.get("cursor")
            if self.profile == "mismatch":
                # 返回的是**别的**公众号的文章：适配器必须整页拒绝，不能入错来源。
                other = "QUJDRA=="
                rows = [{"url": (f"https://mp.weixin.qq.com/s?__biz=QUJDRA%3D%3D&mid=2000000001"
                                 f"&idx=1&sn=demoother1"),
                         "title": "串来源的文章", "pub_time": "2026-10-20 09:30:00"}]
                return WxrankResponse(0, "获取成功", {"wxid": "gh_other0001", "cursor": None, "list": rows})
            page = 1 if not cursor else int(str(cursor).split("-")[-1])
            rows = [_item(page, index) for index in range(PAGE_ITEMS)] if page < PAGES else []
            next_cursor = f"page-{page + 1}" if page < PAGES else None
            return WxrankResponse(0, "获取成功，剩余120积分",
                                  {"wxid": GH_ID, "cursor": next_cursor, "list": rows})
        raise ChannelError("INVALID_INPUT", operation, "未登记的上游端点")
