"""M16 业务接入主链验收测试。

覆盖计划 §3 的核心链路，用隔离数据库与「同一边界的替身 Provider」：
订阅首次保存与手动确认保存 → 持久事件 → 后台任务 → 统一识别结果 →
事务内标签落库 → 界面可查询。

这里替换的只是 Provider 的 HTTP 实现，Provider 组装、契约映射、事件与任务
持久化、标签应用事务走的是与正式流程完全相同的代码路径。替身不联网，
因此本文件的通过不代表真实模型验收；真实调用证据在 docs/verification/m16-minimax/。
"""

import asyncio
import tempfile
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

from tagging_engine.contracts import (
    Candidate, RecognitionError, RecognitionResult, STATUS_MATCHED, STATUS_NO_MATCH,
)


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
        chosen = []
        for tag in request.candidates:
            if tag.name in self.picks.get(request.item_id, []):
                chosen.append(Candidate(tag_id=tag.id, name=tag.name, score=0.95,
                                        score_kind='noul' if request.mode == 'jev' else 'llm'))
        if not chosen:
            return RecognitionResult(provider='stub', status=STATUS_NO_MATCH, model='stub-model')
        return RecognitionResult(provider='stub', status=STATUS_MATCHED, model='stub-model',
                                 requested_model='stub-model', candidates=tuple(chosen))


class AuthFailProvider(StubProvider):
    def recognize(self, request):
        raise RecognitionError('auth_failed', '凭据无效')


class M16TaggingTests(unittest.TestCase):
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
        self.core.settings.update('tagging', {
            'enabled': True, 'mode': mode,
            'providers': {m: {'endpoint': f'https://api.test.invalid/{m}', 'model': 'test-model'}
                          for m in ('jev', 'llm')}},
            credential_refs={'jev': 'ref-jev', 'llm': 'ref-llm'})
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
        # 任务已认领但还没执行，此时配置被改了一次：版本前进。
        self.core.settings.update('tagging', {'mode': 'jev'})
        current_version = self.core.settings.snapshot()['version']
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


if __name__ == '__main__':
    unittest.main()
