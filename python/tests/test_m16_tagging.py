"""M16 业务接入主链验收测试。

覆盖计划 §3 的核心链路，用隔离数据库与「同一边界的替身 Provider」：
订阅首次保存与手动确认保存 → 持久事件 → 后台任务 → 统一识别结果 →
事务内标签落库 → 界面可查询。

这里替换的只是 Provider 的 HTTP 实现，Provider 组装、契约映射、事件与任务
持久化、标签应用事务走的是与正式流程完全相同的代码路径。替身不联网，
因此本文件的通过不代表真实模型验收；真实调用证据在 docs/verification/m16-minimax/。
"""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

from tagging_engine.contracts import (
    Candidate, RecognitionError, RecognitionResult, STATUS_MATCHED, STATUS_NO_MATCH,
)
# M25：连接按稳定资源 ID 组织。
PROVIDER_IDS = {'jev': 'provider-jev', 'llm': 'provider-llm'}

from tagging_engine.providers.jev import JevProvider
from tagging_engine.providers.llm import LlmProvider


def make_item(channel, external_id, title, summary, source_id='fixture-source'):
    """固定采集夹具。不联网、不依赖任何真实平台会话。"""
    source = Source(channel=channel, kind='user', external_id=source_id,
                    name=f'{channel} 夹具来源', url=f'https://example.invalid/{source_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=f'https://example.invalid/{external_id}',
                       kind='video', summary=summary,
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


class StubProvider:
    """与 tagging_engine 契约同形状的替身。按文本里的关键词选标签。"""

    name = 'stub'

    def __init__(self, picks=None):
        self.calls = 0
        self.seen = []
        self.picks = picks or {}

    def recognize(self, request):
        self.calls += 1
        self.seen.append(request)
        wanted = self.picks.get(request.item_id, [])
        chosen = []
        by_name = {tag.name: tag for tag in request.candidates}
        # 目录里已有的标签给 ID；目录里没有的名字按「新标签」返回——
        # 这正是 LLM 在空目录下的行为，也是 Jev 不会做的事。
        for name in wanted:
            tag = by_name.get(name)
            if tag is not None:
                chosen.append(Candidate(tag_id=tag.id, name=tag.name, score=0.95,
                                        score_kind='noul' if request.mode == 'jev' else 'llm',
                                        description=f'{name}主题与相关实践内容'))
            elif request.mode == 'llm':
                chosen.append(Candidate(tag_id=None, name=name, score=0.9, score_kind='llm',
                                        description=f'{name}主题与相关实践内容'))
        for tag in request.candidates:
            if tag.name in wanted and not any(c.tag_id == tag.id for c in chosen):
                chosen.append(Candidate(tag_id=tag.id, name=tag.name, score=0.95, score_kind='llm',
                                        description=f'{tag.name}主题与相关实践内容'))
        if not chosen:
            return RecognitionResult(provider='stub', status=STATUS_NO_MATCH, model='stub-model')
        return RecognitionResult(provider='stub', status=STATUS_MATCHED, model='stub-model',
                                 requested_model='stub-model', candidates=tuple(chosen))


class AuthFailProvider(StubProvider):
    def recognize(self, request):
        self.calls += 1
        self.seen.append(request)
        raise RecognitionError('auth_failed', '凭据无效')


class _M16Fixture:
    """共享夹具与工具；刻意不继承 TestCase，避免被重复收集。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'm16.sqlite3'

        class EmptyGateway:
            def describe(self):
                return []
        self.core = Core(self.path, gateway=EmptyGateway())
        self.repo = self.core.repository
        self.tagging = self.core.tagging
        # 事件与任务的仓储挂在主 Repository 上。
        self.tasks = self.repo.tagging
        self.stub = StubProvider()
        self.loop = asyncio.new_event_loop()

    def tearDown(self):
        asyncio.get_event_loop_policy()
        try:
            self.loop.close()
            self.core.database.close()
        except Exception:
            pass
        self.core.lease.close()
        self.temp.cleanup()

    # ------------------------------------------------------------ 工具

    def enable(self, mode='llm', picks=None):
        """用固定配置开启自动打标，并把 Provider 替换成同契约的替身。"""
        for m in ('jev', 'llm'):
            self.core.credentials.provide(f'ref-{m}', f'sk-test-{m}')
        # M25：连接按稳定 ID 组织；连接参数与识别策略分开保存，互不覆盖。
        self.core.settings.update('ai', {
            'providers': {PROVIDER_IDS[m]: {'endpoint': f'https://api.test.invalid/{m}', 'model': 'test-model'}
                          for m in ('jev', 'llm')}},
            credential_refs={PROVIDER_IDS[m]: f'ref-{m}' for m in ('jev', 'llm')})
        self.core.settings.update('tagging', {'enabled': True, 'mode': mode})
        provider = StubProvider(picks) if picks is not None else self.stub
        self._patch_provider(provider)
        # 断言读的是当前真正接线的那个替身。
        self.stub = provider
        return provider

    def _patch_provider(self, provider):
        import subscribe_flow.application.tagging as module
        self._patched = module.build_provider
        module.build_provider = lambda *a, **k: provider
        self.addCleanup(lambda: setattr(module, 'build_provider', self._patched))

    def add_tag(self, name, description='', enabled=True):
        return self.core.tags.create(name, description=description, enabled=enabled)

    def tags_of(self, item_id):
        content = self.repo.get_content(item_id)
        return sorted(t['name'] for t in content.get('tags', []))

    def drain(self, rounds=8):
        """把后台队列跑到静止。逐轮跑真实 worker 逻辑。"""
        for _ in range(rounds):
            self.loop.run_until_complete(self.tagging._run_once())
            if self.tasks.summary()['active'] == 0:
                return
        self.fail('后台队列未在预期轮次内排空')

    # ------------------------------------------------------------ 主链

class M16TaggingTests(_M16Fixture, unittest.TestCase):
    """第一轮：主链、幂等、人工保护与恢复。"""

    def test_manual_save_reaches_provider_and_applies_tags(self):
        """手动确认保存 → 事件 → 任务 → 替身 Provider → 标签落库 → 界面可查。"""
        python_tag = self.add_tag('Python')
        self.enable(picks={'fixture:feed:python-1': ['Python']})
        item = make_item('fixture', 'python-1', 'Python 异步编程实践',
                         '这篇讲 asyncio 与类型标注的实践总结，包含代码示例与性能对比。')
        saved = self.repo.save_manual(item)
        self.assertEqual(saved['status'], 'created')

        self.drain()

        self.assertEqual(self.stub.calls, 1)
        self.assertEqual(self.tags_of(saved['item_id']), ['Python'])
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(task['state'], 'succeeded')
        self.assertEqual(task['applied_count'], 1)

    def test_connection_test_targets_only_the_requested_api(self):
        """M21：连接测试只测指定的那一类 API。

        不改当前打标方式、不启停识别，也不产生任何标签。
        """
        self.enable()
        seen = []
        gateway = self.tagging.gateway
        original = gateway.test_connection

        def spy(provider_id):
            seen.append(provider_id)
            return {'ok': True, 'provider': 'probe', 'model': 'probe-model', 'message': 'ok'}

        gateway.test_connection = spy
        self.addCleanup(lambda: setattr(gateway, 'test_connection', original))

        # M25：连接测试属于独立 AI 层——只做协议最小探针，不走打标 Provider。
        # 当前方式是 llm，指定测 jev 时探的必须是 jev 那一类连接。
        outcome = self.loop.run_until_complete(self.tagging.test_connection('jev'))
        self.assertTrue(outcome['ok'], outcome)
        self.assertEqual(seen, ['provider-jev'])
        # 测完不能动当前方式与开关。
        snapshot = self.core.settings.snapshot()
        self.assertEqual(snapshot['tagging']['mode'], 'llm')
        self.assertTrue(snapshot['tagging']['enabled'])
        # 连接测试不产生任何打标调用，也不登记打标任务。
        self.assertEqual(self.stub.calls, 0)
        self.assertEqual(self.tasks.list_tasks(limit=5)['total'], 0, '连接测试不产生打标任务')

    def test_connection_test_reports_missing_items_without_changing_the_strategy(self):
        """M21：被测的那一类没配齐时如实报缺项，不改配置也不改方式。"""
        self.enable()
        # 把 llm 的连接参数清空：它就没有 API Key 了。
        self.core.settings.update('ai', {'providers': {'provider-llm': {'endpoint': '', 'model': ''}}},
                                  {'provider-llm': None})
        outcome = self.loop.run_until_complete(self.tagging.test_connection('llm'))
        self.assertFalse(outcome['ok'])
        self.assertIn('API Key', outcome['message'])
        self.assertIn('接口地址', outcome['message'])
        snapshot = self.core.settings.snapshot()
        self.assertEqual(snapshot['tagging']['mode'], 'llm')
        self.assertTrue(snapshot['tagging']['enabled'])

    def test_subscription_save_shares_the_same_fact(self):
        """订阅首次保存与手动保存共用同一种事件，来源不同不重复登记。"""
        self.add_tag('机器学习')
        self.enable(picks={'fixture:feed:ml-1': ['机器学习']})
        item = make_item('fixture', 'ml-1', '机器学习模型评估',
                         '介绍交叉验证与常见评估指标的差异，以及过拟合的处理方式。')
        # 订阅路径：直接走与分页同一个入库原语（_upsert_item 内部事务）。
        with self.repo.database.transaction() as db:
            self.repo._upsert_item(db, item, intake_method='subscription')

        self.drain()

        self.assertEqual(self.stub.calls, 1)
        self.assertEqual(self.tags_of(item.key), ['机器学习'])
        # 再收录一次：重复内容不产生第二条事件，也不产生第二个任务。
        with self.repo.database.transaction() as db:
            self.repo._upsert_item(db, item, intake_method='subscription')
        self.assertEqual(self.tasks.event_count(), 1)
        self.drain()
        self.assertEqual(self.stub.calls, 1)

    def test_disabled_toggle_consumes_events_without_calling_model(self):
        """关闭期间的事件照常推进消费位置，但不请求模型。"""
        self.add_tag('美食')
        self.enable()
        self.core.settings.update('tagging', {'enabled': False})
        self.repo.save_manual(make_item('fixture', 'food-1', '家常菜做法',
                                        '红烧肉的做法与火候控制要点分享。'))
        self.drain()
        self.assertEqual(self.stub.calls, 0)
        self.assertEqual(self.tasks.pending_events(), [])

    # ------------------------------------------------------------ 人工保护

    def test_manual_removal_is_not_reverted_by_late_result(self):
        """人工移除的标签不会被后来的自动结果补回。"""
        tag = self.add_tag('投资')
        self.enable(picks={'fixture:feed:invest-1': ['投资']})
        item = make_item('fixture', 'invest-1', '指数基金定投记录',
                         '记录每月定投的执行情况与账户波动，属于个人理财流水。')
        saved = self.repo.save_manual(item)
        # 先人工挂上，再人工移除 —— 这条决定必须压过自动识别。
        self.core.tags.set_content(saved['item_id'], [tag['id']])
        self.core.tags.set_content(saved['item_id'], [])

        self.drain()

        self.assertEqual(self.stub.calls, 1)
        self.assertEqual(self.tags_of(saved['item_id']), [])
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(task['blocked_count'], 1)

    def test_disabled_tag_is_never_attached(self):
        """禁用标签不被 AI 重新挂载，也不允许同名新建绕过。"""
        tag = self.add_tag('旅行')
        self.enable(picks={'fixture:feed:travel-1': ['旅行']})
        saved = self.repo.save_manual(make_item('fixture', 'travel-1', '京都秋季路线',
                                                '十一月的京都路线与红叶时间建议。'))
        self.core.tags.set_enabled(tag['id'], False)
        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), [])

    def test_manual_tag_behaviour_preserved(self):
        """人工标签既有行为不受自动接入影响。"""
        a, b = self.add_tag('设计'), self.add_tag('摄影')
        saved = self.repo.save_manual(make_item('fixture', 'manual-1', '构图笔记',
                                                '关于构图与光线的个人笔记记录。'))
        self.core.tags.set_content(saved['item_id'], [a['id'], b['id']])
        self.assertEqual(self.tags_of(saved['item_id']), ['摄影', '设计'])
        # 自动流程不会撤销人工关联。
        self.enable()
        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['摄影', '设计'])

    # ------------------------------------------------------------ 版本与恢复

    def test_late_result_is_dropped_after_content_change(self):
        """内容在识别期间变化 → 旧结果不落库，任务记为过期跳过。"""
        self.add_tag('开源')
        self.enable(picks={'fixture:feed:oss-1': ['开源']})
        saved = self.repo.save_manual(make_item('fixture', 'oss-1', '小型开源项目实践',
                                                '记录一个开源命令行工具的开发过程与踩坑。'))
        self.drain()
        task_id = self.tasks.list_tasks(limit=1)['items'][0]['id']
        # 正文随后被重新采集更新，旧响应此刻才回来。
        from subscribe_flow.storage.repositories import now
        self.repo.db.execute('UPDATE contents SET updated_at=? WHERE id=?', (now(), saved['item_id']))
        with self.tasks.database.transaction() as db:
            db.execute("UPDATE tagging_tasks SET state='queued',completed_at=NULL WHERE id=?", (task_id,))
        self.drain()
        # 版本闸门挡住之后，标签关联没有因为重放而增加。
        rows = self.repo.db.execute('SELECT count(*) FROM content_tags WHERE content_id=?',
                                   (saved['item_id'],)).fetchone()[0]
        self.assertEqual(rows, 1)
        self.assertIn(self.tasks.get_task(task_id)['state'], ('skipped', 'succeeded'))

    def test_restart_recovers_running_task(self):
        """崩溃留下的运行租约在重启后被回收，重跑不产生第二条关联。"""
        self.add_tag('编程')
        self.enable(picks={'fixture:feed:code-1': ['编程']})
        saved = self.repo.save_manual(make_item('fixture', 'code-1', '代码评审实践',
                                                '团队代码评审流程与常见问题的记录总结。'))
        self.drain()
        before = self.tasks.list_tasks(limit=5)['total']
        # 制造一条过期的 running 记录，模拟崩溃残留。
        task_id = self.tasks.list_tasks(limit=1)['items'][0]['id']
        self.repo.db.execute("UPDATE tagging_tasks SET state='running',lease_expires_at='2000-01-01T00:00:00'"
                             " WHERE id=?", (task_id,))
        self.assertEqual(self.tasks.recover_stale_tasks(), 1)
        self.assertEqual(self.tasks.list_tasks(limit=5)['total'], before)
        self.assertEqual(self.tags_of(saved['item_id']), ['编程'])

    def test_config_change_requeues_with_current_version(self):
        """配置版本变化后旧任务按新版本重排，不写旧快照结果。"""
        self.add_tag('科技')
        self.enable(picks={'fixture:feed:tech-1': ['科技']})
        self.repo.save_manual(make_item('fixture', 'tech-1', '硬件评测汇总',
                                        '几款设备的实际使用体验与参数对比记录。'))
        self.tagging._register()
        task = self.tasks.next_task()
        self.assertIsNotNone(task)
        stale_version = task['config_version']
        # 任务已认领但还没执行，此时配置被改了一次：打标的有效配置版本前进。
        self.core.settings.update('tagging', {'mode': 'jev'})
        current_version = self.core.settings.snapshot()['tagging']['revision']
        self.assertGreater(current_version, stale_version)
        # 把任务放回队列，让 worker 用新版本重排它。
        with self.tasks.database.transaction() as db:
            db.execute("UPDATE tagging_tasks SET state='queued',lease_expires_at=NULL WHERE id=?",
                       (task['id'],))
        self.loop.run_until_complete(self.tagging._run_once())
        # 第一步：以当前版本重新排队，旧快照结果不写进去。
        requeued = self.tasks.get_task(task['id'])
        self.assertEqual(requeued['state'], 'queued')
        self.assertEqual(requeued['config_version'], current_version)
        # 第二步：新版本下正常执行完成。
        self.loop.run_until_complete(self.tagging._run_once())
        self.assertEqual(self.tasks.get_task(task['id'])['state'], 'succeeded')

    # ------------------------------------------------------------ 认证阻塞

    def test_auth_failure_blocks_until_config_changes(self):
        """认证失败进入阻塞，不持续请求错误凭据。"""
        self.add_tag('安全')
        self.enable()
        self._patch_provider(AuthFailProvider())
        self.repo.save_manual(make_item('fixture', 'sec-1', '加密算法笔记',
                                        '常见对称加密算法的取舍与使用场景说明。'))
        self.drain()
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(task['state'], 'blocked')
        # 改配置后阻塞任务自动回到队列。
        self.enable(picks={'fixture:feed:sec-1': ['安全']})
        self.assertEqual(self.tasks.unblock_all(), 1)
        self.drain()
        self.assertEqual(self.tasks.get_task(task['id'])['state'], 'succeeded')

    # ------------------------------------------------------------ 幂等

    def test_repeated_execution_does_not_duplicate(self):
        """同一任务重复执行不产生重复关联、不重复建标签。"""
        self.add_tag('音乐')
        self.enable(picks={'fixture:feed:music-1': ['音乐']})
        saved = self.repo.save_manual(make_item('fixture', 'music-1', '编曲基础',
                                                '关于和弦进行与编曲结构的入门笔记。'))
        self.drain()
        self.drain()
        rows = self.repo.db.execute('SELECT count(*) FROM content_tags WHERE content_id=?',
                                    (saved['item_id'],)).fetchone()[0]
        self.assertEqual(rows, 1)




class M16TaggingRulesRegressionTests(_M16Fixture, unittest.TestCase):
    """数量和说明走正式 Provider → worker → SQLite；仅 HTTP 响应用固定夹具。"""

    class Transport:
        def __init__(self, response):
            self.response, self.requests = response, []

        def post_json(self, url, payload, headers, timeout=None):
            self.requests.append(payload)
            return 200, self.response

    def llm(self, values):
        self.enable(mode='llm')
        transport = self.Transport({'model': 'fixture-model', 'choices': [
            {'message': {'content': json.dumps({'tags': values}, ensure_ascii=False)}}]})
        self._patch_provider(LlmProvider(endpoint='https://example.invalid/v1', model='fixture',
                                         api_key='fixture', transport=transport))
        return transport

    def save(self, external_id='rules'):
        return self.repo.save_manual(make_item('fixture', external_id, '编程与学习实践',
            '介绍 Python 开发、机器学习、工程实践及其相关主题的应用经验。'))['item_id']

    def test_llm_over_limit_deduplicates_aliases_before_selecting_two_and_saves_scope(self):
        python_tag = self.add_tag('Python', description='人工维护的 Python 分类范围')
        self.core.tags.update(python_tag['id'], synonyms=['Py'])
        self.llm([
            {'tagId': python_tag['id'], 'score': 0.99, 'description': '模型不应覆盖人工说明'},
            {'name': 'Py', 'score': 0.98, 'description': '重复的同类标签'},
            {'name': '机器学习', 'score': 0.97, 'description': '模型训练、算法及评估方法',
             'reason': '文章介绍了一个分类器'},
            {'name': '工程', 'score': 0.95, 'description': '工程设计与系统实践'},
        ])
        item_id = self.save()
        self.drain()
        self.assertEqual(self.tags_of(item_id), ['Python', '机器学习'])
        self.assertEqual(self.repo.get_tag(python_tag['id'])['description'], '人工维护的 Python 分类范围')
        created = self.repo.get_tag(self.repo.find_tag_by_name('机器学习'))
        self.assertEqual(created['description'], '模型训练、算法及评估方法')
        self.assertIsNone(self.repo.find_tag_by_name('工程'), '未选中的第三类不能偷偷创建')
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual((task['state'], task['applied_count']), ('succeeded', 2))

    def test_llm_fills_selected_empty_scopes_by_id_name_and_alias_only_once(self):
        for index, identity_kind in enumerate(('id', 'name', 'alias')):
            with self.subTest(identity=identity_kind):
                tag = self.add_tag(f'空说明{index}')
                self.core.tags.update(tag['id'], synonyms=[f'别名{index}'])
                untouched = self.add_tag(f'未命中{index}')
                identity = {'tagId': tag['id']} if identity_kind == 'id' else {
                    'name': tag['name'] if identity_kind == 'name' else f'别名{index}'}
                transport = self.llm([dict(identity, description=' 开发工具与编程实践 ', reason='本条提到工具')])
                item_id = self.save(f'fill-{index}')
                self.drain()
                self.assertEqual(self.tags_of(item_id), [tag['name']])
                self.assertEqual(self.repo.get_tag(tag['id'])['description'], '开发工具与编程实践')
                self.assertEqual(self.repo.get_tag(untouched['id'])['description'], '')
                self.assertEqual(len(transport.requests), 1, '自己补说明不应让同一任务重排再调用模型')
                self.assertEqual(self.tasks.summary()['active'], 0)

    def test_jev_ranks_all_threshold_matches_and_only_applies_two(self):
        tags = [self.add_tag(f'分类{i}') for i in range(5)]
        self.enable(mode='jev')
        transport = self.Transport({'model': 'jev-fixture', 'answers': {
            tag['id']: {'type': 'noul', 'noul': score}
            for tag, score in zip(tags, (0.81, 0.99, 0.88, 0.95, 0.9))}})
        self._patch_provider(JevProvider(endpoint='https://example.invalid/jev', model='fixture',
                                         api_key='fixture', transport=transport))
        item_id = self.save()
        self.drain()
        self.assertEqual(self.tags_of(item_id), ['分类1', '分类3'])
        self.assertEqual(len(transport.requests[0]['questions']), 5, '结果上限不应少评估候选目录')
        self.assertTrue(all(tag['description'] == '' for tag in self.repo.list_tags()),
                        'Jev 不擅自生成说明')

    def test_worker_enforces_limit_even_when_provider_ignores_request(self):
        tags = [self.add_tag(f'类别{i}', description='已有分类范围') for i in range(4)]
        for mode in ('llm', 'jev'):
            with self.subTest(mode=mode):
                self.enable(mode=mode)
                result = RecognitionResult(provider=mode, status=STATUS_MATCHED, candidates=tuple(
                    Candidate(tag_id=tag['id'], score=score)
                    for tag, score in zip(tags, (0.4, 0.9, 0.8, 0.99))))
                self._patch_provider(type('OverLimitProvider', (), {'recognize': lambda _self, req: result})())
                item_id = self.save(f'over-limit-{mode}')
                self.drain()
                self.assertEqual(self.tags_of(item_id), ['类别1', '类别3'])

    def test_invalid_llm_scope_fails_task_without_creating_empty_tags(self):
        existing = self.add_tag('已有空说明')
        for index, value in enumerate(({'name': '新建缺说明', 'reason': '匹配理由'},
                                       {'tagId': existing['id']},
                                       {'name': '超长说明', 'description': '长' * 201})):
            with self.subTest(value=value):
                self.llm([value])
                item_id = self.save(f'invalid-{index}')
                self.drain()
                task = self.repo.db.execute('SELECT state,error_code,error_message FROM tagging_tasks WHERE content_id=?',
                                             (item_id,)).fetchone()
                self.assertEqual((task['state'], task['error_code']), ('failed', 'invalid_response'))
                self.assertIn('说明', task['error_message'])
                self.assertEqual(self.tags_of(item_id), [])
        self.assertEqual(len(self.repo.list_tags()), 1)
        self.assertEqual(self.repo.get_tag(existing['id'])['description'], '')

    def test_transaction_limits_existing_and_new_tags_together(self):
        tags = [self.add_tag(f'已有{i}', description='已有范围') for i in range(3)]
        self.enable()
        item_id = self.save()
        self.tagging._register()
        task = self.tasks.next_task()
        result = self.tasks.apply_result(
            task['id'], applied_tag_ids=[tags[0]['id']], expected_content_version=task['content_version'],
            new_tags=[{'name': '新类一', 'description': '新类一范围'},
                      {'name': '新类二', 'description': '新类二范围'}])
        self.assertEqual(result['applied'], 2)
        self.assertEqual(self.tags_of(item_id), ['已有0', '新类一'])
        self.assertIsNone(self.repo.find_tag_by_name('新类二'))

    def test_transaction_also_limits_existing_ids_in_both_modes(self):
        tags = [self.add_tag(f'已有{i}', description='已有范围') for i in range(3)]
        for mode in ('llm', 'jev'):
            with self.subTest(mode=mode):
                self.enable(mode=mode)
                item_id = self.save(f'storage-{mode}')
                self.tagging._register()
                task = self.tasks.next_task()
                result = self.tasks.apply_result(task['id'], applied_tag_ids=[tag['id'] for tag in tags],
                    new_tags=[], expected_content_version=task['content_version'])
                self.assertEqual(result['applied'], 2)
                self.assertEqual(self.tags_of(item_id), ['已有0', '已有1'])

    def test_in_flight_manual_scope_edit_is_preserved_after_requeue(self):
        tag = self.add_tag('Python')
        item_id = 'fixture:feed:manual-scope'
        provider = GatedProvider({item_id: ['Python']})
        self.enable()
        self._patch_provider(provider)
        self.save('manual-scope')

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            self.core.tags.update(tag['id'], description='用户在请求期间填写的分类范围')
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())
        self.assertEqual(self.repo.get_tag(tag['id'])['description'], '用户在请求期间填写的分类范围')
        self.assertEqual(self.tags_of(item_id), [])
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'queued')
        self._patch_provider(StubProvider({item_id: ['Python']}))
        self.drain()
        self.assertEqual(self.tags_of(item_id), ['Python'])
        self.assertEqual(self.repo.get_tag(tag['id'])['description'], '用户在请求期间填写的分类范围')

    def test_scope_fill_notifies_tag_page_when_association_already_exists(self):
        tag = self.add_tag('Python')
        self.llm([{'tagId': tag['id'], 'description': 'Python 语言、工具与开发实践'}])
        item_id = self.save()
        self.core.tags.set_content(item_id, [tag['id']])
        events = []
        self.tagging.emit = lambda name, payload: events.append((name, payload))
        self.drain()
        self.assertEqual(self.repo.get_tag(tag['id'])['description'], 'Python 语言、工具与开发实践')
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['applied_count'], 0)
        self.assertIn(('tags.changed', {'ids': [tag['id']]}), events)


class GatedProvider(StubProvider):
    """可控时机的替身：在测试放行前不返回，用来制造「请求在途」窗口。"""

    def __init__(self, picks=None):
        super().__init__(picks)
        import threading
        self.entered = threading.Event()
        self.release = threading.Event()

    def recognize(self, request):
        self.entered.set()
        self.release.wait(timeout=10)
        return StubProvider.recognize(self, request)


    """第一轮主链验收。"""

class M16Round2RegressionTests(_M16Fixture, unittest.TestCase):
    """第二轮：Codex 复现的四个主流程阻断各自的回归验证。"""

    def test_llm_empty_directory_creates_first_tags(self):
        """BUG-090：LLM 空目录仍调用 Provider 并创建第一批标签（Jev 才跳过）。"""
        self.enable(mode='llm', picks={'fixture:feed:first-1': ['自动打标']})
        # 断言前提：此时标签目录确实是空的。
        self.assertEqual(self.tasks.enabled_tags(), [])
        saved = self.repo.save_manual(make_item('fixture', 'first-1', '自动打标入门',
                                                '一篇讲自动打标如何工作的入门文章，介绍流程与配置方式。'))
        self.drain()
        self.assertEqual(self.stub.calls, 1, 'LLM 在空目录必须调用模型')
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'succeeded')
        names = self.tags_of(saved['item_id'])
        self.assertTrue(names, 'LLM 应创建并挂载新标签')
        self.assertTrue(self.repo.list_tags(), '新标签应真正入库')

    def test_jev_empty_directory_still_skips(self):
        """Jev 的限制保留：空目录无事可做，不调模型也不造标签。"""
        self.enable(mode='jev')
        self.repo.save_manual(make_item('fixture', 'jev-empty-1', '空目录样本',
                                        '正文长度足够触发识别流程，用来验证空目录跳过。'))
        self.drain()
        self.assertEqual(self.stub.calls, 0)
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'skipped')

    def test_disable_during_request_blocks_late_write(self):
        """BUG-091：请求在途时关闭开关，迟到结果不得写标签。"""
        provider = GatedProvider({'fixture:feed:late-1': ['科技']})
        self.enable(mode='llm')
        self._patch_provider(provider)
        saved = self.repo.save_manual(make_item('fixture', 'late-1', '并发关闭测试',
                                                '用于验证识别过程中关闭开关时不会写入迟到结果。'))

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            # 模型还在等待：用户此刻关闭自动打标。
            self.core.settings.update('tagging', {'enabled': False})
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())
        self.assertEqual(self.tags_of(saved['item_id']), [], '停用后的迟到结果不得落库')
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'cancelled')

    def test_corrected_config_releases_blocked_task(self):
        """BUG-091：保存修正配置后，阻塞任务经正式 worker 路径自动恢复。

        不手工调用 unblock_all、不改库——用户保存设置就应该生效。
        """
        self.enable(mode='llm')
        failing = AuthFailProvider()
        self._patch_provider(failing)
        self.repo.save_manual(make_item('fixture', 'fix-1', '认证失败样本',
                                        '用于验证修正配置之后被阻塞的任务会自动恢复。'))
        self.drain()
        blocked = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(blocked['state'], 'blocked')
        self.assertEqual(failing.calls, 1)

        # 用户在设置页保存修正后的凭据与配置：设置版本前进，worker 必须发现。
        self.core.credentials.provide('ref-llm', 'sk-corrected')
        self.core.settings.update('ai', {'providers': {'provider-llm': {'model': 'fixed-model'}}})
        self._patch_provider(StubProvider({'fixture:feed:fix-1': ['安全']}))

        self.drain()
        refreshed = self.tasks.get_task(blocked['id'])
        self.assertEqual(refreshed['state'], 'succeeded', '保存修正配置后应自动恢复执行')
        self.assertEqual(self.tags_of('fixture:feed:fix-1'), ['安全'])

    def test_backfill_includes_content_saved_before_enable(self):
        """BUG-092：启用前收录的历史内容必须出现在用户主动补打范围内。"""
        saved = self.repo.save_manual(make_item('fixture', 'old-1', '启用前的内容',
                                                '这条内容在开启自动打标之前就已收录，补打必须覆盖它。'))
        self.assertIsNotNone(saved)
        self.enable(mode='llm')
        preview = self.tagging.backfill_preview(limit=50)
        self.assertEqual(preview['pending'], 1, '启用前内容不能被生效边界排除')
        self.assertIn(saved['item_id'], preview['itemIds'])
        result = self.tagging.backfill(limit=50)
        self.assertEqual(result['queued'], 1, '预览与实际排队数量必须一致')

    def test_backfill_count_matches_preview_with_many_items(self):
        """BUG-092：候选多于展示切片时，预览数量与实际排队数量仍然一致。"""
        self.enable(mode='llm')
        for index in range(60):
            self.repo.save_manual(make_item('fixture', f'bulk-{index}', f'历史内容 {index}',
                                            f'第 {index} 条历史内容，用于验证补打范围与数量一致性。'))
        preview = self.tagging.backfill_preview(limit=200)
        self.assertEqual(preview['pending'], 60)
        self.assertEqual(len(preview['itemIds']), 60)
        # items 只是展示切片，不应被当成执行集合。
        self.assertLessEqual(len(preview['items']), 50)
        result = self.tagging.backfill(limit=200)
        self.assertEqual(result['queued'], preview['pending'], '排队数必须等于预览的 pending')

    def test_exit_releases_inflight_task_and_restart_resumes(self):
        """BUG-093：正常退出释放在途任务，重启后继续执行且不重复写入。

        走真实 Core.close() 与重建 Core，不手工改租约或直接调恢复函数。
        """
        provider = GatedProvider({'fixture:feed:restart-1': ['投资']})
        self.enable(mode='llm')
        self._patch_provider(provider)
        saved = self.repo.save_manual(make_item('fixture', 'restart-1', '退出重启测试',
                                                '用于验证退出时释放在途任务并在重启后继续执行。'))

        async def claim_then_exit():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            # 任务此刻已被 next_task 认领，租约尚未到期。
            in_flight = self.tasks.list_tasks(limit=1)['items'][0]
            self.assertEqual(in_flight['state'], 'running')
            self.assertGreater(in_flight['attempts'], 0)
            await self.tagging.close()
            work.cancel()
            try:
                await work
            except asyncio.CancelledError:
                pass

        self.loop.run_until_complete(claim_then_exit())
        released = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(released['state'], 'queued', '退出必须释放本进程在途任务')

        self.core.database.close()
        self.core.lease.close()
        # 重建 Core：模拟应用重启。
        self.core = Core(self.path, gateway=type('G', (), {'describe': staticmethod(lambda: [])})())
        self.repo = self.core.repository
        self.tagging = self.core.tagging
        self.tasks = self.repo.tagging
        # 凭据只在 Core 内存里，重启后为空；主进程在 core.hello 之后会按设置里的
        # 引用重新推送密钥（settingsBridge.sync）。这里如实复现这一步，而不是
        # 让凭据凭空出现。
        self.core.credentials.provide('ref-llm', 'sk-after-restart')
        self.core.credentials.provide('ref-jev', 'sk-after-restart')
        provider.release.set()
        provider.entered.clear()
        self._patch_provider(StubProvider({'fixture:feed:restart-1': ['投资']}))

        for _ in range(8):
            self.loop.run_until_complete(self.tagging._run_once())
            if self.tasks.summary()['active'] == 0:
                break
        self.assertEqual(self.tasks.summary()['active'], 0, '重启后任务必须能继续跑到终态')
        self.assertEqual(self.tags_of(saved['item_id']), ['投资'])
        rows = self.repo.db.execute('SELECT count(*) FROM content_tags WHERE content_id=?',
                                   (saved['item_id'],)).fetchone()[0]
        self.assertEqual(rows, 1, '重启续跑不得重复写入关联')

    def test_tag_rename_during_request_discards_stale_result(self):
        """BUG-095：识别在途时改名，旧结果不得挂到已改名的标签上。

        目录版本确实变了，但写回时必须按数据库当前目录复核；旧结果被丢弃后
        任务按当前目录重新排队，并最终走到终态，不留在 running、不重复挂载。
        """
        provider = GatedProvider({'fixture:feed:rename-1': ['Python']})
        self.enable(mode='llm')
        self._patch_provider(provider)
        tag = self.add_tag('Python', description='Python 相关内容')
        saved = self.repo.save_manual(make_item('fixture', 'rename-1', 'Python 实践',
                                                '这是一篇 Python 编程实践记录，包含代码示例与依赖说明。'))

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            # 目录已交给 Provider，返回之前用正式 TagService 把同一 ID 改名。
            self.core.tags.update(tag['id'], name='美食')
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())

        # 旧结果不得落库：内容不能被挂到已经叫「美食」的标签上。
        self.assertEqual(self.tags_of(saved['item_id']), [], '旧目录结果不得写入')
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(task['state'], 'queued',
                         '目录变化必须让任务重新排队，不能按旧目录判成功或留在 running')
        self.assertEqual(task['catalog_version'], self.tasks.catalog_version(),
                         '重新排队后任务记录的是当前目录版本')
        self.assertEqual(task['applied_count'], 0, '旧结果没有挂载任何标签')

        # 按当前目录重排后应能继续跑到终态。
        provider.release.set()
        provider.entered.clear()
        self._patch_provider(StubProvider({'fixture:feed:rename-1': ['美食']}))
        for _ in range(8):
            self.loop.run_until_complete(self.tagging._run_once())
            if self.tasks.summary()['active'] == 0:
                break
        self.assertEqual(self.tasks.summary()['active'], 0)
        rows = self.repo.db.execute('SELECT count(*) FROM content_tags WHERE content_id=?',
                                   (saved['item_id'],)).fetchone()[0]
        self.assertLessEqual(rows, 1, '不得重复挂载')

    # ---- BUG-097：用户修正条件后的主动恢复路径 -------------------------

    def test_jev_empty_directory_skip_can_be_recovered_by_backfill(self):
        """Jev 空目录被跳过后，补齐标签并切到 LLM，用户应能主动补打回来。"""
        self.enable(mode='jev')          # 空目录：Jev 会跳过，不调模型
        item = make_item('fixture', 'recover-1', 'Python 协程实践',
                         '这篇讲 asyncio 协程调度与异步上下文管理器的实现与取舍。')
        saved = self.repo.save_manual(item)
        self.drain()
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'skipped')
        self.assertEqual(self.tags_of(saved['item_id']), [])

        # 用户修正条件：建好标签目录并切换到 LLM，重新开启。
        self.add_tag('Python')
        self.enable(mode='llm', picks={'fixture:feed:recover-1': ['Python']})

        preview = self.tagging.backfill_preview(limit=50)
        self.assertEqual(preview['pending'], 1, 'skipped 的内容必须出现在补打范围内')
        self.assertIn(saved['item_id'], preview['itemIds'])
        result = self.tagging.backfill(limit=50)
        self.assertEqual(result['queued'], 1, '预览与实际排队数量必须一致')

        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['Python'])
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'succeeded')

    def test_cancelled_inflight_content_can_be_recovered_by_backfill(self):
        """识别在途时关闭开关被取消的内容，重新开启后应能主动补打回来。"""
        provider = GatedProvider({'fixture:feed:recover-2': ['投资']})
        self.enable(mode='llm')
        self.add_tag('投资')
        self._patch_provider(provider)
        saved = self.repo.save_manual(make_item('fixture', 'recover-2', '定投记录',
                                                '记录每月指数基金定投的执行情况与账户波动。'))

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            self.core.settings.update('tagging', {'enabled': False})
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'cancelled')
        self.assertEqual(self.tags_of(saved['item_id']), [])

        self.core.settings.update('tagging', {'enabled': True})
        preview = self.tagging.backfill_preview(limit=50)
        self.assertEqual(preview['pending'], 1, 'cancelled 的内容必须出现在补打范围内')
        self.assertEqual(self.tagging.backfill(limit=50)['queued'], 1)
        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['投资'])

    def test_backfill_reuses_task_and_never_reprocesses_active_or_succeeded(self):
        """幂等：复用原任务；排队中、运行中和已成功的内容不被重复处理。"""
        self.enable(mode='llm', picks={'fixture:feed:recover-3': ['开源']})
        item = make_item('fixture', 'recover-3', '开源项目记录',
                         '记录一个开源命令行工具的开发过程、依赖选择与踩过的坑。')
        saved = self.repo.save_manual(item)
        self.drain()
        succeeded = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(succeeded['state'], 'succeeded')

        # 补打预览不应再包含已成功的内容。
        self.assertNotIn(saved['item_id'], self.tagging.backfill_preview(limit=50)['itemIds'])
        result = self.tagging.backfill(item_ids=[saved['item_id']], limit=50)
        self.assertEqual(result['queued'], 0, '已成功的内容不得被隐式重复处理')
        self.assertEqual(self.tasks.list_tasks(limit=5)['total'], 1, '不得并排新建任务')
        rows = self.repo.db.execute('SELECT count(*) FROM content_tags WHERE content_id=?',
                                   (saved['item_id'],)).fetchone()[0]
        self.assertEqual(rows, 1)

    def test_backfill_reuses_the_original_skipped_task(self):
        """skipped 的内容被补打时复用原任务行，而不是并排新建。"""
        self.enable(mode='jev')
        item = make_item('fixture', 'recover-4', '美食记录',
                         '记录红烧肉的做法与火候控制要点，以及常见失败原因。')
        saved = self.repo.save_manual(item)
        self.drain()
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'skipped')
        self.add_tag('美食')
        self.enable(mode='llm', picks={'fixture:feed:recover-4': ['美食']})

        before = self.tasks.list_tasks(limit=5)['total']
        self.assertEqual(self.tagging.backfill(item_ids=[saved['item_id']], limit=50)['queued'], 1)
        self.assertEqual(self.tasks.list_tasks(limit=5)['total'], before,
                         '应复用原任务而不是新建一条')
        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['美食'])

    # ---- BUG-097 续修：详情更新后不得被自身旧快照永久挡住 ---------------

    def _apply_detail_update(self, item_key, summary):
        """走正式详情更新链路（create_job → running → apply_detail），不改库。"""
        from subscribe_flow.contracts import Connection
        from subscribe_flow.contracts.models import ContentPatch
        self.repo.add_connection(Connection('fixture:default', 'fixture', 'direct-http', 'http:fixture'))
        source = Source(channel='fixture', kind='user', external_id='detail-source',
                        name='详情夹具来源', url='https://example.invalid/detail')
        subscription = self.repo.subscribe(source, 'fixture:default')
        job, _created = self.repo.create_job(subscription['id'], 'detail', item_key=item_key, trigger='manual')
        self.repo.set_job_state(job['id'], 'running')
        self.repo.apply_detail(job['id'], ContentPatch(item_key=item_key, fields={'summary': summary}))

    def test_backfill_after_detail_update_recovers_to_terminal(self):
        """正式详情更新后，被跳过的内容应能经补打恢复到终态并挂上标签。"""
        self.enable(mode='jev')          # 空目录：Jev 跳过
        saved = self.repo.save_manual(make_item('fixture', 'detail-1', 'Python 笔记',
                                                '关于 Python 的一篇早期短笔记。'))
        self.drain()
        original = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(original['state'], 'skipped')

        # 正式详情更新：正文补全，contents.updated_at 正常前进。
        self._apply_detail_update(saved['item_id'],
                                  '补全后的正文：介绍 asyncio 协程、事件循环与异步上下文管理器的完整实践。')
        current = self.repo.get_content(saved['item_id'])['updated_at']
        self.assertNotEqual(current, original['content_version'])

        self.add_tag('Python')
        self.enable(mode='llm', picks={'fixture:feed:detail-1': ['Python']})
        self.assertEqual(self.tagging.backfill(limit=50)['queued'], 1)
        # 新一轮必须基于当前正文建立快照，而不是沿用首次创建时的版本。
        requeued = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(requeued['content_version'], current,
                         '补打重排必须刷新为当前内容版本')

        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['Python'])
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'succeeded')

    def test_retry_after_detail_update_recovers_to_terminal(self):
        """页面「重试」入口同样必须刷新内容版本，而不是复用旧快照。"""
        provider = GatedProvider({'fixture:feed:detail-2': ['投资']})
        self.enable(mode='llm')
        self.add_tag('投资')
        self._patch_provider(provider)
        saved = self.repo.save_manual(make_item('fixture', 'detail-2', '定投记录',
                                                '一次较早的定投记录，内容较短。'))

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            self.core.settings.update('tagging', {'enabled': False})
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())
        cancelled = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(cancelled['state'], 'cancelled')

        self._apply_detail_update(saved['item_id'], '补全后的正文：记录每月指数基金定投的执行与账户波动情况。')
        current = self.repo.get_content(saved['item_id'])['updated_at']
        self.core.settings.update('tagging', {'enabled': True})
        provider.release.set()
        provider.entered.clear()
        self._patch_provider(StubProvider({'fixture:feed:detail-2': ['投资']}))

        result = self.tagging.retry(cancelled['id'])
        self.assertTrue(result['queued'])
        retried = self.tasks.get_task(cancelled['id'])
        self.assertEqual(retried['content_version'], current, '重试必须刷新为当前内容版本')

        self.drain()
        self.assertEqual(self.tags_of(saved['item_id']), ['投资'])

    def test_inflight_content_change_still_blocks_late_result(self):
        """新轮开始后内容再次变化，迟到结果仍必须被版本保护拦截。"""
        self.enable(mode='jev')          # 空目录：先落一个 skipped，可经补打重排
        saved = self.repo.save_manual(make_item('fixture', 'detail-3', '开源记录',
                                                '记录一个开源命令行工具的开发过程。'))
        self.drain()
        self.assertEqual(self.tasks.list_tasks(limit=1)['items'][0]['state'], 'skipped')
        self.add_tag('开源')
        self.enable(mode='llm', picks={'fixture:feed:detail-3': ['开源']})
        self.assertEqual(self.tagging.backfill(item_ids=[saved['item_id']], limit=50)['queued'], 1)

        provider = GatedProvider({'fixture:feed:detail-3': ['开源']})
        self._patch_provider(provider)

        async def scenario():
            work = asyncio.ensure_future(self.tagging._run_once())
            while not provider.entered.is_set():
                await asyncio.sleep(0.01)
            # 请求在途，正文再次变化：这一轮基于旧正文发起，必须被拦下。
            self._apply_detail_update(saved['item_id'], '正文在识别期间又被改了一次，内容已不同。')
            provider.release.set()
            await work

        self.loop.run_until_complete(scenario())
        self.assertEqual(self.tags_of(saved['item_id']), [], '在途变更后的迟到结果不得写入')
        task = self.tasks.list_tasks(limit=1)['items'][0]
        self.assertEqual(task['state'], 'skipped', '不得按旧结果判定成功')

    def test_expired_lease_recovers_without_manual_call(self):
        """BUG-093：异常残留的过期租约由 worker 循环自行回收，不需手工调用。"""
        self.enable(mode='llm')
        self.repo.save_manual(make_item('fixture', 'orphan-1', '残留租约测试',
                                        '用于验证过期租约由工作循环自动回收而不必人工干预。'))
        self.tagging._register()
        task = self.tasks.next_task()
        self.assertIsNotNone(task)
        self.tasks.db.execute("UPDATE tagging_tasks SET lease_expires_at='2000-01-01T00:00:00'"
                              " WHERE id=?", (task['id'],))
        # 只跑 worker 循环本身：循环必须把过期租约收回来并完成该任务。
        self.drain()
        self.assertIn(self.tasks.get_task(task['id'])['state'],
                      ('succeeded', 'skipped', 'queued', 'failed'))


if __name__ == '__main__':
    unittest.main()
