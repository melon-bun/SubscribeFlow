-- M16 自动打标：持久事件与后台任务。
--
-- 两张表分别承载两个「持久事实」（计划 §3.5）：
--
-- content_events 记录「某条内容被首次成功保存」。订阅分页与手动确认保存
-- 共用这一条事实；预览、取消、重复收录都不写。事件不携带模型配置、密钥或
-- 标签结果——它只说明「这条内容第一次出现了」，具体怎么处理由消费者决定。
--
-- tagging_tasks 是登记的后台任务。消费位置与任务登记在同一事务里推进，
-- 因此崩溃后不会出现「事件被消费但任务没登记」的丢任务，也不会出现重复
-- 消费同一事件产生的重复任务。
--
-- 事件名只保留 content.created 一种：打标自身写标签不发新事件，避免
-- 自己触发自己形成的循环（计划 §3.5 第 3 条明确禁止监听通用 content.changed）。

CREATE TABLE content_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK(name IN ('content.created')),
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    -- 保存瞬间的内容文本版本。消费时用它判断这条内容后来是否变过。
    content_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- 非空表示已被消费。消费位置就是这张表的 id + consumed_at，
    -- 退出与重启后从这里继续，不依赖任何内存游标。
    consumed_at TEXT,
    consumed_by TEXT
);
-- 未消费事件按写入顺序取，这是后台任务的唯一唤醒依据。
CREATE INDEX content_events_pending ON content_events(consumed_at, id);
-- 同一条内容只记录一次首次保存事实：重复收录走这个唯一约束。
CREATE UNIQUE INDEX content_events_once ON content_events(name, content_id);

CREATE TABLE tagging_tasks (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    -- 任务身份三元组：内容、文本版本、配置版本。标签目录版本单独记，
    -- 因为改标签目录不该让模型配置看起来变过，反之亦然。
    content_version TEXT NOT NULL,
    config_version INTEGER NOT NULL,
    catalog_version TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('jev','llm')),
    state TEXT NOT NULL CHECK(state IN (
        'queued','running','retry_wait','blocked','succeeded','skipped','failed','cancelled')),
    -- 幂等键：同一内容 + 同一版本 + 同一配置/目录版本只登记一次。
    -- 重复保存、手动补打多次点击与重启恢复都撞在这个唯一索引上。
    dedupe_key TEXT NOT NULL UNIQUE,
    -- 用户主动重跑时递增的一轮次。点击多次产生同一轮，不会并发。
    round_no INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_attempt_at TEXT,
    -- 运行租约：崩溃后过期的 running 任务可被回收重排（计划 §3.5 第 9 条）。
    lease_expires_at TEXT,
    -- 来源：auto 来自首次保存事件，backfill 来自用户主动补打。
    origin TEXT NOT NULL DEFAULT 'auto' CHECK(origin IN ('auto','backfill')),
    provider TEXT,
    model TEXT,
    usage TEXT,
    -- 只保存分类与脱敏文案，不保存原始响应或全文。
    error_code TEXT,
    error_message TEXT,
    detail TEXT,
    skipped_reason TEXT,
    -- 落库结果摘要，便于界面显示而不必回查关联表。
    applied_count INTEGER NOT NULL DEFAULT 0,
    blocked_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);
-- 取下一个可执行任务：有界队列的核心查询，重启恢复也走它。
CREATE INDEX tagging_tasks_ready ON tagging_tasks(state, next_attempt_at);
CREATE INDEX tagging_tasks_content ON tagging_tasks(content_id, created_at);
