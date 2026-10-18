"""M16 自动打标的持久事件与后台任务仓储。

这一层只管 SQLite：谁被保存过、任务排到哪一步、标签怎么落。
不认识模型、不认识 Provider、不认识界面（计划 §3.1 的依赖方向）。

关键约束全部落在这里，而不是靠调用方记得：
- 事件写入复用内容入库那个事务，不单独开事务，因此不存在「内容存了但
  事件没写」的窗口；
- 消费位置与任务登记在同一个事务里推进，崩溃不会丢任务也不会重复排队；
- 标签写入与任务完成在同一个事务里，崩溃后不会重复创建标签；
- 人工屏蔽、禁用标签、过期版本都在写入前检查，且检查与写入同事务。
"""

import json
import sqlite3
import uuid

from subscribe_flow.contracts import ChannelError

from .repositories import now, encode

# 任务状态（计划 §3.5 建议值）。与迁移里的 CHECK 保持一致。
QUEUED, RUNNING, RETRY_WAIT, BLOCKED = 'queued', 'running', 'retry_wait', 'blocked'
SUCCEEDED, SKIPPED, FAILED, CANCELLED = 'succeeded', 'skipped', 'failed', 'cancelled'

TERMINAL = frozenset({SUCCEEDED, SKIPPED, FAILED, CANCELLED})

# 有限退避（秒）。认证失败与配置缺失不进这里，直接阻塞等人改配置。
BACKOFF_SECONDS = (30, 120, 600)
LEASE_SECONDS = 900

_PUBLIC_COLUMNS = (
    "id,content_id,content_version,config_version,catalog_version,mode,state,origin,"
    "round_no,attempts,max_attempts,next_attempt_at,provider,model,error_code,error_message,"
    "detail,skipped_reason,applied_count,blocked_count,created_count,created_at,updated_at,completed_at"
)


def _fail(message, scope='operation', scope_key=None, code='INVALID_INPUT'):
    raise ChannelError(code, 'tagging', message, scope=scope, scope_key=scope_key)


