import json
import logging
import os
import re
from datetime import datetime, timezone

from subscribe_flow.contracts import ChannelError, Readiness
from subscribe_flow.acquisition.cli import redact


def mapped_error(message: str, operation: str, context) -> ChannelError:
    lower = message.lower()
    code, scope, retryable = "ACCESS_FAILED", "operation", False
    advice = "访问失败，原因尚未确认；请检查浏览器当前页面和连接"
    if any(x in lower for x in ("auth_expired", "session expired", "登录过期")):
        code, scope, advice = "AUTH_EXPIRED", "connection", "浏览器会话已过期，请在 B站恢复登录"
    elif any(x in lower for x in ("auth_required", "not logged in", "login required", "未登录", "(-101)")):
        code, scope, advice = "AUTH_REQUIRED", "connection", "请在外部浏览器完成 B站登录"
    elif any(x in lower for x in ("captcha", "challenge", "验证码", "风控", "(-352)")):
        code, scope, advice = "INTERACTION_REQUIRED", "connection", "请在浏览器完成访问验证后手动检查连接"
    elif any(x in lower for x in ("rate_limit", "too many requests", "429")):
        code, scope, retryable, advice = "RATE_LIMITED", "connection", True, "请求受限，请稍后重试"
    elif any(x in lower for x in ("browser not connected", "no browser", "extension not connected", "econnrefused", "bridge is not connected", "browser connection")):
        code, scope, advice = "DEPENDENCY_UNAVAILABLE", "resource", "请启动 Chrome 并检查 OpenCLI 浏览器桥连接"
    elif any(x in lower for x in ("timeout", "timed out")):
        code, retryable, advice = "TIMEOUT", True, "采集超时，请稍后重试"
    elif any(x in lower for x in ("malformed", "schema", "not valid json")):
        code, scope, advice = "SCHEMA_CHANGED", "backend", "输出结构已变化，需要更新渠道解析器"
    elif any(x in lower for x in ("not found", "(-404)", "已删除", "不存在")):
        code, scope, advice = "SOURCE_UNAVAILABLE", "source", "目标内容或来源不可访问"
    key = {"connection": context.connection.id, "resource": context.connection.resource_key,
           "backend": "bilibili:opencli"}.get(scope)
    return ChannelError(code, operation, advice, scope=scope, scope_key=key, retryable=retryable,
                        retry_after=300 if code == "RATE_LIMITED" else None)


class BilibiliOpenCLIBackend:
    def __init__(self, transport, executable="opencli"):
        self.transport, self.executable = transport, executable
        self.version = None

    async def verify_version(self, context, operation):
        if self.version is None:
            result = await self.transport.run([self.executable, "--version"], context, operation)
            if result.returncode:
                raise mapped_error(result.stderr, operation, context)
            version = result.stdout.strip()
            if version != "1.8.8":
                raise ChannelError("SCHEMA_CHANGED", operation,
                                   "当前仅验收 OpenCLI 1.8.8，请重新验证已安装版本的输出结构",
                                   scope="backend", scope_key="bilibili:opencli")
            self.version = version

    async def call(self, args, context, operation):
        await self.verify_version(context, operation)
        env = {**os.environ, "NO_COLOR": "1", "OPENCLI_BROWSER_CONNECT_TIMEOUT": "15",
               "OPENCLI_BROWSER_COMMAND_TIMEOUT": "30"}
        result = await self.transport.run([self.executable, "bilibili", *args, "-f", "json", "--trace", "off"],
                                          context, operation, env=env)
        if result.returncode:
            logging.getLogger(__name__).warning("OpenCLI %s failed: %s", operation, redact(result.stderr + "\n" + result.stdout))
            raise mapped_error(redact(result.stderr + "\n" + result.stdout), operation, context)
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ChannelError("SCHEMA_CHANGED", operation, "采集工具未返回有效 JSON", scope="backend", scope_key="bilibili:opencli") from exc

    async def check_readiness(self, operation, context):
        now = datetime.now(timezone.utc).isoformat()
        try:
            await self.verify_version(context, operation)
        except ChannelError as error:
            if error.code in {"CANCELLED", "TIMEOUT"}:
                raise
            return Readiness("blocked", operation, error.message, error.scope, error.scope_key or context.connection.id,
                             now, ("check_dependencies",), "unavailable")
        return Readiness("unknown", operation, "工具版本可用；浏览器、操作权限及认证由实际请求确认",
                         "connection", context.connection.id, now, ("retry",), "tool_available", "unknown")
