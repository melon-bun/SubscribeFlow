import inspect
import logging

from subscribe_flow import __version__
from subscribe_flow.contracts import ChannelError, jsonable
from . import PROTOCOL_VERSION


class RPCFault(Exception):
    def __init__(self, code, message, data=None):
        self.code, self.message, self.data = code, message, data


def validate(params, required=None, optional=None):
    required, optional = required or {}, optional or {}
    if not isinstance(params, dict) or set(params) - (required.keys() | optional.keys()) or required.keys() - params.keys():
        raise RPCFault(-32602, "参数字段不符合接口定义")
    for key, value in params.items():
        expected = (required | optional)[key]
        if type(value) is not expected:
            raise RPCFault(-32602, f"参数 {key} 类型不正确")
        if isinstance(value, str) and (not value or len(value) > 2000):
            raise RPCFault(-32602, f"参数 {key} 长度无效")
    return params


class Dispatcher:
    def __init__(self, core, shutdown):
        self.core, self.shutdown = core, shutdown
        self.handshaken = False
        self.routes = self._routes()

    def _routes(self):
        c, repo = self.core, self.core.repository
        # Each route declares exact keys and JSON value types. No reflection-based
        # arbitrary method dispatch, raw SQL, platform configuration or commands.
        return {
            "channel.list": (lambda: c.gateway.describe(), {}, {}),
            "connection.list": (repo.list_connections, {}, {}),
            "connection.check": (c.check_connection, {"connection_id": str}, {"operation": str}),
            "schedule.list": (c.scheduler.list, {}, {}),
            "schedule.status": (c.scheduler.status, {}, {}),
            "system.power": (c.scheduler.power, {"suspended": bool}, {}),
            "source.resolve": (c.subscriptions.resolve, {"locator": str, "connection_id": str}, {}),
            "source.search": (c.subscriptions.search, {"query": str, "connection_id": str}, {"limit": int}),
            "subscription.list": (c.queries.subscriptions, {}, {"include_cancelled": bool}),
            "subscription.add": (c.subscriptions.add, {"locator": str, "connection_id": str, "confirmed": bool}, {"interval_seconds": int, "sync_mode": str}),
            "subscription.update": (c.update_subscription, {"subscription_id": str}, {"status": str, "connection_id": str, "interval_seconds": int, "sync_mode": str}),
            "sync.start": (c.sync.start, {"subscription_id": str}, {"mode": str, "page_budget": int, "item_key": str}),
            "sync.cancel": (c.sync.cancel, {"job_id": str}, {}),
            "sync.retry": (c.sync.retry, {"job_id": str}, {"page_budget": int}),
            "sync.get": (repo.get_job, {"job_id": str}, {}),
            "sync.list": (c.queries.jobs, {}, {"limit": int, "offset": int}),
            "sync.coverage": (c.queries.coverage, {"subscription_id": str}, {}),
            "content.list": (c.queries.contents, {}, {"limit": int, "offset": int, "channel": str, "source_id": str, "query": str, "start": str, "end": str,
                                                      "read": bool, "archived": bool, "deferred": bool}),
            "content.get": (c.queries.content, {"item_id": str}, {}),
            "content.update": (c.content.update, {"item_id": str, "patch": dict}, {}),
            "content.bulk_update": (c.content.bulk_update, {"item_ids": list, "patch": dict}, {}),
        }

    async def handle(self, message):
        valid = (isinstance(message, dict) and message.get("jsonrpc") == "2.0" and
                 isinstance(message.get("method"), str) and
                 ("id" not in message or message["id"] is None or type(message["id"]) in {str, int}))
        if not valid:
            return self.error(None, -32600, "Invalid Request")
        request_id, method = message.get("id"), message["method"]
        try:
            params = message.get("params", {})
            if method == "core.hello":
                validate(params, {"protocol_version": str})
                if params["protocol_version"] != PROTOCOL_VERSION:
                    raise RPCFault(-32001, "协议版本不兼容")
                self.handshaken = True
                self.core.start()
                result = {"protocol_version": PROTOCOL_VERSION, "core_version": __version__, "methods": list(self.routes)}
            elif not self.handshaken:
                raise RPCFault(-32001, "请先完成协议握手")
            elif method == "core.shutdown":
                validate(params)
                self.shutdown()
                result = {"stopping": True}
            else:
                if method not in self.routes:
                    raise RPCFault(-32601, "Method not found")
                function, required, optional = self.routes[method]
                validate(params, required, optional)
                if "item_ids" in params and (len(params["item_ids"]) > 100 or any(type(item) is not str or not item or len(item) > 2000 for item in params["item_ids"])):
                    raise RPCFault(-32602, "内容 ID 列表无效")
                result = function(**params)
                if inspect.isawaitable(result):
                    result = await result
            response = {"jsonrpc": "2.0", "id": request_id, "result": jsonable(result)}
        except RPCFault as error:
            response = self.error(request_id, error.code, error.message, error.data)
        except ChannelError as error:
            response = self.error(request_id, -32000, error.message, error.to_dict())
        except Exception:
            logging.getLogger(__name__).exception("RPC internal error in %s", method)
            response = self.error(request_id, -32603, "Internal error")
        return response if "id" in message else None

    @staticmethod
    def error(request_id, code, message, data=None):
        error = {"code": code, "message": message}
        if data is not None:
            error["data"] = data
        return {"jsonrpc": "2.0", "id": request_id, "error": error}
