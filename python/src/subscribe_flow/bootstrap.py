from subscribe_flow.acquisition.cli import CLITransport
from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.bilibili.adapter import BilibiliAdapter
from subscribe_flow.channels.bilibili.backends.opencli import BilibiliOpenCLIBackend


def build_gateway(opencli_path: str = "opencli") -> ChannelGateway:
    gateway = ChannelGateway()
    gateway.register(BilibiliAdapter(BilibiliOpenCLIBackend(CLITransport(ResourceCoordinator()), opencli_path)))
    return gateway
