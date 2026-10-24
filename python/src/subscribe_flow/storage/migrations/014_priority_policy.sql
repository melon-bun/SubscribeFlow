-- M40–M41：智能优先级的策略状态、任务队列与结果失效。
--
-- 本迁移同样只新增表与触发器，不改动任何既有列的含义。
--
-- 1) priority_policy：当前生效的智能策略，只有一行。
--    读取最终优先级时会拿它和结果行比对：功能关闭、换连接或改策略之后，
--    旧结果立即退出生效范围，读取马上回退人工值／来源值，不等下次模型完成。
--
-- 2) priority_tasks：每条内容最多一条任务。请求去重、有限并发、
--    有限退避重试、退出取消与重启恢复都靠这张表；进程重启后
--    崩溃残留的 running 任务会被收回队列，不会永远卡住。
--
-- 3) 结果失效触发器：判断输入一变，旧结果立刻删掉。
--    删掉而不是标脏，是因为「有效智能值」要能在一条 SQL 里读出来，
--    读路径没有机会先做一次复杂的重新判定。

-- --------------------------------------------------------------- 1) 当前策略

CREATE TABLE priority_policy (
    id INTEGER PRIMARY KEY CHECK(id=1),
    -- 智能判断总开关。关闭时读取立即回退人工值／来源值。
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    -- 所选连接 ID（LLM 或 Jev 由它的协议决定）。
    provider_id TEXT,
    -- 策略版本与连接调用版本：与结果行里的同名字段对上才算有效。
    policy_version TEXT NOT NULL DEFAULT '',
    provider_version TEXT NOT NULL DEFAULT '',
    -- 偏好统计已经按哪一版口径聚合过。旧迁移不会给历史数据标脏，
    -- 所以首次启用或升级后要按这个版本做一次本地聚合。
    stats_version TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

-- --------------------------------------------------------------- 2) 任务队列

CREATE TABLE priority_tasks (
    -- 一条内容同时只有一个任务：请求去重就靠这个唯一键。
    content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('pending','running','succeeded','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    -- 有限退避：可重试的失败退到下一次尝试时间。
    next_attempt_at TEXT,
    reason TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX priority_tasks_due ON priority_tasks(state, next_attempt_at);

-- --------------------------------------------------------------- 3) 结果失效

-- 标签关联变了：判断输入变了，旧结果退出生效范围。
CREATE TRIGGER priority_decision_drop_on_link AFTER INSERT ON content_tags
BEGIN
    DELETE FROM content_priority_decisions WHERE content_id = NEW.content_id;
END;

CREATE TRIGGER priority_decision_drop_on_unlink AFTER DELETE ON content_tags
BEGIN
    DELETE FROM content_priority_decisions WHERE content_id = OLD.content_id;
END;

-- 人工改档（含恢复自动）：用户已经表过态，旧结果不能再冒出来。
CREATE TRIGGER priority_decision_drop_on_state AFTER UPDATE OF priority_override ON content_states
WHEN OLD.priority_override IS NOT NEW.priority_override
BEGIN
    DELETE FROM content_priority_decisions WHERE content_id = NEW.content_id;
END;

-- 标题改了：目标标题是上下文的一部分，旧结果基于旧标题。
CREATE TRIGGER priority_decision_drop_on_title AFTER UPDATE OF title ON contents
WHEN OLD.title IS NOT NEW.title
BEGIN
    DELETE FROM content_priority_decisions WHERE content_id = NEW.id;
END;

-- 标签改名、改描述／别名或停用：这些字段进上下文，相关内容的结果一并失效。
CREATE TRIGGER priority_decision_drop_on_tag AFTER UPDATE OF name, description, synonyms, enabled ON tags
WHEN OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description
  OR OLD.synonyms IS NOT NEW.synonyms OR OLD.enabled IS NOT NEW.enabled
BEGIN
    DELETE FROM content_priority_decisions WHERE content_id IN (
        SELECT content_id FROM content_tags WHERE tag_id = NEW.id);
END;
