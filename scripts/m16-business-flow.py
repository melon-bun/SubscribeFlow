"""M16 业务接入证据：隔离数据目录中跑完整主链，调用正式 Provider。

范围与约束：
- 只用固定合成中文文本，不使用个人收藏，不碰日常数据库、登录态或真实标签；
- 密钥只在本进程内存中读取，不回显、不写入源码、日志或证据文件；
- 真实请求次数控制在个位数，无自动重试；
- 证据只记录 Provider / 模型标识 / 状态 / 候选标签名，不记录密钥或原文响应。

用法：
    PYTHONPATH=python/src python3 scripts/m16-business-flow.py \
        --config ../test_api_key.md --out docs/verification/m16-minimax/2026-10-18-r01
"""

import argparse
import asyncio
import json
import re
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python' / 'src'))
sys.path.insert(0, str(ROOT / 'scripts'))

# 复用既有脚本的读取方式：只解析，不打印。文件名带连字符，按路径加载。
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location('m16_live_models', ROOT / 'scripts' / 'm16-live-models.py')
_m16 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m16)
read_config = _m16.read_config

from subscribe_flow.bootstrap import Core  # noqa: E402
from subscribe_flow.contracts import ContentItem, Source  # noqa: E402
from subscribe_flow.contracts.models import PublishedTime  # noqa: E402

# 固定合成样本：内容明确，期望标签与目录一一对应，便于核对。
SAMPLES = [
    {'external_id': 'py-async', 'title': 'Python 异步编程实践笔记',
     'summary': '这篇笔记整理了 asyncio 事件循环、协程调度与类型标注的常见写法，并对比了同步实现的性能差异。',
     'tags': ['Python', '机器学习']},
    {'external_id': 'home-cooking', 'title': '家常红烧肉做法',
     'summary': '记录红烧肉的做法：五花肉焯水、冰糖炒色、小火慢炖两小时，最后大火收汁。',
     'tags': ['美食']},
]


def make_item(channel, sample):
    source = Source(channel=channel, kind='user', external_id='m16-evidence',
                    name='M16 证据夹具', url='https://example.invalid/m16')
    return ContentItem(channel=channel, namespace='feed', external_id=sample['external_id'],
                       source=source, title=sample['title'],
                       url=f'https://example.invalid/{sample["external_id"]}',
                       kind='video', summary=sample['summary'],
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


def build_core(path, mode, provider_cfg):
    class EmptyGateway:
        def describe(self):
            return []
    core = Core(path, gateway=EmptyGateway())
    # 凭据进内存容器，与桌面主进程推送凭据引用的路径一致。
    core.credentials.provide('m16-live', provider_cfg['api_key'])
    core.settings.update('tagging', {
        'enabled': True, 'mode': mode,
        'providers': {m: {'endpoint': provider_cfg['endpoint'], 'model': provider_cfg['model']}
                      for m in ('jev', 'llm')}},
        credential_refs={'jev': 'm16-live', 'llm': 'm16-live'})
    return core


def run_mode(mode, configs, out_dir):
    cfg = configs.get(mode)
    if not cfg or not all(cfg.get(k) for k in ('endpoint', 'model', 'api_key')):
        return {'mode': mode, 'skipped': '本机配置缺少该方式的完整参数，未发起请求'}
    record = {'mode': mode, 'requestedModel': cfg['model'], 'requests': 0, 'items': []}
    with tempfile.TemporaryDirectory(prefix='m16-evidence-') as tmp:
        core = build_core(Path(tmp) / 'evidence.sqlite3', mode, cfg)
        try:
            # 目录里放齐样本用到的标签，Jev 只在已有标签中选择。
            for name in ('Python', '机器学习', '美食'):
                core.tags.create(name, description=f'{name}相关内容')
            loop = asyncio.new_event_loop()
            for sample in SAMPLES:
                saved = core.repository.save_manual(make_item('m16fixture', sample))
                started = time.monotonic()
                loop.run_until_complete(core.tagging._run_once())
                record['requests'] += 1
                content = core.repository.get_content(saved['item_id'])
                applied = sorted(t['name'] for t in content.get('tags', []))
                task = core.repository.tagging.list_tasks(limit=1)['items'][0]
                record['items'].append({
                    'externalId': sample['external_id'],
                    'expected': sample['tags'],
                    'applied': applied,
                    'taskState': task['state'],
                    'appliedCount': task['applied_count'],
                    'provider': task['provider'],
                    'servedModel': task['model'],
                    'elapsedMs': int((time.monotonic() - started) * 1000),
                    'error': task['error_code'],
                })
            loop.close()
            record['summary'] = core.repository.tagging.summary()
        finally:
            try:
                core.database.close()
            finally:
                core.lease.close()
    return record


def load_configs(path):
    """优先复用既有读取器；它要求两种方式都完整，本脚本允许只配一种。"""
    try:
        return read_config(path)
    except (ValueError, TypeError):
        pass
    configs, mode = {}, None
    for line in Path(path).read_text().splitlines():
        stripped = line.strip().strip('`')
        if not stripped:
            continue
        header = re.fullmatch(r'[#*\s]*(jev|llm)[：:\s*#]*', stripped, re.I)
        if header:
            mode = stripped.strip('#* :：').lower()
            configs.setdefault(mode, {})
            continue
        if mode is None:
            continue
        key = re.match(r'(?:api[_ -]?key|key)\s*[:：=]\s*(.+)', stripped, re.I)
        model = re.match(r'(?:model|模型)\s*[:：=]\s*(.+)', stripped, re.I)
        if key:
            configs[mode]['api_key'] = key.group(1).strip().strip('`"\'')
        elif model:
            configs[mode]['model'] = model.group(1).strip().strip('`"\'')
        else:
            url = re.search(r'https://[^\s<>`"\']+', stripped)
            if url:
                configs[mode]['endpoint'] = url.group().rstrip(')/')
    return configs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, help='本机测试凭据文件（只读，不回显）')
    parser.add_argument('--out', required=True)
    parser.add_argument('--modes', default='llm,jev')
    args = parser.parse_args()

    configs = load_configs(Path(args.config))
    out_dir = ROOT / args.out if not Path(args.out).is_absolute() else Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    evidence = {'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'modes': []}
    for mode in [m.strip() for m in args.modes.split(',') if m.strip()]:
        evidence['modes'].append(run_mode(mode, configs, out_dir))

    total = sum(m.get('requests', 0) for m in evidence['modes'])
    evidence['totalLiveRequests'] = total
    evidence['note'] = ('固定合成中文样本；密钥仅在进程内存中读取，未回显或写入证据；'
                        '无自动重试；未使用个人数据与日常数据库。')

    path = out_dir / 'business-flow.json'
    path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(f'real requests: {total}')
    print(f'evidence: {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
