import asyncio
import itertools
from subscribe_flow.contracts import ChannelError


class BrowserBridge:
    """Private Core -> Main RPC. No cookies, URLs or executable scripts."""

    def __init__(self):
        self.send = None
        self.pending = {}
        self.ids = itertools.count(1)

    def receive(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or "method" in message:
            return False
        request_id = message.get("id")
        if not isinstance(request_id, str) or not request_id.startswith("browser:"):
            return False
        future = self.pending.get(request_id)
        if future and not future.done():
            future.set_result(message)
        return True

    async def call(self, params, context, operation):
        context.check(operation)
        if self.send is None:
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation, "请从桌面应用打开 B站连接",
                               scope="connection", scope_key=context.connection.id)
        request_id = f"browser:{next(self.ids)}"
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        finished = False
        try:
            await self.send({"jsonrpc": "2.0", "id": request_id, "method": "acquisition.request", "params": params})
            while not future.done():
                context.check(operation)
                await asyncio.wait({future}, timeout=0.1)
            context.check(operation)
            response = future.result()
            finished = True
            if error := response.get("error"):
                data = error.get("data") or {}
                raise ChannelError(data.get("code", "ACCESS_FAILED"), operation, str(error.get("message", "应用内采集失败"))[:2000],
                                   scope="connection", scope_key=context.connection.id,
                                   retryable=data.get("retryable") is True, retry_after=data.get("retry_after"))
            if "result" not in response:
                raise ChannelError("SCHEMA_CHANGED", operation, "应用内采集响应无效")
            return response["result"]
        finally:
            self.pending.pop(request_id, None)
            future.cancel()
            if not finished and self.send:
                await self.send({"jsonrpc": "2.0", "method": "acquisition.cancel", "params": {"id": request_id}})
