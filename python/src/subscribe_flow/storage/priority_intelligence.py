"""M37 隐藏的优先级偏好统计仓储。

这一层只管 SQLite：谁被用户手动设成什么优先级、这些内容挂了哪些标签、
每个「优先级 × 标签」分组有多少条内容、最近的两条是哪两篇，以及每条内容
最新一条智能结果。

统计口径（计划 §2）：

- 学习信号只有**用户明确设置的单条优先级**。来源默认值与模型自动结果一律
  不计入，否则兜底和模型自己的输出会被当成用户反馈；
- 分组唯一键是「优先级 × 标签 ID」，同一标签在三档各自独立，不混样本；
- 统计包含已归档、已读、稍后处理与未处理内容，处理状态不影响统计；
- 没有标签的人工优先级仍保留在原内容上，但不进入任何分组；
- 计数是全量去重条数，最近两条标题只是语义参考。

失效与重建：

- 「哪些组脏了」由数据库触发器判定（见迁移 013），因此人工改档、批量操作、
  手动收录、自动打标写入与内容删除走的是同一条路，不会漏掉某个入口；
- 重建只重算被标脏的分组，每次重建都从原始关系重新算，因此可重复执行而
  不会累加重复计数；
- 统计更新在独立事务里进行：失败只回滚统计本身，绝不碰人工优先级、标签、
  采集与来源兜底。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3

from priority_engine.contracts import PRIORITY_HIGH, PRIORITY_LOW, PRIORITY_MEDIUM

from .repositories import now

#: 三个档位的固定顺序。统计与上下文都按这个顺序，读写才不会各排各的。
PRIORITIES = (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)

#: 每个分组最多保留两条历史标题。
MAX_SAMPLES = 2


class PriorityIntelligenceRepository:
    """偏好统计 + 最新智能结果的存取。构造时绑定已建好 schema 的 Database。"""

    def __init__(self, database):
        # 两样都要：transaction() 在 Database 上，普通查询在 connection 上。
        self.database = database
        self.db = database.connection

    # ---------------------------------------------------------- 失效与重建

    def dirty_groups(self):
        """当前被标脏、等待重建的分组。"""
        return [dict(row) for row in self.db.execute(
            "SELECT priority, tag_id, marked_at FROM priority_preference_dirty ORDER BY priority, tag_id")]

    def flush_dirty(self, stamp=None):
        """重建被标脏的分组。

        只重算标脏的分组，不扫全量历史。失败时事务回滚、脏标记保留，
        下次再试——统计更新失败不能破坏人工优先级、标签与来源兜底。
        """
        stamp = stamp or now()
        if not self.db.execute("SELECT 1 FROM priority_preference_dirty LIMIT 1").fetchone():
            return {'rebuilt': 0, 'groups': [], 'error': None}
        rebuilt = []
        try:
            with self.database.transaction() as db:
                rows = db.execute(
                    "SELECT priority, tag_id FROM priority_preference_dirty ORDER BY priority, tag_id").fetchall()
                for row in rows:
                    count = self._rebuild_group(db, row['priority'], row['tag_id'], stamp)
                    db.execute("DELETE FROM priority_preference_dirty WHERE priority=? AND tag_id=?",
                               (row['priority'], row['tag_id']))
                    rebuilt.append({'priority': row['priority'], 'tag_id': row['tag_id'],
                                    'content_count': count})
        except (sqlite3.Error, RuntimeError) as error:
            return {'rebuilt': 0, 'groups': [], 'error': str(error)}
        return {'rebuilt': len(rebuilt), 'groups': rebuilt, 'error': None}

    def rebuild_all(self, stamp=None):
        """从原始关系重算全部统计。

        用于首次启用或升级后的本地聚合：只读人工优先级与标签关联，不调用模型。
        """
        stamp = stamp or now()
        rebuilt = []
        with self.database.transaction() as db:
            tags = db.execute("SELECT id FROM tags ORDER BY id").fetchall()
            for tag in tags:
                for priority in PRIORITIES:
                    count = self._rebuild_group(db, priority, tag['id'], stamp)
                    rebuilt.append({'priority': priority, 'tag_id': tag['id'], 'content_count': count})
            # 停用或已删除的标签不参与当前判断，它们的统计一并退出。
            db.execute("DELETE FROM priority_preference_groups WHERE tag_id NOT IN "
                       "(SELECT id FROM tags WHERE enabled=1)")
            db.execute("DELETE FROM priority_preference_dirty")
        return {'rebuilt': len(rebuilt), 'groups': rebuilt}

    def _rebuild_group(self, db, priority, tag_id, stamp):
        """重算一个「优先级 × 标签」分组，返回它的内容数。

        计数与样本用同一段关系、同一个事务算出，因此两者不会互相矛盾。
        """
        tag = db.execute("SELECT enabled FROM tags WHERE id=?", (tag_id,)).fetchone()
        if tag is None or not tag['enabled']:
            # 停用的标签不参与判断：统计退出，等恢复时再按现有关系重建。
            db.execute("DELETE FROM priority_preference_groups WHERE priority=? AND tag_id=?", (priority, tag_id))
            return 0
        count = db.execute(
            "SELECT count(*) FROM content_states s JOIN content_tags ct ON ct.content_id = s.content_id "
            "WHERE ct.tag_id = ? AND s.priority_override = ?", (tag_id, priority)).fetchone()[0]
        if count <= 0:
            # 没有内容就没有分组：上下文里会显式填零，不留空样本。
            db.execute("DELETE FROM priority_preference_groups WHERE priority=? AND tag_id=?", (priority, tag_id))
            return 0
        row = db.execute("SELECT revision FROM priority_preference_groups WHERE priority=? AND tag_id=?",
                         (priority, tag_id)).fetchone()
        revision = (row['revision'] + 1) if row else 1
        db.execute("INSERT INTO priority_preference_groups(priority,tag_id,content_count,revision,updated_at) "
                   "VALUES(?,?,?,?,?) ON CONFLICT(priority,tag_id) DO UPDATE SET "
                   "content_count=excluded.content_count, revision=excluded.revision, "
                   "updated_at=excluded.updated_at", (priority, tag_id, count, revision, stamp))
        # 「最近」按首次采集／收录时间排序，同刻用稳定内容 ID 打破平局。
        # 标题是缓存：内容改名后由触发器标脏重建，缓存跟着更新。
        samples = db.execute(
            "SELECT c.id AS content_id, c.first_seen_at, c.title FROM content_states s "
            "JOIN content_tags ct ON ct.content_id = s.content_id JOIN contents c ON c.id = s.content_id "
            "WHERE ct.tag_id = ? AND s.priority_override = ? "
            "ORDER BY c.first_seen_at DESC, c.id DESC LIMIT ?", (tag_id, priority, MAX_SAMPLES)).fetchall()
        db.execute("DELETE FROM priority_preference_samples WHERE priority=? AND tag_id=?", (priority, tag_id))
        for position, sample in enumerate(samples, start=1):
            db.execute("INSERT INTO priority_preference_samples(priority,tag_id,sample_order,content_id,"
                       "first_seen_at,title) VALUES(?,?,?,?,?,?)",
                       (priority, tag_id, position, sample['content_id'], sample['first_seen_at'],
                        sample['title']))
        return count

    # ---------------------------------------------------------- 统计读取

    def groups_for_tags(self, tag_ids):
        """读取这些标签在三档下的分布。

        先把待重建的分组重建掉，保证读到的是当前值；没有脏分组时这一步
        只是一次空查询，不会扫描历史。
        """
        tag_ids = self._normalized_tags(tag_ids)
        self.flush_dirty()
        return self._read_groups(tag_ids)

    def _normalized_tags(self, tag_ids):
        return [str(tag_id) for tag_id in dict.fromkeys(tag_ids or []) if str(tag_id)]

    def _read_groups(self, tag_ids):
        result = {priority: {} for priority in PRIORITIES}
        if not tag_ids:
            return result
        marks = ",".join("?" * len(tag_ids))
        rows = self.db.execute(
            f"SELECT priority, tag_id, content_count, revision FROM priority_preference_groups "
            f"WHERE tag_id IN ({marks})", tuple(tag_ids)).fetchall()
        for row in rows:
            result.setdefault(row['priority'], {})[row['tag_id']] = {
                'content_count': int(row['content_count']),
                'revision': int(row['revision']),
                'sample_ids': [],
            }
        sample_rows = self.db.execute(
            f"SELECT priority, tag_id, content_id FROM priority_preference_samples "
            f"WHERE tag_id IN ({marks}) ORDER BY priority, tag_id, sample_order", tuple(tag_ids)).fetchall()
        for row in sample_rows:
            group = result.get(row['priority'], {}).get(row['tag_id'])
            if group is not None:
                group['sample_ids'].append(row['content_id'])
        return result

    def group(self, priority, tag_id):
        """读取单个分组。不存在时返回 None——空组由调用方显式填零。"""
        self.flush_dirty()
        row = self.db.execute(
            "SELECT priority, tag_id, content_count, revision, updated_at FROM priority_preference_groups "
            "WHERE priority=? AND tag_id=?", (priority, tag_id)).fetchone()
        if row is None:
            return None
        samples = self.db.execute(
            "SELECT content_id, first_seen_at, title FROM priority_preference_samples "
            "WHERE priority=? AND tag_id=? ORDER BY sample_order", (priority, tag_id)).fetchall()
        return {'priority': row['priority'], 'tag_id': row['tag_id'],
                'content_count': int(row['content_count']), 'revision': int(row['revision']),
                'updated_at': row['updated_at'],
                'samples': [dict(sample) for sample in samples]}

    def preference_version(self, tag_ids, groups=None):
        """相关偏好版本：只由这些标签的分组版本与计数决定。

        统计变了、标签目录变了都会体现在这里；显示名称的改动不会。
        """
        groups = groups if groups is not None else self.groups_for_tags(tag_ids)
        parts = []
        for priority in PRIORITIES:
            for tag_id, group in sorted((groups.get(priority) or {}).items()):
                parts.append(f"{priority}:{tag_id}:{group['revision']}:{group['content_count']}")
        return hashlib.sha256('|'.join(parts).encode('utf-8')).hexdigest()

    # ---------------------------------------------------------- 上下文快照

    def context_snapshot(self, content_id, *, policy_version='', provider_version='', prompt_version=''):
        """把一条内容的判断输入读成一份快照，交给上下文构建器。

        这里只读不写：读出来的内容、标签、分布与版本来自同一个连接，
        因此统计、标签目录与样本是一致的。
        """
        row = self.db.execute(
            "SELECT c.title, c.updated_at AS content_version, s.manual_priority_version "
            "FROM contents c JOIN content_states s ON s.content_id = c.id WHERE c.id = ?",
            (content_id,)).fetchone()
        if row is None:
            return None
        tag_rows = self.db.execute(
            "SELECT ct.tag_id, ct.created_at AS linked_at, t.name, t.description, t.synonyms, t.updated_at "
            "FROM content_tags ct JOIN tags t ON t.id = ct.tag_id "
            "WHERE ct.content_id = ? AND t.enabled = 1 ORDER BY ct.tag_id", (content_id,)).fetchall()
        tag_ids = [tag_row['tag_id'] for tag_row in tag_rows]
        tags = [{'id': tag_row['tag_id'], 'name': tag_row['name'],
                 'description': tag_row['description'],
                 'synonyms': _synonyms(tag_row['synonyms'])} for tag_row in tag_rows]

        self.flush_dirty()
        groups = self._read_groups(tag_ids)
        history = {}
        sample_ids = []
        for priority in PRIORITIES:
            bucket = {}
            for tag_id in tag_ids:
                group = (groups.get(priority) or {}).get(tag_id)
                if group is None:
                    # 缺少分组就显式填零：空组只表示没有证据。
                    bucket[tag_id] = {'content_count': 0, 'sample_ids': []}
                    continue
                bucket[tag_id] = {'content_count': group['content_count'],
                                  'sample_ids': list(group['sample_ids'])}
                for sample_id in group['sample_ids']:
                    if sample_id not in sample_ids:
                        sample_ids.append(sample_id)
            history[priority] = bucket

        # 标题回查内容本身：缓存坏了要能看出来，标题以内容为准。
        sample_titles = {}
        if sample_ids:
            marks = ",".join("?" * len(sample_ids))
            for title_row in self.db.execute(
                    f"SELECT id, title FROM contents WHERE id IN ({marks})", tuple(sample_ids)):
                sample_titles[title_row['id']] = title_row['title']

        versions = {
            'content_version': row['content_version'],
            'tag_version': _tag_version(tag_rows),
            'manual_version': int(row['manual_priority_version'] or 0),
            'preference_version': self.preference_version(tag_ids, groups),
            'policy_version': policy_version,
            'provider_version': provider_version,
            'prompt_version': prompt_version,
        }
        return {'content_id': content_id, 'title': row['title'], 'tag_ids': tag_ids,
                'tags': tags, 'history': history, 'sample_titles': sample_titles,
                'versions': versions}

    # ---------------------------------------------------------- 最新决策

    def save_decision(self, content_id, decision, *, stamp=None):
        """保存一条最新的智能结果。

        每条内容只保留最新一条：无法判断也可以缓存，避免同样输入下反复付费。
        """
        stamp = stamp or now()
        versions = decision.snapshot
        with self.database.transaction() as db:
            db.execute(
                "INSERT INTO content_priority_decisions(content_id,priority,status,provider_id,model,"
                "context_fingerprint,content_version,tag_version,manual_version,preference_version,"
                "policy_version,provider_version,prompt_version,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET "
                "priority=excluded.priority, status=excluded.status, provider_id=excluded.provider_id, "
                "model=excluded.model, context_fingerprint=excluded.context_fingerprint, "
                "content_version=excluded.content_version, tag_version=excluded.tag_version, "
                "manual_version=excluded.manual_version, preference_version=excluded.preference_version, "
                "policy_version=excluded.policy_version, provider_version=excluded.provider_version, "
                "prompt_version=excluded.prompt_version, updated_at=excluded.updated_at",
                (content_id, decision.priority, decision.status, decision.provider_id, decision.model,
                 decision.context_fingerprint, versions.content_version, versions.tag_version,
                 int(versions.manual_version or 0), versions.preference_version, versions.policy_version,
                 versions.provider_version, versions.prompt_version, stamp, stamp))
        return self.get_decision(content_id)

    def get_decision(self, content_id):
        row = self.db.execute(
            "SELECT * FROM content_priority_decisions WHERE content_id=?", (content_id,)).fetchone()
        return dict(row) if row else None

    def clear_decision(self, content_id):
        """丢弃一条智能结果。标签被摘光、开关关闭时用。"""
        with self.database.transaction() as db:
            cursor = db.execute("DELETE FROM content_priority_decisions WHERE content_id=?", (content_id,))
            return cursor.rowcount > 0

    def decisions_for(self, content_ids):
        """一次取回多条内容的最新结果，避免列表逐条查询。"""
        content_ids = [str(content_id) for content_id in dict.fromkeys(content_ids or []) if str(content_id)]
        if not content_ids:
            return {}
        marks = ",".join("?" * len(content_ids))
        rows = self.db.execute(
            f"SELECT * FROM content_priority_decisions WHERE content_id IN ({marks})", tuple(content_ids)).fetchall()
        return {row['content_id']: dict(row) for row in rows}

    # ---------------------------------------------------------- 诊断

    def summary(self):
        return {
            'groups': self.db.execute("SELECT count(*) FROM priority_preference_groups").fetchone()[0],
            'samples': self.db.execute("SELECT count(*) FROM priority_preference_samples").fetchone()[0],
            'dirty': self.db.execute("SELECT count(*) FROM priority_preference_dirty").fetchone()[0],
            'decisions': self.db.execute("SELECT count(*) FROM content_priority_decisions").fetchone()[0],
        }


def _synonyms(raw):
    """标签别名。存量值本来就是 JSON 数组，坏值就当没有。"""
    try:
        value = json.loads(raw or '[]')
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [str(word) for word in value]


def _tag_version(tag_rows):
    """当前内容的标签版本：关联条数、最近关联时间与标签目录更新时间。

    标签改名、描述与别名改变都会改变它；只改优先级显示名称不会。
    """
    if not tag_rows:
        return '0'
    linked = max(tag_row['linked_at'] or '' for tag_row in tag_rows)
    updated = max(tag_row['updated_at'] or '' for tag_row in tag_rows)
    return f"{len(tag_rows)}:{linked}:{updated}"


__all__ = ['PriorityIntelligenceRepository', 'PRIORITIES', 'MAX_SAMPLES']
