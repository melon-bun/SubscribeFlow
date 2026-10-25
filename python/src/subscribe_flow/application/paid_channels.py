"""M45 付费渠道的受控入口。

只暴露四件事：

- ``status``：渠道卡片需要的全部只读信息（配置状态、本地用量、服务端余额观察值、
  每个来源的刷新／回溯成本与检查点状态）。只读本地账本，不发任何请求，也不花钱。
- ``usage``：本地用量读数（已确认用量、结果未知次数、最近一次观察到的余额）。
- ``clear_cache``：清理来源解析缓存。下次解析会重新付费，因此这是明确的用户动作。
- ``test``：显式付费测试。绕过缓存，必定产生一次付费调用。

解析与采集不走这里：它们走既有的来源解析与采集通道，扣费记账在渠道业务层里统一完成。

费用推导与采集引擎用**同一个**函数（``SyncService.page_budget_for``），
因此界面显示的「几次调用、多少积分」与真正跑出来的次数不会打架。
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime, timezone

from subscribe_flow.channels.wxrank import protocol
from subscribe_flow.channels.wxrank.service import WxrankService
from subscribe_flow.contracts import ChannelError, Context
from subscribe_flow.storage.dates import display_zone

from .sync import SyncService

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
    def __init__(self, service: WxrankService, repository, gateway):
        self.service = service
        self.repository = repository
        self.gateway = gateway

    # ------------------------------------------------------------ 描述符

    def descriptor(self):
        for descriptor in self.gateway.describe():
            if descriptor.channel == self.service.CHANNEL:
                return descriptor
        return None

    # ------------------------------------------------------------ 本地读

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

    def status(self, timezone_name: str | None = None) -> dict:
        """渠道卡片要的全部信息。只读本地，不发请求，不花钱。"""
        descriptor = self.descriptor()
        entry = self.service.settings.channel_credential(self.service.CHANNEL) or {}
        usage = self.usage(timezone_name)
        sources = []
        for sub in self.repository.list_subscriptions():
            if sub.get("channel") != self.service.CHANNEL:
                continue
            source_key = sub["source_id"]
            checkpoint = self.service.checkpoint_state(source_key, sub["connection_id"])
            sources.append({
                "sourceId": source_key,
                "subscriptionId": sub["id"],
                "name": sub.get("name") or source_key,
                "externalId": sub.get("external_id") or "",
                "collectItems": int(sub.get("collect_items") or 0),
                "refresh": self._cost(sub, "refresh", descriptor,
                                      {"state": "fresh", "note": "刷新从最新一页开始"}),
                "backfill": self._cost(sub, "backfill", descriptor, checkpoint),
            })
        return {
            "channel": self.service.CHANNEL,
            "configured": self.service.configured(),
            "enabled": bool(entry.get("enabled", True)),
            "credentialVersion": int(entry.get("revision") or 0),
            "creditsPerCall": protocol.CREDITS_PER_CALL,
            "pageSize": descriptor.page_size if descriptor else protocol.PAGE_SIZE,
            "refreshPages": descriptor.default_refresh_budget if descriptor else 1,
            "backfillPages": descriptor.default_backfill_budget if descriptor else 3,
            "usage": {
                "confirmedCredits": usage["confirmed_credits"],
                "unknownCount": usage["unknown_count"],
                "calls": usage["calls"],
            },
            "balance": usage["balance"],
            "balanceObservedAt": usage["balanceObservedAt"],
            "cacheEntries": usage["cacheEntries"],
            "limits": self.limits(),
            "sources": sources,
            "addCost": {
                "parseCalls": 1,
                "totalCalls": 1,
                "credits": protocol.CREDITS_PER_CALL,
                "note": "首次解析消耗一次付费调用；确认添加命中缓存，不再收费",
            },
        }

    def limits(self) -> list[str]:
        """渠道限制说明。写清楚哪些是上游观察值，哪些是本地约定。"""
        return [
            f"每次成功调用约消耗 {protocol.CREDITS_PER_CALL} 积分（上游观察值）",
            "本应用不设本地余额上限，积分不足时由上游直接拒绝",
            "回溯按页推进，每一页都是一次付费调用；采到 0 条新内容也可能产生费用",
            "检查配置是本地检查，不联网、不产生费用",
        ]

    def _cost(self, sub, mode, descriptor, checkpoint) -> dict:
        """按采集引擎的同一套规则推导这次任务的成本。

        页数用 ``SyncService.page_budget_for``：默认回溯 3 页、刷新 1 页；
        订阅上设了采集条数时按条数除以单页条数向上取整。
        """
        pages = SyncService.page_budget_for(sub, mode, None, descriptor)
        list_calls = max(1, int(pages))
        # 已有订阅的来源身份就在本地，刷新与回溯都不需要再解析一次。
        parse_calls = 0
        total = list_calls + parse_calls
        return {
            "pages": list_calls,
            "listCalls": list_calls,
            "parseCalls": parse_calls,
            "totalCalls": total,
            "credits": total * protocol.CREDITS_PER_CALL,
            "checkpoint": {"state": checkpoint.get("state", "fresh"),
                           "note": checkpoint.get("note", "")},
        }

    # ------------------------------------------------------------ 动作

    def clear_cache(self, biz: str | None = None) -> dict:
        """清理来源解析缓存。返回清理条数。"""
        target = None
        if biz:
            try:
                target = protocol.normalize_biz(biz)
            except ValueError as error:
                raise ChannelError("INVALID_INPUT", "wxrank.cache_clear", str(error)) from None
        return {"cleared": self.service.clear_cache(target)}

    async def test(self, locator: str, connection_id: str) -> dict:
        """显式付费测试。必定产生一次付费调用。"""
        connection = self.repository.get_connection(connection_id)
        context = Context(connection, f"wxrank-test-{uuid.uuid4().hex}",
                          time.monotonic() + TEST_TIMEOUT)
        return await self.service.paid_test(locator, context)
