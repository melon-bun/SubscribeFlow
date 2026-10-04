import asyncio
import tempfile
import time
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.bilibili.electron import BilibiliElectronAdapter, envelope
from subscribe_flow.contracts import ChannelError, Connection, ContentItem, Context, FetchPage, FetchRequest
from subscribe_flow.rpc.browser import BrowserBridge


class FakeBridge:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def call(self, params, context, operation):
        self.calls.append(params)
        return self.payload


class ElectronBilibiliTests(unittest.IsolatedAsyncioTestCase):
    def context(self):
        return Context(Connection('bilibili:default','bilibili','electron-session','browser:electron-bilibili'), 'test', time.monotonic()+5)

    async def test_success_empty_has_terminal_evidence_but_no_full_history_claim(self):
        bridge=FakeBridge({'code':0,'data':{'list':{'vlist':[]},'page':{'pn':1,'ps':20,'count':0}}})
        adapter=BilibiliElectronAdapter(bridge)
        source=await adapter.resolve_source('946974',self.context())
        page=await adapter.fetch_page(source,FetchRequest(),self.context())
        self.assertTrue(page.terminal)
        self.assertEqual(page.coverage,'window_only')
        self.assertFalse(adapter.describe().operations['list_items'].full_history)
        bridge.payload['data']['page']['count']=30
        with self.assertRaises(ChannelError) as error:
            await adapter.fetch_page(source,FetchRequest(),self.context())
        self.assertEqual(error.exception.code,'UNVERIFIED_EMPTY')

    async def test_raw_list_dates_identity_and_incompatible_cursor(self):
        bridge=FakeBridge({'code':0,'data':{'list':{'vlist':[{'bvid':'BV1xx411c7mD','mid':946974,'title':'A &amp; B','created':1700000000,'pic':'//i0.hdslb.com/test.jpg'}]},'page':{'pn':1,'ps':20,'count':1}}})
        adapter=BilibiliElectronAdapter(bridge)
        source=await adapter.resolve_source('946974',self.context())
        page=await adapter.fetch_page(source,FetchRequest(),self.context())
        self.assertEqual(page.items[0].published.precision,'second')
        self.assertEqual(page.items[0].title,'A & B')
        self.assertTrue(page.items[0].thumbnail.startswith('https:'))
        with self.assertRaises(ChannelError) as error:
            await adapter.fetch_page(source,FetchRequest(cursor={'backend':'opencli','page':2}),self.context())
        self.assertEqual(error.exception.code,'INVALID_CURSOR')
        bridge.payload['data']['list']['vlist'][0]['mid']=1
        with self.assertRaises(ChannelError): await adapter.fetch_page(source,FetchRequest(),self.context())

    async def test_platform_codes_never_become_empty_success_or_generic_login(self):
        for code,expected in [(-101,'AUTH_REQUIRED'),(-352,'INTERACTION_REQUIRED'),(-412,'INTERACTION_REQUIRED'),(-509,'RATE_LIMITED'),(-404,'NOT_FOUND'),(-999,'ACCESS_FAILED')]:
            with self.assertRaises(ChannelError) as error: envelope({'code':code,'data':None},'list_items')
            self.assertEqual(error.exception.code,expected)
        with self.assertRaises(ChannelError): envelope({'data':{'result':[]}},'search_sources')

    async def test_check_search_detail_preserve_real_semantics(self):
        bridge=FakeBridge({'code':0,'data':{'authenticated':False}})
        adapter=BilibiliElectronAdapter(bridge)
        ready=await adapter.check_readiness('list_items',self.context())
        self.assertEqual(ready.state,'degraded')
        self.assertEqual(ready.authentication,'required')
        bridge.payload={'code':0,'data':{'result':[{'mid':946974,'uname':'<em>影视</em>飓风'}],'numResults':1}}
        result=await adapter.search_sources('影视飓风',FetchRequest(),self.context())
        self.assertTrue(result.items[0].confirmed)
        self.assertEqual(result.items[0].name,'影视飓风')
        bridge.payload={'code':0,'data':{'bvid':'BV1xx411c7mD','title':'视频','desc':'介绍','pubdate':1700000000,'duration':60}}
        detail=await adapter.get_item_detail('bilibili:video:BV1xx411c7mD',self.context())
        self.assertEqual(detail.fields['duration_seconds'],60)
        self.assertNotIn('thumbnail',detail.fields)

    async def test_private_rpc_cancellation_and_late_response(self):
        bridge=BrowserBridge(); messages=[]
        async def send(message): messages.append(message)
        bridge.send=send
        task=asyncio.create_task(bridge.call({'operation':'check'},self.context(),'list_items'))
        await asyncio.sleep(0)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(messages[-1]['method'],'acquisition.cancel')
        self.assertTrue(bridge.receive({'jsonrpc':'2.0','id':messages[0]['id'],'result':{}}))
        self.assertFalse(bridge.pending)

    async def test_one_way_migration_keeps_subscription_content_state_and_invalidates_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'store.sqlite3'
            core=Core(path)
            sub=await core.subscriptions.add('946974','bilibili:default',confirmed=True)
            source=core.repository.source_for(sub['id'])
            job,_=core.repository.create_job(sub['id'],'refresh')
            core.repository.set_job_state(job['id'],'running')
            item=ContentItem('bilibili','video','BV1xx411c7mD',source,'标题','https://www.bilibili.com/video/BV1xx411c7mD')
            core.repository.commit_page(job['id'],FetchPage((item,),{'page':2},'window_only'))
            core.repository.finish_scan(job['id'],coverage='window_only')
            core.content.update(item.key,{'read':True})
            await core.close()
            core=Core(path,browser_bridge=BrowserBridge())
            try:
                connection=core.repository.get_connection('bilibili:default')
                self.assertEqual((connection.backend,connection.version),('electron-session',2))
                self.assertEqual(core.repository.list_subscriptions()[0]['id'],sub['id'])
                self.assertTrue(core.repository.get_content(item.key)['state']['read'])
                self.assertTrue(all(not p['compatible'] for p in core.queries.coverage(sub['id'])['progress']))
            finally: await core.close()
