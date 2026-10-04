"""Durable due times and bounded recovery; acquisition stays in SyncService."""
import asyncio
import logging
import math
import time
from dataclasses import asdict, dataclass

from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.schedules import ScheduleStore


@dataclass(frozen=True)
class SchedulePolicy:
    tick_seconds: float = 1
    startup_delay: float = 10
    dispatch_gap: float = 5
    resource_gap: float = 3
    retry_base: float = 60
    retry_cap: float = 3600
    max_retries: int = 3
    dependency_interval: float = 300
    page_budget: int = 1

    def __post_init__(self):
        for key, value in asdict(self).items():
            if type(value) not in {int, float} or not math.isfinite(value) or value < 0:
                raise ValueError(f'Invalid scheduling policy: {key}')
        if self.tick_seconds <= 0 or self.retry_base <= 0 or self.retry_cap < self.retry_base:
            raise ValueError('Invalid scheduling delay')
        if type(self.max_retries) is not int or not 0 <= self.max_retries <= 10:
            raise ValueError('Invalid retry budget')
        if type(self.page_budget) is not int or not 1 <= self.page_budget <= 100:
            raise ValueError('Invalid page budget')


class Scheduler:
    def __init__(self, core, *, policy=None, clock=time.time):
        self.core, self.repository = core, core.repository
        self.store = ScheduleStore(self.repository)
        self.policy, self.clock = policy or SchedulePolicy(), clock
        self.task = None
        self.suspended = False
        self.stopping = False
        self.next_dispatch = clock() + self.policy.startup_delay
        self.last_tick = clock()
        self.check_after = {}
        self.tick_lock = asyncio.Lock()
        self._reconcile(recover=True)

    def _reconcile(self, recover=False):
        for sub in self.repository.list_subscriptions():
            plan = self.store.ensure(sub, self.clock())
            if recover:
                # Existing M5 stores have no plan yet. Also recover a task whose
                # terminal event was lost when the process exited.
                row = self.repository.db.execute("SELECT id FROM jobs WHERE subscription_id=? AND mode!='detail' ORDER BY created_at DESC,rowid DESC LIMIT 1", (sub['id'],)).fetchone()
                if not row:
                    continue
                job = self.repository.get_job(row[0])
                if job['snapshot']['subscription_version'] != sub['version']:
                    continue
                if job['state'] == 'interrupted':
                    self.store.update(sub['id'], last_job_id=job['id'], last_state='interrupted', retry_job_id=job['id'],
                                      next_due=self.clock(), reason='上次检查中断，等待恢复')
                elif plan['last_job_id'] != job['id'] or plan['retry_job_id'] == job['id']:
                    self.observe('sync.changed', job)

    def start(self):
        if self.task is None:
            self.task = asyncio.create_task(self._loop(), name='subscription-scheduler')

    async def _loop(self):
        while not self.stopping:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).exception('Scheduler tick failed; local services remain available')
            await asyncio.sleep(self.policy.tick_seconds)

    def _scope(self, error, sub):
        conn = self.repository.get_connection(sub['connection_id'])
        scope = error.get('scope', 'operation')
        if error['code'] == 'SCHEMA_CHANGED':
            return 'backend', f'{conn.channel}:{conn.backend}'
        if scope == 'resource':
            return scope, conn.resource_key
        if scope == 'backend':
            return scope, f'{conn.channel}:{conn.backend}'
        if scope == 'connection' or error['code'] in {'AUTH_REQUIRED', 'AUTH_EXPIRED', 'INTERACTION_REQUIRED', 'DEPENDENCY_UNAVAILABLE'}:
            return 'connection', conn.id
        return 'subscription', sub['id']

    def _matches(self, block, sub, operation='list_items'):
        conn = self.repository.get_connection(sub['connection_id'])
        keys = {'connection': conn.id, 'resource': conn.resource_key,
                'backend': f'{conn.channel}:{conn.backend}', 'subscription': sub['id']}
        # Authentication and shared resource limits affect all acquisition; parser
        # changes remain scoped to the operation that actually failed.
        shared = block['error']['code'] in {'AUTH_REQUIRED','AUTH_EXPIRED','INTERACTION_REQUIRED','DEPENDENCY_UNAVAILABLE','RATE_LIMITED'}
        return keys.get(block['scope']) == block['scope_key'] and (shared or block['operation'] == operation)

    def blocked(self, sub, operation='list_items'):
        return [b for b in self.store.blocks() if self._matches(b, sub, operation) and
                (b['until_at'] is None or b['until_at'] > self.clock())]

    def guard(self, job, operation):
        if self.suspended or self.stopping:
            raise ChannelError('SUSPENDED', operation, '电脑休眠或应用关闭，等待恢复')
        sub = self.repository.get_subscription(job['subscription_id'])
        for block in self.blocked(sub, operation):
            if job['trigger'] != 'manual' or block['error']['code'] == 'RATE_LIMITED':
                error = block['error']
                raise ChannelError(error['code'], operation, error['message'], scope=block['scope'],
                                   scope_key=block['scope_key'], retryable=error.get('retryable', False),
                                   retry_after=max(0, block['until_at'] - self.clock()) if block['until_at'] else None)

    def observe(self, event, job):
        if event != 'sync.changed':
            return
        sub = self.repository.get_subscription(job['subscription_id'])
        plan = self.store.ensure(sub, self.clock())
        operation = 'get_item_detail' if job['mode'] == 'detail' else 'list_items'
        if job['snapshot']['subscription_version'] != sub['version']:
            return
        if plan['last_job_id'] == job['id'] and plan['last_state'] == job['state']:
            return
        if job['state'] in {'queued', 'running'}:
            if operation == 'list_items':
                self.store.update(sub['id'], last_job_id=job['id'], last_state=job['state'], retry_job_id=job['id'])
            return
        error = job['error'] or {}
        if error and error['code'] not in {'CANCELLED', 'STALE_CONFIG', 'SUSPENDED'}:
            scope, key = self._scope(error, sub)
            code = error['code']
            if code in {'AUTH_REQUIRED','AUTH_EXPIRED','DEPENDENCY_UNAVAILABLE','INTERACTION_REQUIRED','SCHEMA_CHANGED','RATE_LIMITED'}:
                delay = max(error.get('retry_after') or 0, self.policy.retry_base) if code == 'RATE_LIMITED' else None
                self.store.block(scope, key, operation, error, self.clock() + delay if delay is not None else None)
        if operation != 'list_items':
            return
        patch = dict(last_job_id=job['id'], last_state=job['state'], retry_job_id=None, reason='', failures=0,
                     next_due=self.clock() + sub['interval_seconds'])
        if job['state'] == 'succeeded':
            for block in self.blocked(sub):
                self.store.clear(block)
        elif job['state'] == 'interrupted':
            patch.update(next_due=self.clock(), retry_job_id=job['id'], reason='上次检查中断，等待恢复', failures=plan['failures'])
        elif job['state'] in {'waiting','failed','partial'}:
            failures = plan['failures'] + 1
            patch.update(failures=failures, reason=error.get('message', '本次采集不完整，下次定时检查'))
            code = error.get('code')
            if code in {'AUTH_REQUIRED','AUTH_EXPIRED','DEPENDENCY_UNAVAILABLE','INTERACTION_REQUIRED','SCHEMA_CHANGED'}:
                patch.update(next_due=self.clock(), retry_job_id=job['id'])
            elif code == 'RATE_LIMITED' or error.get('retryable') or code in {'TIMEOUT','TRANSIENT'}:
                if failures <= self.policy.max_retries:
                    delay = max(error.get('retry_after') or 0, min(self.policy.retry_cap, self.policy.retry_base * 2 ** (failures-1)))
                    patch.update(next_due=self.clock()+delay, retry_job_id=job['id'])
                else:
                    patch.update(next_due=None, retry_job_id=job['id'], reason='自动重试次数已用完，请检查连接后手动重试')
            elif error:
                patch.update(next_due=None, retry_job_id=job['id'])
        self.store.update(sub['id'], **patch)
        self.core.emit('scheduler.changed', {'subscription_id': sub['id']})

    async def connection_checked(self, connection_id, readiness):
        if readiness.state != 'ready':
            return
        changed = False
        for sub in self.repository.list_subscriptions():
            if sub['connection_id'] != connection_id:
                continue
            for block in self.blocked(sub):
                if block['error']['code'] in {'AUTH_REQUIRED','AUTH_EXPIRED','INTERACTION_REQUIRED','DEPENDENCY_UNAVAILABLE'}:
                    self.store.clear(block)
                    changed = True
        if changed:
            self.next_dispatch = max(self.next_dispatch, self.clock()+self.policy.dispatch_gap)
            self.core.emit('scheduler.changed', {})

    async def _check_dependencies(self):
        for conn in self.repository.list_connections():
            subs = [s for s in self.repository.list_subscriptions() if s['connection_id'] == conn['id'] and s['status'] == 'active' and s['sync_mode'] == 'automatic']
            blocks = [b for s in subs for b in self.blocked(s)]
            if not any(b['error']['code'] == 'DEPENDENCY_UNAVAILABLE' for b in blocks):
                continue
            if self.check_after.get(conn['id'], 0) > self.clock():
                continue
            self.check_after[conn['id']] = self.clock() + self.policy.dependency_interval
            await self.core.check_connection(conn['id'])
            break

    async def tick(self):
        async with self.tick_lock:
            if self.suspended or self.stopping:
                return
            timestamp = self.clock()
            if timestamp - self.last_tick > max(30, 3*self.policy.tick_seconds) or timestamp < self.last_tick:
                self.next_dispatch = timestamp + self.policy.startup_delay
            self.last_tick = timestamp
            self._reconcile()
            if timestamp < self.next_dispatch:
                return
            # Keep one due refresh slot even while a recovered backfill is active.
            # Both share the page-level FIFO lock; at most one recovery backfill
            # and one automatic refresh can queue for it.
            automatic = [self.repository.get_job(job_id) for job_id, task in self.core.sync.tasks.items()
                         if not task.done() and self.repository.get_job(job_id)['trigger'] != 'manual']
            if any(job['mode'] != 'backfill' for job in automatic):
                return
            due = []
            for sub in self.repository.list_subscriptions():
                plan = self.store.get(sub['id'])
                if sub['status'] != 'active' or sub['sync_mode'] != 'automatic' or plan['next_due'] is None or plan['next_due'] > timestamp:
                    continue
                if not self.repository.get_connection(sub['connection_id']).enabled or self.blocked(sub):
                    continue
                active = self.repository.db.execute("SELECT id,state FROM jobs WHERE subscription_id=? AND mode!='detail' AND state IN ('queued','running','waiting')", (sub['id'],)).fetchone()
                if active and active['state'] != 'waiting':
                    continue
                if automatic and plan['retry_job_id'] and self.repository.get_job(plan['retry_job_id'])['mode'] == 'backfill':
                    continue
                due.append((plan['next_due'], sub['id'], plan, active))
            if due:
                _, sub_id, plan, active = min(due, key=lambda v: (v[0], v[1]))
                self.next_dispatch = timestamp + self.policy.dispatch_gap
                try:
                    retry_id = active['id'] if active else plan['retry_job_id']
                    if retry_id:
                        await self.core.sync.retry(retry_id, _trigger='recovery')
                        self.store.update(sub_id, failures=plan['failures'])
                    else:
                        self.core.sync.start(sub_id, page_budget=self.policy.page_budget, _trigger='automatic')
                except ChannelError as error:
                    self.store.update(sub_id, next_due=None, reason=error.message)
                    self.core.emit('scheduler.changed', {'subscription_id': sub_id})
            else:
                await self._check_dependencies()

    def list(self):
        self._reconcile()
        result = []
        for sub in self.repository.list_subscriptions():
            plan = self.store.get(sub['id'])
            blocks = self.blocked(sub)
            state = 'scheduled'
            reason = plan['reason']
            if sub['status'] != 'active':
                state, reason = 'paused', '订阅已暂停'
            elif sub['sync_mode'] == 'manual':
                state, reason = 'manual', '手动模式，点击刷新后采集'
            elif self.suspended:
                state, reason = 'suspended', '电脑休眠，唤醒后恢复'
            elif blocks:
                state, reason = 'blocked', blocks[0]['error']['message']
            elif plan['next_due'] is None:
                state = 'blocked'
            elif plan['retry_job_id']:
                job = self.repository.get_job(plan['retry_job_id'])
                state = 'running' if job['state'] in {'running','queued'} else 'retrying'
            result.append({**plan, 'state': state, 'reason': reason,
                           'next_due': None if state in {'manual','paused','suspended'} or plan['next_due'] is None or (blocks and any(b['until_at'] is None for b in blocks)) else max([plan['next_due']] + [b['until_at'] or 0 for b in blocks])})
        return result

    def status(self):
        return {'running': self.task is not None and not self.task.done(), 'suspended': self.suspended,
                'policy': asdict(self.policy)}

    async def power(self, suspended):
        self.suspended = suspended
        self.core.sync.suspended = suspended
        if suspended:
            for job_id in list(self.core.sync.tasks):
                await self.core.sync.interrupt(job_id)
        else:
            self.next_dispatch = self.clock() + self.policy.startup_delay
            self.last_tick = self.clock()
        self.core.emit('scheduler.changed', {})
        return self.status()

    async def close(self):
        self.stopping = True
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
