-- M9 标签系统。
-- 标签属于应用自身的内容整理层，不映射任何平台原生字段：平台话题与用户标签
-- 分别表达，采集流程不会把平台话题写进这张表。
CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    -- 11 档受控色板。未知色值由前端收敛到 slate，数据库只接受枚举值。
    color TEXT NOT NULL DEFAULT 'slate'
        CHECK(color IN ('violet','blue','cyan','green','lime','yellow','amber','red','pink','plum','slate')),
    enabled INTEGER NOT NULL DEFAULT 1,
    synonyms TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- 名称大小写不敏感唯一，重名在写入前就被拒绝而不是静默合并。
CREATE UNIQUE INDEX tags_name_unique ON tags(name COLLATE NOCASE);

-- 内容与标签是多对多。origin 记录这条关联是谁建立的：
-- 'manual' 是人工决定，自动识别路径永远不会移除它；
-- 'suggested' 来自识别建议，可以被人工移除，但也不会被后续建议静默撤销。
CREATE TABLE content_tags (
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    origin TEXT NOT NULL CHECK(origin IN ('manual','suggested')),
    created_at TEXT NOT NULL,
    -- 同一内容同一标签只有一条关联，重复打标是幂等的。
    PRIMARY KEY(content_id, tag_id)
);
CREATE INDEX content_tags_by_tag ON content_tags(tag_id);

-- 人工移除是一条决定，而不是一次临时操作。记住它，自动识别才不能把同一个
-- 标签悄悄加回来——否则「旧建议不能静默撤销人工修改」只在删除方向成立。
-- tag_id 故意不加外键：标签被删除后用同名重建会得到新 ID，屏蔽关系自然失效。
CREATE TABLE content_tag_blocks (
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(content_id, tag_id)
);
