"""在本机定位可用的 wxrank 付费凭据，**只输出路径与元信息，绝不输出秘密本身**。

给 M45.6 真实验收用：脚本扫描候选文件，找形如 API 密钥的长串，
只报告「哪个文件、哪一行、长度、前后各 2 个字符的掩码」，
完整值不打印、不写盘、不进日志。
"""
import json
import os
import re
import sys
from pathlib import Path

CANDIDATE_DIRS = [
    Path.home() / "Desktop",
    Path.home() / "Documents",
    Path.home() / "Downloads",
    Path("/Users/xor/Documents/Subscribe_Call"),
    Path("/Users/xor/Documents/Subscribe_Call/doc"),
]
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".venv", "__pycache__", "runtime", ".pytest_cache"}
TEXT_SUFFIXES = {".md", ".txt", ".json", ".yaml", ".yml", ".env", ".ini", ".cfg", ".conf", ".key", ".sh", ".py"}
# 形如 sk-xxx / 32+ 位十六进制 / 20+ 位大小写数字混排
SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),
    re.compile(r"\b[A-Za-z0-9]{24,}\b"),
]
KEYWORD = re.compile(r"wxrank|data\.wxrank|微积分|付费|积分|key|密钥|token|secret", re.I)


def mask(value: str) -> str:
    if len(value) <= 6:
        return "*" * len(value)
    return value[:2] + "*" * (len(value) - 4) + value[-2:]


def looks_like_secret(text: str) -> bool:
    stripped = text.strip().strip('`"\'')
    if len(stripped) < 16 or stripped.lower() in {"key", "api_key", "apikey", "token", "secret"}:
        return False
    if not re.search(r"[A-Za-z]", stripped):
        return False
    if not re.search(r"\d", stripped):
        return False
    return any(pattern.fullmatch(stripped) or pattern.search(stripped) for pattern in SECRET_PATTERNS)


def scan(path: Path):
    findings = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return findings
    for number, line in enumerate(text.splitlines(), start=1):
        if not looks_like_secret(line):
            continue
        nearby = ""
        for offset in range(max(0, number - 4), min(len(text.splitlines()), number + 3)):
            nearby += text.splitlines()[offset] + "\n"
        findings.append({
            "file": str(path),
            "line": number,
            "masked": mask(line.strip().strip('`"\'')),
            "length": len(line.strip().strip('`"\'')),
            "contextKeywords": sorted({w.lower() for w in KEYWORD.findall(nearby)})[:8],
        })
    return findings


def main():
    findings = []
    seen = set()
    for directory in CANDIDATE_DIRS:
        if not directory.exists():
            continue
        for root, dirs, files in os.walk(directory):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                path = Path(root) / name
                if path in seen:
                    continue
                seen.add(path)
                if path.suffix.lower() not in TEXT_SUFFIXES and name not in {".env"}:
                    continue
                if path.stat().st_size > 512 * 1024:
                    continue
                findings.extend(scan(path))
    print(json.dumps({"findings": findings}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
