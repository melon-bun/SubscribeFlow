-- M36 智能优先级：固定数据与决策契约。
--
-- 本迁移只**新增**表与一列，不改动任何既有列的含义：
-- 人工优先级（content_states.priority_override）、来源默认优先级
-- （subscriptions.default_priority）、标签与归档状态原样保留。
--
-- 四块新增数据：
--
-- 1) priority_preference_groups / priority_preference_samples
--    隐藏的偏好统计。唯一键是「优先级 × 标签 ID」，每组记全量去重条数，
--    以及最近两条内容引用（只有内容 ID、首次采集时间与标题缓存，没有正文）。
--    统计可以由原始关系重建，因此它永远不反过来影响人工值与标签。
--
-- 2) priority_preference_dirty
--    失效队列。短时间内的多次失效合并成一条，重建时按需处理。
--
-- 3) content_priority_decisions
--    每条内容最新一条智能结果，连同它的版本元数据。人工设置、智能结果、
--    来源默认值三者分开保存，不共用覆盖字段。
--
-- 4) content_states.manual_priority_version
--    人工改档次数。它是「单条人工操作版本」：用户改过优先级后，旧的智能
--    结果必须失效，而已读、归档等状态切换不应该作废任何判断结果。
--
-- 失效判定交给触发器，而不是散落在各个写入路径里：人工改档、批量操作、
-- 手动收录、自动打标写入与内容删除（级联）因此走的是同一条路，不会因为
-- 漏掉某个入口而留下过期统计。触发器只负责「标脏」，重建逻辑只有一份，
-- 且可重复执行。

-- --------------------------------------------------------------- 1) 偏好统计分组

CREATE TABLE priority_preference_groups (
    priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    -- 用户设为该优先级、且关联该标签的去重内容数。计数是全量的，
    -- 两条最近标题只是语义参考，不代表统计只覆盖这两篇。
    content_count INTEGER NOT NULL DEFAULT 0 CHECK(content_count >= 0),
    -- 统计版本。每次重建递增，用于失效判断与缓存更新。
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(priority, tag_id)
);
CREATE INDEX priority_preference_groups_tag ON priority_preference_groups(tag_id);

-- --------------------------------------------------------------- 2) 每组最近两条引用

CREATE TABLE priority_preference_samples (
    priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
    tag_id TEXT NOT NULL,
    sample_order INTEGER NOT NULL CHECK(sample_order IN (1,2)),
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    -- 首次采集／收录时间。「最近」按它排序，不按发布时间或用户改档时间。
    first_seen_at TEXT NOT NULL,
    -- 标题缓存。可以由内容重建，不是权威数据。
    title TEXT NOT NULL DEFAULT '',
    -- 分组被清掉（例如该档已经没有任何内容）时，样本随之消失。
    FOREIGN KEY(priority, tag_id) REFERENCES priority_preference_groups(priority, tag_id) ON DELETE CASCADE,
    PRIMARY KEY(priority, tag_id, sample_order)
);
CREATE INDEX priority_preference_samples_content ON priority_preference_samples(content_id);

-- --------------------------------------------------------------- 3) 失效队列

CREATE TABLE priority_preference_dirty (
    priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    marked_at TEXT NOT NULL,
    PRIMARY KEY(priority, tag_id)
);

-- --------------------------------------------------------------- 4) 最新智能结果

