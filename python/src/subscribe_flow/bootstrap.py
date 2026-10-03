from subscribe_flow.acquisition.cli import CLITransport
from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.bilibili.adapter import BilibiliAdapter
from subscribe_flow.channels.bilibili.backends.opencli import BilibiliOpenCLIBackend
from subscribe_flow.application.subscriptions import SubscriptionService
from subscribe_flow.application.sync import SyncService
from subscribe_flow.application.content import ContentService
from subscribe_flow.application.queries import QueryService
from subscribe_flow.contracts import Connection
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository
from subscribe_flow.storage.lease import CoreLease
import logging


def build_gateway(opencli_path: str = "opencli") -> ChannelGateway:
    gateway = ChannelGateway()
    gateway.register(BilibiliAdapter(BilibiliOpenCLIBackend(CLITransport(ResourceCoordinator()), opencli_path)))
    return gateway


class Core:
    def __init__(self, database_path, *, opencli_path="opencli", gateway=None):
        self.lease = CoreLease(database_path)
        try:
            self.database = Database(database_path)
        except BaseException:
            self.lease.close()
            raise
        self.repository = Repository(self.database)
        self.repository.recover_interrupted()
        self.gateway = gateway if gateway is not None else build_gateway(opencli_path)
        self.listeners = []
        self.closed = False
        self.subscriptions = SubscriptionService(self.gateway, self.repository)
        self.sync = SyncService(self.gateway, self.repository, self.emit)
        self.content = ContentService(self.repository, self.emit)
        self.queries = QueryService(self.repository)
        for descriptor in self.gateway.describe():
            self.repository.add_connection(Connection(f"{descriptor.channel}:default", descriptor.channel, descriptor.backend,
                                                      "browser:opencli-default"))

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
        return result

    async def close(self):
        if not self.closed:
            await self.sync.close()
            self.database.close()
            self.lease.close()
            self.closed = True
