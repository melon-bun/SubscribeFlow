ALTER TABLE jobs ADD COLUMN page_budget INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual';
UPDATE jobs SET page_budget=10 WHERE mode='backfill';
ALTER TABLE subscriptions ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'manual' CHECK(sync_mode IN ('manual','automatic'));
UPDATE subscriptions SET interval_seconds=86400 WHERE interval_seconds=3600;
UPDATE subscriptions SET interval_seconds=259200 WHERE interval_seconds>259200;

CREATE TABLE schedules (
    subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
    version INTEGER NOT NULL,
    next_due REAL,
    failures INTEGER NOT NULL DEFAULT 0,
    last_job_id TEXT REFERENCES jobs(id),
    last_state TEXT,
    retry_job_id TEXT REFERENCES jobs(id),
    reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE schedule_blocks (
    scope TEXT NOT NULL, scope_key TEXT NOT NULL, operation TEXT NOT NULL,
    error TEXT NOT NULL, until_at REAL,
    PRIMARY KEY(scope, scope_key, operation)
);
CREATE INDEX schedules_due ON schedules(next_due);
