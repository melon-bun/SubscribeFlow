-- M26 笔记：一条内容最多一条笔记（第五期方案 §5.1）。
--
-- 这张表只承载「用户自己写下的东西」：总结、个人收获与项目结论。
-- 它不参与采集、不参与自动打标，也不影响内容的处理状态（已读／稍后／归档）。
--
-- content_id 是主键并外键级联：内容真正被删除时，笔记随之消失；
-- 取消订阅或归档不会删笔记——那不是删除内容。
--
-- 没有笔记时不存在行：「不写笔记」是界面上的操作状态，不是 template='none' 的空行。
-- 空笔记（总结与收获都空、也没有项目结论）在写入层就被删掉，所有入口共用这条规则。

CREATE TABLE content_notes (
    content_id TEXT PRIMARY KEY REFERENCES contents(id) ON DELETE CASCADE,
    -- 通用笔记只有总结与收获；项目笔记多一个「结论」。
    template TEXT NOT NULL CHECK (template IN ('general', 'project')),
    summary TEXT NOT NULL DEFAULT '',
    -- 总结的来路：手写 manual、AI 草稿未改 ai、用户改过 AI 草稿 ai_edited。
    -- 总结被清空时这里是 NULL。
    summary_origin TEXT CHECK (summary_origin IN ('manual', 'ai', 'ai_edited')),
    takeaway TEXT NOT NULL DEFAULT '',
    -- 结论只能由用户自己写，AI 不得代填。
    verdict TEXT CHECK (verdict IN ('using', 'watching', 'dropped')),
    -- 每次真正写入换一个令牌：旧版本不能覆盖新版本。
    version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- 通用模板不能有项目结论。
    CHECK (template = 'project' OR verdict IS NULL)
);
-- 笔记页默认按最近笔记更新时间排序；同刻再按稳定 ID 排。
CREATE INDEX content_notes_recent ON content_notes(updated_at DESC, content_id);
