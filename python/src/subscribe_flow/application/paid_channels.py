"""M45 付费渠道的受控入口。

只暴露三件事：

- ``usage``：本地用量读数（已确认用量、结果未知次数、最近一次观察到的余额）。
  只读本地账本，不发任何请求，也不花钱。
- ``clear_cache``：清理来源解析缓存。下次解析会重新付费，因此这是明确的用户动作。
- ``test``：显式付费测试。绕过缓存，必定产生一次付费调用。

解析与采集不走这里：它们走既有的来源解析与采集通道，扣费记账在渠道业务层里统一完成。
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from subscribe_flow.channels.wxrank.service import WxrankService
from subscribe_flow.contracts import Context
from subscribe_flow.storage.dates import display_zone

#: 付费测试的时限。它是一次真实的付费请求，不能无限等。
TEST_TIMEOUT = 120.0


def month_range(zone):
    """当前自然月的起止时刻（UTC 表示）。

    自然月按展示时区算：用户在本地看到的「本月」就是这个区间。
    """
    local = datetime.now(zone)
    start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    following = (start.replace(year=start.year + 1, month=1) if start.month == 12
                 else start.replace(month=start.month + 1))
    return (start.astimezone(timezone.utc).isoformat(),
            following.astimezone(timezone.utc).isoformat())


class PaidChannelService:
    def __init__(self, service: WxrankService, repository):
        self.service = service
        self.repository = repository

    def usage(self, timezone_name: str | None = None) -> dict:
        """本地用量读数。不联网。"""
        zone = display_zone(timezone_name) if timezone_name else datetime.now().astimezone().tzinfo
        since, until = month_range(zone)
        summary = self.service.usage_summary(since, until)
        summary["attempts"] = self.recent_attempts()
        summary["cacheEntries"] = self.repository.paid_channels.count_source_cache()
        return summary

    def recent_attempts(self, limit: int = 20) -> list[dict]:
        """最近的付费调用记录。字段是白名单：没有密钥，也没有响应原文。"""
        rows = self.repository.paid_channels.list_attempts(
            channel=self.service.CHANNEL, limit=limit)
        return [{
            "operation": row["operation"],
            "status": row["status"],
            "chargeState": row["charge_state"],
            "confirmedCredits": row["confirmed_credits"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "balance": row["balance_credits"],
            "errorCode": row["error_code"],
        } for row in rows]

    def clear_cache(self, biz: str | None = None) -> dict:
        """清理来源解析缓存。返回清理条数。"""
        target = None
        if biz:
            from subscribe_flow.channels.wxrank.protocol import normalize_biz
            try:
                target = normalize_biz(biz)
            except ValueError as error:
                from subscribe_flow.contracts import ChannelError
                raise ChannelError("INVALID_INPUT", "wxrank.cache_clear", str(error)) from None
        return {"cleared": self.service.clear_cache(target)}

    async def test(self, locator: str, connection_id: str) -> dict:
        """显式付费测试。必定产生一次付费调用。"""
        connection = self.repository.get_connection(connection_id)
        context = Context(connection, f"wxrank-test-{uuid.uuid4().hex}",
                          time.monotonic() + TEST_TIMEOUT)
        return await self.service.paid_test(locator, context)
