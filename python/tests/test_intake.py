import asyncio
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import (ChannelError, Connection, ContentItem, ContentPatch,
    ContentReference, Context, FetchPage, OperationCapability, PublishedTime, Source)
from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.rpc.dispatcher import Dispatcher
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository, encode
import subscribe_flow.storage.database as database_module
from tests.fakes import TestAdapter


STAMP = '2026-09-30T15:30:00.000+00:00'
SOURCE = Source('test', 'author', 'author', 'Author', 'https://example.com/author', True)
ITEM = ContentItem('test', 'video', '1', SOURCE, 'Original', 'https://example.com/1',
                   published=PublishedTime('2020-01-02', 'date', 'test', 'Asia/Tokyo'), acquisition_complete=True)


class LinkAdapter(TestAdapter):
    def __init__(self):
        super().__init__()
        self.item = ITEM
        self.read_calls = 0
        self.resolve_calls = 0
        self.read_started = asyncio.Event()
        self.release = None
        self.active = 0
        self.max_active = 0
        self.started = []

    def describe(self):
        base = super().describe()
        return replace(base, operations={**base.operations, **{
            op: OperationCapability(True, verified=True)
            for op in ('match_item_url', 'resolve_item', 'read_item', 'get_item_detail')}})

    def match_item_url(self, url):
        return urlsplit(url).hostname == 'example.com'

    async def _pause(self):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.started.append(asyncio.get_running_loop().time())
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
        finally:
            self.active -= 1

    async def resolve_item(self, url, context):
        self.resolve_calls += 1
        await self._pause()
        return ContentReference('test', 'video', urlsplit(url).path.strip('/'), url)

    async def read_item(self, reference, context):
        self.read_calls += 1
        self.read_started.set()
        if self.release:
            await self.release.wait()
        await self._pause()
        return replace(self.item, external_id=reference.external_id)

    async def fetch_page(self, source, request, context):
        await self._pause()
        return FetchPage((replace(self.item, source=source),), None, 'history_end', True, 'test end')

    async def get_item_detail(self, item_ref, context):
        return ContentPatch(item_ref, {'title': 'Explicit enrichment'})


class IntakeStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.db = Database(self.path)
        self.repo = Repository(self.db)
        self.repo.add_connection(Connection('c', 'test', 'test', 'shared'))

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def auto(self, item=ITEM):
        sub = self.repo.subscribe(item.source, 'c')
        job, _ = self.repo.create_job(sub['id'], 'refresh')
        self.repo.set_job_state(job['id'], 'running')
        result = self.repo.commit_page(job['id'], FetchPage((item,), None, 'window_only'))
        self.repo.set_job_state(job['id'], 'succeeded')
        return result

    def snapshot(self):
        return {table: [tuple(row) for row in self.db.connection.execute(f'SELECT * FROM {table} ORDER BY 1,2')]
                for table in ('contents', 'sources', 'content_sources', 'content_states', 'content_tags', 'content_tag_blocks')}

    def tag(self, name):
        return self.repo.create_tag(name, name, '', 'slate', True, [])['id']

    def test_manual_old_publication_and_automatic_dates_and_unknown_times(self):
        with patch('subscribe_flow.storage.repositories.now', return_value=STAMP):
            self.repo.save_manual(ITEM)
            self.auto(replace(ITEM, external_id='2'))
            self.repo.save_manual(replace(ITEM, external_id='3', published=PublishedTime()))
            self.auto(replace(ITEM, external_id='4', published=PublishedTime()))
        item = self.repo.get_content(ITEM.key, 'Asia/Tokyo')
        self.assertEqual(item['published']['value'], '2020-01-02')
        self.assertEqual((item['intake_method'], item['manual_added_at'], item['calendar_date']), ('manual', STAMP, '2026-10-01'))
        self.assertEqual(item['calendar_basis'], 'manual_added_at')
        self.assertEqual(self.repo.calendar_summary('2026-10', timezone='Asia/Tokyo')['total'], 2)
        self.assertEqual(self.repo.calendar_summary('2020-01')['total'], 1)
        self.assertEqual(self.repo.query_contents()['total'], 4)
        self.assertIsNone(self.repo.get_content('test:video:4')['calendar_date'])
        self.assertEqual(self.repo.query_contents(intake_method='manual')['total'], 2)
        self.assertEqual(self.repo.query_contents()['items'][0]['intake_method'], 'manual')

    def test_both_duplicate_orders_preserve_all_content_source_and_organizing_rows(self):
        tag = self.tag('Tag')
        self.auto()
        self.repo.update_content_state([ITEM.key], {'archived': True, 'priority': 'low'})
        self.repo.set_content_tags([ITEM.key], [tag])
        before = self.snapshot()
        changed = replace(ITEM, title='Changed', url='https://example.com/new',
                          source=replace(SOURCE, name='Changed author'), published=PublishedTime())
        result = self.repo.save_manual(changed, priority='high', tag_ids=['deleted-tag'])
        self.assertEqual(result, {'status': 'exists', 'item_id': ITEM.key})
        self.assertEqual(self.snapshot(), before)
        new = replace(ITEM, external_id='manual')
        with patch('subscribe_flow.storage.repositories.now', return_value=STAMP):
            self.repo.save_manual(new, priority='medium', tag_ids=[tag])
        before = self.snapshot()
        job = self.auto(replace(new, title='Changed'))
        self.assertEqual(job['new_items'], 0)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.repo.save_manual(new, priority='high')['status'], 'exists')
        self.assertEqual(self.snapshot(), before)

    def test_different_namespaces_and_channels_and_source_without_subscription(self):
        self.repo.save_manual(ITEM)
        self.repo.save_manual(replace(ITEM, namespace='note'))
        self.repo.save_manual(replace(ITEM, channel='other', source=replace(SOURCE, channel='other')))
        self.assertEqual(self.repo.query_contents()['total'], 3)
        self.assertEqual(self.repo.list_subscriptions(), [])
        self.assertEqual(len(self.repo.list_content_sources()['items']), 2)
        self.assertEqual(self.repo.query_contents(source_id=SOURCE.key)['total'], 2)
        self.assertIsNone(self.repo.get_content(ITEM.key)['priority'])
        sub = self.repo.subscribe(SOURCE, 'c')
        self.repo.set_source_priority(sub['id'], 'high')
        self.assertEqual(self.repo.get_content(ITEM.key)['priority'], 'high')

    def test_timezone_day_precision_and_month_end_microseconds_share_one_projection(self):
        self.auto(replace(ITEM, published=PublishedTime('2026-09-30T15:30:00Z', 'second', 'test', 'UTC')))
        self.auto(replace(ITEM, external_id='date', published=PublishedTime('2026-09-30', 'date', 'test', 'Asia/Tokyo')))
        self.auto(replace(ITEM, external_id='last', published=PublishedTime('2026-10-31T14:59:59.999999Z', 'second', 'test', 'UTC')))
        summary = self.repo.calendar_summary('2026-10', timezone='Asia/Tokyo')
        self.assertEqual([(day['date'], day['total']) for day in summary['days']], [('2026-10-01', 1), ('2026-10-31', 1)])
        self.assertEqual(self.repo.calendar_summary('2026-09', timezone='Asia/Tokyo')['total'], 1)
        self.assertEqual(self.repo.calendar_summary('2026-09', timezone='UTC')['total'], 2)
        for day in summary['days']:
            items = self.repo.query_contents(start=day['date'], end=day['date'], timezone='Asia/Tokyo')
            self.assertEqual(items['total'], day['total'])
            self.assertEqual(items['items'][0]['calendar_date'], day['date'])
        for filters in ({'timezone':'Mars/Invalid'}, {'start':'2026-02-30'}, {'intake_method':'click'}):
            with self.assertRaises(ChannelError):
                self.repo.query_contents(**filters)

    def test_full_month_tag_source_priority_filters_and_tag_pagination_are_unique(self):
        tags = [self.tag('A'), self.tag('B')]
        second_source = replace(SOURCE, external_id='second')
        self.repo.remember_sources([second_source])
        with patch('subscribe_flow.storage.repositories.now', return_value=STAMP):
            for index in range(125):
                item = replace(ITEM, external_id=str(index))
                self.repo.save_manual(item, priority='high', tag_ids=tags)
                self.db.connection.execute('INSERT INTO content_sources VALUES(?,?)', (item.key, second_source.key))
        filters = dict(channel='test', source_id=SOURCE.key, intake_method='manual', priority='high',
                       read=False, archived=False, deferred=False, tags=tags, tag_mode='all', timezone='Asia/Tokyo')
        summary = self.repo.calendar_summary('2026-10', **filters)
        self.assertEqual((summary['total'], summary['days'][0]['total'], len(summary['days'][0]['items'])), (125, 125, 3))
        day = dict(start='2026-10-01', end='2026-10-01', **filters)
        first = self.repo.query_contents(limit=100, **day)
        second = self.repo.query_contents(limit=100, offset=first['next_offset'], **day)
        self.assertEqual(len({item['id'] for item in first['items'] + second['items']}), 125)
        tagged = self.repo.tag_contents(tags[0], limit=100, offset=100, **day)
        self.assertEqual((tagged['total'], len(tagged['items'])), (125, 25))
        self.assertEqual(self.repo.get_tag(tags[0])['contentCount'], 125)

    def test_dst_repeated_hour_orders_by_instant_and_naive_platform_time_uses_declared_zone(self):
        self.auto(replace(ITEM, external_id='before', published=PublishedTime('2026-11-01T05:55:00Z', 'minute', 'test', 'UTC')))
        self.auto(replace(ITEM, external_id='after', published=PublishedTime('2026-11-01T06:05:00Z', 'minute', 'test', 'UTC')))
        self.auto(replace(ITEM, external_id='naive', published=PublishedTime('2026-11-01T18:00:00', 'minute', 'test', 'Asia/Tokyo')))
        results = self.repo.query_contents(timezone='America/New_York', start='2026-11-01', end='2026-11-01')
        self.assertEqual([item['external_id'] for item in results['items']], ['naive', 'after', 'before'])
        summary = self.repo.calendar_summary('2026-11', timezone='America/New_York')
        self.assertEqual((summary['total'], summary['days'][0]['date']), (3, '2026-11-01'))
        self.assertEqual([item['id'] for item in summary['days'][0]['items']], [item['id'] for item in results['items']])

    def test_save_fault_rolls_back_every_relation_and_first_intake_is_immutable(self):
        tag = self.tag('Tag')
        self.db.connection.executescript("CREATE TRIGGER save_fault BEFORE INSERT ON content_tags BEGIN SELECT RAISE(ABORT,'test failure'); END;")
        before = self.snapshot()
        with self.assertRaises(sqlite3.IntegrityError):
            self.repo.save_manual(ITEM, priority='high', tag_ids=[tag])
        self.assertEqual(self.snapshot(), before)
        self.db.connection.execute('DROP TRIGGER save_fault')
        self.repo.save_manual(ITEM, priority='high', tag_ids=[tag])
        for statement in ("UPDATE contents SET intake_method='subscription',manual_added_at=NULL", "UPDATE contents SET manual_added_at='changed'", "UPDATE contents SET first_seen_at='changed'"):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.connection.execute(statement)

    def test_concurrent_subscription_and_manual_save_first_commit_wins(self):
        sub = self.repo.subscribe(SOURCE, 'c')
        job, _ = self.repo.create_job(sub['id'], 'refresh')
        self.repo.set_job_state(job['id'], 'running')
        gate = threading.Barrier(2)
        def write(manual):
            db = Database(self.path)
            try:
                repo = Repository(db)
                gate.wait(timeout=5)
                if manual:
                    return repo.save_manual(replace(ITEM, title='Manual winner'))
                return repo.commit_page(job['id'], FetchPage((replace(ITEM, title='Auto winner'),), None, 'window_only'))
            finally:
                db.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            manual, auto = list(pool.map(write, [True, False]))
        item = self.repo.get_content(ITEM.key)
        self.assertEqual(self.repo.query_contents()['total'], 1)
        self.assertEqual((manual['status'], auto['new_items']), ('created', 0) if item['intake_method']=='manual' else ('exists', 1))
        self.assertEqual(item['title'], 'Manual winner' if item['intake_method']=='manual' else 'Auto winner')

    def latest_schema_version(self):
        migrations = Path(database_module.__file__).parent / 'migrations'
        return max(int(p.name.split('_')[0]) for p in migrations.glob('[0-9]*.sql'))

    def legacy(self, filename):
        path = Path(self.temp.name) / filename
        migrations = Path(database_module.__file__).parent / 'migrations'
        with sqlite3.connect(path) as db:
            db.executescript('\n'.join(p.read_text() for p in sorted(migrations.glob('*.sql')) if int(p.name.split('_')[0]) <= 7) + '\nPRAGMA user_version=7;')
            db.execute("INSERT INTO connections VALUES('c','test','test','shared',1,1,NULL)")
            db.execute('INSERT INTO sources VALUES(?,?,?,?,?,?,?)', (SOURCE.key,'test','author','author','Author',SOURCE.url,1))
            db.execute("INSERT INTO subscriptions(id,source_id,connection_id,status,version,interval_seconds,created_at,updated_at,default_priority) VALUES('sub',?,'c','active',1,86400,?,?,'high')", (SOURCE.key, STAMP, STAMP))
            db.execute('INSERT INTO contents VALUES(?,?,?,?,?,?,?,?,?)', (ITEM.key,'test','video','1',ITEM.title,ITEM.published.value,encode(ITEM),STAMP,STAMP))
            db.execute('INSERT INTO content_sources VALUES(?,?)', (ITEM.key, SOURCE.key))
            db.execute("INSERT INTO content_states(content_id,read,archived,deferred,updated_at,priority_override) VALUES(?,0,1,0,?,'low')", (ITEM.key,STAMP))
            db.execute("INSERT INTO tags VALUES('tag','Tag','','slate',1,'[]',?,?)", (STAMP, STAMP))
            db.execute("INSERT INTO content_tags VALUES(?,'tag','manual',?)", (ITEM.key, STAMP))
        return path

    def test_v7_upgrade_preserves_every_old_column_and_backup_and_restart(self):
        path = self.legacy('legacy.sqlite3')
        with sqlite3.connect(path) as old:
            tables = [row[0] for row in old.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            original = {table:list(old.execute(f'SELECT * FROM {table}')) for table in tables}
        db = Database(path)
        repo = Repository(db)
        try:
            for table in tables:
                rows = [tuple(row) for row in db.connection.execute(f'SELECT * FROM {table}')]
                if table == 'contents':
                    self.assertEqual(rows[0][-2:], ('subscription', None))
                    rows = [row[:-2] for row in rows]
                self.assertEqual(rows, original[table])
            self.assertEqual(repo.calendar_summary('2020-01')['total'], 1)
            with sqlite3.connect(path.with_suffix(f'.before-v{self.latest_schema_version()}.backup')) as backup:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 7)
                self.assertEqual(list(backup.execute('SELECT * FROM contents')), original['contents'])
            repo.save_manual(replace(ITEM, external_id='new'))
        finally:
            db.close()
        db = Database(path)
        try:
            item = Repository(db).get_content('test:video:new')
            self.assertEqual(item['intake_method'], 'manual')
            self.assertIsNotNone(item['manual_added_at'])
        finally:
            db.close()

    def test_failed_v7_migration_rolls_back_all_new_columns_and_preserves_backup(self):
        path = self.legacy('broken.sqlite3')
        read = Path.read_text
        def fail(target, *args, **kwargs):
            value = read(target, *args, **kwargs)
            return value + '\nINSERT INTO absent_table VALUES(1);' if target.name.startswith('008_') else value
        with patch.object(Path, 'read_text', fail), self.assertRaises(sqlite3.OperationalError):
            Database(path)
        with sqlite3.connect(path) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 7)
            self.assertNotIn('intake_method', [row[1] for row in db.execute('PRAGMA table_info(contents)')])
            self.assertEqual(db.execute('SELECT title FROM contents').fetchone()[0], ITEM.title)
        db = Database(path)
        db.close()
        with sqlite3.connect(path.with_suffix(f'.before-v{self.latest_schema_version()}.backup')) as backup:
            self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0], 7)


class IntakeServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.adapter = LinkAdapter()
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.core = Core(Path(self.temp.name)/'core.sqlite3', gateway=gateway,
                         schedule_policy=SchedulePolicy(resource_gap=0))
        self.events = []
        self.core.listeners.append(lambda event, data: self.events.append((event, data)))

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    async def preview(self, url='https://example.com/1'):
        task = self.core.intake.start(url)
        result = await self.core.intake.wait(task['task_id'])
        self.assertEqual(result['state'], 'preview', result)
        return result

    async def test_preview_save_and_duplicate_links_without_virtual_subscriptions(self):
        preview = await self.preview()
        self.assertEqual(self.core.queries.contents()['total'], 0)
        tag = self.core.tags.create('Tag')
        saved = self.core.intake.save(preview['preview_id'], priority='medium', tag_ids=[tag['id']])
        self.assertEqual(saved['status'], 'created')
        self.assertEqual(saved['content']['intake_method'], 'manual')
        self.assertEqual(saved['content']['priority'], 'medium')
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        self.assertEqual(self.core.repository.list_jobs(), [])
        self.assertEqual(self.core.repository.get_tag(tag['id'])['contentCount'], 1)
        before = self.core.repository.get_content(ITEM.key)
        duplicate = self.core.intake.start('https://example.com/1?different=link')
        result = await self.core.intake.wait(duplicate['task_id'])
        self.assertEqual((result['state'], self.adapter.read_calls), ('exists', 1))
        self.assertEqual(self.core.intake.save(preview['preview_id'], priority='high')['status'], 'exists')
        self.assertEqual(self.core.repository.get_content(ITEM.key), before)
        self.assertEqual([event for event, _ in self.events].count('content.changed'), 1)

    async def test_preview_then_auto_commit_and_explicit_detail_preserve_first_intake(self):
        preview = await self.preview()
        sub = await self.core.subscriptions.add('author', 'test:default', confirmed=True)
        await self.core.sync.wait(self.core.sync.start(sub['id'])['job_id'])
        before = self.core.repository.get_content(ITEM.key)
        saved = self.core.intake.save(preview['preview_id'], priority='high')
        self.assertEqual(saved['status'], 'exists')
        self.assertEqual(saved['content'], before)
        task = await self.preview('https://example.com/manual')
        manual = self.core.intake.save(task['preview_id'])['content']
        await self.core.sync.wait(self.core.sync.start(sub['id'], mode='detail', item_key=manual['id'])['job_id'])
        enriched = self.core.repository.get_content(manual['id'])
        self.assertEqual(enriched['title'], 'Explicit enrichment')
        self.assertEqual((enriched['intake_method'], enriched['manual_added_at'], enriched['first_seen_at']),
                         (manual['intake_method'], manual['manual_added_at'], manual['first_seen_at']))

    async def test_cancel_waiting_resource_and_late_response_and_timeout_release_resource(self):
        import time
        context = Context(self.core.repository.get_connection('test:default'), 'held', time.monotonic()+5)
        async with self.core.sync.resources.acquire(context, 'test'):
            task = self.core.intake.start('https://example.com/1')
            await asyncio.sleep(0)
            self.assertTrue((await self.core.intake.cancel(task['task_id']))['cancelled'])
            self.assertEqual(self.adapter.resolve_calls, 0)
        self.adapter.release = asyncio.Event()
        task = self.core.intake.start('https://example.com/1')
        await self.adapter.read_started.wait()
        await self.core.intake.cancel(task['task_id'])
        self.adapter.release.set()
        self.assertEqual(self.core.intake.get(task['task_id'])['state'], 'cancelled')
        self.adapter.release = None
        self.adapter.delay = 0.2
        self.core.intake.timeout = 0.02
        task = self.core.intake.start('https://example.com/1')
        result = await self.core.intake.wait(task['task_id'])
        self.assertEqual(result['error']['code'], 'TIMEOUT')
        self.adapter.delay = 0
        self.core.intake.timeout = 1
        preview = await self.preview()
        await self.core.intake.cancel(preview['task_id'])
        with self.assertRaises(ChannelError):
            self.core.intake.save(preview['preview_id'])
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_connection_change_rejects_inflight_result_and_stale_preview(self):
        preview = await self.preview()
        self.core.repository.update_connection('test:default', resource_key='changed')
        with self.assertRaises(ChannelError) as caught:
            self.core.intake.save(preview['preview_id'])
        self.assertEqual(caught.exception.code, 'STALE_CONFIG')
        self.adapter.release = asyncio.Event()
        self.adapter.read_started.clear()
        task = self.core.intake.start('https://example.com/2')
        await self.adapter.read_started.wait()
        self.core.repository.update_connection('test:default', enabled=False)
        self.adapter.release.set()
        result = await self.core.intake.wait(task['task_id'])
        self.assertEqual(result['error']['code'], 'STALE_CONFIG')
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_adapter_returning_after_cancellation_cannot_restore_preview(self):
        entered = asyncio.Event()
        async def late(reference, context):
            entered.set()
            try:
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                await asyncio.sleep(0.01)
            return replace(ITEM, external_id=reference.external_id)
        self.adapter.read_item = late
        task = self.core.intake.start('https://example.com/1')
        await entered.wait()
        await self.core.intake.cancel(task['task_id'])
        result = self.core.intake.get(task['task_id'])
        self.assertEqual(result['state'], 'cancelled')
        self.assertIsNone(result['preview_id'])
        self.assertEqual(self.core.queries.contents()['total'], 0)

    async def test_expiry_close_and_restart_invalidate_unsaved_previews_only(self):
        self.core.intake.preview_ttl = 0.01
        preview = await self.preview()
        await asyncio.sleep(0.02)
        with self.assertRaises(ChannelError) as caught:
            self.core.intake.save(preview['preview_id'])
        self.assertEqual(caught.exception.code, 'PREVIEW_EXPIRED')
        self.core.intake.preview_ttl = 300
        saved_preview = await self.preview()
        self.core.intake.save(saved_preview['preview_id'])
        pending = await self.preview('https://example.com/2')
        path, gateway = self.core.database.path, self.core.gateway
        await self.core.close()
        self.core = Core(path, gateway=gateway)
        self.assertEqual(self.core.queries.contents()['total'], 1)
        with self.assertRaises(ChannelError):
            self.core.intake.save(pending['preview_id'])

    async def test_sync_intake_share_resource_and_cooldown_and_auth_is_reported(self):
        self.assertIs(self.core.intake.resources, self.core.sync.resources)
        self.adapter.delay = 0.01
        self.core.sync.resource_gap = 0.02
        sub = await self.core.subscriptions.add('author', 'test:default', confirmed=True)
        sync = self.core.sync.start(sub['id'])
        intake = self.core.intake.start('https://example.com/2')
        await asyncio.gather(self.core.sync.wait(sync['job_id']), self.core.intake.wait(intake['task_id']))
        self.assertEqual(self.adapter.max_active, 1)
        self.assertTrue(all(b-a >= 0.025 for a,b in zip(self.adapter.started, self.adapter.started[1:])))
        self.adapter.error = ChannelError('AUTH_REQUIRED', 'resolve_item', '请登录')
        task = self.core.intake.start('https://example.com/3')
        result = await self.core.intake.wait(task['task_id'])
        # TestAdapter readiness has unknown authentication, so dependency blockage
        # is reported; an operation-specific adapter error remains structured.
        self.assertEqual(result['state'], 'failed')
        self.assertIn(result['error']['code'], {'AUTH_REQUIRED', 'DEPENDENCY_UNAVAILABLE'})

    async def test_rpc_full_loop_uses_authoritative_preview_and_rejects_payload_and_bad_filters(self):
        rpc = Dispatcher(self.core, lambda: None)
        async def call(method, params=None):
            return await rpc.handle({'jsonrpc':'2.0', 'id':1, 'method':method, 'params':params or {}})
        self.assertNotIn('error', await call('core.hello', {'protocol_version':'1.0'}))
        started = (await call('intake.start', {'url':'https://example.com/1'}))['result']
        await self.core.intake.wait(started['task_id'])
        preview = (await call('intake.get', {'task_id':started['task_id']}))['result']
        forged = await call('intake.save', {'preview_id':preview['preview_id'], 'payload':{'title':'Forged'}})
        self.assertEqual(forged['error']['code'], -32602)
        saved = (await call('intake.save', {'preview_id':preview['preview_id'], 'priority':'high'}))['result']
        self.assertEqual((saved['status'], saved['content']['title']), ('created', 'Original'))
        self.assertEqual((await call('source.list'))['result']['items'][0]['id'], SOURCE.key)
        for params in ({'intake_method':'bad'}, {'timezone':'bad'}, {'start':'2026-99-01'}):
            self.assertIn('error', await call('content.list', params))
        self.assertEqual((await call('content.list', {'intake_method':'manual', 'source_id':SOURCE.key}))['result']['total'], 1)

    async def test_late_auth_failure_marks_connection_and_task_limit_recovers_after_cancel(self):
        async def expired(reference, context):
            raise ChannelError('AUTH_EXPIRED', 'read_item', '登录已失效', scope='connection', scope_key=context.connection.id)
        original = self.adapter.read_item
        self.adapter.read_item = expired
        started = self.core.intake.start('https://example.com/1')
        result = await self.core.intake.wait(started['task_id'])
        self.assertEqual(result['error']['code'], 'AUTH_EXPIRED')
        readiness = self.core.repository.list_connections()[0]['readiness']
        self.assertEqual((readiness['state'], readiness['actions']), ('blocked', ['open_browser']))
        self.adapter.read_item = original
        self.core.intake.max_tasks = 1
        preview = await self.preview()
        with self.assertRaises(ChannelError) as caught:
            self.core.intake.start('https://example.com/2')
        self.assertEqual(caught.exception.code, 'BUSY')
        await self.core.intake.cancel(preview['task_id'])
        self.assertEqual((await self.preview('https://example.com/2'))['state'], 'preview')

    async def test_gateway_unsupported_ambiguous_and_invalid_adapter_results(self):
        plain = ChannelGateway()
        plain.register(TestAdapter())
        connection = self.core.repository.get_connection('test:default')
        with self.assertRaises(ChannelError) as caught:
            plain.route_item_url('https://example.com/1', [connection])
        self.assertEqual(caught.exception.code, 'UNSUPPORTED_OPERATION')
        for url in ('file:///tmp/a', 'https://user:password@example.com/1', 'javascript:alert(1)', 'not a URL'):
            with self.assertRaises(ChannelError):
                self.core.intake.start(url)
        self.core.repository.add_connection(replace(connection, id='another'))
        with self.assertRaises(ChannelError) as caught:
            self.core.intake.start('https://example.com/1')
        self.assertEqual(caught.exception.code, 'AMBIGUOUS_CONNECTION')
        self.adapter.item = replace(ITEM, channel='wrong')
        task = self.core.intake.start('https://example.com/1', 'test:default')
        result = await self.core.intake.wait(task['task_id'])
        self.assertEqual(result['error']['code'], 'INVALID_RESULT')
        self.assertEqual(self.core.queries.contents()['total'], 0)
        self.adapter.item = replace(ITEM, url='javascript:invalid')
        task = self.core.intake.start('https://example.com/2', 'test:default')
        self.assertEqual((await self.core.intake.wait(task['task_id']))['error']['code'], 'INVALID_RESULT')
