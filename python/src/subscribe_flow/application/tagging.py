"""M16 自动打标应用服务：Provider 组装、契约映射与有界后台任务。

这一层是 Core 与独立识别包之间的唯一边界（计划 §3.1）：
- 把设置与受保护凭据组装成正式 Provider，配置不全时明确报「未配置」，
  不会造一个会失败的假实例；
- 把 Core 的 RecognitionInput／TagCandidate 映射成识别包契约，结果再映射回来；
- 后台任务有界、认领租约、有限退避；模型请求走执行器，不阻塞 Core 事件循环；
- 自动关闭时消费位置照常推进但不再请求模型；重启时回收过期租约并恢复。

识别包不依赖本模块；本模块也不认识任何供应商原始响应。
"""

import asyncio
import logging

from subscribe_flow.contracts import ChannelError
from subscribe_flow.contracts.tags import RecognitionInput
from subscribe_flow.storage.repositories import now

from tagging_engine import build_provider
from tagging_engine.contracts import (
    ERROR_AUTH, ERROR_NOT_CONFIGURED, ERROR_RATE_LIMITED, CandidateTag,
    RecognitionError, RecognitionRequest, STATUS_INSUFFICIENT_TEXT, STATUS_MATCHED,
    STATUS_NO_MATCH, MAX_CANDIDATES,
)

LOG = logging.getLogger(__name__)

# 每次自动标签的数量上限（计划 §3.4：不强凑数量，允许无匹配）。
AUTO_TAG_LIMIT = 5
# 后台同时执行的模型请求数。更高会让延迟抖动，也更容易触发限流。
MAX_ACTIVE = 2
# 一轮轮询间隔。事件表才是恢复依据，这个只决定响应快慢。
POLL_SECONDS = 2.0


