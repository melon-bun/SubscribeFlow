from subscribe_flow.contracts import CONTRACT_VERSION, ChannelAdapter, ChannelError, Context, FetchRequest, Source


class ChannelGateway:
    def __init__(self):
        self._adapters: dict[tuple[str, str], ChannelAdapter] = {}

    def register(self, adapter: ChannelAdapter) -> None:
        descriptor = adapter.describe()
        key = (descriptor.channel, descriptor.backend)
        if key in self._adapters or descriptor.contract_version != CONTRACT_VERSION:
            raise ValueError("Duplicate adapter or incompatible contract")
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
        return await self._adapter(context, "search_sources").search_sources(query, request, context)

    async def get_item_detail(self, item_ref: str, context: Context):
        return await self._adapter(context, "get_item_detail").get_item_detail(item_ref, context)
