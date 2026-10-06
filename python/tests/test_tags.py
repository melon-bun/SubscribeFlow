"""M9 标签系统与识别扩展接口的验收测试。

覆盖二期计划的验收条件：持久化与重启、改名不丢关联、幂等、删除影响、
与优先级／处理状态的独立性、重新采集不覆盖人工标签、识别建议经统一服务
应用的边界，以及 AI 未配置时人工标签照常可用。
"""

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from subscribe_flow.contracts import ChannelError, Connection, ContentItem, FetchPage, Source
from subscribe_flow.contracts.models import PublishedTime
from subscribe_flow.contracts.tags import RecognitionInput, TagSuggestion
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
from subscribe_flow.application.tags import TagService


class StubProvider:
    """识别提供者的测试替身：只按固定结果返回，不联网、不调模型。"""

    def __init__(self, candidates, version=None):
        self.candidates, self.version, self.calls = candidates, version, 0

    def suggest(self, request):
        self.calls += 1
        self.seen = request
        return TagSuggestion(request.item_id, list(self.candidates), self.version, 'stub')


class TagTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'tags.sqlite3'
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.events = []
        self.tags = TagService(self.repo, lambda name, data: self.events.append((name, data)))
        self.repo.add_connection(Connection('c', 'test', 'test', 'test'))
        self.source = Source('test', 'author', 'a', 'Author', 'https://example.com/a', True)
        self.sub = self.repo.subscribe(self.source, 'c')
        self.item = ContentItem('test', 'video', 'a', self.source, 'Title', 'https://example.com/a')
        self.job, _ = self.repo.create_job(self.sub['id'], 'refresh')
        self.repo.set_job_state(self.job['id'], 'running')
        self.repo.commit_page(self.job['id'], FetchPage((self.item,), None, 'window_only'))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def make_tags(self, *names):
        return [self.tags.create(name) for name in names]

    def dated_item(self, external_id, published, title='Titled'):
        """带发布日期的内容。日历按发布日期归集，fixture 默认没有日期。"""
        item = ContentItem('test', 'video', external_id, self.source, title,
                           f'https://example.com/{external_id}',
                           published=PublishedTime(value=published, precision='minute'))
        self.repo.commit_page(self.job['id'], FetchPage((item,), None, 'window_only'))
        return item

    def second_item(self, external_id='b', title='Other'):
        item = ContentItem('test', 'video', external_id, self.source, title, 'https://example.com/b')
        self.repo.commit_page(self.job['id'], FetchPage((item,), None, 'window_only'))
        return item

    def restart(self):
        self.db.close()
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.tags = TagService(self.repo, lambda name, data: None)

    # ------------------------------------------------- 持久化与重启

    def test_create_tag_persists_shape_and_survives_restart(self):
        tag = self.tags.create('旅行', description='目的地推荐', color='cyan', synonyms=['出游', '攻略'])
        self.assertEqual(tag['name'], '旅行')
        self.assertEqual(tag['color'], 'cyan')
        self.assertEqual(tag['synonyms'], ['出游', '攻略'])
        self.assertTrue(tag['enabled'])
        self.assertEqual(tag['contentCount'], 0)
        self.assertEqual(self.tags.list_tags()['total'], 1)
        self.restart()
        self.assertEqual(self.tags.get(tag['id'])['name'], '旅行')
        self.assertEqual(self.tags.get(tag['id'])['synonyms'], ['出游', '攻略'])

    def test_rename_keeps_content_links_and_delete_reports_impact(self):
        first, second = self.make_tags('旅行', '美食')
        self.tags.bulk_set([self.item.key], [first['id'], second['id']])
        renamed = self.tags.update(first['id'], name='出行')
        self.assertEqual(renamed['name'], '出行')
        # 关联挂在稳定 ID 上，改名不丢内容关系。
        self.assertEqual([t['id'] for t in self.repo.get_content(self.item.key)['tags']], [first['id'], second['id']])
        self.restart()
        self.assertEqual(self.repo.get_content(self.item.key)['tags'][0]['name'], '出行')
        removed = self.tags.remove(first['id'])
        self.assertTrue(removed['removed'])
        # 删除的影响被如实回报，界面据此告知用户会摘掉多少条内容上的标签。
        self.assertEqual(removed['detachedContents'], 1)
        self.assertEqual([t['id'] for t in self.repo.get_content(self.item.key)['tags']], [second['id']])
        self.assertEqual(self.repo.get_content(self.item.key)['tags'][0]['origin'], 'manual')

    def test_duplicate_names_conflict_including_case_and_rename(self):
        self.tags.create('Travel')
        for bad in ('travel', 'TRAVEL'):
            with self.assertRaises(ChannelError) as error:
                self.tags.create(bad)
            self.assertEqual(error.exception.code, 'CONFLICT')
        kept = self.tags.create('摄影')
        other = self.make_tags('财经')[0]
        with self.assertRaises(ChannelError):
            self.tags.update(other['id'], name='travel')
        with self.assertRaises(ChannelError):
            self.tags.update(kept['id'], name='TRAVEL')
        # 改回自己的名字不算冲突。
        self.assertEqual(self.tags.update(kept['id'], name='摄影')['name'], '摄影')

    def test_invalid_tag_fields_are_rejected(self):
        for bad in ('', '   ', 'x' * 41, '换\n行'):
            with self.assertRaises(ChannelError):
                self.tags.create(bad)
        for bad in ('chartreuse', '#ff0000', 1, True):
            with self.assertRaises(ChannelError):
                self.tags.create(f'色{bad}', color=bad)
        with self.assertRaises(ChannelError):
            self.tags.create('说明', description='x' * 201)
        with self.assertRaises(ChannelError):
            self.tags.create('别名', synonyms=['重复', '重复', 'x' * 41])
        self.assertEqual(self.tags.create('别名', synonyms=['重复', '重复'])['synonyms'], ['重复'])

    # ------------------------------------------------- 打标与幂等

    def test_tagging_is_idempotent_and_replace_is_explicit(self):
        first, second = self.make_tags('旅行', '美食')
        for _ in range(3):
            self.tags.set_content(self.item.key, [first['id']])
        item = self.repo.get_content(self.item.key)
        self.assertEqual(len(item['tags']), 1)
        self.assertEqual(item['tags'][0]['origin'], 'manual')
        self.tags.set_content(self.item.key, [first['id'], second['id']])
        self.assertEqual(len(self.repo.get_content(self.item.key)['tags']), 2)
        # 给定列表即最终结果：传空列表是明确的清空，不是无操作。
        self.tags.set_content(self.item.key, [])
        self.assertEqual(self.repo.get_content(self.item.key)['tags'], [])
        with self.assertRaises(ChannelError):
            self.tags.set_content(self.item.key, [first['id'], 'missing'])
        with self.assertRaises(ChannelError):
            self.tags.set_content('missing', [first['id']])
        with self.assertRaises(ChannelError):
            self.tags.bulk_set([], [first['id']])
        with self.assertRaises(ChannelError):
            self.tags.bulk_set(['x'] * 101, [first['id']])

    def test_bulk_tagging_is_atomic_across_the_selection(self):
        first = self.make_tags('旅行')[0]
        second = self.second_item()
        result = self.tags.bulk_set([self.item.key, second.key], [first['id']])
        self.assertEqual(result['updated'], 2)
        self.assertEqual(self.repo.query_contents(tags=[first['id']])['total'], 2)
        with self.assertRaises(ChannelError):
            self.tags.bulk_set([self.item.key, 'missing'], [first['id']])

    # ------------------------------------------------- 筛选与组合

    def test_filter_by_tags_supports_any_and_all(self):
        first, second, third = self.make_tags('旅行', '美食', '摄影')
        both = self.second_item('b', 'Both')
        self.tags.set_content(self.item.key, [first['id'], second['id']])
        self.tags.set_content(both.key, [first['id'], third['id']])
        self.assertEqual(self.repo.query_contents(tags=[first['id']], tag_mode='any')['total'], 2)
        self.assertEqual(self.repo.query_contents(tags=[first['id'], second['id']], tag_mode='all')['total'], 1)
        self.assertEqual(self.repo.query_contents(tags=[second['id'], third['id']], tag_mode='all')['total'], 0)
        self.assertEqual(self.repo.query_contents(tags=[third['id']])['total'], 1)
        # 多对多不应放大统计：两条内容各有一个标签，按任一筛选仍是 2 而不是 4。
        listing = self.repo.query_contents(tags=[first['id']], tag_mode='any')
        self.assertEqual(len({item['id'] for item in listing['items']}), 2)
        for bad in ('ANY', '', 1, True):
            with self.assertRaises(ChannelError):
                self.repo.query_contents(tags=[first['id']], tag_mode=bad)
        with self.assertRaises(ChannelError):
            self.repo.query_contents(tags=[first['id']] * 21)
        with self.assertRaises(ChannelError):
            self.repo.query_contents(tags=[1])

    def test_tags_are_independent_from_priority_and_processing_state(self):
        first = self.make_tags('旅行')[0]
        self.repo.set_source_priority(self.sub['id'], 'high')
        self.repo.update_content_state([self.item.key], {'read': True})
        self.tags.set_content(self.item.key, [first['id']])
        item = self.repo.get_content(self.item.key)
        # 打标签不动重要程度，改重要程度也不动标签。
        self.assertEqual(item['priority'], 'high')
        self.assertTrue(item['state']['read'])
        self.assertEqual(len(item['tags']), 1)
        self.repo.update_content_state([self.item.key], {'priority': 'low'})
        self.repo.update_content_state([self.item.key], {'deferred': True})
        item = self.repo.get_content(self.item.key)
        self.assertEqual((item['priority'], item['tags'][0]['id']), ('low', first['id']))
        # 三个维度可以任意组合查询。
        self.assertEqual(self.repo.query_contents(priority='low', tags=[first['id']], deferred=True)['total'], 1)
        # 处理状态彼此互斥：标记为稍后处理后 read 不再成立，这属于既有规则。
        self.assertEqual(self.repo.query_contents(priority='low', tags=[first['id']], read=True)['total'], 0)
        self.assertEqual(self.repo.query_contents(priority='high', tags=[first['id']])['total'], 0)

    def test_calendar_summary_supports_tag_filter_without_inflating_counts(self):
        first, second = self.make_tags('旅行', '美食')
        high = self.dated_item('c', '2026-10-03T08:00:00Z', 'High')
        low = self.dated_item('d', '2026-10-03T20:00:00Z', 'Low')
        self.repo.update_content_state([high.key], {'priority': 'high'})
        self.repo.update_content_state([low.key], {'priority': 'low'})
        self.tags.set_content(high.key, [first['id'], second['id']])
        self.tags.set_content(low.key, [first['id']])
        summary = self.repo.calendar_summary('2026-10', tags=[first['id']], tag_mode='any')
        self.assertEqual(summary['total'], 2)
        self.assertEqual(summary['priorities'], {'high': 1, 'medium': 0, 'low': 1, 'none': 0})
        both = self.repo.calendar_summary('2026-10', tags=[first['id'], second['id']], tag_mode='all')
        self.assertEqual((both['total'], both['priorities']['high']), (1, 1))
        # 唯一约束下两条内容不可能同时命中，日期分组也不会重复计数。
        self.assertEqual(sum(day['total'] for day in summary['days']), 2)
        self.assertEqual([day['date'] for day in summary['days']], ['2026-10-03'])
        self.assertEqual(self.repo.calendar_summary('2026-10', tags=[second['id']])['total'], 1)

    # ------------------------------------------------- 采集不干扰

    def test_recollection_never_overwrites_manual_tags(self):
        first, second = self.make_tags('旅行', '美食')
        self.tags.set_content(self.item.key, [first['id'], second['id']])
        self.repo.commit_page(self.job['id'], FetchPage((replace(self.item, title='New'),), None, 'window_only'))
        item = self.repo.get_content(self.item.key)
        self.assertEqual(item['title'], 'New')
        self.assertEqual({t['id'] for t in item['tags']}, {first['id'], second['id']})
        self.restart()
        self.assertEqual(len(self.repo.get_content(self.item.key)['tags']), 2)

    def test_platform_topics_are_not_mixed_into_the_user_tag_library(self):
        # 平台原生的 hashtag 留在内容自身的载荷里，不进入 tags 表。
        self.repo.db.execute("UPDATE contents SET payload=? WHERE id=?",
                        ('{"title":"Title","hashtags":["旅行","美食"]}', self.item.key))
        self.assertEqual(self.tags.list_tags()['total'], 0)
        self.assertEqual(self.repo.query_contents()['total'], 1)

    def test_disabled_tag_keeps_existing_links_but_stays_out_of_the_list_default(self):
        first = self.make_tags('旅行')[0]
        self.tags.set_content(self.item.key, [first['id']])
        self.tags.set_enabled(first['id'], False)
        self.assertFalse(self.tags.get(first['id'])['enabled'])
        self.assertEqual(self.tags.list_tags(enabled=True)['total'], 0)
        self.assertEqual(self.tags.list_tags(enabled=False)['total'], 1)
        # 停用不抹掉已有归类，内容仍然可以按这个标签被检索到。
        self.assertEqual(self.repo.query_contents(tags=[first['id']])['total'], 1)

    def test_tag_contents_listing_shares_the_content_filter(self):
        first, second = self.make_tags('旅行', '美食')
        other = self.second_item('b', 'Second')
        self.tags.set_content(self.item.key, [first['id']])
        self.tags.set_content(other.key, [second['id']])
        listing = self.tags.contents(first['id'])
        self.assertEqual((listing['total'], len(listing['items'])), (1, 1))
        self.assertEqual(listing['items'][0]['tags'][0]['id'], first['id'])
        self.assertEqual(self.tags.contents(second['id'], priority='none')['total'], 1)
        with self.assertRaises(ChannelError):
            self.tags.contents('missing')

    # ------------------------------------------------- 识别扩展接口

    def test_recognition_input_is_stable_and_allows_missing_fields(self):
        first = self.make_tags('旅行')[0]
        provider = StubProvider([{'name': '旅行'}])
        self.tags.recognition_provider = provider
        self.tags.recognize(self.item.key)
        request = provider.seen
        self.assertEqual(request.item_id, self.item.key)
        self.assertEqual(request.channel, 'test')
        self.assertEqual(request.title, 'Title')
        # 没有取到正文就是 None，不用空串或猜测值冒充。
        self.assertIsNone(request.summary)

    def test_suggestions_apply_through_the_unified_service_without_creating_tags(self):
        travel = self.make_tags('旅行')[0]
        provider = StubProvider([
            {'tag_id': travel['id'], 'confidence': 0.82, 'reason': '标题含目的地'},
            {'name': '待确认分类', 'reason': '疑似合集'},
        ])
        self.tags.recognition_provider = provider
        report = self.tags.apply_suggestion(self.tags.recognize(self.item.key))
        self.assertFalse(report['stale'])
        self.assertEqual(report['applied'], 1)
        self.assertEqual(report['newTags'][0]['name'], '待确认分类')
        # 建议的新标签只回报，不擅自创建——建标签是人的决定。
        self.assertEqual(self.tags.list_tags()['total'], 1)
        self.assertEqual(self.repo.get_content(self.item.key)['tags'][0]['origin'], 'suggested')

    def test_repeated_suggestions_are_idempotent(self):
        travel = self.make_tags('旅行')[0]
        self.tags.recognition_provider = StubProvider([{'tag_id': travel['id']}])
        for _ in range(3):
            self.tags.apply_suggestion(self.tags.recognize(self.item.key))
        self.assertEqual(len(self.repo.get_content(self.item.key)['tags']), 1)

    def test_old_suggestions_cannot_silently_undo_a_manual_removal(self):
        travel, food = self.make_tags('旅行', '美食')
        provider = StubProvider([{'tag_id': travel['id'], 'confidence': 0.9}])
        self.tags.recognition_provider = provider
        self.tags.apply_suggestion(self.tags.recognize(self.item.key))
        self.assertEqual([t['id'] for t in self.repo.get_content(self.item.key)['tags']], [travel['id']])
        # 用户移除后，后续同一份建议再次到达也不能把它悄悄加回来。
        self.tags.set_content(self.item.key, [food['id']])
        report = self.tags.apply_suggestion(provider.suggest(
            RecognitionInput(self.item.key, 'test', source_id='a', title='Title')))
        self.assertEqual(report['applied'], 0)
        self.assertEqual(report['blocked'], 1)
        self.assertEqual(report['blockedTags'], [travel['id']])
        self.assertEqual([t['id'] for t in self.repo.get_content(self.item.key)['tags']], [food['id']])
        # 人工重新添加同样是一次决定，解除屏蔽后建议可以再次命中。
        self.tags.set_content(self.item.key, [food['id'], travel['id']])
        self.assertEqual(self.tags.apply_suggestion(provider.suggest(
            RecognitionInput(self.item.key, 'test')))['applied'], 0)

    def test_manual_tags_are_never_demoted_or_removed_by_recognition(self):
        travel, food = self.make_tags('旅行', '美食')
        self.tags.set_content(self.item.key, [travel['id']])
        self.tags.recognition_provider = StubProvider([{'tag_id': food['id'], 'confidence': 1.0}])
        self.tags.apply_suggestion(self.tags.recognize(self.item.key))
        item = self.repo.get_content(self.item.key)
        self.assertEqual({t['id'] for t in item['tags']}, {travel['id'], food['id']})
        self.assertEqual({t['id']: t['origin'] for t in item['tags']},
                         {travel['id']: 'manual', food['id']: 'suggested'})
        # 人工关联被再次确认为人工来源，识别路径没有覆盖它。
        self.tags.set_content(self.item.key, [travel['id'], food['id']])
        self.assertEqual({t['origin'] for t in self.repo.get_content(self.item.key)['tags']}, {'manual'})

    def test_stale_suggestions_are_reported_rather_than_applied(self):
        travel = self.make_tags('旅行')[0]
        provider = StubProvider([{'tag_id': travel['id']}], version='stale-version')
        self.tags.recognition_provider = provider
        report = self.tags.apply_suggestion(provider.suggest(
            RecognitionInput(self.item.key, 'test', title='Title', content_updated_at='older')))
        self.assertTrue(report['stale'])
        self.assertEqual(report['applied'], 0)
        self.assertEqual(self.repo.get_content(self.item.key)['tags'], [])

    def test_malformed_suggestions_are_rejected_not_guessed(self):
        self.make_tags('旅行')
        bad = [
            {'candidates': [{'tag_id': 'x'}]},                                  # 缺 item_id
            {'item_id': self.item.key, 'candidates': []},                      # 空候选
            {'item_id': self.item.key, 'candidates': [{}]},                     # 既无名称也无 ID
            {'item_id': self.item.key, 'candidates': [{'name': 'x', 'confidence': 5}]},
            {'item_id': self.item.key, 'candidates': [{'name': 'x', 'confidence': '高'}]},
            {'item_id': self.item.key, 'candidates': '旅行'},
        ]
        for raw in bad:
            with self.assertRaises(ChannelError):
                self.tags.apply_suggestion(raw)
        self.assertEqual(self.repo.get_content(self.item.key)['tags'], [])

    def test_missing_confidence_is_left_absent_never_invented(self):
        travel = self.make_tags('旅行')[0]
        provider = StubProvider([{'tag_id': travel['id'], 'reason': '标题命中'}])
        self.tags.recognition_provider = provider
        suggestion = self.tags.recognize(self.item.key)
        # 提供者没有给置信度，契约里就保持没有，不代填一个看起来合理的数。
        self.assertIsNone(suggestion.candidates[0].confidence)
        self.assertEqual(self.tags.apply_suggestion(suggestion)['applied'], 1)

    def test_provider_returning_wrong_shape_is_rejected(self):
        self.tags.recognition_provider = StubProvider([{'tag_id': 'x'}])
        self.tags.recognition_provider.suggest = lambda request: {'not': 'a suggestion'}
        with self.assertRaises(ChannelError):
            self.tags.recognize(self.item.key)

    def test_manual_tagging_works_with_no_provider_configured(self):
        # 人工标签不依赖 AI 可用性：没有注入提供者时依然完整可用。
        self.assertIsNone(self.tags.recognition_provider)
        travel = self.make_tags('旅行')[0]
        self.tags.set_content(self.item.key, [travel['id']])
        self.assertEqual(self.repo.query_contents(tags=[travel['id']])['total'], 1)
        with self.assertRaises(ChannelError) as error:
            self.tags.recognize(self.item.key)
        self.assertEqual(error.exception.code, 'NOT_CONFIGURED')

    def test_unknown_tag_id_in_suggestion_is_rejected_not_silently_dropped(self):
        provider = StubProvider([{'tag_id': 'does-not-exist'}])
        self.tags.recognition_provider = provider
        with self.assertRaises(ChannelError) as error:
            self.tags.apply_suggestion(provider.suggest(RecognitionInput(self.item.key, 'test')))
        self.assertEqual(error.exception.code, 'NOT_FOUND')

    # ------------------------------------------------- 事件

    def test_tag_changes_emit_refresh_events(self):
        travel = self.make_tags('旅行')[0]
        self.tags.update(travel['id'], name='出行')
        self.tags.set_enabled(travel['id'], False)
        self.tags.set_content(self.item.key, [travel['id']])
        self.tags.remove(travel['id'])
        names = [name for name, _ in self.events]
        self.assertEqual(names.count('tags.changed'), 4)
        self.assertIn('content.changed', names)


if __name__ == '__main__':
    unittest.main()
