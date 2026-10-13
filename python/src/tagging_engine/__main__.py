"""识别包的独立调试入口。

用法（不启动 Electron、不创建业务数据库、不经过 Core）：

    PYTHONPATH=src python3 -m tagging_engine '<JSON 请求>'
    PYTHONPATH=src python3 -m tagging_engine --file request.json
    PYTHONPATH=src python3 -m tagging_engine --file request.json --env

请求 JSON：{"mode","endpoint","model","apiKey" 或 "apiKeyEnv","text","title","candidates","limit"}
输出：一行 JSON 的 RecognitionResult 或 {"error":{...}}。

密钥只从参数或环境变量读取，既不回显也不落盘。
"""

from __future__ import annotations

import json
import os
import sys

from .contracts import RecognitionError, RecognitionRequest
from .registry import build_provider


def run(payload: dict) -> dict:
    request = RecognitionRequest.from_dict(payload)
    provider = build_provider(
        request.mode,
        endpoint=payload.get('endpoint', ''),
        model=payload.get('model', ''),
        api_key=_api_key(payload),
        threshold=payload.get('threshold'),
        batch=payload.get('batch'),
        timeout=payload.get('timeout'),
    )
    return provider.recognize(request).to_dict()


def _api_key(payload: dict) -> str | None:
    key = payload.get('apiKey')
    if isinstance(key, str) and key:
        return key
    name = payload.get('apiKeyEnv')
    # 只认显式指定的环境变量名，不去遍历整个环境。
    return os.environ.get(name) if isinstance(name, str) and name else None


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if '--help' in argv or '-h' in argv:
        print(__doc__.strip())
        return 0
    try:
        if '--file' in argv:
            index = argv.index('--file')
            with open(argv[index + 1], encoding='utf-8') as handle:
                payload = json.load(handle)
        elif argv:
            payload = json.loads(argv[0])
        else:
            payload = json.load(sys.stdin)
    except (OSError, ValueError) as error:
        print(json.dumps({'error': {'code': 'invalid_input', 'message': f'无法读取请求：{error}'}}, ensure_ascii=False))
        return 2
    try:
        result = run(payload)
    except RecognitionError as error:
        print(json.dumps({'error': error.to_dict()}, ensure_ascii=False))
        return 1
    except (ValueError, KeyError) as error:
        print(json.dumps({'error': {'code': 'invalid_input', 'message': str(error)}}, ensure_ascii=False))
        return 2
    # 输出里不含密钥：请求字段不回显。
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())