-- Per-subscription collection ceiling expressed in items (1-50). Zero keeps the
-- historical defaults: one page for refresh, ten pages for backfill. Pages are
-- derived from this value at job creation time, so existing jobs keep their budget.
ALTER TABLE subscriptions ADD COLUMN collect_items INTEGER NOT NULL DEFAULT 0
    CHECK(collect_items BETWEEN 0 AND 50);
