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

from subscribe_flow.ai.gateway import AiGateway
from subscribe_flow.contracts import ChannelError
from subscribe_flow.contracts.tags import AUTO_TAG_LIMIT
from subscribe_flow.storage.repositories import now

from tagging_engine import build_provider
from tagging_engine.contracts import (
    ERROR_AUTH, ERROR_NOT_CONFIGURED, ERROR_RATE_LIMITED, CandidateTag,
    RecognitionError, RecognitionRequest, STATUS_INSUFFICIENT_TEXT, STATUS_MATCHED,
    STATUS_NO_MATCH, MAX_CANDIDATES, check_llm_candidates, rank_candidates,
)

LOG = logging.getLogger(__name__)

# 后台同时执行的模型请求数。更高会让延迟抖动，也更容易触发限流。
MAX_ACTIVE = 2
# 一轮轮询间隔。事件表才是恢复依据，这个只决定响应快慢。
POLL_SECONDS = 2.0


class TaggingService:
    def __init__(self, *, repository, tags_repository, settings, credentials, emit, clock=None,
                 gateway=None):
        self.repo = repository              # TaggingRepository：事件与任务
        self.tags = tags_repository         # Repository：内容、标签与事务
        self.settings = settings            # SettingsService
        self.credentials = credentials      # CredentialBroker（只在内存里有明文）
        # 公共 AI 层：连接的解析、凭据组装与协议探针都在那边。
        # 打标只负责「怎么用这条连接打标签」，不自己造连接。
        # 优先用 Core 注入的同一个网关，避免各处各建一份、各自看到不同的连接。
        self.gateway = gateway or AiGateway(settings=settings, credentials=credentials)
        self.emit = emit
        self.clock = clock or (lambda: now())
        self.workers: list[asyncio.Task] = []
        self.closing = False
        self.running_task_id: str | None = None
        # 上一轮读到的配置版本：用来发现用户保存了设置（含主进程推进凭据后
        # 提交的引用），从而让被阻塞的任务自动恢复。None 表示还没读过。
        self._seen_config_version = None

    # ------------------------------------------------------------ 组装

    def snapshot(self):
        """当前配置版本与生效状态。每次组装前重新读，不缓存快照。

        M25：连接在 ``ai.providers`` 里按稳定 ID 组织，识别策略在 ``tagging``。
        这里把两者合成识别服务要的形状，调用方不必知道配置被拆成了两个分区。
        """
        config = self.settings.snapshot()
        tagging = dict(config['tagging'])
        tagging['providers'] = dict(config['ai']['providers'])
        return config, tagging

    def _provider_for(self, mode, providers):
        """按当前方式选中的连接组装标签 Provider。

        连接是哪一条由策略决定（``tagging.providerIds``）；凭据组装与协议往返
        交给公共 AI 层，这里只把「这条连接怎么用」翻译成标签业务要的形状。
        """
        provider_id = (self._provider_ids() or {}).get(mode)
        provider = (providers or {}).get(provider_id)
        if not provider:
            raise RecognitionError(ERROR_NOT_CONFIGURED, f'自动打标没有可用的连接（{mode}）')
        missing = [label for key, label in (('endpoint', '接口地址'), ('model', '模型标识'))
                   if not provider.get(key)]
        if missing:
            raise RecognitionError(ERROR_NOT_CONFIGURED,
                                   '自动打标尚未配置完整：' + '、'.join(missing))
        # 密钥只在公共层组装：明文不进这里，也不进日志。
        adapter = self.gateway.adapter(provider_id)
        return build_provider(mode, adapter=adapter, model=provider.get('model') or '')

    def _provider_ids(self):
        """打标策略当前引用哪些连接。"""
        return self.settings.snapshot()['tagging'].get('providerIds') or {}

    async def test_connection(self, mode=None):
        """兼容入口：连接测试已经由公共 AI 层承担。

        M25：测试连接属于独立 AI 层——用协议最小固定探针，不执行真实内容打标，
        也不产生任何标签。这里保留代理入口，设置页不再依赖它。
        """
        config, tagging = self.snapshot()
        target = mode or tagging['mode']
        if target not in ('jev', 'llm'):
            return {'ok': False, 'code': 'invalid_input',
                    'message': '不支持的识别方式。', 'retryable': False}
        provider_id = (tagging.get('providerIds') or {}).get(target)
        if not provider_id:
            return {'ok': False, 'code': ERROR_NOT_CONFIGURED,
                    'message': '自动打标没有可用的连接。', 'retryable': False}
        return self.gateway.test_connection(provider_id)

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
    def _resolve(result, directory, mode):
        """识别结果 → (已有标签 ID, 带说明的新标签, 已有标签待补齐的说明)。

        按计划 §3.4：先按现有名称/明确别名复用；Jev 不允许新建（引擎已保证）。
        目录里没有的 ID 一律丢弃——模型不能凭空指认一个不存在的标签。
        """
        by_id = {tag['id']: tag for tag in directory}
        candidates = result.candidates
        if mode == 'llm':
            # 再守住业务边界：替换 Provider 也不能绕过数量与新标签说明约束。
            try:
                candidates = check_llm_candidates(
                    [candidate.to_dict() for candidate in candidates],
                    catalogue=tuple(CandidateTag.from_dict(tag) for tag in directory),
                    limit=AUTO_TAG_LIMIT)
            except ValueError as error:
                raise RecognitionError('invalid_response', f'模型返回的标签不符合约定：{error}',
                                       retryable=False) from None
        applied, new_tags, descriptions, seen = [], [], {}, set()
        for candidate in rank_candidates(candidates):
            if len(applied) + len(new_tags) >= AUTO_TAG_LIMIT:
                break
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
                if mode == 'llm' and not (tag.get('description') or '').strip():
                    descriptions[tag['id']] = candidate.description
                continue
            if mode != 'llm':
                continue
            name = (candidate.name or '').strip()
            if not name:
                continue
            key = ('name', name.casefold())
            if key in seen:
                continue
            seen.add(key)
            new_tags.append({'name': name, 'description': candidate.description})
        return applied, new_tags, descriptions

    # ------------------------------------------------------------ 后台任务

    def _register(self):
        """把持久事件推进成任务。关闭期间的事件照常消费但不请求模型。"""
        config, tagging = self.snapshot()
        catalog = self.repo.catalog_version()
        try:
            created = self.repo.register_from_events(
                config_version=config['tagging']['revision'], tagging_enabled=bool(tagging['enabled']),
                catalog_version=catalog, mode=tagging['mode'],
                enabled_since=tagging.get('enabledSince'))
        except Exception:
            LOG.exception('Registering auto-tagging tasks failed')
            return
        if created:
            self.emit('tagging.changed', {'registered': len(created)})

    def _notice_config_change(self):
        """设置或凭据变化后让后台任务跟着变，不要求重启也不要求用户手工操作。

        worker 本身就每轮读一次最新设置，因此以「设置版本 + 凭据代次」为界判断
        是否变化最可靠：用户在设置页保存配置会让版本前进，Core 重启后主进程
        重新推送密钥只会让凭据代次前进（设置版本不变）。两者都要看，否则
        被认证/配置缺失阻塞的任务会永远停在 blocked。
        """
        config, _ = self.snapshot()
        stamp = (config['tagging']['revision'], self.credentials.generation)
        if self._seen_config_version is None:
            self._seen_config_version = stamp
            return False
        if stamp == self._seen_config_version:
            return False
        self._seen_config_version = stamp
        try:
            released = self.repo.unblock_all()
        except Exception:
            LOG.exception('Releasing blocked auto-tagging tasks failed')
            return False
        if released:
            self.emit('tagging.changed', {'released': released})
        return True

    async def _run_once(self):
        """一轮：推进事件 → 认领一个任务 → 执行 → 落库。"""
        if self.closing:
            return
        # 过期租约每轮回收：崩溃或异常残留的 running 任务到点就重新可执行，
        # 否则它们会永远滞留，worker 自己却以为队列已空。
        try:
            recovered = self.repo.recover_stale_tasks()
        except Exception:
            LOG.exception('Recovering stale auto-tagging tasks failed')
        else:
            if recovered:
                self.emit('tagging.changed', {'recovered': recovered})
        self._notice_config_change()
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
        if task['config_version'] != config['tagging']['revision'] or task['catalog_version'] != catalog:
            self.repo.rerun(task['id'], config_version=config['tagging']['revision'],
                            catalog_version=catalog, mode=tagging['mode'], force=True)
            self.emit('tagging.changed', {'requeued': task['id']})
            return

        content = self.tags.get_content(task['content_id'])
        if content is None:
            self.repo.finish(task['id'], CANCELLED_STATE, skipped_reason='内容已删除')
            return

        directory = self.repo.enabled_tags()
        if not directory and task['mode'] == 'jev':
            # 只有 Jev 受这条限制：它只能在已有标签里选，空目录无事可做，
            # 调模型既拿不到候选也造不出新标签（计划 §3.3）。
            # LLM 空目录仍要调用——新用户的第一批标签正是这样产生的（§3.4）。
            self.repo.finish(task['id'], 'skipped', skipped_reason='没有可用于自动分类的已启用标签')
            return

        request = self._request_for(task, content, [CandidateTag.from_dict(tag) for tag in directory])
        if not request.has_enough_text():
            self.repo.finish(task['id'], 'skipped', skipped_reason='标题与正文过短，不足以判断')
            return

        try:
            provider = self._provider_for(task['mode'], tagging['providers'])
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
        # 写回前必须按当前配置再核一次。只在请求开始处检查是不够的：
        # 用户可能在模型返回之前就关掉开关或换掉凭据，那时这条结果已经过期，
        # 落库就等于用旧配置的决定覆盖用户当前的选择。
        current, current_tagging = self.snapshot()
        if not current_tagging['enabled']:
            self.repo.finish(task['id'], CANCELLED_STATE, skipped_reason='自动打标在识别期间已关闭')
            return
        if current['tagging']['revision'] != task['config_version']:
            # 配置已变（模式或凭据引用不同）：按当前版本重排，不写旧快照结果。
            # 比较与重排都用打标的有效配置版本（tagging.revision），
            # 不能用设置的保存计数：保存计数会被无关保存推进，
            # 那会让在途结果被根本没碰过识别配置的保存作废。
            self.repo.rerun(task['id'], config_version=current['tagging']['revision'],
                            catalog_version=catalog, mode=current_tagging['mode'], force=True)
            self.emit('tagging.changed', {'requeued': task['id']})
            return
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

        try:
            applied, new_tags, descriptions = self._resolve(result, directory, task['mode'])
        except RecognitionError as error:
            self.repo.finish(task['id'], 'failed', error_code=error.code, error_message=error.message)
            self.emit('tagging.changed', {'failed': task['id']})
            return
        # 不再传请求开始时的目录快照：写回边界按数据库当前目录复核（BUG-095）。
        outcome = self.repo.apply_result(
            task['id'], applied_tag_ids=applied, new_tags=new_tags,
            expected_content_version=task['content_version'], tag_descriptions=descriptions)
        if outcome['outcome'] in ('succeeded',) and outcome['applied']:
            # 只在提交成功后通知界面（§3.6）。
            self.emit('content.changed', {'ids': [task['content_id']]})
            self.emit('tags.changed', {'ids': applied})
        if outcome.get('created'):
            self.emit('tags.changed', {'created': outcome['created']})
        if outcome.get('described'):
            self.emit('tags.changed', {'ids': outcome['described']})
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
        # 退出这一刻所有 running 任务都属于本进程（数据库由 CoreLease 单进程独占），
        # 无论是否被本进程认领，都必须显式退回队列：它们租约未到期，
        # 若只回收「已过期」，重启后既认领不了也等不到过期。
        try:
            self.repo.release_running_tasks()
        except Exception:
            LOG.exception('Releasing in-flight auto-tagging tasks failed')

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
        result = self.repo.rerun(task_id, config_version=config['tagging']['revision'],
                                 catalog_version=self.repo.catalog_version(),
                                 mode=tagging['mode'])
        self.emit('tagging.changed', {'retry': task_id})
        return result

    def backfill_preview(self, since=None, limit=200):
        config, tagging = self.snapshot()
        # 不传 enabled_since：用户主动补打必须覆盖开关关闭/开启前收录的内容。
        preview = self.repo.backfill_preview(since=since, limit=limit)
        preview['mode'] = tagging['mode']
        preview['configVersion'] = config['tagging']['revision']
        preview['enabled'] = bool(tagging['enabled'])
        return preview

    def backfill(self, item_ids=None, limit=200):
        """用户主动补打。没有指定内容时，对预览范围内的内容排队。

        执行范围必须与刚刚展示的预览同源：否则界面写着 60 条、实际只排队一部分，
        用户无法判断哪些内容真的被打标过。
        """
        config, tagging = self.snapshot()
        if not tagging['enabled']:
            raise ChannelError('NOT_CONFIGURED', 'tagging.backfill', '自动打标已关闭，无法补打')
        if not item_ids:
            preview = self.repo.backfill_preview(limit=limit)
            item_ids = preview['itemIds']
        result = self.repo.enqueue_backfill(item_ids, config_version=config['tagging']['revision'],
                                            catalog_version=self.repo.catalog_version(),
                                            mode=tagging['mode'], limit=limit)
        self.emit('tagging.changed', {'backfilled': result['queued']})
        return result


CANCELLED_STATE = 'cancelled'
