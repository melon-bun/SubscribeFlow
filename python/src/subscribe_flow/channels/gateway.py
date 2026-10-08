from urllib.parse import urlsplit

from subscribe_flow.contracts import (CONTRACT_VERSION, ChannelAdapter, ChannelError,
    ContentItem, ContentReference, Context, FetchRequest, PublishedTime, Source)


class ChannelGateway:
    def __init__(self):
        self._adapters: dict[tuple[str, str], ChannelAdapter] = {}

    def register(self, adapter: ChannelAdapter) -> None:
        descriptor = adapter.describe()
        key = (descriptor.channel, descriptor.backend)
        if key in self._adapters or descriptor.contract_version != CONTRACT_VERSION:
            raise ValueError("Duplicate adapter or incompatible contract")
        if (descriptor.budget_unit not in {"pages", "details", "items"} or type(descriptor.page_size) is not int or not 1 <= descriptor.page_size <= 100 or
                type(descriptor.scan_overhead_budget) is not int or not 0 <= descriptor.scan_overhead_budget <= 20 or
                any(type(value) is not int or not 1 <= value <= 100 for value in
                    (descriptor.default_refresh_budget, descriptor.default_backfill_budget))):
            raise ValueError("Invalid channel acquisition policy")
        for operation in ('match_item_url', 'resolve_item', 'read_item'):
            capability = descriptor.operations.get(operation)
            if capability and capability.supported and not callable(getattr(adapter, operation, None)):
                raise ValueError(f"Advertised capability has no implementation: {operation}")
        self._adapters[key] = adapter

    def describe(self) -> list:
        return [adapter.describe() for adapter in self._adapters.values()]

    def _adapter(self, context: Context, operation: str) -> ChannelAdapter:
        context.check(operation)
        connection = context.connection
        adapter = self._adapters.get((connection.channel, connection.backend))
        if not adapter:
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation, "未注册指定渠道实现",
                               scope="connection", scope_key=connection.id)
        capability = adapter.describe().operations.get(operation)
        if not capability or not capability.supported:
            raise ChannelError("UNSUPPORTED_OPERATION", operation, "此渠道实现不支持该操作")
        return adapter

    async def resolve_source(self, locator: str, context: Context):
        return await self._adapter(context, "resolve_source").resolve_source(locator, context)

    async def check_readiness(self, operation: str, context: Context):
        return await self._adapter(context, operation).check_readiness(operation, context)

    async def fetch_page(self, source: Source, request: FetchRequest, context: Context):
        if source.channel != context.connection.channel:
            raise ChannelError("INVALID_INPUT", "list_items", "来源与连接的渠道不一致")
        if request.mode not in {"initial", "refresh", "backfill"} or not 1 <= request.limit <= 100:
            raise ChannelError("INVALID_INPUT", "list_items", "获取模式或页大小无效")
        return await self._adapter(context, "list_items").fetch_page(source, request, context)

    async def search_sources(self, query: str, request: FetchRequest, context: Context):
        if type(request.limit) is not int or not 1 <= request.limit <= 100:
            raise ChannelError("INVALID_INPUT", "search_sources", "搜索页大小必须在 1 到 100 之间")
        return await self._adapter(context, "search_sources").search_sources(query, request, context)

    async def get_item_detail(self, item_ref: str, context: Context):
        return await self._adapter(context, "get_item_detail").get_item_detail(item_ref, context)

    @staticmethod
    def validate_item_url(url):
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            valid = (parsed and parsed.scheme in {'http', 'https'} and parsed.hostname
                     and not parsed.username and not parsed.password and 0 < len(url) <= 2000
                     and not any(char.isspace() or ord(char) < 32 for char in url))
        except ValueError:
            valid = False
        if not valid:
            raise ChannelError('INVALID_INPUT', 'resolve_item', '请提供有效的 HTTP 或 HTTPS 内容链接')
        return url

    def route_item_url(self, url, connections, connection_id=None):
        """Only registered adapters know platform URL rules. Matching does no I/O."""
        self.validate_item_url(url)
        if connection_id is not None:
            connections = [connection for connection in connections if connection.id == connection_id]
            if not connections:
                raise ChannelError('NOT_FOUND', 'resolve_item', '连接不存在')
            if not connections[0].enabled:
                raise ChannelError('DEPENDENCY_UNAVAILABLE', 'resolve_item', '连接已停用',
                                   scope='connection', scope_key=connection_id)
        matches = []
        for connection in connections:
            adapter = self._adapters.get((connection.channel, connection.backend))
            if not connection.enabled or adapter is None:
                continue
            operations = adapter.describe().operations
            if not all(operations.get(op) and operations[op].supported
                       for op in ('match_item_url', 'resolve_item', 'read_item')):
                continue
            matched = adapter.match_item_url(url)
            if type(matched) is not bool:
                raise ChannelError('INVALID_RESULT', 'match_item_url', '渠道链接匹配结果无效')
            if matched:
                matches.append(connection)
        if not matches:
            raise ChannelError('UNSUPPORTED_OPERATION', 'resolve_item', '当前连接尚不支持此内容链接')
        if len(matches) > 1:
            raise ChannelError('AMBIGUOUS_CONNECTION', 'resolve_item', '多个连接支持此链接，请指定连接')
        return matches[0]

    async def resolve_item(self, url, context):
        self.validate_item_url(url)
        reference = await self._adapter(context, 'resolve_item').resolve_item(url, context)
        context.check('resolve_item')
        if (not isinstance(reference, ContentReference) or reference.channel != context.connection.channel
                or any(not isinstance(part, str) or not part or ':' in part
                       for part in (reference.channel, reference.namespace, reference.external_id))):
            raise ChannelError('INVALID_RESULT', 'resolve_item', '渠道返回的内容身份无效')
        try:
            self.validate_item_url(reference.url)
        except ChannelError as error:
            raise ChannelError('INVALID_RESULT', 'resolve_item', '渠道返回的读取地址无效') from error
        return reference

    async def read_item(self, reference, context):
        if not isinstance(reference, ContentReference) or reference.channel != context.connection.channel:
            raise ChannelError('INVALID_INPUT', 'read_item', '内容身份与连接不一致')
        item = await self._adapter(context, 'read_item').read_item(reference, context)
        context.check('read_item')
        if (not isinstance(item, ContentItem) or item.key != reference.key
                or not isinstance(item.source, Source) or item.source.channel != item.channel
                or any(not isinstance(part, str) or not part for part in
                       (item.title, item.url, item.source.external_id, item.source.kind, item.source.name, item.source.url))
                or ':' in item.source.external_id or ':' in item.source.kind
                or not isinstance(item.published, PublishedTime)
                or item.published.precision not in {'unknown','date','minute','second'}
                or (item.published.value is not None and not isinstance(item.published.value, str))
                or any(value is not None and not isinstance(value, str) for value in (item.summary, item.thumbnail))
                or (item.duration_seconds is not None and (type(item.duration_seconds) is not int or item.duration_seconds < 0))):
            raise ChannelError('INVALID_RESULT', 'read_item', '渠道返回的内容或作者归属无效')
        try:
            self.validate_item_url(item.url)
            self.validate_item_url(item.source.url)
        except ChannelError as error:
            raise ChannelError('INVALID_RESULT', 'read_item', '渠道返回的内容或作者链接无效') from error
        return item
