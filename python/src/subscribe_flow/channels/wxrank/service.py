"""M45 付费渠道业务层。

这里做四件事，边界清楚：

1. 计费记账。每一次付费调用先把「开始」写进账本，拿到答复后再按答复结算。
   只有上游回了整数业务码 0 才记为已确认消费；网络未决一律记「结果未知」，
   绝不为了界面好看写成零消费。
2. 来源解析缓存。同一个规范 biz 只付一次解析费用；「解析 → 确认添加」与
   「重启后再解析」都走缓存，不会重复扣费。
3. 单飞合并。并发解析同一个 biz 时只发一次请求，其余等待同一次结果。
4. 资源互斥与限流。所有付费入口共用同一把闸门：同一时刻至多一个请求，
   并按已核对的 QPS 做起始时间节流。

密钥只在请求体里出现一次，不进 URL、不进账本、不进日志。
"""

from __future__ import annotations

import asyncio

from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.contracts import ChannelError, ContentItem, FetchPage, Source

from . import protocol
from .transport import WxrankTransport

#: 付费入口的用途标识。写进账本，用来区分「这次花钱是为了什么」。
OP_RESOLVE = "resolve_source"
OP_LIST = "list_items"
OP_TEST = "paid_test"

#: 上游观察到的 QPS。节流按「起始时间」算：两次请求的起点至少相隔这么久。
DEFAULT_QPS = 5


