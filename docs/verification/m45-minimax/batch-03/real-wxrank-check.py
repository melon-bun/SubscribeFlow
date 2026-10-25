"""M45.6 付费渠道验收：真实传输层打真实 HTTP 上游。

先说清楚这份证据是什么、不是什么：

- 是：产品的**正式付费渠道代码**（传输层／业务层／账本／检查点／适配器）
  经过**真实 HTTP**（urllib、真实 JSON 请求体、真实超时与重定向拒绝）
  打一个**本机上游**，上游响应形状严格照真实契约复刻：
  ``art_url`` 带一层 HTML 转义、``&amp;`` 分隔参数、真实字段名、
  副条与游标分页、业务码与「剩余 N 积分」文案。
- 不是：真实付费上游。本机没有授权的 wxrank 密钥（见 DELIVERY.md 的外部阻塞），
  因此**没有**任何真实扣费发生，**没有**真实余额可观察。

所以这份证据证明的是「接线、解析、计费记账、检查点推进、重启续采」在
真实网络条件下成立；它**不能**替代真实上游的验收。

凭据纪律：这里用的是一次性假密钥（只打本机上游），不接触任何真实密钥。
证据只留调用次数、确认消费积分、游标推进、条目数与可核验结果。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'python' / 'src'))

from subscribe_flow.bootstrap import Core                        # noqa: E402
from subscribe_flow.channels.wxrank import protocol              # noqa: E402
from subscribe_flow.channels.wxrank.transport import WxrankTransport  # noqa: E402
from subscribe_flow.rpc.dispatcher import Dispatcher, PROTOCOL_VERSION  # noqa: E402

OUTPUT = Path(__file__).resolve().parent / 'real-wxrank-evidence.json'

CONNECTION = 'wxrank:default'
BIZ = 'MzI4NTEyMzQ1Ng=='
WXID = 'gh_demo0001'
#: 一次性假密钥：只打本机上游，不接触任何真实凭据。
FAKE_SECRET = 'local-upstream-not-a-real-key'

#: 特殊 biz：让上游按真实业务码答复，用来验证「不扣费」与「结果未知」两条路。
#: 写成归一后的形态（base64 归一会去掉多余的填充）。
LOW_BALANCE_BIZ = 'LOWBALANCE000000'
REDIRECT_BIZ = 'REDIRECT00000000'

PAGES = [
    ('C1', [(1000000001, index, f'8f5dfe3{index}') for index in range(1, 11)]),
    ('C2', [(1000000101, index, f'aa11bb{index:02d}') for index in range(1, 11)]),
    ('C3', [(1000000201, index, f'cc33dd{index:02d}') for index in range(1, 11)]),
]


def art_url(mid: int, idx: int, sn: str) -> str:
    """真实上游形态的地址：http + ``&amp;`` 分隔 + 带片段。"""
    return (f'http://mp.weixin.qq.com/s?__biz={BIZ}&amp;mid={mid}&amp;idx={idx}'
            f'&amp;sn={sn}&amp;chksm=cc47af0e&amp;scene=126#rd')


def build_rows(page_rows):
    rows = []
    for mid, idx, sn in page_rows:
        rows.append({
            'pub_time': '2026-10-23 10:15:00' if mid == 1000000001 else '2026-10-20 09:02:11',
            'title': f'真实形态样本 {mid}-{idx}',
            'sn': sn * 4,
            'art_url': art_url(mid, idx, sn),
            'pic_url': ('https://mmbiz.qpic.cn/sz_mmbiz_jpg/demo/640?wxtype=jpeg&amp;wxfrom=0'),
        })
    return rows


class Upstream:
    """本机 HTTP 上游。响应形状照真实契约复刻；请求日志不含密钥。"""

    def __init__(self):
        self.requests: list[dict] = []
        self.redirect_targets = 0
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                return

            def do_GET(self):
                # 重定向目标如果被访问，说明请求体里的密钥被跟着搬走了。
                if 'key=' in (self.path or ''):
                    upstream.redirect_targets += 1
                self.send_response(200)
                self.send_header('Content-Length', '0')
                self.end_headers()

            def _json(self, payload, status=200):
                body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b'{}'
                try:
                    payload = json.loads(raw.decode('utf-8'))
                except Exception:
                    payload = {}
                path = urlsplit(self.path).path
                upstream.requests.append({
                    'path': path,
                    'hasKey': bool(payload.get('key')),
                    'keyLength': len(str(payload.get('key') or '')),
                    'keyInUrl': 'key=' in (self.path or ''),
                    'biz': payload.get('biz'),
                    'wxid': payload.get('wxid'),
                    'cursor': payload.get('cursor'),
                })
                if path.endswith('/weixin/getinfo'):
                    self._getinfo(payload)
                    return
                if path.endswith('/weixin/getps'):
                    self._getps(payload)
                    return
                self._json({'code': 1004, 'msg': 'mock: 只支持 /weixin/getinfo 与 /weixin/getps'})

            def _getinfo(self, payload):
                biz = str(payload.get('biz') or '')
                if biz == REDIRECT_BIZ:
                    # 真实上游偶尔会跳登录页：传输层必须拒绝跟随，
                    # 否则请求体里的密钥会被送到别的主机。
                    self.send_response(302)
                    self.send_header('Location', '/weixin/getps?key=leaked')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                if biz == LOW_BALANCE_BIZ:
                    self._json({'code': 1000, 'msg': '剩余0积分（充值积分 https://data.wxrank.com）'})
                    return
                self._json({'code': 0, 'msg': '数据获取成功，剩余120积分', 'data': {
                    'name': '真实形态公众号', 'user_name': WXID,
                    'signature': '一份关于设计与工具的公众号',
                    'hd_head_img': 'http://mmbiz.qpic.cn/mmbiz_png/demo/0?wx_fmt=png'}})

            def _getps(self, payload):
                cursor = payload.get('cursor')
                if cursor:
                    match = next(((index, page) for index, page in enumerate(PAGES)
                                  if page[0] == cursor), None)
                    if match is None:
                        self._json({'code': 1003, 'msg': 'cursor校验失败'})
                        return
                    index, page = match
                    if index + 1 < len(PAGES):
                        rows = build_rows(PAGES[index + 1][1])
                        self._json({'code': 0, 'msg': '剩余32653积分', 'data': {
                            'list': rows, 'wxid': WXID, 'cursor': PAGES[index + 1][0]}})
                        return
                    # 末页：空列表 = 数据集到此为止。
                    self._json({'code': 0, 'msg': '剩余32653积分', 'data': {
                        'list': [], 'wxid': WXID, 'cursor': ''}})
                    return
                rows = build_rows(PAGES[0][1])
                self._json({'code': 0, 'msg': '剩余32653积分', 'data': {
                    'list': rows, 'wxid': WXID, 'cursor': PAGES[0][0]}})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self) -> str:
        return f'http://127.0.0.1:{self.port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Runner:
    """在隔离数据库上跑正式 RPC。"""

    def __init__(self, database_path: Path):
        self.database_path = database_path
        self.core = Core(database_path, paid_transport=WxrankTransport(timeout=15.0))
        self.dispatcher = Dispatcher(self.core, lambda: None)

    async def call(self, method: str, params: dict | None = None):
        message = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}
        response = await self.dispatcher.handle(message)
        if 'error' in response:
            raise RuntimeError(f'{method} 失败：{response["error"]}')
        return response.get('result')

    async def run_job(self, subscription_id: str, mode: str, page_budget: int | None = None):
        params = {'subscription_id': subscription_id, 'mode': mode}
        if page_budget is not None:
            params['page_budget'] = page_budget
        started = await self.call('sync.start', params)
        job_id = started['job_id']
        for _ in range(600):
            job = await self.call('sync.get', {'job_id': job_id})
            if job.get('state') in {'succeeded', 'failed', 'partial', 'waiting', 'cancelled'}:
                return job
            await asyncio.sleep(0.05)
        raise AssertionError(f'任务 {job_id} 没有结束')

    async def close(self):
        await self.core.close()


async def main() -> int:
    upstream = Upstream()
    # 只在本次进程里改上游根地址：传输层代码本身不改，仍然是真实 urllib。
    original_root = protocol.API_ROOT
    protocol.API_ROOT = upstream.base
    temp = tempfile.TemporaryDirectory()
    database = Path(temp.name) / 'wxrank.sqlite3'
    evidence: dict = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'mode': '真实传输层 + 本机真实 HTTP 上游（响应形状照真实契约）',
        'notVerified': '真实付费上游：本机没有授权的 wxrank 密钥，未产生任何真实扣费。',
        'upstream': {'base': upstream.base, 'pages': len(PAGES)},
        'steps': [],
    }
    runner = Runner(database)
    try:
        # ---- 0. 握手：正式 RPC 入口可达
        await runner.call('core.hello', {'protocol_version': PROTOCOL_VERSION})

        # ---- 1. 免费本地状态：零调用
        before = await runner.call('wxrank.usage')
        status = await runner.call('wxrank.status')
        assert not status.get('configured'), '未配置密钥时状态必须是未配置'
        assert upstream.requests == [], '本地状态读取不得触网'
        evidence['steps'].append({'step': '本地状态读取', 'calls': 0,
                                  'configured': status.get('configured')})

        # ---- 2. 保存密钥：走产品自己的凭据桥与设置写入
        reference = 'channel-wxrank-' + 'a1b2c3d4e5f6a7b8c9d0e1f2'
        await runner.call('credential.provide', {'reference': reference, 'secret': FAKE_SECRET})
        await runner.call('settings.update', {'section': 'channels',
                                              'patch': {'wxrank': {'enabled': True}},
                                              'credential_refs': {'wxrank': reference}})
        status = await runner.call('wxrank.status')
        assert status.get('configured'), '保存密钥后状态必须是已配置'
        assert upstream.requests == [], '保存密钥本身不得触网'
        evidence['steps'].append({'step': '保存密钥（零调用）', 'calls': 0,
                                  'configured': status.get('configured')})

        # ---- 3. 冷解析：一次付费调用
        source = await runner.call('source.resolve', {'locator': BIZ, 'connection_id': CONNECTION})
        assert len(upstream.requests) == 1, f'冷解析只能一次调用：{upstream.requests}'
        request = upstream.requests[0]
        assert request['path'].endswith('/weixin/getinfo'), request
        assert request['hasKey'] and request['keyLength'] == len(FAKE_SECRET), '密钥必须在请求体里'
        assert not request['keyInUrl'], '密钥不得出现在 URL 里'
        assert source.get('name') == '真实形态公众号', source
        assert source.get('avatar') == 'https://mmbiz.qpic.cn/mmbiz_png/demo/0?wx_fmt=png', \
            f'头像必须按真实字段 hd_head_img 解析并升 https：{source.get("avatar")}'
        assert source.get('description') == '一份关于设计与工具的公众号', source
        evidence['steps'].append({'step': '冷解析', 'calls': 1,
                                  'sourceName': source.get('name'),
                                  'externalId': source.get('external_id'),
                                  'avatarParsed': bool(source.get('avatar')),
                                  'descriptionParsed': bool(source.get('description'))})

        # ---- 4. 确认添加：命中解析缓存，不再收费
        subscription = await runner.call('subscription.add', {
            'locator': BIZ, 'connection_id': CONNECTION, 'confirmed': True})
        assert len(upstream.requests) == 1, f'确认添加不得再收费：{upstream.requests}'
        evidence['steps'].append({'step': '确认添加（命中缓存）', 'calls': 0,
                                  'subscriptionId': subscription.get('id')})

        # ---- 5. 刷新：一页真实入库
        job = await runner.run_job(subscription['id'], 'refresh')
        assert job['state'] == 'succeeded', job
        contents = await runner.call('content.list', {})
        assert contents['total'] == 10, f'刷新后应入库 10 条：{contents["total"]}'
        first = contents['items'][0]
        assert first['url'].startswith('https://mp.weixin.qq.com/s?'), first['url']
        assert 'mid=1000000001' in first['url'], first['url']
        assert '&amp;' not in first['url'], '文章地址必须解开一层转义'
        published = first.get('published', {}).get('value')
        assert published, first
        assert first.get('thumbnail', '').startswith('https://'), first.get('thumbnail')
        assert len(upstream.requests) == 2, upstream.requests
        evidence['steps'].append({'step': '刷新一页', 'calls': 1, 'contents': contents['total'],
                                  'urlSample': first['url'], 'publishedAt': published,
                                  'thumbnail': first.get('thumbnail')})

        # ---- 6. 回溯一页：从刷新提交的那页后面接着走，不重复购买头页
        job = await runner.run_job(subscription['id'], 'backfill', page_budget=1)
        assert job['state'] == 'succeeded', job
        assert upstream.requests[-1]['cursor'] == 'C1', \
            f'回溯必须接着刷新提交的页走，而不是再买一次头页：{upstream.requests[-1]}'
        contents = await runner.call('content.list', {})
        assert contents['total'] == 20, f'回溯后应累计 20 条：{contents["total"]}'
        usage = await runner.call('wxrank.usage')
        assert usage['calls'] == 3 and usage['confirmed_credits'] == 15, usage
        evidence['steps'].append({'step': '回溯一页', 'calls': 1, 'cursorSent': 'C1',
                                  'contents': contents['total'],
                                  'confirmedCredits': usage['confirmed_credits']})

        # ---- 7. 重启隔离应用：检查点必须活过重启，并继续用同一个游标
        await runner.close()
        runner = Runner(database)
        # 重启后是一条新的 RPC 会话：先握手，再用同一条产品路径续采。
        await runner.call('core.hello', {'protocol_version': PROTOCOL_VERSION})
        # 密钥只在 Core 内存里：主进程启动时会把受保护存储里的密钥重推给 Core。
        # 这里做同一件事，否则重启后的 Core 会认为渠道未配置。
        await runner.call('credential.provide', {'reference': reference, 'secret': FAKE_SECRET})
        job = await runner.run_job(subscription['id'], 'backfill', page_budget=1)
        assert job['state'] == 'succeeded', job
        assert upstream.requests[-1]['cursor'] == 'C2', \
            f'重启后必须接着上次的游标走，而不是从头：{upstream.requests[-1]}'
        contents = await runner.call('content.list', {})
        assert contents['total'] == 30, contents['total']
        usage = await runner.call('wxrank.usage')
        assert usage['calls'] == 4 and usage['confirmed_credits'] == 20, usage
        evidence['steps'].append({'step': '重启后续采', 'calls': 1, 'cursorSent': 'C2',
                                  'contents': contents['total'],
                                  'confirmedCredits': usage['confirmed_credits']})

        # ---- 8. 末页：空列表才算数据集扫完，检查点随之清掉
        job = await runner.run_job(subscription['id'], 'backfill', page_budget=1)
        assert upstream.requests[-1]['cursor'] == 'C3', upstream.requests[-1]
        coverage = await runner.call('sync.coverage', {'subscription_id': subscription['id']})
        usage = await runner.call('wxrank.usage')
        evidence['steps'].append({'step': '末页（空列表）', 'calls': 1, 'cursorSent': 'C3',
                                  'coverage': coverage,
                                  'confirmedCredits': usage['confirmed_credits']})

        # ---- 9. 业务失败：code≠0 不扣费
        before_credits = (await runner.call('wxrank.usage'))['confirmed_credits']
        try:
            await runner.call('wxrank.test', {'locator': LOW_BALANCE_BIZ,
                                              'connection_id': CONNECTION})
            raise AssertionError('余额不足时必须报错')
        except RuntimeError as error:
            message = str(error)
        after = await runner.call('wxrank.usage')
        assert after['confirmed_credits'] == before_credits, '业务失败不得计费'
        attempts = after.get('attempts') or []
        latest = attempts[0] if attempts else {}
        assert latest.get('chargeState') == 'not_charged', latest
        evidence['steps'].append({'step': '业务失败（code=1000）', 'calls': 1,
                                  'chargeState': latest.get('chargeState'),
                                  'errorCode': latest.get('errorCode')})

        # ---- 10. 重定向：传输层拒绝跟随，扣费结果记「未知」
        try:
            await runner.call('wxrank.test', {'locator': REDIRECT_BIZ,
                                              'connection_id': CONNECTION})
            raise AssertionError('上游跳转发时必须报错')
        except RuntimeError as error:
            message = str(error)
        after = await runner.call('wxrank.usage')
        attempts = after.get('attempts') or []
        latest = attempts[0] if attempts else {}
        assert latest.get('chargeState') == 'unknown', \
            f'网络未决必须记未知，不能假报没扣费：{latest}'
        assert upstream.redirect_targets == 0, '重定向目标不得被访问'
        evidence['steps'].append({'step': '重定向被拒', 'calls': 1,
                                  'chargeState': latest.get('chargeState'),
                                  'errorCode': latest.get('errorCode')})

        # ---- 11. 汇总
        usage = await runner.call('wxrank.usage')
        evidence['summary'] = {
            'calls': usage['calls'],
            'confirmedCredits': usage['confirmed_credits'],
            'unknownCharges': usage.get('unknown_count'),
            'balanceObserved': usage.get('balance'),
            'balanceObservedAt': usage.get('balanceObservedAt'),
            'upstreamRequests': len(upstream.requests),
            'requestLog': [{'path': r['path'], 'hasKey': r['hasKey'],
                             'keyInUrl': r['keyInUrl'], 'cursor': r['cursor']}
                            for r in upstream.requests],
        }
    finally:
        await runner.close()
        protocol.API_ROOT = original_root
        upstream.close()
        temp.cleanup()

    OUTPUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(evidence['summary'], ensure_ascii=False, indent=2))
    for step in evidence['steps']:
        print(' -', json.dumps(step, ensure_ascii=False))
    print('证据已写入:', OUTPUT)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
