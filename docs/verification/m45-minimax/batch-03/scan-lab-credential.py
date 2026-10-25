#!/usr/bin/env python3
"""在授权的本机公众号付费实验目录里定位真实 wxrank 密钥。

只报告「文件、位置、长度、上下文关键词」，不打印任何密钥片段。
找不到就如实说找不到：真实付费流程缺凭据属于外部阻塞，不能伪造。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

BASE = Path("/Users/xor/Documents/xiaohongshu_login_test")
SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv"}

#: wxrank 密钥的形态：与「公众号付费 API」相关的长 token。
TOKEN = re.compile(r"[A-Za-z0-9_\-]{20,64}")
CONTEXT = re.compile(r"(?i)wxrank|data\.wxrank\.com|积分|付费|充值|getinfo|getps|api[_-]?key|密钥")


def interesting(line: str) -> bool:
    if not CONTEXT.search(line):
        return False
    return bool(TOKEN.search(line))


def main() -> int:
    findings = []
    scanned = 0
    for path in sorted(BASE.rglob("*")):
        if any(part in SKIP for part in path.parts):
            continue
        if not path.is_file() or path.stat().st_size > 4_000_000:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        scanned += 1
        for number, line in enumerate(text.splitlines(), 1):
            if interesting(line):
                tokens = TOKEN.findall(line)
                findings.append({
                    "file": str(path.relative_to(BASE)),
                    "line": number,
                    "tokenCount": len(tokens),
                    "tokenLengths": sorted({len(t) for t in tokens}),
                    "hasWxrankHost": "data.wxrank.com" in line,
                    "hasKeyWord": bool(re.search(r"(?i)key|密钥", line)),
                })
    print(json.dumps({
        "scannedFiles": scanned,
        "findingCount": len(findings),
        "findings": findings[:80],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
