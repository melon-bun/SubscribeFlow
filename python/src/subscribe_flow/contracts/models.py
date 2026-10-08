from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass, field, is_dataclass
from typing import Any, Literal, Protocol

CONTRACT_VERSION = "1.1"
Operation = Literal["resolve_source", "search_sources", "list_items", "get_item_detail",
                    "match_item_url", "resolve_item", "read_item"]


def jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return jsonable(asdict(value))
    if isinstance(value, dict):
        return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return value


class ChannelError(Exception):
    def __init__(self, code: str, operation: str, message: str, *,
                 scope: str = "operation", scope_key: str | None = None,
                 retryable: bool = False, retry_after: float | None = None):
        super().__init__(message)
        self.code, self.operation, self.message = code, operation, message
        self.scope, self.scope_key = scope, scope_key
        self.retryable, self.retry_after = retryable, retry_after

    def to_dict(self) -> dict:
        return dict(code=self.code, operation=self.operation, message=self.message,
                    scope=self.scope, scope_key=self.scope_key,
                    retryable=self.retryable, retry_after=self.retry_after)


@dataclass(frozen=True)
class OperationCapability:
    supported: bool
    verified: bool = False
    authentication: str = "unknown"
    dependencies: tuple[str, ...] = ()
    pagination: str = "none"
    ordering: str = "unknown"
    full_history: bool = False
    notes: str = ""


@dataclass(frozen=True)
class ChannelDescriptor:
    channel: str
    name: str
    backend: str
    operations: dict[str, OperationCapability]
    contract_version: str = CONTRACT_VERSION
    adapter_version: str = "1"
    parser_version: str = "1"
    progress_version: str = "1"
    content_types: tuple[str, ...] = ("video",)
    page_size: int = 20
    default_refresh_budget: int = 1
    default_backfill_budget: int = 10
    scan_overhead_budget: int = 0
    budget_unit: str = "pages"


@dataclass(frozen=True)
class Connection:
    id: str
    channel: str
    backend: str
    resource_key: str
    version: int = 1
    enabled: bool = True


@dataclass
class Context:
    connection: Connection
    job_id: str
    deadline: float
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)
    source: Source | None = None

    def check(self, operation: str) -> None:
        if self.cancelled.is_set():
            raise ChannelError("CANCELLED", operation, "任务已取消", scope="job", scope_key=self.job_id)
        if time.monotonic() >= self.deadline:
            raise ChannelError("TIMEOUT", operation, "执行超过时间限制", retryable=True)
        if not self.connection.enabled:
            raise ChannelError("DEPENDENCY_UNAVAILABLE", operation, "连接已停用",
                               scope="connection", scope_key=self.connection.id)


@dataclass(frozen=True)
class Source:
    channel: str
    kind: str
    external_id: str
    name: str
    url: str
    confirmed: bool = False
    avatar: str | None = None
    description: str | None = None

    @property
    def key(self) -> str:
        return f"{self.channel}:{self.kind}:{self.external_id}"


@dataclass(frozen=True)
class PublishedTime:
    value: str | None = None
    precision: str = "unknown"
    provenance: str = "unavailable"
    timezone: str | None = None
    raw_label: str | None = None


@dataclass(frozen=True)
class ContentItem:
    channel: str
    namespace: str
    external_id: str
    source: Source
    title: str
    url: str
    kind: str = "video"
    published: PublishedTime = field(default_factory=PublishedTime)
    summary: str | None = None
    thumbnail: str | None = None
    duration_seconds: int | None = None
    acquisition_complete: bool = False

    @property
    def key(self) -> str:
        return f"{self.channel}:{self.namespace}:{self.external_id}"


@dataclass(frozen=True)
class ContentPatch:
    item_key: str
    fields: dict[str, Any]


@dataclass(frozen=True)
class ContentReference:
    """Adapter-confirmed identity; URL retains any channel-required share locator."""
    channel: str
    namespace: str
    external_id: str
    url: str

    @property
    def key(self) -> str:
        return f"{self.channel}:{self.namespace}:{self.external_id}"


@dataclass(frozen=True)
class FetchRequest:
    mode: Literal["initial", "refresh", "backfill"] = "refresh"
    cursor: dict | None = None
    progress: dict | None = None
    limit: int = 20
    content_range: str = "videos"
    known_ids: tuple[str, ...] = ()
    item_budget: int | None = None


@dataclass(frozen=True)
class ItemError:
    index: int
    code: str
    message: str


@dataclass(frozen=True)
class FetchPage:
    items: tuple[ContentItem, ...]
    next_cursor: dict | None
    coverage: str
    terminal: bool = False
    end_evidence: str | None = None
    candidate_progress: dict | None = None
    item_errors: tuple[ItemError, ...] = ()
    scan_advanced: bool = False
    metrics: dict[str, int] = field(default_factory=dict)

    def __post_init__(self):
        if self.terminal and (not self.end_evidence or self.next_cursor is not None):
            raise ValueError("A terminal page requires evidence and no next cursor")
        if self.coverage == "history_end" and not self.terminal:
            raise ValueError("history_end requires terminal evidence")


@dataclass(frozen=True)
class SourcePage:
    items: tuple[Source, ...]
    next_cursor: dict | None = None


@dataclass(frozen=True)
class Readiness:
    state: Literal["ready", "blocked", "degraded", "unknown"]
    operation: str
    reason: str
    scope: str
    scope_key: str
    checked_at: str
    actions: tuple[str, ...] = ()
    dependency: str = "unknown"
    authentication: str = "unknown"
    retry_after: float | None = None


class ChannelAdapter(Protocol):
    def describe(self) -> ChannelDescriptor: ...
    async def resolve_source(self, locator: str, context: Context) -> Source: ...
    async def check_readiness(self, operation: str, context: Context) -> Readiness: ...
    async def fetch_page(self, source: Source, request: FetchRequest, context: Context) -> FetchPage: ...
    async def search_sources(self, query: str, request: FetchRequest, context: Context) -> SourcePage: ...
    async def get_item_detail(self, item_ref: str, context: Context) -> ContentPatch: ...


class ItemLinkAdapter(Protocol):
    """Optional capabilities; existing subscription adapters need not implement these."""
    def match_item_url(self, url: str) -> bool: ...
    async def resolve_item(self, url: str, context: Context) -> ContentReference: ...
    async def read_item(self, reference: ContentReference, context: Context) -> ContentItem: ...