class WxrankService:
    """付费渠道业务层。传输可注入，测试用假传输，不触网。"""

    CHANNEL = protocol.CHANNEL

    def __init__(self, *, settings, credentials, repository, transport=None,
                 resources=None, qps: int = DEFAULT_QPS):
        self.settings = settings
        self.credentials = credentials
        self.repository = repository
        self.transport = transport if transport is not None else WxrankTransport()
        self.resources = resources if resources is not None else ResourceCoordinator()
        self.min_interval = 1.0 / max(1, int(qps))
        self._inflight: dict[str, asyncio.Task] = {}

    # ------------------------------------------------------------ 凭据

    def credential(self) -> tuple[str | None, int]:
        """当前渠道的运行时密钥与凭据版本。

        密钥只存在于内存里；版本号来自设置，换密钥时前进，
        账本据此区分「哪一次调用用的是哪一把密钥」。
        """
        entry = self.settings.channel_credential(self.CHANNEL) or {}
        reference = entry.get("reference")
        secret = self.credentials.secret_for(reference) if reference else None
        return secret, int(entry.get("revision") or 0)

    def configured(self) -> bool:
        secret, _ = self.credential()
        return bool(secret)

    # ------------------------------------------------------------ 付费调用

    async def _paid_request(self, *, operation: str, path: str, fields: dict, context,
                            purpose: str | None = None, biz: str | None = None,
                            wxid: str | None = None):
        """发一次付费请求并结算。

        账本先写「开始」再发请求：进程崩了也留下痕迹，下次启动按「结果未知」
        结算，不会把可能已经扣掉的费用当成没发生。
        """
        secret, version = self.credential()
        if not secret:
            raise ChannelError("NOT_CONFIGURED", operation, "尚未配置付费渠道密钥")
        attempt = self.repository.begin_attempt(
            channel=self.CHANNEL, operation=purpose or operation,
            connection_id=context.connection.id, credential_version=version,
            biz=biz, wxid=wxid)
        payload = protocol.request_body(operation, secret, **fields)
        sent = False
        try:
            async with self.resources.acquire(context, operation, gap=self.min_interval):
                sent = True
                response = await self.transport.post(path, payload, context, operation)
        except asyncio.CancelledError:
            self.repository.finish_attempt(
                attempt, status="cancelled",
                charge_state="unknown" if sent else "not_charged",
                error_code="CANCELLED",
                error_message="任务已取消，扣费结果未知" if sent else "任务已取消，请求未发出")
            raise
        except ChannelError as error:
            # 请求已经发出却没拿到业务答复：可能已经扣费，按「结果未知」记账。
            # 请求还没发出（取消、超时、连接被停用）：没有产生消费。
            self.repository.finish_attempt(
                attempt, status="unknown" if sent else "failed",
                charge_state="unknown" if sent else "not_charged",
                error_code=error.code,
                error_message=error.message if sent else f"{error.message}（请求未发出）")
            raise
        balance = protocol.parse_balance(response.message)
        if response.code == protocol.CODE_OK:
            # code=0 就是已确认消费：即使数据是坏的，这一次调用也已经产生了费用。
            self.repository.finish_attempt(
                attempt, status="succeeded", charge_state="confirmed",
                confirmed_credits=protocol.CREDITS_PER_CALL, balance=balance)
            return response
        # 服务端明确答复失败：没有产生消费。业务失败不重试，再打一次只会再花钱。
        code, message, retryable = protocol.error_for_code(response.code, response.message)
        self.repository.finish_attempt(
            attempt, status="failed", charge_state="not_charged", balance=balance,
            error_code=code, error_message=message)
        raise ChannelError(code, operation, message, retryable=retryable)

    # ------------------------------------------------------------ 来源解析

    async def resolve_source(self, locator: str, context) -> Source:
        """解析公众号来源。命中缓存不发请求，也不花钱。"""
        try:
            biz = protocol.extract_biz(locator)
        except ValueError as error:
            raise ChannelError("INVALID_INPUT", "resolve_source", str(error)) from None
        cached = self.repository.cached_source(biz)
        if cached:
            return self._source_from_cache(biz, cached)
        # 并发解析同一个 biz：只发一次请求，其余等待同一次结果。
        task = self._inflight.get(biz)
        if task is None:
            task = asyncio.ensure_future(self._resolve_uncached(biz, context))
            self._inflight[biz] = task
            task.add_done_callback(lambda finished: self._settle(biz, finished))
        # shield：等待方被取消时不牵连已经付过钱的在途请求。
        return await asyncio.shield(task)

    def _settle(self, biz: str, task: asyncio.Task) -> None:
        if self._inflight.get(biz) is task:
            self._inflight.pop(biz, None)
        if not task.cancelled():
            # 取走异常，避免「异常从未被取回」的告警；等待方仍会照常收到它。
            task.exception()

    async def _resolve_uncached(self, biz: str, context) -> Source:
        response = await self._paid_request(
            operation=OP_RESOLVE, path=protocol.PATH_INFO, fields={"biz": biz},
            context=context, purpose=OP_RESOLVE, biz=biz)
        try:
            account = protocol.parse_account(response.data)
        except ValueError:
            raise ChannelError("SCHEMA_CHANGED", "resolve_source",
                               "公众号信息结构已变化，请更新适配器") from None
        source = Source(channel=self.CHANNEL, kind="account",
                        external_id=protocol.source_external_id(account["gh_id"]),
                        name=account["name"], url=protocol.source_url(biz),
                        confirmed=False, avatar=account["avatar"],
                        description=account["description"])
        _, version = self.credential()
        self.repository.save_source_cache(
            biz=biz, gh_id=source.external_id, name=source.name, avatar=source.avatar,
            description=source.description, source_id=source.key,
            credential_version=version, parser_version=protocol.PARSER_VERSION)
        return source

    def _source_from_cache(self, biz: str, cached: dict) -> Source:
        """用缓存里的身份重建来源。地址仍由规范 biz 推导，两处不会走偏。"""
        return Source(channel=self.CHANNEL, kind="account",
                      external_id=protocol.source_external_id(cached["gh_id"]),
                      name=cached["name"] or cached["gh_id"],
                      url=protocol.source_url(biz), confirmed=False,
                      avatar=cached.get("avatar"), description=cached.get("description"))

    # ------------------------------------------------------------ 列表采集

    async def fetch_page(self, source: Source, request, context) -> FetchPage:
        """取一页文章。每页都是一次付费调用。"""
        cursor = (request.cursor or {}).get("cursor")
        response = await self._paid_request(
            operation=OP_LIST, path=protocol.PATH_LIST,
            fields={"wxid": source.external_id, **protocol.list_request_fields(cursor)},
            context=context, purpose=OP_LIST, wxid=source.external_id)
        try:
            parsed = protocol.parse_list(response.data)
        except ValueError:
            raise ChannelError("SCHEMA_CHANGED", "list_items",
                               "文章列表结构已变化，请更新适配器") from None
        budget = request.item_budget or self._default_budget()
        if type(budget) is not int or not 1 <= budget <= 50:
            raise ChannelError("INVALID_INPUT", "list_items",
                               "本轮采集条数需为 1 到 50 之间")
        known = set(request.known_ids)
        items: list[ContentItem] = []
        skipped = 0
        truncated = 0
        for row in parsed["items"]:
            if len(items) >= budget:
                truncated += 1
                continue
            item = ContentItem(
                channel=self.CHANNEL, namespace="article",
                external_id=protocol.content_external_id(row["biz"], row["mid"], row["idx"]),
                source=source, title=row["title"] or "（无标题）", url=row["url"],
                kind="article", published=protocol.published_time(row["published_raw"]),
                thumbnail=row["cover"], summary=None, acquisition_complete=False)
            if item.external_id in known:
                # 已收录的条目仍然返回：入库层会判重，页面因此不为空，
                # 不会被上层判成「没有进展」。
                skipped += 1
            items.append(item)
        metrics = {"profile_reads": 1, "discovered": len(parsed["items"]),
                   "skipped": skipped, "detail_requests": 0}
        next_cursor = {"cursor": parsed["cursor"]} if parsed["cursor"] else None
        if next_cursor is not None:
            # 还有下一页：不能声称扫完了。
            return FetchPage(tuple(items), next_cursor, "partial_history", False, None,
                             metrics=metrics)
        if not parsed["items"]:
            # 空列表是「服务端当前数据集已扫完」的终止证据。
            # 它只说明服务端这份数据扫完了，不代表公众号的全部历史。
            return FetchPage(tuple(items), None, "history_end", True, "empty_list",
                             metrics=metrics)
        return FetchPage(tuple(items), None, "partial_history", False, None, metrics=metrics)

    @staticmethod
    def _default_budget() -> int:
        return 20

    # ------------------------------------------------------------ 本地读

    def usage_summary(self, since: str, until: str) -> dict:
        """自然月汇总：已确认用量与结果未知次数。只读本地账本，不发请求。"""
        summary = self.repository.usage_summary(channel=self.CHANNEL, since=since, until=until)
        _, version = self.credential()
        balance = self.repository.latest_balance(channel=self.CHANNEL, credential_version=version)
        summary["balance"] = balance["balance_credits"] if balance else None
        summary["balanceObservedAt"] = balance["balance_observed_at"] if balance else None
        summary["credentialVersion"] = version
        summary["configured"] = self.configured()
        return summary

    def clear_cache(self, biz: str | None = None) -> int:
        """清理来源解析缓存。下次解析会重新付费，因此这是明确的用户动作。"""
        return self.repository.clear_source_cache(biz)

    async def paid_test(self, locator: str, context) -> dict:
        """显式付费测试。绕过缓存，必定产生一次付费调用。"""
        try:
            biz = protocol.extract_biz(locator)
        except ValueError as error:
            raise ChannelError("INVALID_INPUT", OP_TEST, str(error)) from None
        response = await self._paid_request(
            operation=OP_TEST, path=protocol.PATH_INFO, fields={"biz": biz},
            context=context, purpose=OP_TEST, biz=biz)
        try:
            account = protocol.parse_account(response.data)
        except ValueError:
            raise ChannelError("SCHEMA_CHANGED", OP_TEST,
                               "公众号信息结构已变化，请更新适配器") from None
        return {
            "biz": biz,
            "name": account["name"],
            "externalId": account["gh_id"],
            "credits": protocol.CREDITS_PER_CALL,
            "balance": protocol.parse_balance(response.message),
        }
