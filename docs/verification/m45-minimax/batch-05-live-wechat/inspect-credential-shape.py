#!/usr/bin/env python3
"""查看凭据文件的**结构**（不是内容）：行号、标题层级、字段名。

所有取值一律替换成 <VALUE>；长 token 一律打码。
目的只是让解析规则对准真实的分组标题与字段名，不让密钥进模型上下文。
"""

from __future__ import annotations

import re
from pathlib import Path

SOURCE = Path("/Users/xor/Documents/Subscribe_Call/test_api_key.md")


def mask(line: str) -> str:
    masked = re.sub(r"(?i)\b(key|api[_-]?key|secret|token|password|密钥|秘钥|口令)\b\s*[：:=]\s*.*$",
                    r"\1: <VALUE>", line)
    masked = re.sub(r"(?i)([A-Za-z0-9_\-]*(?:key|token|secret)[A-Za-z0-9_\-]*)\s*[：:=]\s*\S+",
                    r"\1: <VALUE>", masked)
    # 任何长 token 都打码：宁可多遮，也不漏。
    masked = re.sub(r"\b[A-Za-z0-9_\-]{16,}\b", "<TOKEN>", masked)
    return masked


def main() -> int:
    text = SOURCE.read_text(encoding="utf-8", errors="replace")
    for number, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            print(f"{number:>3}| <空行>")
            continue
        kind = "标题" if stripped.startswith("#") else ("字段" if ":" in stripped or "：" in stripped else "文本")
        print(f"{number:>3}| {kind}| {mask(stripped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
