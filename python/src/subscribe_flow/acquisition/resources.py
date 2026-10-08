import asyncio
import time
from contextlib import asynccontextmanager

from subscribe_flow.contracts import Context


class ResourceCoordinator:
    """All connections using one browser session share the same resource key."""

    def __init__(self):
        self._locks: dict[str, asyncio.Lock] = {}
        self.ready_at: dict[str, float] = {}

    @asynccontextmanager
    async def acquire(self, context: Context, operation: str, *, gap=0):
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
        used = False
        try:
            while (delay := self.ready_at.get(key, 0) - time.monotonic()) > 0:
                context.check(operation)
                await asyncio.sleep(min(delay, 0.1))
            context.check(operation)
            used = True
            yield
        finally:
            if used:
                self.ready_at[key] = time.monotonic() + gap
            lock.release()
