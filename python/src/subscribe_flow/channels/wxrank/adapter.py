"""M45 付费渠道适配器。

适配器只做「契约翻译」：把渠道协议翻译成应用契约，把应用契约翻译回渠道请求。
真正的付费记账、缓存与限流都在 service 里，适配器不重复实现一遍。

本期不提供：搜索、正文读取、单条文章接入。文章身份只用于列表里已经拿到的条目。
"""

from __future__ import annotations

from datetime import datetime, timezone

from subscribe_flow.contracts import (ChannelDescriptor, ChannelError, FetchPage,
    OperationCapability, Readiness, Source, SourcePage)

from . import protocol
from .service import WxrankService


class WxrankAdapter:
    """公众号数据（付费）渠道。"""

    CHANNEL = protocol.CHANNEL
    BACKEND = protocol.BACKEND

    def __init__(self, service: WxrankService):
        self.service = service

    def describe(self) -> ChannelDescriptor:
        return ChannelDescriptor(
            self.CHANNEL, "公众号 · 付费API", self.BACKEND, {
                'resolve_source': OperationCapability(
                    True, notes='输入公众号 biz 或含 __biz 的链接；首次解析消耗一次付费调用，命中缓存不消耗'),
                'search_sources': OperationCapability(False, notes='本期不提供公众号搜索'),
                'list_items': OperationCapability(
                    True, dependencies=('paid-api',), authentication='not_required',
                    pagination='cursor', ordering='server_cursor', full_history=False,
                    notes='按页获取文章列表；每一页都是一次付费调用，游标由上游给出'),
                'get_item_detail': OperationCapability(False, notes='本期不提供正文与详情补充'),
                'match_item_url': OperationCapability(False, notes='本期不做单条文章接入'),
                'resolve_item': OperationCapability(False, notes='本期不做单条文章接入'),
                'read_item': OperationCapability(False, notes='本期不做单条文章接入'),
            },
            adapter_version=protocol.ADAPTER_VERSION,
            parser_version=protocol.PARSER_VERSION,
            progress_version=protocol.PROGRESS_VERSION,
            content_types=('article',), page_size=protocol.PAGE_SIZE,
            default_refresh_budget=1, default_backfill_budget=3,
            scan_overhead_budget=0, budget_unit='pages',
            # 付费渠道：调度器不得按通用重试策略自动重放扣费结果未知的请求；
            # 支持持久回溯检查点：回溯从上次已提交成功的页继续。
            paid=True, resumable=True)

    async def resolve_source(self, locator: str, context) -> Source:
        return await self.service.resolve_source(locator, context)

    async def check_readiness(self, operation: str, context) -> Readiness:
        # 「检查配置」不发网络请求：付费渠道的连通性检查本身就要花钱。
        # 这里只检查本地是否已配置可用密钥，可用性交给真正的调用去证明。
        checked = datetime.now(timezone.utc).isoformat()
        if operation not in {'resolve_source', 'list_items'}:
            raise ChannelError('UNSUPPORTED_OPERATION', operation, '此渠道不支持该操作')
        entry = self.service.settings.channel_credential(self.CHANNEL) or {}
        if not entry.get('enabled', True):
            return Readiness('blocked', operation, '付费渠道已停用',
                             'connection', context.connection.id, checked,
                             actions=('settings',), dependency='not_configured',
                             authentication='configured')
        if not self.service.configured():
            return Readiness('blocked', operation, '尚未配置付费渠道密钥',
                             'connection', context.connection.id, checked,
                             actions=('settings',), dependency='not_configured',
                             authentication='required')
        return Readiness('ready', operation, '已配置付费渠道密钥，未联网验证',
                         'connection', context.connection.id, checked,
                         dependency='available', authentication='configured')

    async def fetch_page(self, source: Source, request, context) -> FetchPage:
        if source.channel != self.CHANNEL or source.kind != 'account':
            raise ChannelError('INVALID_INPUT', 'list_items', '来源不是公众号账号')
        return await self.service.fetch_page(source, request, context)

    async def search_sources(self, query: str, request, context) -> SourcePage:
        raise ChannelError('UNSUPPORTED_OPERATION', 'search_sources', '本期不提供公众号搜索')

    async def get_item_detail(self, item_ref: str, context):
        raise ChannelError('UNSUPPORTED_OPERATION', 'get_item_detail', '本期不提供正文与详情补充')
