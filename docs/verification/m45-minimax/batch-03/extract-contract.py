#!/usr/bin/env python3
"""从本机实验文档里提取「协议结构」，不输出任何秘密或真实身份。

用途：M45.6 要把适配器对齐上游真实契约（字段名、业务码、链接转义形态），
但真实密钥与真实公众号身份不能进入模型上下文或证据文件。

做法：正则脱敏后打印结构；真实密钥/身份只在本机进程内解析。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BASE = Path("/Users/xor/Documents/xiaohongshu_login_test")

MASKS: list[tuple[re.Pattern[str], str]] = [
    # 密钥 / 凭据类字段（大小写不敏感）
    (re.compile(r"(?i)\b(api[_-]?key|app[_-]?key|secret|token|sign|密钥|秘钥|口令)\b\s*[：:=]\s*[\"'`]?[A-Za-z0-9_\-]{8,}[\"'`]?"), r"\1=<REDACTED>"),
    # 裸的长 token
    (re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"), "<TOKEN>"),
    # 公众号与文章身份
    (re.compile(r"__biz=[^&\"'\s\\]+"), "__biz=<BIZ>"),
    (re.compile(r"(?i)\b(wxid|user_name|gh_id|fakeid)\b\s*[：:=]\s*[\"'`]?[A-Za-z0-9_\-]{6,}[\"'`]?"), r"\1=<ID>"),
    (re.compile(r"gh_[A-Za-z0-9_\-]{4,}"), "gh_<ID>"),
    (re.compile(r"\b(mid|idx|sn)=[^&\"'\s\\]+"), r"\1=<N>"),
    # 名称 / 头像 / 封面等身份类字段
    (re.compile(r"(?i)\"(name|nickname|title|signature|avatar|hd_head_img|pic_url|hd_head_img|art_url|img)\"\s*:\s*\"[^\"]*\""), r'"\1":"<MASKED>"'),
    (re.compile(r"(?i)(头像|名称|微信号|公众号名)\s*[：:=]\s*\S+"), r"\1=<MASKED>"),
]


def mask(text: str) -> str:
    for pattern, replacement in MASKS:
        text = pattern.sub(replacement, text)
    return text


def summarize_json_blocks(text: str) -> list[str]:
    """把文档里的 JSON 片段解析成「键 + 类型」结构，避免打印真实值。"""
    out: list[str] = []

    def shape(value, depth: int = 0) -> str:
        if depth > 4:
            return "…"
        if isinstance(value, dict):
            return "{" + ", ".join(f'"{k}": {shape(v, depth + 1)}' for k, v in value.items()) + "}"
        if isinstance(value, list):
            head = shape(value[0], depth + 1) if value else "∅"
            return f"[{head} ×{len(value)}]"
        if isinstance(value, bool):
            return "bool"
        if isinstance(value, (int, float)):
            return "number"
        if value is None:
            return "null"
        return "string"

    for match in re.finditer(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", text, re.S):
        chunk = match.group(0)
        if '"' not in chunk or len(chunk) > 4000:
            continue
        try:
            parsed = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        out.append(shape(parsed))
    return out


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    targets = [
        BASE / "docs" / "公众号推文列表付费API方案.md",
        BASE / "docs" / "验证记录.md",
    ]
    if only:
        targets = [t for t in targets if only in t.name]
    for target in targets:
        print(f"===== {target.name} =====")
        if not target.exists():
            print("(不存在)")
            continue
        raw = target.read_text(encoding="utf-8", errors="replace")
        masked = mask(raw)
        print(masked)
        print(f"----- JSON 结构摘要 -----")
        for shape_line in summarize_json_blocks(raw):
            print(shape_line)
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