class TaggingRepository:
    """事件 + 任务 + 标签落库。构造时绑定已建好 schema 的 Database。"""

    def __init__(self, database):
        # 两样都要：transaction() 在 Database 上，普通查询在 connection 上。
        self.database = database
        self.db = database.connection

    # ---------------------------------------------------------- 事件写入

    def record_content_created(self, db, content_id, content_version, stamp=None):
        """在**内容入库的同一事务里**记录首次保存事实。

        调用方传入 db（外层事务句柄），这里绝不自己开事务——这正是
        「内容保存与事件写入原子提交」的实现方式（计划 §3.5 第 1 条）。
        重复收录由唯一索引忽略，不会产生第二条事件。
        """
        db.execute(
            "INSERT OR IGNORE INTO content_events(name,content_id,content_version,created_at)"
            " VALUES('content.created',?,?,?)",
            (content_id, content_version, stamp or now()))

    def pending_events(self, limit=50):
        rows = self.db.execute(
            "SELECT id,content_id,content_version,created_at FROM content_events"
            " WHERE consumed_at IS NULL ORDER BY id LIMIT ?", (limit,))
        return [dict(row) for row in rows]

    def event_count(self):
        return self.db.execute("SELECT count(*) FROM content_events").fetchone()[0]

    # ---------------------------------------------------------- 任务登记

    def register_from_events(self, *, settings_version, tagging_enabled, catalog_version,
                             mode, enabled_since=None, limit=50, origin='auto'):
        """消费待处理事件并登记任务。消费位置与登记在同一事务内推进。

        自动打标关闭时事件仍推进消费位置并记为「不处理」，这样关闭期间
        收录的内容不会被日后自动补上——它们只能由用户主动补打（§3.5 第 4 条）。
        """
        created = []
        with self.database.transaction() as db:
            rows = db.execute(
                "SELECT id,content_id,content_version,created_at FROM content_events"
                " WHERE consumed_at IS NULL ORDER BY id LIMIT ?", (limit,)).fetchall()
            stamp = now()
            for row in rows:
                consumed_by = None
                if tagging_enabled:
                    # enabledSince 之后首次保存的内容才自动处理；边界之前收录的
                    # 内容需要用户主动补打，不在这里偷偷补。
                    if enabled_since is None or row['created_at'] >= enabled_since:
                        key = f"{row['content_id']}:{row['content_version']}:{settings_version}:{catalog_version}:{origin}"
                        cursor = db.execute(
                            "INSERT OR IGNORE INTO tagging_tasks(id,content_id,content_version,config_version,"
                            "catalog_version,mode,state,dedupe_key,round_no,origin,next_attempt_at,"
                            "created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,1,?,?,?,?)",
                            (uuid.uuid4().hex, row['content_id'], row['content_version'], settings_version,
                             catalog_version, mode, key, origin, stamp, stamp, stamp))
                        if cursor.rowcount:
                            consumed_by = 'task'
                            created.append(row['content_id'])
                # 无论是否登记任务，消费位置都要推进。
                db.execute("UPDATE content_events SET consumed_at=?,consumed_by=? WHERE id=?",
                           (stamp, consumed_by or 'disabled', row['id']))
        return created

    # ---------------------------------------------------------- 队列操作

    def next_task(self, stamp=None):
        """取下一个可执行任务并落运行租约。

        取任务与占租约在同一个事务里，两个后台循环同时跑也不会拿到同一条。
        """
        stamp = stamp or now()
        with self.database.transaction() as db:
            row = db.execute(
                f"SELECT {_PUBLIC_COLUMNS} FROM tagging_tasks WHERE state='queued'"
                " AND (next_attempt_at IS NULL OR next_attempt_at<=?)"
                " ORDER BY created_at,id LIMIT 1", (stamp,)).fetchone()
            if row is None:
                return None
            db.execute("UPDATE tagging_tasks SET state='running',attempts=attempts+1,lease_expires_at=?,"
                       "updated_at=? WHERE id=?", (_iso(stamp, LEASE_SECONDS), stamp, row['id']))
            task = dict(row)
            task['state'], task['attempts'] = RUNNING, task['attempts'] + 1
            return task

    def renew_lease(self, task_id, seconds=LEASE_SECONDS):
        self.db.execute("UPDATE tagging_tasks SET lease_expires_at=?,updated_at=? WHERE id=? AND state='running'",
                        (_iso(now(), seconds), now(), task_id))

    def recover_stale_tasks(self, stamp=None):
        """重启回收：过期的 running 任务退回队列，不留在假运行状态。

        崩溃可能发生在模型已返回、标签未落库之间，因此这里统一退回重排；
        幂等由 dedupe_key 与「标签写入+任务完成同事务」保证（§3.5 第 9 条）。
        """
        stamp = stamp or now()
        with self.database.transaction() as db:
            cursor = db.execute(
                "UPDATE tagging_tasks SET state='queued',lease_expires_at=NULL,updated_at=?"
                " WHERE state='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<?",
                (stamp, stamp))
            return cursor.rowcount

    def finish(self, task_id, state, **fields):
        """结束任务。state 必须是终态，且标签落库调用方负责同事务提交。"""
        if state not in TERMINAL:
            raise ValueError('finish() requires a terminal state')
        stamp = now()
        allowed = {'provider', 'model', 'usage', 'error_code', 'error_message', 'detail',
                   'skipped_reason', 'applied_count', 'blocked_count', 'created_count'}
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f'unsupported task fields: {sorted(unknown)}')
        assignments, args = [], []
        for key, value in fields.items():
            assignments.append(f"{key}=?")
            args.append(encode(value) if key == 'usage' else value)
        assignments += ["state=?", "completed_at=?", "lease_expires_at=NULL", "updated_at=?"]
        args += [state, stamp, stamp, task_id]
        with self.database.transaction() as db:
            cursor = db.execute(f"UPDATE tagging_tasks SET {','.join(assignments)} WHERE id=?", args)
            return cursor.rowcount

    def retry_wait(self, task_id, *, code, message, max_attempts=3, detail=None):
        """暂时性失败：有限退避重试；用尽次数后落 failed。

        认证失败与配置缺失不在这里——那些由调用方走 blocked，等用户改配置。
        """
        stamp = now()
        with self.database.transaction() as db:
            row = db.execute("SELECT attempts,max_attempts FROM tagging_tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return False
            attempts, allowed = row['attempts'], row['max_attempts'] or max_attempts
            if attempts >= allowed:
                db.execute("UPDATE tagging_tasks SET state='failed',error_code=?,error_message=?,detail=?,"
                           "lease_expires_at=NULL,completed_at=?,updated_at=? WHERE id=?",
                           (code, message, detail, stamp, stamp, task_id))
                return True
            delay = BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
            db.execute("UPDATE tagging_tasks SET state='retry_wait',next_attempt_at=?,error_code=?,"
                       "error_message=?,detail=?,lease_expires_at=NULL,updated_at=? WHERE id=?",
                       (_iso(stamp, delay), code, message, detail, stamp, task_id))
            return True

    def block(self, task_id, *, code, message, detail=None):
        """认证失败/配置缺失：停止请求，等配置修好再恢复（§3.5 第 8 条）。"""
        stamp = now()
        with self.database.transaction() as db:
            db.execute("UPDATE tagging_tasks SET state='blocked',error_code=?,error_message=?,detail=?,"
                       "lease_expires_at=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?",
                       (code, message, detail, stamp, task_id))

    def unblock_all(self):
        """配置改好后让被阻塞的任务回到队列。"""
        stamp = now()
        with self.database.transaction() as db:
            return db.execute("UPDATE tagging_tasks SET state='queued',error_code=NULL,error_message=NULL,"
                              "next_attempt_at=NULL,updated_at=? WHERE state='blocked'", (stamp,)).rowcount

    def promote_due(self, stamp=None):
        """把到期的 retry_wait 放回队列。"""
        stamp = stamp or now()
        with self.database.transaction() as db:
            return db.execute("UPDATE tagging_tasks SET state='queued',next_attempt_at=NULL,updated_at=?"
                              " WHERE state='retry_wait' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?",
                              (stamp, stamp)).rowcount

    # ---------------------------------------------------------- 标签目录版本

    def catalog_version(self):
        """标签目录版本。目录一变，旧任务的候选清单就不再成立。"""
        row = self.db.execute("SELECT count(*),max(updated_at),max(id) FROM tags").fetchone()
        return f"{row[0]}:{row[1] or ''}:{row[2] or ''}"

    def enabled_tags(self):
        """可自动分类的标签目录：只有已启用的（计划 §3.2 候选标签目录）。"""
        rows = self.db.execute(
            "SELECT id,name,description,synonyms,color,updated_at FROM tags WHERE enabled=1 ORDER BY created_at,id")
        items = []
        for row in rows:
            try:
                synonyms = json.loads(row['synonyms']) or []
            except (TypeError, ValueError):
                synonyms = []
            items.append({'id': row['id'], 'name': row['name'], 'description': row['description'] or '',
                          'synonyms': synonyms, 'color': row['color'], 'updated_at': row['updated_at']})
        return items

    # ---------------------------------------------------------- 结果落库

    def apply_result(self, task_id, *, applied_tag_ids, new_tags, expected_content_version,
                     catalog_version):
        """在同一事务里：复核版本与屏蔽 → 挂载/新建标签 → 完成任务。

        这是迟到结果的唯一拦截点。人工移除过的标签、已被禁用的标签、
        期间已经改过正文的内容，都在这里被挡住；挡住与完成同事务，
        重启重放也不会把它们补回来（计划 §3.5 第 7 条）。
        """
        stamp = now()
        applied = blocked = created = 0
        with self.database.transaction() as db:
            task = db.execute("SELECT * FROM tagging_tasks WHERE id=?", (task_id,)).fetchone()
            if task is None:
                raise ChannelError('NOT_FOUND', 'tagging', '打标任务不存在')

            content = db.execute("SELECT id,updated_at FROM contents WHERE id=?",
                                 (task['content_id'],)).fetchone()
            if content is None:
                # 内容已删除：任务作废，不落任何标签。
                self._complete(db, task_id, CANCELLED, stamp, skipped_reason='内容已删除')
                return {'applied': 0, 'blocked': 0, 'created': 0, 'outcome': CANCELLED,
                        'reason': '内容已删除'}
            # 版本复核必须与写入同事务，否则「检查通过后内容又变了」会有窗口。
            if expected_content_version and content['updated_at'] != expected_content_version:
                self._complete(db, task_id, SKIPPED, stamp, skipped_reason='内容已更新，建议已过期')
                return {'applied': 0, 'blocked': 0, 'created': 0, 'outcome': SKIPPED,
                        'reason': '内容已更新，该结果基于旧版本'}
            if task['catalog_version'] != catalog_version:
                # 标签目录在识别期间变了：候选含义可能已经不同，重新排队而不是写旧快照。
                db.execute("UPDATE tagging_tasks SET state='queued',catalog_version=?,dedupe_key=?,"
                           "lease_expires_at=NULL,attempts=0,next_attempt_at=NULL,updated_at=? WHERE id=?",
                           (catalog_version, _dedupe(task['content_id'], task['content_version'],
                                                     task['config_version'], catalog_version, task['origin'],
                                                     task['round_no']), stamp, task_id))
                return {'applied': 0, 'blocked': 0, 'created': 0, 'outcome': 'requeued',
                        'reason': '标签目录已变化，将按当前目录重新识别'}

            for tag_id in dict.fromkeys(applied_tag_ids):
                if not self._tag_usable(db, task['content_id'], tag_id):
                    blocked += 1
                    continue
                if db.execute("SELECT 1 FROM content_tag_blocks WHERE content_id=? AND tag_id=?",
                              (task['content_id'], tag_id)).fetchone():
                    blocked += 1
                    continue
                cursor = db.execute(
                    "INSERT INTO content_tags(content_id,tag_id,origin,created_at)"
                    " VALUES(?,?,'suggested',?) ON CONFLICT(content_id,tag_id) DO NOTHING",
                    (task['content_id'], tag_id, stamp))
                applied += cursor.rowcount if cursor.rowcount > 0 else 0

            for name in new_tags:
                tag_id = self._resolve_or_create(db, name, stamp)
                if tag_id is None:
                    continue
                if db.execute("SELECT 1 FROM content_tag_blocks WHERE content_id=? AND tag_id=?",
                              (task['content_id'], tag_id)).fetchone():
                    blocked += 1
                    continue
                cursor = db.execute(
                    "INSERT INTO content_tags(content_id,tag_id,origin,created_at)"
                    " VALUES(?,?,'suggested',?) ON CONFLICT(content_id,tag_id) DO NOTHING",
                    (task['content_id'], tag_id, stamp))
                added = cursor.rowcount if cursor.rowcount > 0 else 0
                applied += added
                created += added

            self._complete(db, task_id, SUCCEEDED, stamp,
                           applied_count=applied, blocked_count=blocked, created_count=created)
        return {'applied': applied, 'blocked': blocked, 'created': created, 'outcome': SUCCEEDED}

    def _complete(self, db, task_id, state, stamp, *, skipped_reason=None,
                  applied_count=0, blocked_count=0, created_count=0):
        db.execute("UPDATE tagging_tasks SET state=?,completed_at=?,lease_expires_at=NULL,skipped_reason=?,"
                   "applied_count=?,blocked_count=?,created_count=?,updated_at=? WHERE id=?",
                   (state, stamp, skipped_reason, applied_count, blocked_count, created_count, stamp, task_id))

    @staticmethod
    def _tag_usable(db, content_id, tag_id):
        """标签存在且已启用。禁用标签不被 AI 重新启用，也不能被挂载。"""
        row = db.execute("SELECT enabled FROM tags WHERE id=?", (tag_id,)).fetchone()
        if row is None or not row['enabled']:
            return False
        return True

    @staticmethod
    def _resolve_or_create(db, name, stamp):
        """按名称/别名复用已有标签；没有才新建。并发同名时复用已存在记录。

        禁用标签不会被自动重新启用，也不允许通过同名新建绕过禁用。
        多个别名同时命中同一名称视为歧义，跳过并记原因（§3.4）。
        """
        from subscribe_flow.contracts.tags import validate_tag_name, validate_synonyms, validate_tag_color

        clean = validate_tag_name(name)
        row = db.execute("SELECT id,enabled FROM tags WHERE name=? COLLATE NOCASE", (clean,)).fetchone()
        if row is not None:
            return row['id'] if row['enabled'] else None

        # 别名复用：只看登记过的别名，不做语义相近的自动合并。
        candidates = []
        for tag in db.execute("SELECT id,name,synonyms,enabled FROM tags WHERE enabled=1"):
            try:
                synonyms = json.loads(tag['synonyms']) or []
            except (TypeError, ValueError):
                synonyms = []
            if clean.casefold() in {str(s).strip().casefold() for s in synonyms}:
                candidates.append(tag['id'])
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            return None  # 多个别名候选：不擅自合并，跳过

        tag_id = uuid.uuid4().hex
        try:
            db.execute("INSERT INTO tags(id,name,description,color,enabled,synonyms,created_at,updated_at)"
                       " VALUES(?,?,'','slate',1,'[]',?,?)", (tag_id, clean, stamp, stamp))
        except sqlite3.IntegrityError:
            # 并发同名创建：复用已存在的那条，不抛给用户。
            existing = db.execute("SELECT id,enabled FROM tags WHERE name=? COLLATE NOCASE", (clean,)).fetchone()
            return existing['id'] if existing and existing['enabled'] else None
        return tag_id

    # ---------------------------------------------------------- 界面用查询

    def get_task(self, task_id):
        row = self.db.execute(f"SELECT {_PUBLIC_COLUMNS} FROM tagging_tasks WHERE id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def list_tasks(self, *, states=None, limit=50, offset=0):
        clauses, args = [], []
        if states:
            clauses.append("state IN (%s)" % ",".join("?" * len(states)))
            args.extend(states)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        total = self.db.execute(f"SELECT count(*) FROM tagging_tasks{where}", args).fetchone()[0]
        rows = self.db.execute(
            f"SELECT {_PUBLIC_COLUMNS} FROM tagging_tasks{where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
            (*args, limit, offset))
        return {'items': [dict(row) for row in rows], 'total': total, 'limit': limit, 'offset': offset}

    def summary(self):
        """界面顶部状态条用的计数。按状态分组，空状态也有真实数字。"""
        rows = self.db.execute("SELECT state,count(*) AS n FROM tagging_tasks GROUP BY state")
        counts = {row['state']: row['n'] for row in rows}
        return {'states': counts,
                'total': sum(counts.values()),
                'active': sum(counts.get(state, 0) for state in (QUEUED, RUNNING, RETRY_WAIT)),
                'needsAttention': counts.get(FAILED, 0) + counts.get(BLOCKED, 0)}

    def rerun(self, task_id, *, config_version, catalog_version, mode, force=False):
        """失败/阻塞任务重试。复用任务身份，不新建并发任务（§3.5 第 5 条）。

        force 只给持有租约的后台 worker 用：它自己刚把任务认领成 running，
        仍需按新配置版本原地重排。没有 force 时，正在排队/运行的任务拒绝重跑，
        避免用户连点产生并发任务。
        """
        stamp = now()
        with self.database.transaction() as db:
            row = db.execute("SELECT * FROM tagging_tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                raise ChannelError('NOT_FOUND', 'tagging.retry', '打标任务不存在')
            if not force and row['state'] in (QUEUED, RUNNING):
                return {'queued': False, 'reason': '任务已在队列中'}
            round_no = row['round_no'] + 1
            db.execute(
                "UPDATE tagging_tasks SET state='queued',config_version=?,catalog_version=?,mode=?,"
                "dedupe_key=?,round_no=?,attempts=0,max_attempts=3,next_attempt_at=NULL,lease_expires_at=NULL,"
                "error_code=NULL,error_message=NULL,skipped_reason=NULL,completed_at=NULL,updated_at=? WHERE id=?",
                (config_version, catalog_version, mode,
                 _dedupe(row['content_id'], row['content_version'], config_version, catalog_version,
                         row['origin'], round_no), round_no, stamp, task_id))
        return {'queued': True, 'task_id': task_id, 'round': round_no}

    def enqueue_backfill(self, content_ids, *, config_version, catalog_version, mode,
                         enabled_since=None, limit=500):
        """用户主动补打。范围与数量由界面先预览，这里只负责登记。

        不在升级或首次开启时自动扫全库——这是用户明确触发的动作（§3.5 第 10 条）。
        """
        stamp = now()
        queued, skipped = [], 0
        with self.database.transaction() as db:
            for content_id in list(dict.fromkeys(content_ids))[:limit]:
                row = db.execute("SELECT id,updated_at FROM contents WHERE id=?", (content_id,)).fetchone()
                if row is None:
                    skipped += 1
                    continue
                key = _dedupe(content_id, row['updated_at'], config_version, catalog_version, 'backfill', 1)
                cursor = db.execute(
                    "INSERT OR IGNORE INTO tagging_tasks(id,content_id,content_version,config_version,"
                    "catalog_version,mode,state,dedupe_key,round_no,origin,next_attempt_at,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,?,'queued',?,1,'backfill',?,?,?)",
                    (uuid.uuid4().hex, content_id, row['updated_at'], config_version, catalog_version,
                     mode, key, stamp, stamp, stamp))
                if cursor.rowcount:
                    queued.append(content_id)
        return {'queued': len(queued), 'skipped': skipped, 'item_ids': queued[:100]}

    def backfill_preview(self, *, since=None, limit=500, enabled_since=None):
        """补打范围预览：数量与是否已打过，界面在执行前展示。"""
        clauses, args = ['1=1'], []
        if since:
            clauses.append("first_seen_at>=?")
            args.append(since)
        if enabled_since:
            clauses.append("first_seen_at>=?")
            args.append(enabled_since)
        where = ' AND '.join(clauses)
        total = self.db.execute(f"SELECT count(*) FROM contents WHERE {where}", args).fetchone()[0]
        rows = self.db.execute(
            f"SELECT c.id,c.first_seen_at FROM contents c WHERE {where}"
            " AND NOT EXISTS(SELECT 1 FROM tagging_tasks t WHERE t.content_id=c.id)"
            " ORDER BY c.first_seen_at DESC LIMIT ?", (*args, limit))
        pending = [dict(row) for row in rows]
        return {'total': total, 'pending': len(pending),
                'limit': min(limit, total), 'items': pending[:50]}

    def delete_tasks(self, task_id):
        with self.database.transaction() as db:
            return db.execute("DELETE FROM tagging_tasks WHERE id=?", (task_id,)).rowcount


def _dedupe(content_id, content_version, config_version, catalog_version, origin, round_no):
    return f"{content_id}:{content_version}:{config_version}:{catalog_version}:{origin}:{round_no}"


def _iso(stamp, seconds):
    """在 ISO 时间戳上加偏移。存储层不引第三方库。"""
    from datetime import datetime, timedelta
    base = datetime.fromisoformat(stamp)
    return (base + timedelta(seconds=seconds)).isoformat()
