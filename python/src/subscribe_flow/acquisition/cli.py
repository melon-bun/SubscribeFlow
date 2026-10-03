from __future__ import annotations

import asyncio
import os
import re
import signal
from dataclasses import dataclass

from subscribe_flow.contracts import ChannelError, Context
from .resources import ResourceCoordinator


def redact(text: str) -> str:
    text = re.sub(r"(?im)(cookie|authorization|set-cookie)\s*[:=][^\r\n]*", r"\1: [REDACTED]", text)
    text = re.sub(r"(?i)(SESSDATA|bili_jct|access_token|refresh_token|api[_-]?key|token|password)\s*[=:]\s*[^\s;&\"']+",
                  r"\1=[REDACTED]", text)
    text = re.sub(r"(https?://[^\s?]+)\?[^\s]+", r"\1?[REDACTED]", text)
    return text[:2000]


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    returncode: int


class CLITransport:
    def __init__(self, resources: ResourceCoordinator, *, max_output: int = 2_000_000):
        self.resources, self.max_output = resources, max_output

    async def run(self, argv: list[str], context: Context, operation: str,
                  *, env: dict[str, str] | None = None) -> CommandResult:
        if not argv or not all(isinstance(arg, str) and "\0" not in arg for arg in argv):
            raise ValueError("Expected a nonempty argument array")
        async with self.resources.acquire(context, operation):
            try:
                process = await asyncio.create_subprocess_exec(
                    *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env=env, start_new_session=(os.name == "posix"))
            except FileNotFoundError as exc:
                raise ChannelError("DEPENDENCY_UNAVAILABLE", operation, "找不到采集工具，请配置可执行文件路径",
                                   scope="resource", scope_key=context.connection.resource_key) from exc
            total = 0

            async def read(stream):
                nonlocal total
                chunks = []
                while data := await stream.read(16384):
                    total += len(data)
                    if total > self.max_output:
                        raise ChannelError("OUTPUT_LIMIT", operation, "工具输出超过大小限制")
                    chunks.append(data)
                return b"".join(chunks).decode("utf-8", errors="replace")

            async def collect():
                stdout, stderr = await asyncio.gather(read(process.stdout), read(process.stderr))
                code = await process.wait()
                return CommandResult(stdout, redact(stderr), code)

            output = asyncio.create_task(collect())
            try:
                while not output.done():
                    context.check(operation)
                    await asyncio.wait({output}, timeout=0.05)
                context.check(operation)
                return output.result()
            finally:
                # A tool may leave children behind after its own exit. Only this job's
                # private process group is terminated, never the user's browser.
                await self._stop(process)
                if not output.done():
                    output.cancel()
                await asyncio.gather(output, return_exceptions=True)

    @staticmethod
    async def _stop(process):
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif process.returncode is None:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 0.3)
        except TimeoutError:
            pass
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.returncode is None:
            process.kill()
        await process.wait()
