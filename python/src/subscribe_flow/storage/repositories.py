from __future__ import annotations

import json
import calendar
import re
import sqlite3
import uuid
from datetime import datetime, timezone

from subscribe_flow.contracts import ChannelError, Connection, ContentPatch, Source, jsonable
from subscribe_flow.contracts.priorities import validate_priority
from subscribe_flow.contracts.tags import validate_tag_filter
from subscribe_flow.contracts.tags import validate_tag_ids
from subscribe_flow.storage.dates import calendar_key, calendar_order, date_boundary, display_zone


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def encode(value) -> str:
    return json.dumps(jsonable(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Repository:
    def __init__(self, database):
        self.database, self.db = database, database.connection
        self.db.create_function('sf_calendar_key', 4, calendar_key, deterministic=True)
        self.db.create_function('sf_calendar_order', 4, calendar_order, deterministic=True)

    def add_connection(self, connection: Connection):
        with self.database.transaction() as db:
            db.execute("INSERT INTO connections(id,channel,backend,resource_key,version,enabled) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
                       (connection.id, connection.channel, connection.backend, connection.resource_key, connection.version, int(connection.enabled)))
        return self.get_connection(connection.id)

    def get_connection(self, connection_id: str) -> Connection:
        row = self.db.execute("SELECT * FROM connections WHERE id=?", (connection_id,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "connection", "连接不存在")
        return Connection(row["id"], row["channel"], row["backend"], row["resource_key"], row["version"], bool(row["enabled"]))

    def list_connections(self):
        return [{**dict(row), "readiness": json.loads(row["readiness"]) if row["readiness"] else None}
                for row in self.db.execute("SELECT * FROM connections ORDER BY id")]

    def set_readiness(self, connection_id, readiness):
        self.db.execute("UPDATE connections SET readiness=? WHERE id=?", (encode(readiness), connection_id))

    def update_connection(self, connection_id, *, enabled=None, resource_key=None, backend=None):
        old = self.get_connection(connection_id)
        new = Connection(old.id, old.channel, backend if backend is not None else old.backend,
                         resource_key if resource_key is not None else old.resource_key, old.version + 1,
                         old.enabled if enabled is None else enabled)
        with self.database.transaction() as db:
            db.execute("UPDATE connections SET backend=?,resource_key=?,version=?,enabled=?,readiness=NULL WHERE id=?",
                       (new.backend, new.resource_key, new.version, int(new.enabled), new.id))
        return new

    def _save_source(self, db, source: Source):
        db.execute("""INSERT INTO sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                      name=CASE WHEN excluded.confirmed OR NOT sources.confirmed THEN excluded.name ELSE sources.name END,
                      confirmed=MAX(sources.confirmed,excluded.confirmed),url=excluded.url""",
                   (source.key, source.channel, source.kind, source.external_id, source.name, source.url, int(source.confirmed)))

    def remember_sources(self, sources):
        with self.database.transaction() as db:
            for source in sources:
                if source.confirmed:
                    self._save_source(db, source)

    def subscribe(self, source: Source, connection_id: str, interval_seconds=86400, sync_mode='manual'):
        connection = self.get_connection(connection_id)
        if source.channel != connection.channel:
            raise ChannelError("INVALID_INPUT", "subscription.add", "来源与连接不属于同一渠道")
        with self.database.transaction() as db:
            self._save_source(db, source)
            existing = db.execute("SELECT * FROM subscriptions WHERE source_id=?", (source.key,)).fetchone()
            stamp = now()
            if existing:
                sub_id = existing["id"]
                if existing["status"] == "cancelled":
                    db.execute("UPDATE subscriptions SET status='active',connection_id=?,interval_seconds=?,sync_mode=?,version=version+1,updated_at=? WHERE id=?",
                               (connection_id, interval_seconds, sync_mode, stamp, sub_id))
                # An accidental repeated add does not resume a user-paused subscription.
            else:
                sub_id = uuid.uuid4().hex
                db.execute("INSERT INTO subscriptions(id,source_id,connection_id,status,version,interval_seconds,created_at,updated_at,sync_mode) VALUES(?,?,?,'active',1,?,?,?,?)",
                           (sub_id, source.key, connection_id, interval_seconds, stamp, stamp, sync_mode))
        return self.get_subscription(sub_id)

    def get_subscription(self, sub_id):
        row = self.db.execute("""SELECT s.*,r.channel,r.kind,r.external_id,r.name,r.url,r.confirmed,c.backend
                                 FROM subscriptions s JOIN sources r ON r.id=s.source_id
                                 JOIN connections c ON c.id=s.connection_id WHERE s.id=?""", (sub_id,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "subscription", "订阅不存在")
        return dict(row)

    def list_subscriptions(self, include_cancelled=False):
        clause = "" if include_cancelled else "WHERE status!='cancelled'"
        return [self.get_subscription(row[0]) for row in self.db.execute(f"SELECT id FROM subscriptions {clause} ORDER BY created_at,id")]

    def source_for(self, sub_id):
        data = self.get_subscription(sub_id)
        return Source(data["channel"], data["kind"], data["external_id"], data["name"], data["url"], bool(data["confirmed"]))

    def update_subscription(self, sub_id, *, status=None, connection_id=None, interval_seconds=None, sync_mode=None, collect_items=None):
        old = self.get_subscription(sub_id)
        conn_id = connection_id or old["connection_id"]
        if self.get_connection(conn_id).channel != old["channel"]:
            raise ChannelError("INVALID_INPUT", "subscription.update", "连接不属于同一渠道")
        if status is not None and status not in {"active", "paused", "cancelled"}:
            raise ChannelError("INVALID_INPUT", "subscription.update", "无效订阅状态")
        with self.database.transaction() as db:
            db.execute("UPDATE subscriptions SET status=?,connection_id=?,interval_seconds=?,sync_mode=?,collect_items=?,version=version+1,updated_at=? WHERE id=?",
                       (status or old["status"], conn_id, interval_seconds if interval_seconds is not None else old["interval_seconds"], sync_mode or old['sync_mode'],
                        collect_items if collect_items is not None else old['collect_items'], now(), sub_id))
        return self.get_subscription(sub_id)

    def set_source_priority(self, sub_id, priority):
        validate_priority(priority)
        self.get_subscription(sub_id)
        with self.database.transaction() as db:
            db.execute('UPDATE subscriptions SET default_priority=?,updated_at=? WHERE id=?',
                       (priority, now(), sub_id))
        return self.get_subscription(sub_id)

    def snapshot(self, sub_id, progress_version="1"):
        sub = self.get_subscription(sub_id)
        conn = self.get_connection(sub["connection_id"])
        return {"subscription_version": sub["version"], "connection_id": conn.id, "connection_version": conn.version,
                "backend": conn.backend, "progress_version": progress_version, "content_range": "videos"}

    def assert_current(self, job):
        sub = self.get_subscription(job["subscription_id"])
        current = self.snapshot(sub["id"], job["snapshot"]["progress_version"])
        if sub["status"] != "active" or current != job["snapshot"] or not self.get_connection(sub["connection_id"]).enabled:
            raise ChannelError("STALE_CONFIG", "sync", "订阅或连接配置已改变，本次任务停止提交", scope="job", scope_key=job["id"])

    def create_job(self, sub_id, mode, *, item_key=None, progress_version="1", page_budget=1, trigger="manual"):
        if mode == "detail":
            existing = self.db.execute("SELECT id FROM jobs WHERE item_key=? AND mode='detail' AND state IN ('queued','running','waiting')", (item_key,)).fetchone()
        else:
            existing = self.db.execute("SELECT id FROM jobs WHERE subscription_id=? AND mode!='detail' AND state IN ('queued','running','waiting')", (sub_id,)).fetchone()
        if existing:
            return self.get_job(existing[0]), False
        snapshot = self.snapshot(sub_id, progress_version)
        job_id, stamp = uuid.uuid4().hex, now()
        with self.database.transaction() as db:
            db.execute("INSERT INTO jobs(id,subscription_id,mode,state,snapshot,item_key,created_at,updated_at,page_budget,trigger) VALUES(?,?,?,'queued',?,?,?,?,?,?)",
                       (job_id, sub_id, mode, encode(snapshot), item_key, stamp, stamp, page_budget, trigger))
        return self.get_job(job_id), True

    def get_job(self, job_id):
        row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "sync.status", "任务不存在")
        result = dict(row)
        for field in ("snapshot", "cursor", "error", "acquisition_metrics"):
            result[field] = json.loads(result[field]) if result[field] else None
        return result

    def list_jobs(self, limit=100, offset=0):
        return [self.get_job(row[0]) for row in self.db.execute("SELECT id FROM jobs ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?", (limit, offset))]

    def set_job_state(self, job_id, state, *, error=None, coverage=None):
        self.db.execute("UPDATE jobs SET state=?,error=?,coverage=COALESCE(?,coverage),updated_at=? WHERE id=?",
                        (state, encode(error) if error else None, coverage, now(), job_id))
        return self.get_job(job_id)

    def recover_interrupted(self):
        self.db.execute("UPDATE jobs SET state='interrupted',updated_at=? WHERE state IN ('queued','running')", (now(),))

    def existing_item_id(self, reference):
        row = self.db.execute('SELECT id FROM contents WHERE channel=? AND namespace=? AND external_id=?',
                              (reference.channel, reference.namespace, reference.external_id)).fetchone()
        return row['id'] if row else None

    def _upsert_item(self, db, item, *, intake_method='subscription', stamp=None):
        # Both entry points call this inside BEGIN IMMEDIATE. No source, state,
        # payload or timestamp is written on a duplicate identity.
        if self.existing_item_id(item):
            return 0
        if (any(not isinstance(part, str) or not part or ':' in part
                for part in (item.channel, item.namespace, item.external_id,
                             item.source.kind, item.source.external_id))
                or not item.title or not item.url or not item.source.name or not item.source.url
                or item.channel != item.source.channel):
            raise ValueError("Invalid content contract")
        data = jsonable(item)
        stamp = stamp or now()
        db.execute("""INSERT INTO contents(id,channel,namespace,external_id,title,published_at,payload,
                      first_seen_at,updated_at,intake_method,manual_added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                   (item.key, item.channel, item.namespace, item.external_id, item.title,
                    data['published']['value'], encode(data), stamp, stamp, intake_method,
                    stamp if intake_method == 'manual' else None))
        self._save_source(db, item.source)
        db.execute("INSERT OR IGNORE INTO content_sources VALUES(?,?)", (item.key, item.source.key))
        db.execute("INSERT OR IGNORE INTO content_states(content_id,updated_at) VALUES(?,?)", (item.key, stamp))
        return 1

    def save_manual(self, item, *, priority=None, tag_ids=None):
        with self.database.transaction() as db:
            existing = self.existing_item_id(item)
            if existing:
                return {'status': 'exists', 'item_id': existing}
            validate_priority(priority)
            tag_ids = validate_tag_ids(tag_ids or [])
            self._require_tags(tag_ids, 'intake.save')
            stamp = now()
            self._upsert_item(db, item, intake_method='manual', stamp=stamp)
            if priority is not None:
                db.execute('UPDATE content_states SET priority_override=? WHERE content_id=?', (priority, item.key))
            for tag_id in tag_ids:
                db.execute("INSERT INTO content_tags(content_id,tag_id,origin,created_at) VALUES(?,?,'manual',?)",
                           (item.key, tag_id, stamp))
        return {'status': 'created', 'item_id': item.key}

    def list_content_sources(self, channel=None, query=None):
        clauses, args = ["(EXISTS(SELECT 1 FROM content_sources cs WHERE cs.source_id=r.id) "
                         "OR EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.source_id=r.id))"], []
        if channel:
            clauses.append('r.channel=?')
            args.append(channel)
        if query:
            clauses.append('instr(lower(r.name),lower(?))>0')
            args.append(query)
        rows = self.db.execute("SELECT r.*,(SELECT count(*) FROM content_sources cs WHERE cs.source_id=r.id) AS content_count "
                               "FROM sources r WHERE " + ' AND '.join(clauses) + ' ORDER BY r.name,r.id', args)
        return {'items': [dict(row) for row in rows]}

    def _save_progress(self, db, job, mode, payload):
        snap = job["snapshot"]
        db.execute("""INSERT INTO sync_progress VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(subscription_id,backend,progress_version,content_range,mode)
                      DO UPDATE SET connection_version=excluded.connection_version,subscription_version=excluded.subscription_version,
                      payload=excluded.payload,updated_at=excluded.updated_at""",
                   (job["subscription_id"], snap["backend"], snap["progress_version"], snap["content_range"], mode,
                    snap["connection_version"], snap["subscription_version"], encode(payload), now()))

    def commit_page(self, job_id, page):
        with self.database.transaction() as db:
            job = self.get_job(job_id)
            if job["state"] != "running":
                raise ChannelError("STALE_CONFIG", "sync", "任务已停止，不再接受分页提交")
            self.assert_current(job)
            source_key = self.get_subscription(job["subscription_id"])["source_id"]
            if any(item.source.key != source_key for item in page.items):
                raise ValueError("Adapter returned content for a different source")
            new_count = sum(self._upsert_item(db, item) for item in page.items)
            errors = job["item_errors"] + len(page.item_errors)
            metrics = dict(job["acquisition_metrics"])
            for key, value in page.metrics.items():
                if key not in {"profile_reads", "discovered", "skipped", "detail_requests"} or type(value) is not int or value < 0:
                    raise ValueError("Invalid acquisition metric")
                metrics[key] = metrics.get(key, 0) + value
            db.execute("UPDATE jobs SET acquisition_metrics=? WHERE id=?", (encode(metrics), job_id))
            coverage = "possible_gaps" if errors else page.coverage
            db.execute("INSERT INTO fetch_runs(job_id,page_index,item_count,new_count,errors,coverage,created_at) VALUES(?,?,?,?,?,?,?)",
                       (job_id, job["pages"] + 1, len(page.items), new_count, encode(page.item_errors), coverage, now()))
            db.execute("UPDATE jobs SET pages=pages+1,items=items+?,new_items=new_items+?,item_errors=?,cursor=?,coverage=?,end_evidence=?,updated_at=? WHERE id=?",
                       (len(page.items), new_count, errors, encode(page.next_cursor) if page.next_cursor else None, coverage,
                        page.end_evidence if page.terminal else None, now(), job_id))
            if job["mode"] == "backfill":
                self._save_progress(db, job, "backfill", {"cursor": page.next_cursor, "coverage": coverage, "complete": False})
        return self.get_job(job_id)

    def complete_source_ids(self, source_key, limit=2000):
        """Only successfully acquired details qualify for the pre-navigation skip."""
        return tuple(row[0] for row in self.db.execute(
            "SELECT c.external_id FROM contents c JOIN content_sources cs ON cs.content_id=c.id "
            "WHERE cs.source_id=? AND json_extract(c.payload,'$.acquisition_complete')=1 "
            "ORDER BY c.published_at DESC,c.id DESC LIMIT ?", (source_key, limit)))

    def finish_scan(self, job_id, *, coverage, complete=False, checkpoint=None):
        with self.database.transaction() as db:
            job = self.get_job(job_id)
            self.assert_current(job)
            if job["state"] != "running":
                raise ChannelError("STALE_CONFIG", "sync", "任务不在执行中")
            if complete and (job["item_errors"] or not job["end_evidence"] or coverage not in {"history_end", "refresh_interval"}):
                raise ValueError("Incomplete scan cannot advance a checkpoint")
            state = "partial" if job["item_errors"] or coverage == "possible_gaps" else "succeeded"
            if complete:
                mode = "backfill" if job["mode"] == "backfill" else "refresh"
                self._save_progress(db, job, mode, {"coverage": coverage, "complete": True, "checkpoint": checkpoint, "cursor": None})
            db.execute("UPDATE jobs SET state=?,coverage=?,updated_at=? WHERE id=?", (state, coverage, now(), job_id))
        return self.get_job(job_id)

    def get_progress(self, sub_id):
        return [{**dict(row), "payload": json.loads(row["payload"])} for row in self.db.execute("SELECT * FROM sync_progress WHERE subscription_id=?", (sub_id,))]

    def update_content_state(self, keys, patch):
        if not isinstance(patch, dict) or not patch or set(patch) - {"read", "archived", "deferred", "priority"}:
            raise ChannelError("INVALID_INPUT", "content.update", "不支持的内容整理字段")
        states = {k: v for k, v in patch.items() if k != 'priority'}
        if any(type(v) is not bool for v in states.values()):
            raise ChannelError("INVALID_INPUT", "content.update", "处理状态必须为布尔值")
        chosen = [field for field, value in states.items() if value]
        if len(chosen) > 1:
            raise ChannelError("INVALID_INPUT", "content.update", "已读、稍后处理和归档只能选择一项")
        if chosen:
            states = {field: field == chosen[0] for field in ("read", "archived", "deferred")}
        values = {key: int(value) for key, value in states.items()}
        if 'priority' in patch:
            validate_priority(patch['priority'])
            values['priority_override'] = patch['priority']
        fields = ",".join(f"{key}=?" for key in values)
        with self.database.transaction() as db:
            for key in keys:
                if not db.execute("SELECT 1 FROM contents WHERE id=?", (key,)).fetchone():
                    raise ChannelError("NOT_FOUND", "content.update", "内容不存在")
                db.execute(f"UPDATE content_states SET {fields},updated_at=? WHERE content_id=?", (*values.values(), now(), key))
        return {"updated": len(set(keys))}

    def apply_detail(self, job_id, patch: ContentPatch):
        allowed = {"title", "summary", "thumbnail", "duration_seconds", "published", "url", "acquisition_complete"}
        if set(patch.fields) - allowed:
            raise ValueError("Unknown detail field")
        with self.database.transaction() as db:
            job = self.get_job(job_id)
            self.assert_current(job)
            if job["item_key"] != patch.item_key or job["state"] != "running":
                raise ValueError("Detail patch does not belong to this running job")
            row = db.execute("SELECT payload FROM contents WHERE id=?", (patch.item_key,)).fetchone()
            if not row:
                raise ChannelError("NOT_FOUND", "content.detail", "内容尚未入库")
            data = json.loads(row[0])
            fields = {key: jsonable(value) for key, value in patch.fields.items() if value is not None}
            precision = {"unknown": 0, "date": 1, "minute": 2, "second": 3}
            if "published" in fields and precision.get(fields["published"]["precision"], 0) < precision.get(data["published"]["precision"], 0):
                fields.pop("published")
            data.update(fields)
            db.execute("UPDATE contents SET title=?,published_at=?,payload=?,updated_at=? WHERE id=?",
                       (data["title"], data["published"]["value"], encode(data), now(), patch.item_key))
            db.execute("UPDATE jobs SET state='succeeded',updated_at=? WHERE id=?", (now(), job_id))

    @staticmethod
    def _content(row, timezone='UTC'):
        data = json.loads(row['payload'])
        published = data.get('published', {})
        manual = row['intake_method'] == 'manual'
        value = row['manual_added_at'] if manual else row['published_at']
        projected = calendar_key(value, 'second' if manual else published.get('precision', 'unknown'),
                                 'UTC' if manual else published.get('timezone'), timezone)
        return {"id": row["id"], **data,
                'first_seen_at': row['first_seen_at'], 'intake_method': row['intake_method'],
                'manual_added_at': row['manual_added_at'], 'calendar_at': value,
                'calendar_date': projected[:10] if projected else None, 'calendar_timezone': timezone,
                'calendar_basis': 'manual_added_at' if manual else 'published_at',
                # 采集侧的更新时间：识别建议据此判断内容是否已经变化。
                "updated_at": row["updated_at"],
                "state": {field: bool(row[field]) for field in ("read", "archived", "deferred")},
                "priority": row["effective_priority"], "priority_override": row["priority_override"],
                "source_priority": row["source_priority"]}

    # Content may link to several sources: inherit the highest non-null source
    # default. Aggregation keeps list counts unique and never multiplies rows.
    SOURCE_PRIORITY = """(SELECT sub.default_priority FROM content_sources cs
        JOIN subscriptions sub ON sub.source_id=cs.source_id
        WHERE cs.content_id=c.id AND sub.default_priority IS NOT NULL
        ORDER BY CASE sub.default_priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,sub.id LIMIT 1)"""
    EFFECTIVE_PRIORITY = f"COALESCE(s.priority_override,{SOURCE_PRIORITY})"
    CONTENT_COLUMNS = f"c.*,s.read,s.archived,s.deferred,s.priority_override,{SOURCE_PRIORITY} AS source_priority,{EFFECTIVE_PRIORITY} AS effective_priority"

    def get_content(self, key, timezone='UTC'):
        display_zone(timezone)
        row = self.db.execute(f"SELECT {self.CONTENT_COLUMNS} FROM contents c JOIN content_states s ON s.content_id=c.id WHERE c.id=?", (key,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "content.get", "内容不存在")
        return self._with_tags([self._content(row, timezone)])[0]

    CALENDAR_VALUE = "CASE WHEN c.intake_method='manual' THEN c.manual_added_at ELSE c.published_at END"

    def _calendar_expr(self, timezone='UTC', *, order=False):
        # IANA name validation excludes SQL metacharacters. One expression is used
        # for sorting, range filters, day grouping and previews.
        display_zone(timezone)
        function = 'sf_calendar_order' if order else 'sf_calendar_key'
        return (f"{function}({self.CALENDAR_VALUE},"
                "CASE WHEN c.intake_method='manual' THEN 'second' ELSE COALESCE(json_extract(c.payload,'$.published.precision'),'unknown') END,"
                "CASE WHEN c.intake_method='manual' THEN 'UTC' ELSE json_extract(c.payload,'$.published.timezone') END,"
                f"'{timezone}')")

    # M17 统一口径。列表与统计复用同一段谓词，避免「通知说 23 条、页面只剩 2 条」。
    # 收件箱的原义不变：pending 比它多包含「稍后处理」，不靠改名实现。
    PENDING_CLAUSE = "((s.read=0 AND s.archived=0 AND s.deferred=0) OR s.deferred=1)"
    HIGH_UNARCHIVED_CLAUSE = f"({EFFECTIVE_PRIORITY}='high' AND s.archived=0)"

    def _content_filter(self, *, channel=None, source_id=None, query=None, start=None, end=None,
                        read=None, archived=None, deferred=None, priority=None, tags=None, tag_mode=None,
                        intake_method=None, timezone='UTC', state=None, view=None):
        clauses, args = ["1=1"], []
        date_expr = self._calendar_expr(timezone)
        if state is not None:
            if state != 'pending':
                raise ChannelError('INVALID_INPUT', 'content.query', '内容口径无效')
            clauses.append(self.PENDING_CLAUSE)
        if view is not None:
            if view != 'high_unarchived':
                raise ChannelError('INVALID_INPUT', 'content.query', '内容视图无效')
            clauses.append(self.HIGH_UNARCHIVED_CLAUSE)
        if intake_method is not None:
            if intake_method not in {'subscription', 'manual'}:
                raise ChannelError('INVALID_INPUT', 'content.query', '收录方式无效')
            clauses.append('c.intake_method=?')
            args.append(intake_method)
        if priority == 'none':
            clauses.append(f"{self.EFFECTIVE_PRIORITY} IS NULL")
        elif priority is not None:
            validate_priority(priority)
            clauses.append(f"{self.EFFECTIVE_PRIORITY}=?")
            args.append(priority)
        tag_ids, mode = validate_tag_filter(tags, tag_mode)
        if tag_ids:
            marks = ",".join("?" * len(tag_ids))
            # 任一符合用 EXISTS，全部符合用计数相等；两种写法都让同一条内容
            # 只出现一次，统计不会因为多对多而被放大。
            if mode == 'any':
                clauses.append(f"EXISTS(SELECT 1 FROM content_tags ct WHERE ct.content_id=c.id AND ct.tag_id IN ({marks}))")
                args += tag_ids
            else:
                clauses.append(f"(SELECT count(DISTINCT ct.tag_id) FROM content_tags ct"
                               f" WHERE ct.content_id=c.id AND ct.tag_id IN ({marks}))=?")
                args += [*tag_ids, len(tag_ids)]
        for field, value in (("c.channel", channel), ("s.read", read), ("s.archived", archived), ("s.deferred", deferred)):
            if value is not None:
                clauses.append(f"{field}=?")
                args.append(value)
        if source_id:
            clauses.append("EXISTS(SELECT 1 FROM content_sources cs WHERE cs.content_id=c.id AND cs.source_id=?)")
            args.append(source_id)
        if query:
            clauses.append("instr(lower(c.title),lower(?))>0")
            args.append(query)
        for operator, value in ((">=", start), ("<=", end)):
            if value:
                clauses.append(f"{date_expr} {operator} ?")
                args.append(date_boundary(value, end=operator == '<=', zone=timezone))
        base = "FROM contents c JOIN content_states s ON s.content_id=c.id WHERE " + " AND ".join(clauses)
        return base, args

    def query_contents(self, *, limit=50, offset=0, **filters):
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
            raise ChannelError("INVALID_INPUT", "content.list", "分页参数无效")
        base, args = self._content_filter(**filters)
        timezone = filters.get('timezone', 'UTC')
        total = self.db.execute("SELECT count(*) " + base, args).fetchone()[0]
        records = self.db.execute(f"SELECT {self.CONTENT_COLUMNS} " + base + f" ORDER BY {self._calendar_expr(timezone, order=True)} DESC,c.id DESC LIMIT ? OFFSET ?", (*args, limit, offset))
        return {"items": self._with_tags([self._content(row, timezone) for row in records]), "total": total, "limit": limit, "offset": offset,
                "next_offset": offset + limit if offset + limit < total else None}


    def save_reminder_state(self, *, signature, generation=0, next_check_at=None, last_handled_at=None,
                            last_result=None, notification_error=None, backoff_index=0):
        """原子维护提醒运行状态（计划 §5）。

        signature 是提醒配置身份：配置切换后旧记录不得再被当成当前状态使用。
        """
        if not isinstance(signature, str) or not signature:
            raise ChannelError('INVALID_INPUT', 'reminder.state', '缺少提醒配置身份')
        with self.database.transaction() as db:
            db.execute(
                "INSERT INTO reminder_run_state(id,signature,generation,next_check_at,last_handled_at,"
                "last_result,notification_error,backoff_index,updated_at) VALUES(1,?,?,?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET signature=excluded.signature,generation=excluded.generation,"
                "next_check_at=excluded.next_check_at,last_handled_at=excluded.last_handled_at,"
                "last_result=excluded.last_result,notification_error=excluded.notification_error,"
                "backoff_index=excluded.backoff_index,updated_at=excluded.updated_at",
                (signature, int(generation), next_check_at, last_handled_at, last_result,
                 notification_error, int(backoff_index), now()))
        return self.load_reminder_state()

    def load_reminder_state(self):
        row = self.db.execute(
            "SELECT signature,generation,next_check_at,last_handled_at,last_result,notification_error,"
            "backoff_index,updated_at FROM reminder_run_state WHERE id=1").fetchone()
        if row is None:
            return None
        return {'signature': row['signature'], 'generation': row['generation'],
                'nextCheckAt': row['next_check_at'], 'lastHandledAt': row['last_handled_at'],
                'lastResult': row['last_result'], 'notificationError': row['notification_error'],
                'backoffIndex': row['backoff_index'], 'updatedAt': row['updated_at']}

    def reminder_summary(self, timezone='UTC'):
        """待处理与高优先级未归档的数量（R01/R02）。

        两个数出自同一次读取：不渲染 UI、不缓存、不依赖当前筛选，因此不会
        出现通知与列表对不上。按内容行计数，同一内容关联多个来源不会重复累加。
        """
        display_zone(timezone)
        row = self.db.execute(
            "SELECT count(*) FILTER (WHERE " + self.PENDING_CLAUSE + ") AS pending,"
            " count(*) FILTER (WHERE " + self.HIGH_UNARCHIVED_CLAUSE + ") AS high"
            " FROM contents c JOIN content_states s ON s.content_id=c.id").fetchone()
        return {'pendingCount': row['pending'], 'highUnarchivedCount': row['high'],
                'observedAt': now(), 'timezone': timezone}

    def calendar_summary(self, month, **filters):
        if not isinstance(month, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}", month):
            raise ChannelError('INVALID_INPUT', 'content.calendar', '月份格式应为 YYYY-MM')
        year, number = map(int, month.split('-'))
        if not 1 <= year <= 9999 or not 1 <= number <= 12:
            raise ChannelError('INVALID_INPUT', 'content.calendar', '月份无效')
        end = f"{month}-{calendar.monthrange(year, number)[1]:02d}"
        base, args = self._content_filter(start=month+'-01', end=end, **filters)
        date_expr = self._calendar_expr(filters.get('timezone', 'UTC'))
        order_expr = self._calendar_expr(filters.get('timezone', 'UTC'), order=True)
        levels = ('high', 'medium', 'low', 'none')
        counts = dict.fromkeys(levels, 0)
        days = {}
        # Group the entire filtered month, not an arbitrary page of content.
        rows = self.db.execute(f"SELECT substr({date_expr},1,10) AS day, "
                               f"{self.EFFECTIVE_PRIORITY} AS priority,count(*) AS count "
                               + base + " GROUP BY day,priority ORDER BY day", args)
        for row in rows:
            day = days.setdefault(row['day'], {'date':row['day'], 'total':0,
                                               'priorities':dict.fromkeys(levels, 0), 'items':[]})
            level = row['priority'] or 'none'
            day['total'] += row['count']
            day['priorities'][level] += row['count']
            counts[level] += row['count']
        # Only three small previews per day cross RPC; full day lists paginate
        # via content.list with identical filters and stable ordering.
        previews = self.db.execute(f"""SELECT id,title,day,priority,intake_method,calendar_at FROM (
            SELECT c.id,c.title,c.intake_method,{self.CALENDAR_VALUE} AS calendar_at,substr({date_expr},1,10) AS day,
                   {self.EFFECTIVE_PRIORITY} AS priority,
                   ROW_NUMBER() OVER (PARTITION BY substr({date_expr},1,10)
                                      ORDER BY {order_expr} DESC,c.id DESC) AS position
            """ + base + ") WHERE position<=3 ORDER BY day,position", args)
        for row in previews:
            days[row['day']]['items'].append({'id':row['id'], 'title':row['title'], 'priority':row['priority'],
                                             'intake_method':row['intake_method'], 'calendar_at':row['calendar_at']})
        return {'month':month, 'timezone':filters.get('timezone', 'UTC'), 'total':sum(counts.values()), 'priorities':counts, 'days':list(days.values())}

    # ---------------------------------------------------------------- 标签 M9
    #
    # 标签存在独立表里，采集只写 contents/content_states，因此重新采集在结构上
    # 就无法覆盖人工标签；平台原生话题也不会被采集写进 content_tags。

    @staticmethod
    def _tag(row, content_count=0):
        return {"id": row["id"], "name": row["name"], "description": row["description"],
                "color": row["color"], "enabled": bool(row["enabled"]),
                "synonyms": json.loads(row["synonyms"]), "contentCount": content_count,
                "createdAt": row["created_at"], "updatedAt": row["updated_at"]}

    def list_tags(self, query=None, enabled=None):
        clauses, args = ["1=1"], []
        if query:
            clauses.append("(instr(lower(name),lower(?))>0 OR instr(lower(synonyms),lower(?))>0)")
            args += [query, query]
        if enabled is not None:
            clauses.append("enabled=?")
            args.append(int(enabled))
        rows = self.db.execute(
            "SELECT t.*,(SELECT count(*) FROM content_tags ct WHERE ct.tag_id=t.id) AS usage "
            f"FROM tags t WHERE {' AND '.join(clauses)} ORDER BY t.name COLLATE NOCASE", args)
        return [self._tag(row, row["usage"]) for row in rows]

    def get_tag(self, tag_id):
        row = self.db.execute(
            "SELECT t.*,(SELECT count(*) FROM content_tags ct WHERE ct.tag_id=t.id) AS usage "
            "FROM tags t WHERE t.id=?", (tag_id,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "tag", "标签不存在")
        return self._tag(row, row["usage"])

    def find_tag_by_name(self, name):
        row = self.db.execute("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (name,)).fetchone()
        return row["id"] if row else None

    def create_tag(self, tag_id, name, description, color, enabled, synonyms):
        if self.find_tag_by_name(name):
            raise ChannelError("CONFLICT", "tag.create", "已存在同名标签")
        stamp = now()
        try:
            with self.database.transaction() as db:
                db.execute("INSERT INTO tags(id,name,description,color,enabled,synonyms,created_at,updated_at)"
                           " VALUES(?,?,?,?,?,?,?,?)",
                           (tag_id, name, description, color, int(enabled), encode(synonyms), stamp, stamp))
        except sqlite3.IntegrityError as error:
            # 唯一的第二道防线：大小写不同的重名由索引拦下，而不是静默合并。
            if "tags_name_unique" in str(error):
                raise ChannelError("CONFLICT", "tag.create", "已存在同名标签") from error
            raise
        return self.get_tag(tag_id)

    def update_tag(self, tag_id, **patch):
        current = self.get_tag(tag_id)
        values = {field: current[field] for field in ("name", "description", "color", "synonyms")}
        if "name" in patch and patch["name"] != current["name"]:
            clash = self.find_tag_by_name(patch["name"])
            if clash and clash != tag_id:
                raise ChannelError("CONFLICT", "tag.update", "已存在同名标签")
        values.update({k: v for k, v in patch.items() if k in values})
        fields = ",".join(f"{key}=?" for key in values)
        args = [encode(values["synonyms"]) if key == "synonyms" else values[key] for key in values]
        try:
            with self.database.transaction() as db:
                db.execute(f"UPDATE tags SET {fields},updated_at=? WHERE id=?", (*args, now(), tag_id))
        except sqlite3.IntegrityError as error:
            if "tags_name_unique" in str(error):
                raise ChannelError("CONFLICT", "tag.update", "已存在同名标签") from error
            raise
        return self.get_tag(tag_id)

    def set_tag_enabled(self, tag_id, enabled):
        self.get_tag(tag_id)
        with self.database.transaction() as db:
            db.execute("UPDATE tags SET enabled=?,updated_at=? WHERE id=?", (int(enabled), now(), tag_id))
        return self.get_tag(tag_id)

    def delete_tag(self, tag_id):
        tag = self.get_tag(tag_id)
        # 先记下受影响的条数再删：界面需要如实告知「这个标签正在 N 条内容上」。
        with self.database.transaction() as db:
            db.execute("DELETE FROM tags WHERE id=?", (tag_id,))
        return {"removed": True, "id": tag["id"], "detachedContents": tag["contentCount"]}

    def tags_for_contents(self, item_ids):
        """一次取回多条内容的标签，避免列表渲染逐条查询。"""
        grouped = {item_id: [] for item_id in item_ids}
        if not item_ids:
            return grouped
        marks = ",".join("?" * len(item_ids))
        rows = self.db.execute(
            f"SELECT ct.content_id,ct.origin,t.id,t.name,t.color FROM content_tags ct "
            f"JOIN tags t ON t.id=ct.tag_id WHERE ct.content_id IN ({marks}) ORDER BY t.name COLLATE NOCASE",
            tuple(item_ids))
        for row in rows:
            grouped[row["content_id"]].append(
                {"id": row["id"], "name": row["name"], "color": row["color"], "origin": row["origin"]})
        return grouped

    def _require_tags(self, tag_ids, method):
        if not tag_ids:
            return
        marks = ",".join("?" * len(tag_ids))
        found = {row["id"] for row in self.db.execute(f"SELECT id FROM tags WHERE id IN ({marks})", tuple(tag_ids))}
        missing = [tag_id for tag_id in tag_ids if tag_id not in found]
        if missing:
            raise ChannelError("NOT_FOUND", method, f"标签不存在：{missing[0]}")

    def set_content_tags(self, item_ids, tag_ids, origin="manual"):
        """人工打标：以给定列表为准替换。重复调用同一列表是幂等的。"""
        self._require_tags(tag_ids, "content.set_tags")
        stamp = now()
        kept = set(tag_ids)
        with self.database.transaction() as db:
            for item_id in dict.fromkeys(item_ids):
                if not db.execute("SELECT 1 FROM contents WHERE id=?", (item_id,)).fetchone():
                    raise ChannelError("NOT_FOUND", "content.set_tags", "内容不存在")
                current = {row["tag_id"] for row in
                           db.execute("SELECT tag_id FROM content_tags WHERE content_id=?", (item_id,))}
                # 被摘掉的标签记为人工屏蔽；仍在列表里的解除屏蔽，因为重新添加也是一次决定。
                for removed in current - kept:
                    db.execute("INSERT INTO content_tag_blocks(content_id,tag_id,created_at) VALUES(?,?,?)"
                               " ON CONFLICT(content_id,tag_id) DO NOTHING", (item_id, removed, stamp))
                for restored in kept:
                    db.execute("DELETE FROM content_tag_blocks WHERE content_id=? AND tag_id=?", (item_id, restored))
                # 人工设置即最终结果：无论原来的关联是人工还是识别建议，都一并替换。
                db.execute("DELETE FROM content_tags WHERE content_id=?", (item_id,))
                for tag_id in tag_ids:
                    # 人工指定的关联总是升格为 manual，此后自动识别不会移除它。
                    db.execute("INSERT INTO content_tags(content_id,tag_id,origin,created_at) VALUES(?,?,'manual',?)"
                               " ON CONFLICT(content_id,tag_id) DO UPDATE SET origin='manual'",
                               (item_id, tag_id, stamp))
        return {"updated": len(set(item_ids)), "tags": list(tag_ids)}

    def add_suggested_tags(self, item_id, tag_ids):
        """应用识别建议：只增不删，且不越过人工屏蔽。

        这是「旧建议不能静默撤销人工修改」的结构性保证——本方法没有任何
        DELETE，人工移除过的标签既不会被删，也不会被后续建议悄悄加回来。
        """
        self._require_tags(tag_ids, "tag.suggestion")
        stamp = now()
        added, blocked = 0, []
        with self.database.transaction() as db:
            if not db.execute("SELECT 1 FROM contents WHERE id=?", (item_id,)).fetchone():
                raise ChannelError("NOT_FOUND", "tag.suggestion", "内容不存在")
            for tag_id in dict.fromkeys(tag_ids):
                if db.execute("SELECT 1 FROM content_tag_blocks WHERE content_id=? AND tag_id=?",
                              (item_id, tag_id)).fetchone():
                    blocked.append(tag_id)
                    continue
                # 冲突即忽略：重复建议不产生重复关联，也不覆盖既有的 manual 来源。
                cursor = db.execute("INSERT INTO content_tags(content_id,tag_id,origin,created_at)"
                                    " VALUES(?,?,'suggested',?) ON CONFLICT(content_id,tag_id) DO NOTHING",
                                    (item_id, tag_id, stamp))
                added += cursor.rowcount if cursor.rowcount > 0 else 0
        return added, blocked

    def tag_contents(self, tag_id, limit=50, offset=0, **filters):
        self.get_tag(tag_id)
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
            raise ChannelError("INVALID_INPUT", "tag.contents", "分页参数无效")
        base, args = self._content_filter(**filters)
        timezone = filters.get('timezone', 'UTC')
        clause = base.replace("WHERE 1=1", f"WHERE 1=1 AND EXISTS(SELECT 1 FROM content_tags ct "
                                            f"WHERE ct.content_id=c.id AND ct.tag_id=?)", 1)
        args = [tag_id, *args]
        total = self.db.execute("SELECT count(*) " + clause, args).fetchone()[0]
        records = self.db.execute(f"SELECT {self.CONTENT_COLUMNS} " + clause +
                                  f" ORDER BY {self._calendar_expr(timezone, order=True)} DESC,c.id DESC LIMIT ? OFFSET ?", (*args, limit, offset))
        return {"items": self._with_tags([self._content(row, timezone) for row in records]),
                "total": total, "limit": limit, "offset": offset,
                "next_offset": offset + limit if offset + limit < total else None}

    def _with_tags(self, contents):
        by_id = self.tags_for_contents([item["id"] for item in contents])
        for item in contents:
            item["tags"] = by_id.get(item["id"], [])
        return contents
