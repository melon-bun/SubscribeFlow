CREATE TABLE connections (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, backend TEXT NOT NULL,
    resource_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    readiness TEXT
);
CREATE TABLE sources (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, kind TEXT NOT NULL,
    external_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
    confirmed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel, kind, external_id)
);
CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
    connection_id TEXT NOT NULL REFERENCES connections(id),
    status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled')),
    version INTEGER NOT NULL DEFAULT 1,
    interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK(interval_seconds >= 300),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE contents (
    id TEXT PRIMARY KEY, channel TEXT NOT NULL, namespace TEXT NOT NULL,
    external_id TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT,
    payload TEXT NOT NULL, first_seen_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(channel, namespace, external_id)
);
CREATE TABLE content_sources (
    content_id TEXT NOT NULL REFERENCES contents(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    PRIMARY KEY(content_id, source_id)
);
CREATE TABLE content_states (
    content_id TEXT PRIMARY KEY REFERENCES contents(id),
    read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    deferred INTEGER NOT NULL DEFAULT 0 CHECK(deferred IN (0,1)),
    updated_at TEXT NOT NULL
);
CREATE TABLE jobs (
    id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
    mode TEXT NOT NULL CHECK(mode IN ('initial','refresh','backfill','detail')),
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','partial','failed','waiting','cancelled','interrupted')),
    snapshot TEXT NOT NULL, item_key TEXT,
    pages INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL DEFAULT 0,
    new_items INTEGER NOT NULL DEFAULT 0, item_errors INTEGER NOT NULL DEFAULT 0,
    coverage TEXT NOT NULL DEFAULT 'unknown', cursor TEXT, error TEXT, end_evidence TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_scan ON jobs(subscription_id)
    WHERE state IN ('queued','running','waiting') AND mode != 'detail';
CREATE UNIQUE INDEX one_active_detail ON jobs(item_key)
    WHERE state IN ('queued','running','waiting') AND mode = 'detail';
CREATE TABLE fetch_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
    page_index INTEGER NOT NULL, item_count INTEGER NOT NULL, new_count INTEGER NOT NULL,
    errors TEXT NOT NULL, coverage TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(job_id, page_index)
);
CREATE TABLE sync_progress (
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
    backend TEXT NOT NULL, progress_version TEXT NOT NULL, content_range TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('refresh','backfill')),
    connection_version INTEGER NOT NULL, subscription_version INTEGER NOT NULL,
    payload TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(subscription_id, backend, progress_version, content_range, mode)
);
CREATE INDEX content_timeline ON contents(published_at DESC, id DESC);
CREATE INDEX source_content ON content_sources(source_id, content_id);
CREATE INDEX jobs_recent ON jobs(updated_at DESC);
