from __future__ import annotations

import asyncio
import logging
import time

from subscribe_flow.contracts import ChannelError, Context, FetchRequest, Readiness
from subscribe_flow.storage.repositories import now
from subscribe_flow.acquisition.resources import ResourceCoordinator


class SyncService:
    def __init__(self, gateway, repository, emit, *, page_timeout=60):
        self.gateway, self.repository, self.emit = gateway, repository, emit
        self.page_timeout = page_timeout
        self.tasks: dict[str, asyncio.Task] = {}
        self.signals: dict[str, asyncio.Event] = {}
        self.closing = False
        self.suspended = False
        self.interrupted = set()
        self.resources = ResourceCoordinator()
        self.resource_gap = 0
        self.resource_ready = {}
        self.guard = None

    # The per-subscription ceiling is expressed in items. A page is one whole
    # FetchRequest.limit request, so a short final page still costs a full round trip.
    PAGE_ITEMS = 20

    @classmethod
    def page_budget_for(cls, sub, mode, page_budget=None, descriptor=None):
        if page_budget is not None:
            return page_budget
        collect_items = sub.get("collect_items") or 0
        page_size = descriptor.page_size if descriptor else cls.PAGE_ITEMS
        if collect_items:
            return -(-collect_items // page_size)
        if descriptor:
            return descriptor.default_backfill_budget if mode == "backfill" else descriptor.default_refresh_budget
        return 10 if mode == "backfill" else 1

    def start(self, subscription_id, *, mode="refresh", page_budget=None, item_key=None, _trigger="manual"):
        if self.closing:
            raise ChannelError("UNAVAILABLE", "sync.start", "应用正在关闭")
        if self.suspended:
            raise ChannelError("SUSPENDED", "sync.start", "电脑休眠，唤醒后再采集")
        if mode not in {"initial", "refresh", "backfill", "detail"}:
            raise ChannelError("INVALID_INPUT", "sync.start", "无效任务模式")
        sub = self.repository.get_subscription(subscription_id)
        connection = self.repository.get_connection(sub["connection_id"])
        descriptor = next((d for d in self.gateway.describe() if d.channel == connection.channel and d.backend == connection.backend), None)
        budget = self.page_budget_for(sub, mode, page_budget, descriptor)
        if type(budget) is not int or not 1 <= budget <= 100:
            raise ChannelError("INVALID_INPUT", "sync.start", "分页预算必须在 1 到 100 之间")
        if sub["status"] != "active":
            raise ChannelError("SUBSCRIPTION_INACTIVE", "sync.start", "请先恢复订阅")
        if _trigger != 'manual' and sub['sync_mode'] != 'automatic':
            raise ChannelError('SUBSCRIPTION_INACTIVE', 'sync.start', '订阅已切换为手动模式')
        operation = "get_item_detail" if mode == "detail" else "list_items"
        capability = descriptor.operations.get(operation) if descriptor else None
        if not capability or not capability.supported:
            raise ChannelError("UNSUPPORTED_OPERATION", "sync.start", "当前连接不支持此任务")
        if mode == "detail":
            if not item_key:
                raise ChannelError("INVALID_INPUT", "sync.start", "详情任务需要内容 ID")
            item = self.repository.get_content(item_key)
            source = item["source"]
            if f'{source["channel"]}:{source["kind"]}:{source["external_id"]}' != sub["source_id"]:
                raise ChannelError("INVALID_INPUT", "sync.start", "内容不属于该订阅")
        job, created = self.repository.create_job(subscription_id, mode, item_key=item_key, progress_version=descriptor.progress_version,
                                                  page_budget=budget, trigger=_trigger)
        if created:
            self._launch(job, budget)
        return {"job_id": job["id"], "created": created, "mode": job["mode"]}

    def _launch(self, job, budget):
        job_id = job["id"]
        self.signals[job_id] = asyncio.Event()
        task = asyncio.create_task(self._run(job_id, budget), name=f"sync-{job_id}")
        self.tasks[job_id] = task

        def done(_):
            self.tasks.pop(job_id, None)
            self.signals.pop(job_id, None)
        task.add_done_callback(done)
        self.emit("sync.changed", self.repository.get_job(job_id))

    def _context(self, job):
        connection = self.repository.get_connection(job["snapshot"]["connection_id"])
        return Context(connection, job["id"], time.monotonic() + self.page_timeout, self.signals[job["id"]],
                       self.repository.source_for(job["subscription_id"]))

    async def _request(self, job, operation, function):
        context = self._context(job)
        async with self.resources.acquire(context, operation):
            key = context.connection.resource_key
            delay = self.resource_ready.get(key, 0) - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            context = self._context(job)
            if self.guard:
                self.guard(job, operation)
            try:
                value = await function(context)
                context.check(operation)
                return value
            finally:
                self.resource_ready[key] = time.monotonic() + self.resource_gap

    async def _run(self, job_id, budget):
        repository = self.repository
        try:
            job = repository.set_job_state(job_id, "running")
            repository.assert_current(job)
            self.emit("sync.changed", job)
            if job["mode"] == "detail":
                patch = await self._request(job, 'get_item_detail', lambda ctx: self.gateway.get_item_detail(job["item_key"], ctx))
                repository.apply_detail(job_id, patch)
                self.emit("content.changed", {"ids": [patch.item_key]})
                return
            source = repository.source_for(job["subscription_id"])
            descriptor = next(d for d in self.gateway.describe() if d.channel == source.channel and d.backend == job["snapshot"]["backend"])
            known_ids = repository.complete_source_ids(source.key)
            # Cursor persistence is retained as evidence; page-number backends can
            # move while the app is closed, so a new run safely starts at the head.
            cursor, seen, first_keys = None, set(), set()
            consumed = 0
            for index in range(budget + descriptor.scan_overhead_budget):
                job = repository.get_job(job_id)
                repository.assert_current(job)
                context = self._context(job)
                page = await self._request(job, 'list_items', lambda ctx: self.gateway.fetch_page(source,
                    FetchRequest(mode=job["mode"], cursor=cursor, limit=descriptor.page_size,
                                 known_ids=known_ids if cursor is None else (), item_budget=budget * descriptor.page_size), ctx))
                consumed += page.metrics.get("detail_requests", 0) if descriptor.budget_unit == "details" else 1
                keys = {item.key for item in page.items}
                if index == 0:
                    first_keys = keys
                no_progress = index > 0 and not (keys - seen) and not page.scan_advanced
                seen |= keys
                job = repository.commit_page(job_id, page)
                self._record_success(context)
                self.emit("content.changed", {"ids": [item.key for item in page.items]})
                self.emit("sync.changed", job)
                if page.terminal:
                    complete = not job["item_errors"]
                    coverage = page.coverage if complete else "possible_gaps"
                    # Recheck the head after a multi-page traversal. If new entries
                    # appeared, save them but require another scan before completion.
                    if complete and index > 0 and job["mode"] == "backfill" and not page.scan_advanced:
                        head = await self._request(job, 'list_items', lambda ctx: self.gateway.fetch_page(source, FetchRequest(mode="refresh"), ctx))
                        if {item.key for item in head.items} != first_keys or head.item_errors:
                            repository.commit_page(job_id, head)
                            complete, coverage = False, "possible_gaps"
                    repository.finish_scan(job_id, coverage=coverage, complete=complete and coverage in {"history_end", "refresh_interval"}, checkpoint=page.candidate_progress)
                    return
                if no_progress or (not page.items and not page.scan_advanced):
                    raise ChannelError("NO_PROGRESS", "list_items", "分页未取得进展，保留已保存内容但不宣告历史完成")
                if not page.next_cursor:
                    repository.finish_scan(job_id, coverage="window_only")
                    return
                cursor = page.next_cursor
                if consumed >= budget:
                    break
                await asyncio.sleep(0)  # Release the resource between bounded pages.
            job = repository.get_job(job_id)
            repository.finish_scan(job_id, coverage="possible_gaps" if job["item_errors"] else "window_only")
        except asyncio.CancelledError:
            repository.set_job_state(job_id, "interrupted" if job_id in self.interrupted else "cancelled")
        except ChannelError as error:
            job = repository.get_job(job_id)
            waiting = error.code in {"AUTH_REQUIRED", "AUTH_EXPIRED", "DEPENDENCY_UNAVAILABLE", "INTERACTION_REQUIRED", "RATE_LIMITED"}
            state = "interrupted" if error.code == 'SUSPENDED' else "cancelled" if error.code in {"CANCELLED", "STALE_CONFIG"} else "waiting" if waiting else "partial" if job["pages"] else "failed"
            repository.set_job_state(job_id, state, error=error.to_dict(), coverage="possible_gaps" if job["pages"] else None)
            if error.scope in {"connection", "resource", "backend"}:
                self._record_failure(job, error)
        except Exception:
            logging.getLogger(__name__).exception("Sync failed internally for job %s", job_id)
            error = ChannelError("INTERNAL_ERROR", "sync", "任务内部错误，已提交内容保留")
            job = repository.get_job(job_id)
            repository.set_job_state(job_id, "partial" if job["pages"] else "failed", error=error.to_dict(), coverage="possible_gaps" if job["pages"] else None)
        finally:
            self.emit("sync.changed", repository.get_job(job_id))

    def _record_success(self, context):
        previous = next((c["readiness"] for c in self.repository.list_connections() if c["id"] == context.connection.id), None)
        authentication = (previous or {}).get("authentication", "unknown")
        self.repository.set_readiness(context.connection.id, Readiness("ready", "list_items", "最近投稿请求成功；具体登录状态以连接检查为准",
                                      "connection", context.connection.id, now(), dependency="available", authentication=authentication))

    def _record_failure(self, job, error):
        connection_id = job["snapshot"]["connection_id"]
        actions = {"AUTH_REQUIRED": "open_browser", "AUTH_EXPIRED": "open_browser",
                   "INTERACTION_REQUIRED": "open_browser", "RATE_LIMITED": "wait", "SCHEMA_CHANGED": "update_adapter"}
        readiness = Readiness("blocked", error.operation, error.message, error.scope, error.scope_key or connection_id,
                              now(), (actions.get(error.code, "check_dependencies"),),
                              dependency="unavailable" if error.code == "DEPENDENCY_UNAVAILABLE" else "unknown",
                              authentication="required" if error.code.startswith("AUTH_") else "unknown", retry_after=error.retry_after)
        self.repository.set_readiness(connection_id, readiness)

    async def cancel(self, job_id):
        job = self.repository.get_job(job_id)
        if job["state"] not in {"queued", "running", "waiting"}:
            return {"cancelled": False, "job_id": job_id}
        if signal := self.signals.get(job_id):
            signal.set()
        if task := self.tasks.get(job_id):
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        # A just-created task may be cancelled before entering its try/finally.
        self.repository.set_job_state(job_id, "cancelled")
        self.emit("sync.changed", self.repository.get_job(job_id))
        return {"cancelled": True, "job_id": job_id}

    async def cancel_subscription(self, subscription_id):
        for job in self.repository.list_jobs(100000):
            if job["subscription_id"] == subscription_id and job["state"] in {"queued", "running", "waiting"}:
                await self.cancel(job["id"])

    async def retry(self, job_id, *, page_budget=None, _trigger="manual"):
        job = self.repository.get_job(job_id)
        if job["state"] in {"queued", "running"}:
            return {"job_id": job_id, "created": False, "mode": job["mode"]}
        if job["state"] == "waiting":
            await self.cancel(job_id)
        return self.start(job["subscription_id"], mode=job["mode"], item_key=job["item_key"],
                          page_budget=job['page_budget'] if page_budget is None else page_budget, _trigger=_trigger)

    async def interrupt(self, job_id):
        if self.repository.get_job(job_id)['state'] not in {'queued', 'running'}:
            return
        self.interrupted.add(job_id)
        try:
            if signal := self.signals.get(job_id):
                signal.set()
            if task := self.tasks.get(job_id):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            self.repository.set_job_state(job_id, 'interrupted')
            self.emit('sync.changed', self.repository.get_job(job_id))
        finally:
            self.interrupted.discard(job_id)

    async def wait(self, job_id):
        if task := self.tasks.get(job_id):
            await asyncio.shield(task)
        return self.repository.get_job(job_id)

    async def close(self):
        self.closing = True
        for job_id in list(self.tasks):
            await self.interrupt(job_id)
