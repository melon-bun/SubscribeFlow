"""Single-item intake orchestration. Platform rules belong exclusively to adapters."""
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from subscribe_flow.contracts import ChannelError, Connection, ContentItem, Context, Readiness, jsonable
from subscribe_flow.storage.repositories import now


@dataclass
class IntakeTask:
    id: str
    url: str
    connection: Connection
    deadline: float
    state: str = 'queued'
    created_at: str = field(default_factory=now)
    updated_at: str = field(default_factory=now)
    touched: float = field(default_factory=time.monotonic)
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    preview_id: str | None = None
    preview_expires: float = 0
    item: ContentItem | None = None
    item_id: str | None = None
    error: dict | None = None


class IntakeService:
    def __init__(self, gateway, repository, emit, resources, *, resource_gap=lambda: 0,
                 suspended=lambda: False, timeout=60, preview_ttl=300, max_tasks=100, max_active=8):
        self.gateway, self.repository, self.emit = gateway, repository, emit
        self.resources, self.resource_gap, self.suspended = resources, resource_gap, suspended
        self.timeout, self.preview_ttl = timeout, preview_ttl
        self.max_tasks, self.max_active = max_tasks, max_active
        self.records: dict[str, IntakeTask] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.previews: dict[str, IntakeTask] = {}
        self.closing = False

    def _public(self, record):
        result = {'task_id': record.id, 'state': record.state, 'connection_id': record.connection.id,
                  'channel': record.connection.channel, 'preview_id': record.preview_id,
                  'item_id': record.item_id, 'error': record.error,
                  'created_at': record.created_at, 'updated_at': record.updated_at}
        if record.state == 'preview':
            result['preview'] = {'id': record.item.key, **jsonable(record.item)}
        elif record.item_id:
            result['content'] = self.repository.get_content(record.item_id)
        return result

    def _set(self, record, state, *, error=None):
        record.state, record.error = state, error
        record.updated_at, record.touched = now(), time.monotonic()
        self.emit('intake.changed', self._public(record))

    def _prune(self):
        current = time.monotonic()
        for record in list(self.records.values()):
            if record.preview_id and current >= record.preview_expires:
                self.previews.pop(record.preview_id, None)
                if record.state == 'preview':
                    record.item = None
                    self._set(record, 'expired', error=ChannelError('PREVIEW_EXPIRED', 'intake.save', '预览已过期，请重新识别').to_dict())
            if record.state not in {'queued', 'running', 'preview'} and current - record.touched > 600:
                self.records.pop(record.id, None)

    def _record(self, task_id):
        self._prune()
        record = self.records.get(task_id)
        if record is None:
            raise ChannelError('NOT_FOUND', 'intake.get', '收录任务不存在或已失效')
        return record

    def _verify(self, record, operation):
        if self.closing or record.cancelled.is_set():
            raise ChannelError('CANCELLED', operation, '收录任务已取消')
        if self.suspended():
            raise ChannelError('SUSPENDED', operation, '电脑休眠，唤醒后请重新识别')
        current = self.repository.get_connection(record.connection.id)
        if current != record.connection or not current.enabled:
            raise ChannelError('STALE_CONFIG', operation, '连接配置已变化，请重新识别',
                               scope='connection', scope_key=current.id)

    def start(self, url, connection_id=None):
        if self.closing:
            raise ChannelError('UNAVAILABLE', 'intake.start', '应用正在关闭')
        if self.suspended():
            raise ChannelError('SUSPENDED', 'intake.start', '电脑休眠，唤醒后再收录')
        self._prune()
        if len(self.tasks) >= self.max_active:
            raise ChannelError('BUSY', 'intake.start', '正在识别的内容较多，请稍后重试', retryable=True)
        if len(self.records) >= self.max_tasks:
            removable = next((record for record in self.records.values()
                              if record.state not in {'queued', 'running', 'preview'}), None)
            if removable is None:
                raise ChannelError('BUSY', 'intake.start', '待确认预览较多，请保存或取消后重试')
            self.records.pop(removable.id)
            self.previews.pop(removable.preview_id, None)
        connections = [self.repository.get_connection(row['id']) for row in self.repository.list_connections()]
        connection = self.gateway.route_item_url(url, connections, connection_id)
        record = IntakeTask(uuid.uuid4().hex, url, connection, time.monotonic() + self.timeout)
        self.records[record.id] = record
        task = asyncio.create_task(self._run(record), name=f'intake-{record.id}')
        self.tasks[record.id] = task
        task.add_done_callback(lambda _: self.tasks.pop(record.id, None))
        self.emit('intake.changed', self._public(record))
        return self._public(record)

    async def _request(self, record, operation, function):
        self._verify(record, operation)
        context = Context(record.connection, record.id, record.deadline, record.cancelled)
        async with self.resources.acquire(context, operation, gap=self.resource_gap()):
            self._verify(record, operation)
            readiness = await self.gateway.check_readiness(operation, context)
            context.check(operation)
            self._verify(record, operation)
            self.repository.set_readiness(record.connection.id, readiness)
            if readiness.state == 'blocked':
                if readiness.authentication in {'required', 'expired'}:
                    code = 'AUTH_EXPIRED' if readiness.authentication == 'expired' else 'AUTH_REQUIRED'
                elif 'wait' in readiness.actions:
                    code = 'RATE_LIMITED'
                elif 'update_adapter' in readiness.actions:
                    code = 'SCHEMA_CHANGED'
                else:
                    code = 'DEPENDENCY_UNAVAILABLE'
                raise ChannelError(code, operation, readiness.reason, scope=readiness.scope,
                                   scope_key=readiness.scope_key, retry_after=readiness.retry_after)
            result = await function(context)
            context.check(operation)
            self._verify(record, operation)
            return result

    async def _run(self, record):
        try:
            self._set(record, 'running')
            async with asyncio.timeout(max(0, record.deadline - time.monotonic())):
                reference = await self._request(record, 'resolve_item', lambda ctx: self.gateway.resolve_item(record.url, ctx))
                if existing := self.repository.existing_item_id(reference):
                    record.item_id = existing
                    self._set(record, 'exists')
                    return
                item = await self._request(record, 'read_item', lambda ctx: self.gateway.read_item(reference, ctx))
                record.item, record.preview_id = item, uuid.uuid4().hex
                record.preview_expires = time.monotonic() + self.preview_ttl
                self.previews[record.preview_id] = record
                self._set(record, 'preview')
        except asyncio.CancelledError:
            self._set(record, 'cancelled')
        except TimeoutError:
            self._set(record, 'failed', error=ChannelError('TIMEOUT', 'intake.start', '识别超过时间限制，请重试', retryable=True).to_dict())
        except ChannelError as error:
            self._record_failure(record, error)
            self._set(record, 'cancelled' if error.code == 'CANCELLED' else 'failed', error=error.to_dict())
        except Exception:
            logging.getLogger(__name__).exception('Intake failed for %s', record.id)
            self._set(record, 'failed', error=ChannelError('INTERNAL_ERROR', 'intake.start', '内容识别失败，请重试').to_dict())

    def _record_failure(self, record, error):
        actions = {'AUTH_REQUIRED':'open_browser', 'AUTH_EXPIRED':'open_browser',
                   'INTERACTION_REQUIRED':'open_browser', 'RATE_LIMITED':'wait',
                   'SCHEMA_CHANGED':'update_adapter', 'DEPENDENCY_UNAVAILABLE':'check_dependencies'}
        if (error.code not in actions or record.cancelled.is_set()
                or self.repository.get_connection(record.connection.id) != record.connection):
            return
        readiness = Readiness('blocked', error.operation, error.message, error.scope,
                              error.scope_key or record.connection.id, now(), (actions[error.code],),
                              dependency='unavailable' if error.code == 'DEPENDENCY_UNAVAILABLE' else 'unknown',
                              authentication='required' if error.code.startswith('AUTH_') else 'unknown',
                              retry_after=error.retry_after)
        self.repository.set_readiness(record.connection.id, readiness)

    def get(self, task_id):
        return self._public(self._record(task_id))

    def save(self, preview_id, *, priority=None, tag_ids=None):
        self._prune()
        record = self.previews.get(preview_id)
        if record is None:
            raise ChannelError('PREVIEW_EXPIRED', 'intake.save', '预览已取消、过期或失效，请重新识别')
        self._verify(record, 'intake.save')
        if record.state in {'saved', 'exists'}:
            return {'status': 'exists', 'item_id': record.item_id,
                    'content': self.repository.get_content(record.item_id)}
        if record.state != 'preview':
            raise ChannelError('PREVIEW_EXPIRED', 'intake.save', '预览已失效，请重新识别')
        result = self.repository.save_manual(record.item, priority=priority, tag_ids=tag_ids)
        record.item_id = result['item_id']
        self._set(record, 'saved' if result['status'] == 'created' else 'exists')
        if result['status'] == 'created':
            self.emit('content.changed', {'ids': [record.item_id]})
            self.emit('tags.changed', {'ids': list(tag_ids or [])})
        return {**result, 'content': self.repository.get_content(record.item_id)}

    async def cancel(self, task_id):
        record = self._record(task_id)
        if record.state not in {'queued', 'running', 'preview'}:
            return {'cancelled': False, 'task_id': task_id}
        record.cancelled.set()
        self.previews.pop(record.preview_id, None)
        record.item = None
        if task := self.tasks.get(task_id):
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._set(record, 'cancelled')
        return {'cancelled': True, 'task_id': task_id}

    async def wait(self, task_id):
        if task := self.tasks.get(task_id):
            await asyncio.shield(task)
        return self.get(task_id)

    async def close(self):
        self.closing = True
        for record in list(self.records.values()):
            if record.state in {'queued', 'running', 'preview'}:
                await self.cancel(record.id)
        self.previews.clear()
