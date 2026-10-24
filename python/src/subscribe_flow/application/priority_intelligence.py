"""M40 智能优先级的后台判断服务。

它做四件事：

- **资格检查**：一条内容只有在「没有人工值、有有效标签、当前结果对不上」时
  才有资格判断。没有标签或没有历史证据时本地兜底，不发请求。
- **排队与执行**：请求去重、有限并发、有限退避重试、退出取消、重启恢复。
- **在途核对**：模型返回前重新读一遍输入，用**真实上下文指纹**和各个版本
  核对一遍；用户改过档、换过标签、关掉开关或换过连接之后，旧结果不写。
- **落库与通知**：结果写进自己的表，不碰人工值与来源默认值；写完发既有
  的内容变更通知，让列表、计数与提醒一起刷新。

边界：

- 不阻塞采集、阅读与设置。判断在后台跑，失败只影响这一条内容。
- 不做全量重判。偏好统计变了不会把历史内容全部重新问一遍模型。
- 关闭功能或摘掉标签之后，读取立刻回退人工值／来源值，不等这次判断结束。
"""

from __future__ import annotations

import asyncio
import functools
import logging
from datetime import datetime, timedelta, timezone

from priority_engine.context import build_context
from priority_engine.contracts import (
    PRIORITY_UNKNOWN,
    STATUS_INCONSISTENT,
    STATUS_NETWORK_FAILED,
    STATUS_NOT_CONFIGURED,
    STATUS_NO_EVIDENCE,
    STATUS_NO_TAGS,
    STATUS_TIMEOUT,
    PriorityDecision,
)
from priority_engine.inference import ERROR_STATUS, PriorityInference
from priority_engine.prompts import PROMPT_VERSION

from subscribe_flow.storage.priority_intelligence import (
    MAX_ATTEMPTS,
    PREFERENCE_STATS_VERSION,
    PriorityStatsError,
)

LOG = logging.getLogger(__name__)

#: 可以退避重试的执行状态。其余的（无法判断、协议非法、未配置）重试也不会变好。
RETRYABLE_STATUSES = frozenset({STATUS_TIMEOUT, STATUS_NETWORK_FAILED})

#: 本地兜底状态：没有东西可判，因此记下来而不是问模型。
#: 这两种状态跟着偏好统计走：统计一变就可能变成有东西可判。
LOCAL_FALLBACK_STATUSES = frozenset({STATUS_NO_TAGS, STATUS_NO_EVIDENCE})

#: 有限退避的秒数。用完就用最后一档，不再无限拉长。
BACKOFF_SECONDS = (5, 20, 60)

#: 轮询间隔。队列空时这只是空转，不会查历史。
POLL_SECONDS = 2.0

#: 同时进行的判断数。判断是花钱的，队列再长也不无限并发。
MAX_WORKERS = 2


def _stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _after(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec='milliseconds')


