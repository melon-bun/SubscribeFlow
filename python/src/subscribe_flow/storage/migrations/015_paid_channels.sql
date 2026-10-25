-- M45 付费渠道：调用账本、来源解析缓存与回溯检查点。
--
-- 三张表都只存非敏感信息：没有密钥、没有请求体、没有响应原文。
-- 密钥由桌面凭据服务单独保管；这里只保留足以区分「哪一次调用、哪一把密钥」的版本号。
--
-- charge_state 只有三种取值，不引入第四种「大概没扣」：
--   confirmed    已确认消费（上游回了 code=0）
--   not_charged  服务端明确拒绝，未产生消费
--   unknown      结果未知：可能已扣费（网络未决、进程崩溃遗留）
-- confirmed_credits 只有在 charge_state='confirmed' 时才非零。

CREATE TABLE paid_channel_attempts(
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    connection_id TEXT,
    credential_version INTEGER NOT NULL DEFAULT 0,
    operation TEXT NOT NULL,
    biz TEXT,
    wxid TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed','unknown','cancelled')),
    charge_state TEXT NOT NULL CHECK(charge_state IN ('pending','confirmed','not_charged','unknown')),
    confirmed_credits INTEGER NOT NULL DEFAULT 0 CHECK(confirmed_credits >= 0),
    balance_credits INTEGER,
    balance_observed_at TEXT,
    error_code TEXT,
    error_message TEXT
);
CREATE INDEX paid_attempts_period ON paid_channel_attempts(started_at);
CREATE INDEX paid_attempts_channel ON paid_channel_attempts(channel, credential_version);

-- 来源解析缓存：规范 biz → 上游公众号身份。
-- 命中缓存时不再发付费请求，因此「解析 → 确认添加」与「重启后再解析」都不会重复扣费。
-- 缓存里的身份、来源定位地址与内容身份使用同一份规范 biz。
CREATE TABLE paid_channel_sources(
    biz TEXT PRIMARY KEY,
    gh_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    description TEXT,
    source_id TEXT NOT NULL,
    credential_version INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    resolved_at TEXT NOT NULL
);

-- 回溯检查点：服务端游标 + 凭据／解析版本。
-- 版本对不上时旧游标不再使用，避免把旧密钥下拿到的游标当成新密钥的位置。
CREATE TABLE paid_channel_checkpoints(
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    cursor TEXT,
    obtained_at TEXT NOT NULL,
    expires_at TEXT,
    credential_version INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    progress_version TEXT NOT NULL,
    UNIQUE(source_id, connection_id)
);
