"""Provider 级并发闸门。

同一条连接同时只跑有限个请求：后台打标与用户主动触发的总结共用它，
因此一次慢请求不会把连接打爆，也不会让另一条业务排队到天荒地老。

等待有界：闸门排队超过预算就报「忙」，不无限等。
"""

from __future__ import annotations

import threading
from contextlib import contextmanager

from .contracts import ERROR_TIMEOUT, AiError


class ProviderGate:
    """按连接限流的闸门。

    limit 是**每条连接**的并发上限；排队等待也有上限。
    """

    def __init__(self, limit: int = 2, wait_timeout: float = 10.0):
        self.limit = max(1, int(limit))
        self.wait_timeout = float(wait_timeout)
        self._guard = threading.Lock()
        self._slots: dict[str, threading.BoundedSemaphore] = {}

    def _semaphore(self, provider_id: str) -> threading.BoundedSemaphore:
        with self._guard:
            slot = self._slots.get(provider_id)
            if slot is None:
                slot = threading.BoundedSemaphore(self.limit)
                self._slots[provider_id] = slot
            return slot

    @contextmanager
    def slot(self, provider_id: str, timeout: float | None = None):
        """占用一个名额。拿不到名额就报超时（忙），不无限等。"""
        budget = self.wait_timeout if timeout is None else float(timeout)
        semaphore = self._semaphore(provider_id or '')
        if not semaphore.acquire(timeout=max(0.0, budget)):
            raise AiError(ERROR_TIMEOUT, '这条连接正忙，稍后再试。')
        try:
            yield
        finally:
            semaphore.release()

    def status(self) -> dict:
        with self._guard:
            return {provider_id: {'limit': self.limit} for provider_id in self._slots}
