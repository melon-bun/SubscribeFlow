import asyncio
from contextlib import asynccontextmanager

from subscribe_flow.contracts import Context


class ResourceCoordinator:
    """All connections using one external browser share the same resource key."""

    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def acquire(self, context: Context, operation: str):
        key = context.connection.resource_key
        if not key:
            raise ValueError("A connection must declare its resource key")
        lock = self._locks.setdefault(key, asyncio.Lock())
        while True:
            context.check(operation)
            try:
                await asyncio.wait_for(lock.acquire(), timeout=0.1)
                break
            except TimeoutError:
                continue
        try:
            context.check(operation)
            yield
        finally:
            lock.release()
