-- M17 提醒运行状态。与内容状态分开：只保存「下一次该查了没有」。
-- 配置身份（signature）随记录写入，用于拒绝上一个提醒配置留下的旧记录。
CREATE TABLE reminder_run_state(
    id INTEGER PRIMARY KEY CHECK(id=1),
    signature TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    next_check_at INTEGER,
    last_handled_at INTEGER,
    last_result TEXT,
    notification_error TEXT,
    backoff_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
