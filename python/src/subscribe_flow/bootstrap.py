from subscribe_flow.acquisition.cli import CLITransport
from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.bilibili.adapter import BilibiliAdapter
from subscribe_flow.channels.bilibili.backends.opencli import BilibiliOpenCLIBackend
from subscribe_flow.channels.bilibili.electron import BilibiliElectronAdapter
from subscribe_flow.channels.xiaohongshu.adapter import XiaohongshuAdapter
from subscribe_flow.application.subscriptions import SubscriptionService
from subscribe_flow.application.sync import SyncService
from subscribe_flow.application.intake import IntakeService
from subscribe_flow.application.content import ContentService
from subscribe_flow.application.queries import QueryService
from subscribe_flow.application.priorities import PriorityService
from subscribe_flow.application.tags import TagService
from subscribe_flow.application.scheduler import Scheduler
from subscribe_flow.contracts import Connection
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
from subscribe_flow.storage.lease import CoreLease
import logging


def build_gateway(opencli_path: str = "opencli", browser_bridge=None) -> ChannelGateway:
    gateway = ChannelGateway()
    if browser_bridge is not None:
        gateway.register(BilibiliElectronAdapter(browser_bridge))
        gateway.register(XiaohongshuAdapter(browser_bridge))
    else:
        gateway.register(BilibiliAdapter(BilibiliOpenCLIBackend(CLITransport(ResourceCoordinator()), opencli_path)))
    return gateway


class Core:
    def __init__(self, database_path, *, opencli_path="opencli", gateway=None, browser_bridge=None, schedule_policy=None, clock=None, recognition_provider=None):
        self.lease = CoreLease(database_path)
        try:
            self.database = Database(database_path)
        except BaseException:
            self.lease.close()
            raise
        self.repository = Repository(self.database)
        self.repository.recover_interrupted()
        self.browser_bridge = browser_bridge
        self.gateway = gateway if gateway is not None else build_gateway(opencli_path, browser_bridge)
        self.listeners = []
        self.closed = False
        self.subscriptions = SubscriptionService(self.gateway, self.repository)
        self.sync = SyncService(self.gateway, self.repository, self.emit)
        self.intake = IntakeService(self.gateway, self.repository, self.emit, self.sync.resources,
                                    resource_gap=lambda: self.sync.resource_gap,
                                    suspended=lambda: self.sync.suspended)
        self.content = ContentService(self.repository, self.emit)
        self.priorities = PriorityService(self.repository, self.emit)
        # 默认不注入识别提供者：人工标签完整可用，识别接口明确返回未接入。
        self.tags = TagService(self.repository, self.emit, recognition_provider)
        self.queries = QueryService(self.repository, self.gateway)
        for descriptor in self.gateway.describe():
            resource = f"browser:electron-{descriptor.channel}" if descriptor.backend == "electron-session" else "browser:opencli-default"
            self.repository.add_connection(Connection(f"{descriptor.channel}:default", descriptor.channel, descriptor.backend, resource))
            if descriptor.backend == "electron-session":
                # One-way upgrade of known legacy connections. Version invalidates
                # old cursors/checkpoints without deleting subscriptions or content.
                for connection in self.repository.list_connections():
                    if descriptor.channel == "bilibili" and connection["channel"] == "bilibili" and connection["backend"] == "opencli":
                        self.repository.update_connection(connection["id"], backend="electron-session", resource_key=resource)
        self.scheduler = Scheduler(self, policy=schedule_policy, **({'clock': clock} if clock else {}))
        self.listeners.append(self.scheduler.observe)
        self.sync.guard = self.scheduler.guard

    def start(self):
        self.sync.resource_gap = self.scheduler.policy.resource_gap
        self.scheduler.start()

    async def check_connection(self, connection_id, operation='list_items'):
        readiness = await self.subscriptions.check_connection(connection_id, operation)
        await self.scheduler.connection_checked(connection_id, readiness)
        return readiness

    def emit(self, event, data):
        for listener in tuple(self.listeners):
            try:
                listener(event, data)
            except Exception:
                logging.getLogger(__name__).exception("Event listener failed")

    async def update_subscription(self, subscription_id, **patch):
        result = self.subscriptions.update(subscription_id, **patch)
        await self.sync.cancel_subscription(subscription_id)
        self.emit("subscription.changed", {"id": subscription_id})
        self.scheduler.store.ensure(result, self.scheduler.clock())
        return result

    async def close(self):
        if not self.closed:
            await self.scheduler.close()
            await self.intake.close()
            await self.sync.close()
            self.database.close()
            self.lease.close()
            self.closed = True
