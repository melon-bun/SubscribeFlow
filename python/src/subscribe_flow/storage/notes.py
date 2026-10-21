"""笔记的存储（M26）。

一条内容最多一条笔记。写笔记只碰 ``content_notes``：
不动 ``contents.updated_at``、不动首次收录信息、不动已读／稍后／归档——
那些是内容自己的状态，笔记不该替它们做决定。

筛选谓词复用主仓储的 ``content_filter``：内容列表、标签页与笔记查询共用同一段，
不另造第二套会长期分叉的条件。笔记查询在此之上多挂一张 ``content_notes``，
关键词多搜总结与收获两列。
"""

from subscribe_flow.contracts import ChannelError

# 笔记页的排序白名单。值是 ORDER BY 片段，键是接口里公开的排序名。
# 默认按笔记最近更新时间倒序，同一刻再按稳定 ID 排，列表不会因为同刻而抖动。
NOTE_SORTS = {
    "updated": "n.updated_at DESC, n.content_id ASC",
    "created": "n.created_at DESC, n.content_id ASC",
    "title": "c.title COLLATE NOCASE ASC, n.content_id ASC",
}
DEFAULT_NOTE_SORT = "updated"

# 笔记查询挂在内容之上的额外 JOIN，以及关键词要搜的列。
NOTE_JOIN = " JOIN content_notes n ON n.content_id=c.id"
NOTE_QUERY_COLUMNS = ("c.title", "n.summary", "n.takeaway")


def _note(row):
    return {
        "content_id": row["content_id"],
        "template": row["template"],
        "summary": row["summary"],
        "summary_origin": row["summary_origin"],
        "takeaway": row["takeaway"],
        "verdict": row["verdict"],
        "version": row["version"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class NoteRepository:
    def __init__(self, database, contents):
        self.database = database
        self.db = database.connection
        self.contents = contents      # 主仓储：借它的内容筛选谓词

    # ------------------------------------------------------------------ 读写

    def get(self, content_id):
        row = self.db.execute("SELECT * FROM content_notes WHERE content_id=?", (content_id,)).fetchone()
        return _note(row) if row else None

    def write(self, content_id, *, template, summary, summary_origin, takeaway, verdict,
              version, stamp):
        """写入或整体替换一条笔记。

        created_at 在第一次写入时定下，之后替换不动它——那是「什么时候开始写的」。
        每次写入换新的 version 令牌：旧版本盖不住新版本。
        """
        with self.database.transaction() as db:
            row = db.execute("SELECT created_at FROM content_notes WHERE content_id=?",
                             (content_id,)).fetchone()
            created_at = row["created_at"] if row else stamp
            db.execute(
                "INSERT INTO content_notes(content_id,template,summary,summary_origin,takeaway,"
                "verdict,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(content_id) DO UPDATE SET template=excluded.template,"
                "summary=excluded.summary,summary_origin=excluded.summary_origin,"
                "takeaway=excluded.takeaway,verdict=excluded.verdict,version=excluded.version,"
                "updated_at=excluded.updated_at",
                (content_id, template, summary, summary_origin, takeaway, verdict, version,
                 created_at, stamp))
        return self.get(content_id)

    def remove(self, content_id):
        """删掉一条笔记。内容本身不动。"""
        with self.database.transaction() as db:
            cursor = db.execute("DELETE FROM content_notes WHERE content_id=?", (content_id,))
            return cursor.rowcount > 0

    # ------------------------------------------------------------------ 查询

    def _scope(self, *, query=None, channel=None, source_id=None, tags=None, tag_mode=None,
               verdict=None, timezone='UTC'):
        """笔记范围的筛选条件。列表与 facets 用同一段，口径完全一致。"""
        base, args = self.contents.content_filter(
            query=query, channel=channel, source_id=source_id, tags=tags, tag_mode=tag_mode,
            timezone=timezone, joins=NOTE_JOIN, query_columns=NOTE_QUERY_COLUMNS)
        if verdict is not None:
            base += " AND n.verdict=?"
            args.append(verdict)
        return base, args

    def list_notes(self, *, limit=50, offset=0, query=None, channel=None, source_id=None,
                   tags=None, tag_mode=None, verdict=None, sort=None, timezone='UTC'):
        """标题目录用的列表：只给 ID、原标题与笔记更新时间。

        不返回总结与收获正文——目录不画卡片墙，正文由笔记详情自己取。
        """
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
            raise ChannelError("INVALID_INPUT", "note.list", "分页参数无效")
        order = NOTE_SORTS.get(sort or DEFAULT_NOTE_SORT)
        if order is None:
            raise ChannelError("INVALID_INPUT", "note.list", "排序方式无效")
        base, args = self._scope(query=query, channel=channel, source_id=source_id, tags=tags,
                                  tag_mode=tag_mode, verdict=verdict, timezone=timezone)
        total = self.db.execute("SELECT count(*) " + base, args).fetchone()[0]
        rows = self.db.execute(
            "SELECT c.id, c.title, n.updated_at AS note_updated_at " + base +
            f" ORDER BY {order} LIMIT ? OFFSET ?", (*args, limit, offset))
        items = [{"id": row["id"], "title": row["title"], "note_updated_at": row["note_updated_at"]}
                 for row in rows]
        return {"items": items, "total": total, "limit": limit, "offset": offset,
                "next_offset": offset + limit if offset + limit < total else None}

    def facets(self, *, query=None, channel=None, source_id=None, tags=None, tag_mode=None,
               verdict=None, timezone='UTC'):
        """笔记范围内的平台、来源与标签，以及各自被多少条笔记用到。

        标签只统计**有笔记的内容**上的标签：不是笔记的标签不进这里，
        免得筛选器里出现一堆选了就没结果的选项。数量按内容去重。
        """
        base, args = self._scope(query=query, channel=channel, source_id=source_id, tags=tags,
                                  tag_mode=tag_mode, verdict=verdict, timezone=timezone)
        scope = "SELECT c.id " + base
        channels = self.db.execute(
            "SELECT c.channel AS id, count(*) AS count FROM contents c"
            f" WHERE c.id IN ({scope}) GROUP BY c.channel ORDER BY count DESC, c.channel", args)
        sources = self.db.execute(
            "SELECT r.id, r.name, count(DISTINCT cs.content_id) AS count FROM content_sources cs"
            f" JOIN sources r ON r.id=cs.source_id WHERE cs.content_id IN ({scope})"
            " GROUP BY r.id, r.name ORDER BY count DESC, r.name", args)
        tag_rows = self.db.execute(
            "SELECT t.id, t.name, t.color, count(DISTINCT ct.content_id) AS count FROM content_tags ct"
            f" JOIN tags t ON t.id=ct.tag_id WHERE ct.content_id IN ({scope})"
            " GROUP BY t.id, t.name, t.color ORDER BY count DESC, t.name", args)
        return {
            "channels": [{"id": row["id"], "count": row["count"]} for row in channels],
            "sources": [{"id": row["id"], "name": row["name"], "count": row["count"]} for row in sources],
            "tags": [{"id": row["id"], "name": row["name"], "color": row["color"],
                      "count": row["count"]} for row in tag_rows],
        }