class PriorityIntelligenceService:
    """智能优先级的后台服务。"""

    def __init__(self, repository, settings, gateway, emit, *, inference=None, clock=None):
        self.repository = repository
        self.intel = repository.priority_intelligence
        self.tasks = repository.priority_tasks
        self.settings = settings
        self.gateway = gateway
        self.emit = emit
        self.inference = inference or PriorityInference()
        self.clock = clock
        self.workers = []
        self.closing = False
        self.requested = 0
        self.decided = 0

    # ------------------------------------------------------------ 策略

    def policy(self):
        """当前生效的策略：开关、连接、协议与两个版本号。

        版本号的分工：策略版本随开关与所选连接变化，连接调用版本随连接自身的
        调用参数变化。只改三级显示名称两者都不动。
        """
        config = self.settings.snapshot()
        smart = (config.get('priority') or {}).get('smart') or {}
        provider_id = smart.get('providerId')
        provider = None
        if provider_id:
            try:
                provider = self.gateway.provider(provider_id)
            except Exception:
                provider = None
        mode = None
        provider_version = ''
        if provider is not None:
            # 协议决定走哪条路径：Jev 是四问收敛，LLM 是单字段 JSON。
            mode = 'jev' if provider.protocol == 'jev_systemone' else 'llm'
            provider_version = f"{provider.id}:{int(provider.revision)}"
        return {
            'enabled': bool(smart.get('enabled')),
            'provider_id': provider_id if provider is not None else None,
            'mode': mode,
            'policy_version': str(smart.get('revision') or ''),
            'provider_version': provider_version,
            'prompt_version': PROMPT_VERSION,
        }

    def sync_policy(self, *, stamp=None):
        """把当前策略写进存储。

        策略一变，读取口径立刻跟着变：功能关闭、换连接或改策略之后，
        旧结果立刻退出生效范围，读取马上回退人工值／来源值。
        """
        policy = self.policy()
        current = self.intel.policy()
        if (bool(current['enabled']) != policy['enabled']
                or (current['provider_id'] or None) != (policy['provider_id'] or None)
                or current['policy_version'] != policy['policy_version']
                or current['provider_version'] != policy['provider_version']):
            self.intel.save_policy(enabled=policy['enabled'], provider_id=policy['provider_id'],
                                    policy_version=policy['policy_version'],
                                    provider_version=policy['provider_version'], stamp=stamp)
        return policy

    def on_settings_changed(self):
        """设置保存后立即生效：策略变了就把口径同步过去。"""
        try:
            self.sync_policy()
        except Exception:
            LOG.exception('同步智能优先级策略失败')

    # ------------------------------------------------------------ 生命周期

    def start(self):
        """启动后台服务。

        旧迁移不会给历史数据标脏，所以首次启用或升级后要按当前口径做一次
        本地聚合：已有人工优先级与标签关系的内容因此也能参与偏好统计。
        聚合过一次就不再来第二次，不在每次启动时扫历史。
        """
        self.sync_policy()
        try:
            if self.intel.stats_version() != PREFERENCE_STATS_VERSION:
                self.intel.rebuild_all()
                self.intel.mark_stats_built(PREFERENCE_STATS_VERSION)
        except Exception:
            LOG.exception('聚合已有人工优先级偏好统计失败')
        try:
            # 重启恢复：崩溃留下的 running 任务收回队列。
            recovered = self.tasks.recover()
            if recovered:
                self.emit('priority.changed', {'recovered': recovered})
        except Exception:
            LOG.exception('恢复智能优先级任务失败')
        if self.workers:
            return
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # 没有事件循环（例如同步脚本里调用）：只做聚合，worker 留给
            # 真正进入事件循环时再起。
            return
        for index in range(MAX_WORKERS):
            self.workers.append(asyncio.create_task(self._loop(), name=f'priority-{index}'))

    async def close(self):
        """有界退出：停循环、在途任务退回队列，不无限等待模型请求。"""
        self.closing = True
        for worker in self.workers:
            worker.cancel()
        if self.workers:
            await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers = []
        try:
            self.tasks.release_running()
        except Exception:
            LOG.exception('退回在途智能优先级任务失败')

    # ------------------------------------------------------------ 资格与排队

    def request(self, content_ids, *, reason='auto', force=False):
        """做一次资格检查，把有资格的内容排进队列。

        ``force=True`` 是用户明确要求重新判断：它会忽略已有结果与重试预算。
        """
        try:
            policy = self.sync_policy()
        except Exception:
            LOG.exception('读取智能优先级策略失败')
            return {'queued': 0, 'reason': 'policy_error'}
        if not policy['enabled'] or not policy['provider_id']:
            return {'queued': 0, 'reason': 'disabled'}
        queued = 0
        for content_id in dict.fromkeys(content_ids or []):
            if not isinstance(content_id, str) or not content_id:
                continue
            try:
                eligible = force or self._eligible(content_id, policy)
            except Exception:
                LOG.exception('检查内容 %s 的判断资格失败', content_id)
                continue
            if not eligible:
                continue
            if self.tasks.enqueue(content_id, reason, force=force):
                queued += 1
                self.requested += 1
        return {'queued': queued, 'reason': reason}

    def _eligible(self, content_id, policy):
        """这条内容现在需不需要判断。

        三道门：内容还在、没有人工值、已有结果对不上当前输入。
        没有标签与没有证据不算「不需要」：它们是有界的本地兜底状态，
        照样要记下来，界面与统计才知道这条为什么没判。
        """
        versions = self.intel.input_versions(content_id)
        if versions is None:
            return False
        if versions['manual_priority'] is not None:
            # 人工值优先：这一条不需要模型判断。
            return False
        decision = self.intel.get_decision(content_id)
        if decision is not None and self._decision_current(decision, versions, policy):
            # 结果还对得上当前输入：不重复花钱。
            return False
        return True

    def _decision_current(self, decision, versions, policy):
        """缓存里的结果是否还对得上当前输入。

        比较的是内容版本、标签版本、单条人工操作版本、策略版本、连接调用版本
        与提示词版本。**不比较偏好统计版本**：统计变了只影响之后的判断，
        不该把历史内容全部重新问一遍。

        例外是本地兜底状态（没有标签、没有证据）：它说的其实是「刚才没东西
        可判」。统计一变就可能变成有东西可判，因此这两种状态要跟着统计走。
        """
        if not (decision.get('content_version') == versions['content_version']
                and decision.get('tag_version') == versions['tag_version']
                and int(decision.get('manual_version') or 0) == int(versions['manual_version'])
                and decision.get('policy_version') == policy['policy_version']
                and decision.get('provider_version') == policy['provider_version']
                and decision.get('prompt_version') == policy['prompt_version']):
            return False
        if decision.get('status') in LOCAL_FALLBACK_STATUSES:
            preference = self.intel.preference_version(versions['tag_ids'])
            return decision.get('preference_version') == preference
        return True

    def observe(self, event, data):
        """内容或标签变化后做一次资格检查。

        只排真正可能有资格的内容：人工改档、恢复自动、标签增删都会走到这里。
        """
        if event != 'content.changed':
            return
        ids = (data or {}).get('ids') or []
        if not ids:
            return
        self.request(ids, reason='event')

    # ------------------------------------------------------------ 执行

    async def _loop(self):
        while not self.closing:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.exception('智能优先级 worker 迭代失败')
            await asyncio.sleep(POLL_SECONDS)

    async def _run_once(self):
        if self.closing:
            return
        policy = self.sync_policy()
        if not policy['enabled'] or not policy['provider_id']:
            return
        task = self.tasks.next_task()
        if task is None:
            return
        try:
            await self._execute(task, policy)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOG.exception('智能优先级任务 %s 执行异常', task['content_id'])
            self.tasks.finish(task['content_id'], 'failed', error_code='internal_error',
                              reason='后台任务执行异常')

    async def _execute(self, task, policy):
        content_id = task['content_id']
        try:
            snapshot = self._snapshot(content_id, policy)
        except PriorityStatsError:
            # 统计没能重建：不拿旧分布去问模型，直接兜底。
            self.tasks.finish(content_id, 'failed', error_code='stats_unavailable',
                              reason='偏好统计暂时不可用，已回退人工值或来源值')
            return
        if snapshot is None:
            self.tasks.finish(content_id, 'cancelled', reason='内容已删除')
            return

        result = build_context(snapshot)
        if not result.usable:
            # 本地兜底：没有标题、没有有效标签、没有历史证据、超预算或本地
            # 数据不一致。都不发请求，如实记一条有状态的结果。
            decision = PriorityDecision(PRIORITY_UNKNOWN, result.status,
                                        provider_id=policy['provider_id'],
                                        context_fingerprint='', snapshot=result.snapshot)
            self._write(content_id, decision)
            self.tasks.finish(content_id, 'succeeded', reason=result.status)
            return

        try:
            # 适配器在事件循环线程里组装：读设置、查凭据都在这一侧完成。
            # 只有网络请求进执行器——SQLite 连接绑定创建它的线程。
            adapter = self.gateway.adapter(policy['provider_id'])
        except Exception as error:
            code = str(getattr(error, 'code', '') or '')
            status = ERROR_STATUS.get(code, STATUS_NOT_CONFIGURED)
            self.tasks.finish(content_id, 'failed', error_code=status, reason='所选连接尚未配置完成')
            return
        mode = 'jev' if getattr(adapter, 'protocol', '') == 'jev_systemone' else 'llm'
        call = functools.partial(self.inference.judge, caller=adapter, mode=mode,
                                 payload=result.payload,
                                 context_fingerprint=result.fingerprint, snapshot=result.snapshot)
        try:
            # 模型请求在执行器里跑：Core 事件循环不能被同步 SDK 卡住。
            decision = await asyncio.get_running_loop().run_in_executor(None, call)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOG.exception('智能优先级请求失败：%s', content_id)
            self._defer(task, 'network_failed', '调用判断接口失败')
            return
        # 写回前再核对一次。用户可能在这期间改过档、换过标签、关掉开关或
        # 换过连接。核对的是真实上下文指纹与各个版本，不是可能相同的时间戳。
        try:
            current = self._snapshot(content_id, policy)
        except PriorityStatsError:
            current = None
        if current is None:
            self.tasks.finish(content_id, 'cancelled', reason='内容已删除')
            return
        current_result = build_context(current)
        if current_result.fingerprint != result.fingerprint:
            self.tasks.finish(content_id, 'cancelled', reason='判断期间内容或标签已变化')
            return
        if current_result.snapshot.to_dict() != result.snapshot.to_dict():
            self.tasks.finish(content_id, 'cancelled', reason='判断期间配置或输入已变化')
            return

        if decision.status in RETRYABLE_STATUSES:
            self._defer(task, decision.status, '判断接口暂时不可用，稍后重试')
            return
        self._write(content_id, decision)
        self.tasks.finish(content_id, 'succeeded', reason=decision.status)

    def _snapshot(self, content_id, policy):
        """读出判断输入快照。统计不可用时抛 PriorityStatsError。"""
        return self.intel.context_snapshot(
            content_id, policy_version=policy['policy_version'],
            provider_version=policy['provider_version'],
            prompt_version=policy['prompt_version'])

    def _write(self, content_id, decision):
        self.intel.save_decision(content_id, decision)
        self.decided += 1
        # 既有内容变更通知：列表、计数与提醒一起刷新。
        self.emit('content.changed', {'ids': [content_id]})

    def _defer(self, task, error_code, reason):
        """有限退避。可重试的失败退到下一次尝试时间。"""
        attempts = int(task.get('attempts') or 0) + 1
        if attempts >= MAX_ATTEMPTS:
            self.tasks.finish(task['content_id'], 'failed', error_code=error_code, reason=reason)
            return
        delay = BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
        self.tasks.defer(task['content_id'], attempts, _after(delay), error_code=error_code, reason=reason)

    # ------------------------------------------------------------ 界面入口

    def status(self):
        policy = self.policy()
        return {
            'enabled': policy['enabled'],
            'providerId': policy['provider_id'],
            'mode': policy['mode'],
            'policyVersion': policy['policy_version'],
            'providerVersion': policy['provider_version'],
            'promptVersion': policy['prompt_version'],
            'tasks': self.tasks.summary(),
            'decisions': self.intel.summary()['decisions'],
            'requested': self.requested,
            'decided': self.decided,
        }

    def judge(self, item_id):
        """用户明确要求判断一条内容。"""
        return self.request([item_id], reason='manual', force=True)

    def judge_bulk(self, item_ids):
        """批量恢复自动判断。去重与限流由任务表负责。"""
        if not item_ids or len(item_ids) > 100:
            from subscribe_flow.contracts import ChannelError
            raise ChannelError('INVALID_INPUT', 'priority.judge_bulk', '每次需指定 1 到 100 条内容')
        return self.request(item_ids, reason='manual', force=True)


__all__ = ['PriorityIntelligenceService', 'RETRYABLE_STATUSES', 'BACKOFF_SECONDS',
           'MAX_WORKERS', 'POLL_SECONDS']
