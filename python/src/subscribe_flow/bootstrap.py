from subscribe_flow.acquisition.cli import CLITransport
from subscribe_flow.acquisition.resources import ResourceCoordinator
from subscribe_flow.channels.gateway import ChannelGateway


def build_gateway(opencli_path: str = "opencli") -> ChannelGateway:
    gateway = ChannelGateway()
    return gateway
