-- Previous versions allowed overlapping processing flags. There are no
-- per-flag timestamps, so retain archive first, then deferred, then read.
CREATE TABLE content_states_v3 (
    content_id TEXT PRIMARY KEY REFERENCES contents(id),
    read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0,1)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    deferred INTEGER NOT NULL DEFAULT 0 CHECK(deferred IN (0,1)),
    updated_at TEXT NOT NULL,
    CHECK(read + archived + deferred <= 1)
);
INSERT INTO content_states_v3(content_id,read,archived,deferred,updated_at)
SELECT content_id,
       CASE WHEN archived=1 OR deferred=1 THEN 0 ELSE read END,
       archived,
       CASE WHEN archived=1 THEN 0 ELSE deferred END,
       updated_at
FROM content_states;
DROP TABLE content_states;
ALTER TABLE content_states_v3 RENAME TO content_states;
