"""M45 真实公众号付费验收：打真实上游 https://data.wxrank.com。

**这是真钱调用**：每次成功调用约 5 积分。因此本脚本把调用次数写死并自我约束：
最多 5 次（冷解析 + 刷新 + 两次一页回溯 + 可能的重启续采），不为重复截图、
轮询、重复启动或整套测试再消费。

凭据纪律（硬要求）：
- 凭据只由本机进程按**组名**解析 `test_api_key.md`：文件里有三个分组
  （Jev／LLM／wechat），每组以一行裸组名开头，之后才是 ``key:`` 等字段。
  必须按组名取，不能把后面的 LLM key 当成 wechat，也不能只按 wxrank 标签找。
- 密钥只在内存里：不打印、不进日志、不进证据、不进源码、不进提示词。
- 公众号 biz 取自已授权的本机公众号付费实验缓存（那里有真实 biz 与 wxid），
  不凭空猜 biz。

上游契约：固定 https://data.wxrank.com，不使用任何 fixture／本机假上游开关。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'python' / 'src'))

from subscribe_flow.bootstrap import Core                        # noqa: E402
from subscribe_flow.channels.wxrank import protocol              # noqa: E402
from subscribe_flow.channels.wxrank.transport import WxrankTransport  # noqa: E402
from subscribe_flow.rpc.dispatcher import Dispatcher, PROTOCOL_VERSION  # noqa: E402

CREDENTIAL_FILE = ROOT.parent / 'test_api_key.md'
#: 已授权的公众号付费实验缓存：真实 biz 与 wxid 只从这里取。
LAB_STATE = Path('/Users/xor/Documents/xiaohongshu_login_test/.wxrank-state.json')
OUTPUT = Path(__file__).resolve().parent / 'live-wxrank-evidence.json'

CONNECTION = 'wxrank:default'
MAX_CALLS = 5          # 硬上限：冷解析 1 + 刷新 1 + 两次回溯 2 + 可选重启续采 1


# --------------------------------------------------------------------- 凭据解析

def read_wechat_key(path: Path) -> str | None:
    """按组名取 wechat 分组的 key。

    文件结构：一行裸组名（Jev／LLM／wechat），之后是 ``key:``／``url:`` 等字段，
    组之间用空行分开。这里必须按**组名**定位：先前按 URL 推导组名，
    漏掉了没有 url 的 wechat 分组，误判成「文件里没有公众号密钥」。
    """
    sections: list[tuple[str, dict[str, str]]] = []
    name: str | None = None
    fields: dict[str, str] = {}

    def flush():
        if name is not None:
            sections.append((name, dict(fields)))

    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        stripped = line.strip()
        if not stripped:
            flush()
            name, fields = None, {}
            continue
        if ':' not in stripped and '：' not in stripped:
            # 一行裸组名：下一行的 key/url 都属于它。
            flush()
            name, fields = stripped, {}
            continue
        key, _, value = stripped.partition(':')
        if not value:
            key, _, value = stripped.partition('：')
        key = key.strip().lstrip('-*# ').strip().lower()
        value = value.strip()
        if key and value:
            fields[key] = value
    flush()

    for group, values in sections:
        if group.strip().lower() == 'wechat':
            return values.get('key')
    return None


def read_lab_biz(path: Path) -> tuple[str, str] | None:
    """从已授权的实验缓存里取真实 biz 与 wxid。"""
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    cache = data.get('bizCache') if isinstance(data, dict) else None
    if not isinstance(cache, dict) or not cache:
        return None
    for biz, entry in cache.items():
        wxid = entry.get('wxid') if isinstance(entry, dict) else None
        if biz and wxid:
            return str(biz), str(wxid)
    return None


def mask_identity(value: str, head: int = 4, tail: int = 4) -> str:
    """脱敏身份：只留头尾，中间打码。"""
    if len(value) <= head + tail:
        return value[:head] + '…'
    return f"{value[:head]}…{value[-tail:]}"


# --------------------------------------------------------------------- 正式链路

class Runner:
    """隔离 Core + 正式 RPC。"""

    def __init__(self, database_path: Path):
        self.database_path = database_path
        # 正式传输层：固定打真实上游，不改 API_ROOT，不开任何 fixture。
        self.core = Core(database_path, paid_transport=WxrankTransport(timeout=25.0))
        self.dispatcher = Dispatcher(self.core, lambda: None)

    async def call(self, method: str, params: dict | None = None):
        message = {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}
        response = await self.dispatcher.handle(message)
        if 'error' in response:
            raise RuntimeError(f'{method} 失败：{response["error"]}')
        return response.get('result')

    async def handshake(self):
        await self.call('core.hello', {'protocol_version': PROTOCOL_VERSION})

    async def run_job(self, subscription_id: str, mode: str, page_budget: int | None = None):
        params = {'subscription_id': subscription_id, 'mode': mode}
        if page_budget is not None:
            params['page_budget'] = page_budget
        started = await self.call('sync.start', params)
        job_id = started['job_id']
        for _ in range(1200):
            job = await self.call('sync.get', {'job_id': job_id})
            if job.get('state') in {'succeeded', 'failed', 'partial', 'waiting', 'cancelled'}:
                return job
            await asyncio.sleep(0.1)
        raise AssertionError(f'任务 {job_id} 没有结束')

    async def ledger(self) -> dict:
        usage = await self.call('wxrank.usage')
        attempts = usage.get('attempts') or []
        return {
            'calls': usage['calls'],
            'confirmedCredits': usage['confirmed_credits'],
            'unknownCount': usage.get('unknown_count'),
            'balanceObserved': usage.get('balance'),
            'balanceObservedAt': usage.get('balanceObservedAt'),
            'attempts': [{'operation': row.get('operation'), 'status': row.get('status'),
                          'chargeState': row.get('chargeState'),
                          'confirmedCredits': row.get('confirmedCredits'),
                          'errorCode': row.get('errorCode'),
                          'balance': row.get('balance'),
                          'startedAt': row.get('startedAt')} for row in attempts],
        }

    async def close(self):
        await self.core.close()


async def run_flow(runner, key, biz, expected_wxid, reference, steps) -> None:
    """真实付费流程本体。"""
    # ---- 1. 保存密钥：走产品凭据桥与设置写入（不触网） ----
    await runner.call('credential.provide', {'reference': reference, 'secret': key})
    await runner.call('settings.update', {'section': 'channels',
                                          'patch': {'wxrank': {'enabled': True}},
                                          'credential_refs': {'wxrank': reference}})
    status = await runner.call('wxrank.status')
    assert status.get('configured'), '保存密钥后状态必须是已配置'
    steps.append({'step': '保存渠道密钥', 'paidCalls': 0, 'configured': True})

    # ---- 2. 免费本地检查：零付费请求 ----
    before = await runner.call('wxrank.usage')
    readiness = await runner.call('connection.check', {'connection_id': CONNECTION,
                                                        'operation': 'list_items'})
    after = await runner.call('wxrank.usage')
    assert after['calls'] == before['calls'], '本地检查不得触发任何付费调用'
    assert after['confirmed_credits'] == 0, '本地检查不得产生费用'
    steps.append({'step': '免费本地检查', 'paidCalls': 0,
                  'readinessState': readiness.get('state'),
                  'readinessDetail': readiness.get('detail')})

    # ---- 3. 冷解析：一次付费调用 ----
    source = await runner.call('source.resolve', {'locator': biz, 'connection_id': CONNECTION})
    usage = await runner.call('wxrank.usage')
    assert usage['calls'] == 1, f'冷解析只能一次调用：{usage}'
    assert source.get('external_id') == expected_wxid, \
        f'上游返回的账号身份与已授权缓存不一致：{source.get("external_id")}'
    steps.append({'step': '冷解析', 'paidCalls': 1, 'calls': usage['calls'],
                  'confirmedCredits': usage['confirmed_credits'],
                  'sourceName': source.get('name'),
                  'externalIdMatchesAuthorizedCache': True})

    # ---- 4. 确认添加：命中解析缓存，不再收费 ----
    subscription = await runner.call('subscription.add', {
        'locator': biz, 'connection_id': CONNECTION, 'confirmed': True})
    usage = await runner.call('wxrank.usage')
    assert usage['calls'] == 1, f'确认添加不得再收费：{usage}'
    # 采集条数 10：刷新与回溯都是一页一次调用。
    await runner.call('subscription.update', {'subscription_id': subscription['id'],
                                              'collect_items': 10})
    steps.append({'step': '确认添加（命中缓存）', 'paidCalls': 0, 'calls': usage['calls']})

    # ---- 5. 单页刷新：真实入库 ----
    job = await runner.run_job(subscription['id'], 'refresh')
    usage = await runner.call('wxrank.usage')
    assert job['state'] == 'succeeded', job.get('error')
    contents = await runner.call('content.list', {})
    assert contents['total'] > 0, '刷新后必须有真实内容入库'
    first = contents['items'][0]
    assert first['url'].startswith('https://mp.weixin.qq.com/s?'), first['url']
    assert 'mid=' in first['url'] and 'idx=' in first['url'], first['url']
    assert '&amp;' not in first['url'], '文章地址必须解开一层转义'
    published = (first.get('published') or {}).get('value')
    assert published, first
    steps.append({'step': '单页刷新（真实入库）', 'paidCalls': 1, 'calls': usage['calls'],
                  'confirmedCredits': usage['confirmed_credits'],
                  'contents': contents['total'],
                  'urlSampleMasked': mask_identity(first['url'], 28, 12),
                  'publishedAt': published,
                  'titleSample': (first.get('title') or '')[:24]})

    # ---- 6. 两次一页回溯：核对游标推进 ----
    for index in range(2):
        job = await runner.run_job(subscription['id'], 'backfill', page_budget=1)
        usage = await runner.call('wxrank.usage')
        assert job['state'] == 'succeeded', job.get('error')
        state = await runner.call('wxrank.status')
        checkpoint = ((state.get('sources') or [{}])[0].get('backfill') or {}).get('checkpoint') or {}
        contents = await runner.call('content.list', {})
        steps.append({'step': f'第{index + 1}次一页回溯', 'paidCalls': 1,
                      'calls': usage['calls'], 'confirmedCredits': usage['confirmed_credits'],
                      'contents': contents['total'], 'checkpointState': checkpoint.get('state'),
                      'checkpointNote': checkpoint.get('note')})

    # ---- 7. 隔离重启：检查点必须活过重启（本地核对，零付费调用） ----
    checkpoint_before = await runner.call('wxrank.status')
    before_state = ((checkpoint_before.get('sources') or [{}])[0].get('backfill') or {}).get('checkpoint') or {}
    await runner.close()
    runner.core = Core(runner.database_path, paid_transport=WxrankTransport(timeout=25.0))
    runner.dispatcher = Dispatcher(runner.core, lambda: None)
    await runner.handshake()
    # 主进程启动时会把受保护存储里的密钥重推给 Core。
    await runner.call('credential.provide', {'reference': reference, 'secret': key})
    after_state = await runner.call('wxrank.status')
    after_checkpoint = ((after_state.get('sources') or [{}])[0].get('backfill') or {}).get('checkpoint') or {}
    contents = await runner.call('content.list', {})
    assert after_checkpoint.get('state') == before_state.get('state'), \
        f'重启后检查点状态必须一致：{before_state} → {after_checkpoint}'
    steps.append({'step': '隔离重启（零付费调用核对进度）', 'paidCalls': 0,
                  'checkpointBefore': before_state.get('state'),
                  'checkpointAfterRestart': after_checkpoint.get('state'),
                  'contentsAfterRestart': contents['total']})

    # ---- 8. 重启后是否真的还能续采：有可继续位置才多花这一次 ----
    if after_checkpoint.get('state') == 'resume':
        job = await runner.run_job(subscription['id'], 'backfill', page_budget=1)
        usage = await runner.call('wxrank.usage')
        contents = await runner.call('content.list', {})
        steps.append({'step': '重启后续采（一页）', 'paidCalls': 1,
                      'state': job.get('state'), 'calls': usage['calls'],
                      'confirmedCredits': usage['confirmed_credits'],
                      'contents': contents['total']})
    else:
        steps.append({'step': '重启后续采', 'paidCalls': 0,
                      'skipped': '历史已到末页或没有可继续位置：不为了证明而多花钱',
                      'checkpointState': after_checkpoint.get('state')})


async def main() -> int:
    evidence: dict = {
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'upstream': protocol.API_ROOT,
        'transport': '正式 WxrankTransport（真实 HTTPS，无 fixture／无本机假上游）',
        'callBudget': MAX_CALLS,
    }

    key = read_wechat_key(CREDENTIAL_FILE)
    print('wechat 凭据已识别:', bool(key))
    evidence['wechatCredentialFound'] = bool(key)
    if not key:
        print('没有解析到 wechat 分组的密钥，停止（不发起任何付费调用）', file=sys.stderr)
        return 2

    lab = read_lab_biz(LAB_STATE)
    if not lab:
        print('已授权的实验缓存里没有可用的真实 biz，停止（不发起任何付费调用）', file=sys.stderr)
        return 2
    biz, expected_wxid = lab
    evidence['identity'] = {'bizMasked': mask_identity(biz), 'wxidMasked': mask_identity(expected_wxid)}
    print('真实 biz（脱敏）:', evidence['identity']['bizMasked'])

    reference = 'channel-wxrank-live-acceptance'
    temp = tempfile.TemporaryDirectory()
    database = Path(temp.name) / 'live-wxrank.sqlite3'
    runner = Runner(database)
    steps: list[dict] = []
    try:
        try:
            await runner.handshake()
            await run_flow(runner, key, biz, expected_wxid, reference, steps)
            evidence['ledger'] = await runner.ledger()
        except Exception as error:
            # 真实调用失败也要留证：如实记录上游答复与错误，不假报通过。
            evidence['error'] = f'{type(error).__name__}: {error}'
            try:
                evidence['ledger'] = await runner.ledger()
            except Exception:
                evidence['ledger'] = {}
            print('真实调用未完成：', evidence['error'], file=sys.stderr)
    finally:
        await runner.close()
        temp.cleanup()

    evidence['steps'] = steps
    ledger = evidence.get('ledger', {})
    assert ledger.get('calls', 0) <= MAX_CALLS, f'调用次数超出预算：{ledger.get("calls")}'
    OUTPUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(ledger, ensure_ascii=False, indent=2))
    for step in steps:
        print(' -', json.dumps(step, ensure_ascii=False))
    print('证据已写入:', OUTPUT)
    return 1 if evidence.get('error') else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
