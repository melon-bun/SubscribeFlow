"""Bounded live checks using the production tagging providers.

Credentials are read into memory from the user-designated local configuration.
Only synthetic samples and redacted results are written to the evidence folder.
No retries, business database, or desktop settings are involved.
"""

import argparse
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python' / 'src'))

from tagging_engine import RecognitionError, RecognitionRequest, build_provider
from tagging_engine.transport import HttpTransport


BASIC = {
    'id': 'basic',
    'text': '本文介绍如何使用 Python 训练一个机器学习分类器。',
    'title': '机器学习入门',
    'candidates': [
        {'id': 'python', 'name': 'Python', 'description': 'Python 编程语言的使用、开发与教程'},
        {'id': 'ml', 'name': '机器学习', 'description': '机器学习算法、模型训练与评估'},
        {'id': 'food', 'name': '美食', 'description': '菜谱、烹饪与餐厅体验'},
    ],
    'expected': ['python', 'ml'],
}


def read_config(path):
    configs, mode = {}, None
    for line in path.read_text().splitlines():
        line = line.strip().strip('`')
        if not line:
            continue
        if re.fullmatch(r'[#*\s]*(jev|llm)[：:\s*#]*', line, re.I):
            mode = line.strip('#* :：').lower()
            configs.setdefault(mode, {})
            continue
        if mode is None:
            continue
        key_match = re.match(r'(?:api[_ -]?key|key)\s*[:：=]\s*(.+)', line, re.I)
        model_match = re.match(r'(?:model|模型)\s*[:：=]\s*(.+)', line, re.I)
        if key_match:
            configs[mode]['api_key'] = key_match.group(1).strip().strip('`\"\'')
        elif model_match:
            configs[mode]['model'] = model_match.group(1).strip().strip('`\"\'')
        else:
            url = re.search(r'https://[^\s<>`\"\']+', line)
            if url:
                configs[mode]['endpoint'] = url.group().rstrip(')/')
    for selected in ('jev', 'llm'):
        if not all(configs.get(selected, {}).get(k) for k in ('endpoint', 'model', 'api_key')):
            raise ValueError(f'{selected}: incomplete local test configuration')
        parsed = urlsplit(configs[selected]['endpoint'])
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query:
            raise ValueError(f'{selected}: test endpoint must be HTTPS without embedded credentials')
    return configs


class ObservedTransport:
    """Observe real production HTTP without storing headers or request secrets."""

    def __init__(self, timeout):
        self.real = HttpTransport(timeout=timeout)
        self.calls = []

    def post_json(self, url, payload, headers, timeout=None):
        call = {'endpoint': url, 'request_model': payload.get('model')}
        self.calls.append(call)
        started = time.monotonic()
        try:
            status, body = self.real.post_json(url, payload, headers, timeout)
            call['http_status'] = status
            call['response_fields'] = sorted(body)
            call['served_model'] = body.get('model')
            # Retain every score, including candidates selected by Jev's top-two fallback.
            if isinstance(body.get('answers'), dict):
                call['probabilities'] = {
                    str(k): v.get('noul') for k, v in body['answers'].items()
                    if isinstance(v, dict) and type(v.get('noul')) in (int, float)
                }
            if isinstance(body.get('choices'), list):
                call['finish_reasons'] = [v.get('finish_reason') for v in body['choices'] if isinstance(v, dict)]
                call['content_lengths'] = [
                    len(v.get('message', {}).get('content') or '')
                    for v in body['choices'] if isinstance(v, dict) and isinstance(v.get('message'), dict)
                ]
            if isinstance(body.get('usage'), dict):
                call['usage'] = body['usage']
            # Some gateways return a JSON error envelope with HTTP 200.
            base = body.get('base_resp')
            if isinstance(base, dict):
                call['service_status_code'] = base.get('status_code')
            return status, body
        except RecognitionError as error:
            call['error_code'] = error.code
            raise
        finally:
            call['elapsed_ms'] = round((time.monotonic() - started) * 1000)


def recognize(mode, config, sample, timeout):
    observer = ObservedTransport(timeout)
    request = RecognitionRequest.from_dict({
        'item_id': f"live-test:{sample['id']}", 'mode': mode,
        'title': sample.get('title', ''), 'text': sample['text'],
        'candidates': sample.get('candidates', BASIC['candidates']), 'limit': 5,
    })
    result = {'mode': mode, 'sample_id': sample['id'],
              'sample_sha256': hashlib.sha256(sample['text'].encode()).hexdigest(),
              'prompt_contract': 'production-llm-system-prompt/jev-noul',
              'threshold': 0.8 if mode == 'jev' else None,
              'selection_policy': 'threshold_or_top2' if mode == 'jev' else 'llm_free_tags'}
    try:
        provider = build_provider(mode, **config, transport=observer, timeout=timeout)
        result['recognition'] = provider.recognize(request).to_dict()
        result['format_passed'] = True
    except RecognitionError as error:
        result['error'] = error.to_dict()
        result['format_passed'] = False
    except Exception as error:
        # Unexpected exceptions are recorded by type, never repr/traceback.
        result['error'] = {'code': 'unexpected', 'type': type(error).__name__}
        result['format_passed'] = False
    result['calls'] = observer.calls
    result['real_call_succeeded'] = bool(observer.calls) and result['format_passed']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=Path)
    parser.add_argument('--modes', nargs='+', choices=['jev', 'llm'], default=['jev', 'llm'])
    parser.add_argument('--timeout', type=float, default=60)
    args = parser.parse_args()
    try:
        configs = read_config(args.config)
    except (ValueError, OSError) as error:
        print(json.dumps({'configuration_error': type(error).__name__}))
        return 2
    if args.samples:
        manifest = json.loads(args.samples.read_text())
        samples = [dict(sample, candidates=manifest['catalogue']) for sample in manifest['samples']]
    else:
        samples = [BASIC]
    if not 1 <= len(samples) <= 32:
        raise SystemExit('Live test budget requires 1 to 32 samples per mode')
    args.output.mkdir(parents=True, exist_ok=True)

    def run_mode(mode):
        results = []
        for sample in samples:
            result = recognize(mode, configs[mode], sample, args.timeout)
            results.append(result)
            path = args.output / f'{mode}-{sample["id"]}.json'
            path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'mode': mode, 'sample': sample['id'],
                              'real_call_succeeded': result['real_call_succeeded'],
                              'error_code': result.get('error', {}).get('code')}, ensure_ascii=False), flush=True)
            # Avoid repeated paid failures; investigate before another call.
            if not result['format_passed']:
                break
        return mode, results

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = dict(executor.map(run_mode, args.modes))
    report = {'time_utc': datetime.now(timezone.utc).isoformat(),
              'sample_count_requested_per_mode': len(samples),
              'retries': 0, 'synthetic_samples_only': True,
              'business_database_used': False, 'results': results}
    (args.output / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    return 0 if all(r['format_passed'] for values in results.values() for r in values) else 1


if __name__ == '__main__':
    raise SystemExit(main())
