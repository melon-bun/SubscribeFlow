"""M45.6 真实 LLM 验收：走正式产品的 AI 网关与连接测试。

与 wxrank 付费调用无关，也不碰任何付费接口：
这里只证明「正式产品的 AI 链路能用真实服务跑通」，不替代任何付费渠道证据。

凭据处理（硬要求）：
- ``test_api_key.md`` 只由本机进程直接解析，密钥只在内存里；
- 不打印密钥、不打印含密钥的整段配置、不写源码／日志／证据；
- 证据里只留脱敏的 host、protocol、model、调用次数、成功与否、
  非空回答的长度与前若干字符、以及服务返回的 usage。

走的是产品自己的链路：
``Dispatcher → ai.provider.test → AiGateway.test_connection → 协议适配器 → HttpTransport``，
和界面上的「测试连接」是同一条路。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'python' / 'src'))

from subscribe_flow.ai.transport import HttpTransport          # noqa: E402
from subscribe_flow.bootstrap import Core                        # noqa: E402
from subscribe_flow.rpc.dispatcher import Dispatcher, PROTOCOL_VERSION  # noqa: E402

CREDENTIAL_FILE = ROOT.parent / 'test_api_key.md'
OUTPUT = Path(__file__).resolve().parent / 'real-llm-evidence.json'
TIMEOUT = 90.0


# --------------------------------------------------------------- 凭据（只在内存里）

def load_credentials(path):
    """读凭据文件，返回 {组名: {'url','model','key','host'}}。

    文件里没有组名：按出现顺序分组。按协议特征判断组名，不打印任何值。
    """
    sections, current = [], {}
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line.strip():
            if current:
                sections.append(current)
                current = {}
            continue
        if ':' not in line:
            continue
        key, _, value = line.partition(':')
        key = key.strip().lstrip('-*# ').strip().lower()
        value = value.strip()
        if key in ('key', 'url', 'model') and value:
            current[key] = value
    if current:
        sections.append(current)
    groups = {}
    for section in sections:
        if 'url' not in section or 'key' not in section:
            continue
        host = urlparse(section['url']).netloc
        name = 'jev' if 'typesafe' in host else 'llm'
        groups[name] = {'url': section['url'], 'model': section.get('model', ''),
                        'key': section['key'], 'host': host}
    return groups


class TapTransport:
    """真实传输外面套一层观测。

    只记服务标识、请求形态与响应里的非空结果与用量：
    请求头、密钥与完整响应原文都不碰。
    """

    def __init__(self, inner):
        self.inner = inner
        self.calls = []
        self.last = None

    def post_json(self, url, payload, headers=None, timeout=None):
        parsed = urlparse(url)
        record = {'host': parsed.netloc, 'path': parsed.path,
                  'model': payload.get('model'),
                  'roles': [m.get('role') for m in payload.get('messages', [])],
                  'hasAuthorization': bool(headers and headers.get('Authorization'))}
        self.calls.append(record)
        status, body = self.inner.post_json(url, payload, headers, timeout)
        record['status'] = status
        record['response'] = self._summarize(body)
        self.last = record
        return status, body

    @staticmethod
    def _summarize(body):
        if not isinstance(body, dict):
            return {'unexpected': type(body).__name__}
        summary = {}
        choices = body.get('choices')
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            message = choices[0].get('message')
            content = message.get('content') if isinstance(message, dict) else None
            if isinstance(content, str):
                summary['answerChars'] = len(content)
                summary['answerHead'] = content.strip()[:120]
        answers = body.get('answers')
        if isinstance(answers, dict):
            summary['answerIds'] = sorted(answers)
        usage = body.get('usage')
        if isinstance(usage, dict) and usage:
            summary['usage'] = usage
        if 'model' in body and isinstance(body['model'], str):
            summary['model'] = body['model']
        return summary


# --------------------------------------------------------------- 用产品自己的 RPC 跑

async def run_provider(group_name, credential, provider_id, protocol):
    """在隔离数据库里走一遍正式 RPC 的连接测试。"""
    transport = TapTransport(HttpTransport(TIMEOUT))
    temp = tempfile.TemporaryDirectory()
    core = Core(Path(temp.name) / f'{group_name}.sqlite3', ai_transport=transport)
    dispatcher = Dispatcher(core, lambda: None)
    evidence = {'provider_id': provider_id, 'protocol': protocol,
                'host': credential['host'], 'configuredModel': credential['model'],
                'keyProvided': bool(credential['key'])}
    try:
        # 与界面「保存 AI 连接」同一条路径：设置里登记连接，凭据进受保护存储。
        core.credentials.provide(provider_id, credential['key'])
        core.settings.update('ai', {'providers': {provider_id: {
            'protocol': protocol, 'endpoint': credential['url'],
            'model': credential['model']}}},
            {provider_id: provider_id})

        hello = await dispatcher.handle({'jsonrpc': '2.0', 'id': 0, 'method': 'core.hello',
                                         'params': {'protocol_version': PROTOCOL_VERSION}})
        evidence['rpcReachable'] = 'result' in hello

        started = time.time()
        response = await dispatcher.handle({'jsonrpc': '2.0', 'id': 1, 'method': 'ai.provider.test',
                                            'params': {'provider_id': provider_id}})
        evidence['elapsedSeconds'] = round(time.time() - started, 2)
        if 'result' in response:
            result = response['result']
            evidence['rpc'] = 'ai.provider.test'
            evidence['ok'] = bool(result.get('ok'))
            evidence['provider'] = result.get('provider')
            evidence['model'] = result.get('model')
            evidence['message'] = result.get('message')
            if not result.get('ok'):
                evidence['code'] = result.get('code')
                evidence['retryable'] = result.get('retryable')
        else:
            evidence['rpc'] = 'ai.provider.test'
            evidence['ok'] = False
            evidence['error'] = response.get('error')
        evidence['calls'] = len(transport.calls)
        evidence['requests'] = transport.calls
    finally:
        await core.close()
        temp.cleanup()
    return evidence


async def main():
    if not CREDENTIAL_FILE.exists():
        print('找不到凭据文件', file=sys.stderr)
        return 2
    credentials = load_credentials(CREDENTIAL_FILE)
    if not credentials:
        print('凭据文件里没有可用的配置', file=sys.stderr)
        return 2
    evidence = {'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                'credentialFile': str(CREDENTIAL_FILE),
                'note': '密钥只在进程内使用：证据里没有密钥、没有请求头、没有完整响应原文。',
                'providers': []}
    for group_name, provider_id, protocol in (('llm', 'provider-llm', 'openai_chat'),
                                              ('jev', 'provider-jev', 'jev_systemone')):
        credential = credentials.get(group_name)
        if not credential:
            evidence['providers'].append({'provider_id': provider_id,
                                           'skipped': '凭据文件里没有这一组'})
            continue
        try:
            result = await run_provider(group_name, credential, provider_id, protocol)
        except Exception as error:
            result = {'provider_id': provider_id, 'protocol': protocol,
                      'host': credential['host'], 'configuredModel': credential['model'],
                      'ok': False, 'error': f'{type(error).__name__}: {error}',
                      'calls': 0}
        evidence['providers'].append(result)
    OUTPUT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')

    for provider in evidence['providers']:
        if provider.get('skipped'):
            print(f"=== {provider['provider_id']}：{provider['skipped']} ===")
            continue
        print(f"=== {provider['provider_id']} / {provider['host']} / "
              f"{provider.get('model') or provider.get('configuredModel')} ===")
        print(f"  ok={provider.get('ok')} calls={provider.get('calls')} "
              f"message={provider.get('message') or provider.get('error')}")
        for request in provider.get('requests', []):
            print(f"  请求 host={request.get('host')} path={request.get('path')} "
                  f"model={request.get('model')} status={request.get('status')} "
                  f"回答字符数={request.get('response', {}).get('answerChars')} "
                  f"用量={request.get('response', {}).get('usage')}")
    print('证据已写入:', OUTPUT)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
