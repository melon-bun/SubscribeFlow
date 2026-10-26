-- One public WeChat channel. Upstream account identities survive clearing the
-- optional profile/parse cache; unconfirmed resolutions need no Source row.
CREATE TABLE wechat_backend_identities (
    provider_id TEXT NOT NULL,
    biz TEXT NOT NULL,
    upstream_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(provider_id, biz)
);

-- Recovery evidence stays in the user's local database. It contains original
-- rows whenever identity normalization or merging changes their representation.
CREATE TABLE wechat_identity_migration_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    canonical_id TEXT NOT NULL,
    originals TEXT NOT NULL,
    created_at TEXT NOT NULL
);