CREATE TABLE content_priority_decisions (
    content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
    -- 业务决策：四选一。unknown 是合法结果，不是错误。
    priority TEXT NOT NULL CHECK(priority IN ('high','medium','low','unknown')),
    -- 执行状态：这次判断为什么是这个结果。业务决策与执行状态分开保存，
    -- 因此「模型说无法判断」不会被记成「调用失败」。
    status TEXT NOT NULL CHECK(status IN (
        'ok','model_unknown','invalid_response','not_configured','timeout',
        'network_failed','cancelled','input_budget_exceeded','no_title',
        'no_tags','no_evidence','inconsistent')),
    provider_id TEXT,
    model TEXT,
    -- 上下文指纹：模型返回后据此判断输入是否已经变了。
    context_fingerprint TEXT NOT NULL DEFAULT '',
    content_version TEXT NOT NULL DEFAULT '',
    tag_version TEXT NOT NULL DEFAULT '',
    manual_version INTEGER NOT NULL DEFAULT 0,
    preference_version TEXT NOT NULL DEFAULT '',
    policy_version TEXT NOT NULL DEFAULT '',
    -- 所选连接的调用版本。切换连接或改模型后，旧结果据此失效。
    provider_version TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX content_priority_decisions_updated ON content_priority_decisions(updated_at);

-- --------------------------------------------------------------- 5) 人工改档版本

ALTER TABLE content_states ADD COLUMN manual_priority_version INTEGER NOT NULL DEFAULT 0;

-- --------------------------------------------------------------- 失效触发器

-- 人工改档（含恢复自动）：旧档位与新档位都要重建，人工操作版本加一。
CREATE TRIGGER priority_stats_state_changed AFTER UPDATE OF priority_override ON content_states
WHEN OLD.priority_override IS NOT NEW.priority_override
BEGIN
    UPDATE content_states SET manual_priority_version = manual_priority_version + 1
        WHERE content_id = NEW.content_id;
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT NEW.priority_override, ct.tag_id, NEW.updated_at FROM content_tags ct
        WHERE ct.content_id = NEW.content_id AND NEW.priority_override IS NOT NULL;
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT OLD.priority_override, ct.tag_id, NEW.updated_at FROM content_tags ct
        WHERE ct.content_id = OLD.content_id AND OLD.priority_override IS NOT NULL;
END;

-- 新增标签关联：该内容所在的人工档位要重建。
CREATE TRIGGER priority_stats_tag_linked AFTER INSERT ON content_tags
BEGIN
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT s.priority_override, NEW.tag_id, NEW.created_at FROM content_states s
        WHERE s.content_id = NEW.content_id AND s.priority_override IS NOT NULL;
END;

-- 移除标签关联：这里标三档而不是一档。删除可能来自内容被删除（级联），
-- 那时内容本身已经不在，档位无从得知；标三档是安全的——重建按真实关系重算，
-- 多标的两档会被算成空组并清掉。标签本身被删除时不再标脏：那一档的统计
-- 随标签一起级联删除，重建时也查不到这个标签。
CREATE TRIGGER priority_stats_tag_unlinked AFTER DELETE ON content_tags
BEGIN
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT p.priority, OLD.tag_id, OLD.created_at
        FROM (SELECT 'high' AS priority UNION ALL SELECT 'medium' UNION ALL SELECT 'low') p
        WHERE EXISTS(SELECT 1 FROM tags t WHERE t.id = OLD.tag_id);
END;

-- 标签停用／恢复：停用后该标签不参与判断，其统计随之退出；恢复时重建。
CREATE TRIGGER priority_stats_tag_enabled AFTER UPDATE OF enabled ON tags
WHEN OLD.enabled IS NOT NEW.enabled
BEGIN
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT p.priority, NEW.id, NEW.updated_at
        FROM (SELECT 'high' AS priority UNION ALL SELECT 'medium' UNION ALL SELECT 'low') p;
END;

-- 标题更新：样本里的标题是缓存，必须跟着更新。
CREATE TRIGGER priority_stats_title_changed AFTER UPDATE OF title ON contents
WHEN OLD.title IS NOT NEW.title
BEGIN
    INSERT OR IGNORE INTO priority_preference_dirty(priority, tag_id, marked_at)
        SELECT s.priority_override, ct.tag_id, NEW.updated_at FROM content_states s
        JOIN content_tags ct ON ct.content_id = s.content_id
        WHERE s.content_id = NEW.id AND s.priority_override IS NOT NULL;
END;