class TaggingService:
    def __init__(self, *, repository, tags_repository, settings, credentials, emit, clock=None):
        self.repo = repository              # TaggingRepository：事件与任务
        self.tags = tags_repository         # Repository：内容、标签与事务
        self.settings = settings            # SettingsService
        self.credentials = credentials      # CredentialBroker（只在内存里有明文）
        self.emit = emit
        self.clock = clock or (lambda: now())
        self.workers: list[asyncio.Task] = []
        self.closing = False
        self.running_task_id: str | None = None

    # ------------------------------------------------------------ 组装

    def snapshot(self):
        """当前配置版本与生效状态。每次组装前重新读，不缓存快照。"""
        config = self.settings.snapshot()
        tagging = config['tagging']
        return config, tagging

    def _provider_for(self, tagging):
        """按当前模式组装正式 Provider。

        密钥只在这一刻从内存凭据容器取用，不落库、不进日志、不返回给界面。
        """
        mode = tagging['mode']
        provider = tagging['providers'][mode]
        reference = provider.get('credentialRef')
        api_key = self.credentials.secret_for(reference) if reference else None
        missing = [label for key, label in (('endpoint', '接口地址'), ('model', '模型标识'))
                   if not provider.get(key)]
        if not api_key:
            missing.append('API Key')
        if missing:
            raise RecognitionError(ERROR_NOT_CONFIGURED,
                                   '自动打标尚未配置完整：' + '、'.join(missing))
        return build_provider(mode, endpoint=provider['endpoint'], model=provider['model'],
                              api_key=api_key)

    async def test_connection(self):
        """设置页「测试连接」：复用正式 Provider 与固定样例，反馈真实结果。

        走的是与后台任务完全相同的组装路径，因此这里通过不等于后台也能用，
        反之亦然——不存在只给界面演示的假通路。
        """
        config, tagging = self.snapshot()
        sample = RecognitionRequest(
            item_id='connection-test',
            text='这是一段用于验证接口连通性的固定样例文本，内容涉及编程与开发工具。',
            title='连接测试', mode=tagging['mode'],
            candidates=(CandidateTag('sample-probe', '连接测试标签', '仅用于验证接口是否可用'),),
            limit=1, content_version=self.clock())
        try:
            provider = self._provider_for(tagging)
        except RecognitionError as error:
            return {'ok': False, 'code': error.code, 'message': error.message, 'retryable': False}
        try:
            # 同步 SDK 放执行器：设置页调用不能卡住 Core 事件循环。
            result = await asyncio.get_running_loop().run_in_executor(None, provider.recognize, sample)
        except RecognitionError as error:
            return {'ok': False, 'code': error.code, 'message': error.message, 'retryable': error.retryable}
        except Exception:
            LOG.exception('Auto-tagging connection test failed')
            return {'ok': False, 'code': 'invalid_response', 'message': '接口返回了无法解析的结果',
                    'retryable': False}
        return {'ok': True, 'provider': result.provider, 'model': result.model,
                'requestedModel': result.requested_model, 'status': result.status,
                'candidates': len(result.candidates),
                'message': '连接正常，接口返回了可用结果',
                'configVersion': config['version']}

    # ------------------------------------------------------------ 映射

    def _request_for(self, task, content, candidates):
        """Core 内容 → 识别请求。只用已保存且实际存在的文本，不额外抓取。"""
        payload = content.get('payload') or content
        text = payload.get('summary') or payload.get('text') or ''
        if type(text) is not str:
            text = ''
        return RecognitionRequest(
            item_id=task['content_id'], text=text, title=payload.get('title') or '',
            mode=task['mode'], candidates=tuple(candidates),
            limit=min(AUTO_TAG_LIMIT, MAX_CANDIDATES),
            content_version=task['content_version'])

    @staticmethod
    def _resolve(result, directory):
        """识别结果 → (已有标签 ID 列表, 新标签名列表)。

        按计划 §3.4：先按现有名称/明确别名复用；Jev 不允许新建（引擎已保证）。
        目录里没有的 ID 一律丢弃——模型不能凭空指认一个不存在的标签。
        """
        by_id = {tag['id']: tag for tag in directory}
        applied, new_names, seen = [], [], set()
        for candidate in result.candidates:
            if candidate.tag_id:
                tag = by_id.get(candidate.tag_id)
                # 目录版本已在落库前复核；这里再挡一次禁用/已删标签。
                if tag is None:
                    continue
                key = ('id', tag['id'])
                if key in seen:
                    continue
                seen.add(key)
                applied.append(tag['id'])
                continue
            name = (candidate.name or '').strip()
            if not name:
                continue
            key = ('name', name.casefold())
            if key in seen:
                continue
            seen.add(key)
            new_names.append(name)
        return applied, new_names

    # ------------------------------------------------------------ 后台任务

    def _register(self):
        """把持久事件推进成任务。关闭期间的事件照常消费但不请求模型。"""
        config, tagging = self.snapshot()
        catalog = self.repo.catalog_version()
        try:
            created = self.repo.register_from_events(
                settings_version=config['version'], tagging_enabled=bool(tagging['enabled']),
                catalog_version=catalog, mode=tagging['mode'],
                enabled_since=tagging.get('enabledSince'))
        except Exception:
            LOG.exception('Registering auto-tagging tasks failed')
            return
        if created:
            self.emit('tagging.changed', {'registered': len(created)})

    async def _run_once(self):
        """一轮：推进事件 → 认领一个任务 → 执行 → 落库。"""
        if self.closing:
            return
        self.repo.promote_due()
        self._register()
        task = self.repo.next_task()
        if task is None:
            return
        self.running_task_id = task['id']
        try:
            await self._execute(task)
        except Exception:
            LOG.exception('Auto-tagging task %s failed unexpectedly', task['id'])
            self.repo.retry_wait(task['id'], code='internal_error', message='后台任务执行异常，请重试')

    async def _execute(self, task):
        """执行单个任务。认证/配置缺失进阻塞，其余可重试错误走有限退避。"""
        config, tagging = self.snapshot()
        catalog = self.repo.catalog_version()

        if not tagging['enabled']:
            # 关闭期间的在途任务：暂停而不是继续请求模型（§3.5 第 4 条）。
            self.repo.finish(task['id'], CANCELLED_STATE, skipped_reason='自动打标已关闭')
            return
        # 配置或目录已经变化：标记过期并以当前版本重新排队，避免写旧快照结果。
        # force=True：这条任务正由本 worker 持有租约（状态是 running），
        # 不加这个标志会被「已在队列中」的并发保护挡掉，任务将永远卡在 running。
        if task['config_version'] != config['version'] or task['catalog_version'] != catalog:
            self.repo.rerun(task['id'], config_version=config['version'],
                            catalog_version=catalog, mode=tagging['mode'], force=True)
            self.emit('tagging.changed', {'requeued': task['id']})
            return

        content = self.tags.get_content(task['content_id'])
        if content is None:
            self.repo.finish(task['id'], CANCELLED_STATE, skipped_reason='内容已删除')
            return

        directory = self.repo.enabled_tags()
        if not directory:
            # 空标签目录直接跳过，不调用模型，也不生成新标签（§3.3）。
            self.repo.finish(task['id'], 'skipped', skipped_reason='没有可用于自动分类的已启用标签')
            return

        request = self._request_for(task, content, [CandidateTag.from_dict(tag) for tag in directory])
        if not request.has_enough_text():
            self.repo.finish(task['id'], 'skipped', skipped_reason='标题与正文过短，不足以判断')
            return

        try:
            provider = self._provider_for(tagging)
        except RecognitionError as error:
            self.repo.block(task['id'], code=error.code, message=error.message)
            self.emit('tagging.changed', {'blocked': task['id']})
            return

        try:
            # 模型请求在执行器里跑：Core 事件循环不能被同步 SDK 卡住。
            result = await asyncio.get_running_loop().run_in_executor(
                None, provider.recognize, request)
        except RecognitionError as error:
            if error.code in (ERROR_AUTH, ERROR_NOT_CONFIGURED):
                self.repo.block(task['id'], code=error.code, message=error.message)
                self.emit('tagging.changed', {'blocked': task['id']})
            elif error.code == ERROR_RATE_LIMITED or error.retryable:
                self.repo.retry_wait(task['id'], code=error.code, message=error.message)
                self.emit('tagging.changed', {'retry': task['id']})
            else:
                # 非法响应不触发兜底，也不重试：同样的输入再来一次不会变好。
                self.repo.finish(task['id'], 'failed', error_code=error.code, error_message=error.message)
                self.emit('tagging.changed', {'failed': task['id']})
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            LOG.exception('Provider call failed for task %s', task['id'])
            self.repo.retry_wait(task['id'], code='network_failed', message='调用识别接口失败')
            return

        self.repo.renew_lease(task['id'])
        if result.status == STATUS_INSUFFICIENT_TEXT:
            self.repo.finish(task['id'], 'skipped', provider=result.provider, model=result.model,
                             skipped_reason='文本过短，不足以判断')
            return
        if result.status == STATUS_NO_MATCH or not result.candidates:
            # 空匹配是正常结果，不是失败：明确的内容不该被硬塞一个标签。
            self.repo.finish(task['id'], 'succeeded', provider=result.provider, model=result.model,
                             applied_count=0)
            self.emit('tagging.changed', {'succeeded': task['id']})
            return

        applied, new_names = self._resolve(result, directory)
        outcome = self.repo.apply_result(
            task['id'], applied_tag_ids=applied, new_tags=new_names,
            expected_content_version=task['content_version'], catalog_version=catalog)
        if outcome['outcome'] in ('succeeded',) and outcome['applied']:
            # 只在提交成功后通知界面（§3.6）。
            self.emit('content.changed', {'ids': [task['content_id']]})
            self.emit('tags.changed', {'ids': applied})
        if outcome.get('created'):
            self.emit('tags.changed', {'created': outcome['created']})
        self.emit('tagging.changed', {'completed': task['id'], 'outcome': outcome['outcome']})

    async def _loop(self):
        while not self.closing:
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                LOG.exception('Auto-tagging worker iteration failed')
            await asyncio.sleep(POLL_SECONDS)

    def start(self):
        if self.workers:
            return
        # 重启恢复：回收崩溃留下的运行租约，并让被阻塞任务在配置修好后重排。
        try:
            recovered = self.repo.recover_stale_tasks()
            self.repo.unblock_all()
            if recovered:
                self.emit('tagging.changed', {'recovered': recovered})
        except Exception:
            LOG.exception('Recovering auto-tagging tasks failed')
        for index in range(MAX_ACTIVE):
            self.workers.append(asyncio.create_task(self._loop(), name=f'tagging-{index}'))

    async def close(self):
        """有界退出：停循环、等在途任务收尾，不无限等待模型请求。"""
        self.closing = True
        for worker in self.workers:
            worker.cancel()
        if self.workers:
            await asyncio.gather(*self.workers, return_exceptions=True)
        self.workers = []
        # 在途任务退回队列，重启后可恢复，不留在假运行状态。
        if self.running_task_id:
            try:
                self.repo.recover_stale_tasks()
            except Exception:
                LOG.exception('Releasing in-flight auto-tagging task failed')

    def on_settings_changed(self):
        """设置保存后立即生效：配置版本一变，旧任务按新版本重排。"""
        try:
            self.repo.unblock_all()
        except Exception:
            LOG.exception('Unblocking auto-tagging tasks failed')

    # ------------------------------------------------------------ 界面入口

    def status(self):
        return {'summary': self.repo.summary(), 'recent': self.repo.list_tasks(limit=20)['items']}

    def tasks(self, states=None, limit=50, offset=0):
        return self.repo.list_tasks(states=states, limit=limit, offset=offset)

    def retry(self, task_id):
        config, tagging = self.snapshot()
        if not tagging['enabled']:
            raise ChannelError('NOT_CONFIGURED', 'tagging.retry', '自动打标已关闭，无法重试')
        result = self.repo.rerun(task_id, config_version=config['version'],
                                 catalog_version=self.repo.catalog_version(),
                                 mode=tagging['mode'])
        self.emit('tagging.changed', {'retry': task_id})
        return result

    def backfill_preview(self, since=None, limit=200):
        config, tagging = self.snapshot()
        preview = self.repo.backfill_preview(since=since, limit=limit,
                                             enabled_since=tagging.get('enabledSince'))
        preview['mode'] = tagging['mode']
        preview['configVersion'] = config['version']
        preview['enabled'] = bool(tagging['enabled'])
        return preview

    def backfill(self, item_ids=None, limit=200):
        """用户主动补打。没有指定内容时，对预览范围内的内容排队。"""
        config, tagging = self.snapshot()
        if not tagging['enabled']:
            raise ChannelError('NOT_CONFIGURED', 'tagging.backfill', '自动打标已关闭，无法补打')
        if not item_ids:
            preview = self.repo.backfill_preview(limit=limit,
                                                 enabled_since=tagging.get('enabledSince'))
            item_ids = [row['id'] for row in self.repo.backfill_preview(
                limit=limit, enabled_since=tagging.get('enabledSince'))['items']]
        result = self.repo.enqueue_backfill(item_ids, config_version=config['version'],
                                            catalog_version=self.repo.catalog_version(),
                                            mode=tagging['mode'], limit=limit)
        self.emit('tagging.changed', {'backfilled': result['queued']})
        return result


CANCELLED_STATE = 'cancelled'
