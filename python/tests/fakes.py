import asyncio
from datetime import datetime, timezone

from subscribe_flow.contracts import (
    ChannelDescriptor, ChannelError, ContentItem, FetchPage,
    OperationCapability, Readiness, Source,
)


class TestAdapter:
    """Deterministic test-only channel, deliberately named without a real platform."""
    def __init__(self, pages=None, error=None, delay=0):
        self.pages, self.error, self.delay = pages, error, delay
        self.calls = 0

    def describe(self):
        return ChannelDescriptor("test", "Test channel", "test", {
            op: OperationCapability(True, verified=True, full_history=True)
            for op in ("resolve_source", "list_items")
        })

    async def resolve_source(self, locator, context):
        return Source("test", "author", locator, locator, "https://example.com/author", True)

    async def check_readiness(self, operation, context):
        state = "blocked" if self.error else "ready"
        return Readiness(state, operation, str(self.error or "可用"), "connection",
                         context.connection.id, datetime.now(timezone.utc).isoformat())

    async def fetch_page(self, source, request, context):
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        context.check("list_items")
        if self.error:
            raise self.error
        if self.pages:
            return self.pages[(request.cursor or {}).get("page", 0)]
        return FetchPage((ContentItem("test", "video", "1", source, "Test item", "https://example.com/1"),),
                         None, "history_end", True, "test terminal")
