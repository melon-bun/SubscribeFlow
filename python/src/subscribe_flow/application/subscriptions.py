import time
import uuid

from subscribe_flow.contracts import ChannelError, Context, FetchRequest


class SubscriptionService:
    def __init__(self, gateway, repository):
        self.gateway, self.repository = gateway, repository

    def context(self, connection_id, operation="source"):
        return Context(self.repository.get_connection(connection_id), f"{operation}-{uuid.uuid4().hex}", time.monotonic() + 60)

    async def resolve(self, locator, connection_id):
        return await self.gateway.resolve_source(locator, self.context(connection_id))

    async def search(self, query, connection_id, limit=20):
        return await self.gateway.search_sources(query, FetchRequest(limit=limit), self.context(connection_id))

    async def add(self, locator, connection_id, *, confirmed=False, interval_seconds=3600):
        if confirmed is not True:
            raise ChannelError("CONFIRMATION_REQUIRED", "subscription.add", "请先确认作者 UID 或主页再添加订阅")
        if type(interval_seconds) is not int or not 300 <= interval_seconds <= 604800:
            raise ChannelError("INVALID_INPUT", "subscription.add", "刷新间隔需在 300 到 604800 秒之间")
        source = await self.resolve(locator, connection_id)
        return self.repository.subscribe(source, connection_id, interval_seconds)

    def update(self, subscription_id, **patch):
        if "interval_seconds" in patch and (type(patch["interval_seconds"]) is not int or not 300 <= patch["interval_seconds"] <= 604800):
            raise ChannelError("INVALID_INPUT", "subscription.update", "刷新间隔需在 300 到 604800 秒之间")
        return self.repository.update_subscription(subscription_id, **patch)

    async def check_connection(self, connection_id, operation="list_items"):
        readiness = await self.gateway.check_readiness(operation, self.context(connection_id, "check"))
        self.repository.set_readiness(connection_id, readiness)
        return readiness
