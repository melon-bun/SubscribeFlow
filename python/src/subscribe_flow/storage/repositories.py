from __future__ import annotations

import json
import calendar
import re
import uuid
from datetime import datetime, timezone

from subscribe_flow.contracts import ChannelError, Connection, ContentPatch, Source, jsonable
from subscribe_flow.contracts.priorities import validate_priority


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def encode(value) -> str:
    return json.dumps(jsonable(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Repository:
    def __init__(self, database):
        self.database, self.db = database, database.connection

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
        row = self.db.execute("""SELECT s.*,r.channel,r.kind,r.external_id,r.name,r.url,r.confirmed
                                 FROM subscriptions s JOIN sources r ON r.id=s.source_id WHERE s.id=?""", (sub_id,)).fetchone()
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
        for field in ("snapshot", "cursor", "error"):
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

    def _upsert_item(self, db, item):
        if not item.external_id or not item.title or not item.url or item.channel != item.source.channel:
            raise ValueError("Invalid content contract")
        data = jsonable(item)
        old = db.execute("SELECT payload FROM contents WHERE id=?", (item.key,)).fetchone()
        if old:
            prior = json.loads(old[0])
            for field in ("summary", "thumbnail", "duration_seconds"):
                if data[field] is None:
                    data[field] = prior[field]
            precision = {"unknown": 0, "date": 1, "minute": 2, "second": 3}
            if precision.get(data["published"]["precision"], 0) < precision.get(prior["published"]["precision"], 0):
                data["published"] = prior["published"]
        stamp = now()
        db.execute("""INSERT INTO contents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                      title=excluded.title,published_at=excluded.published_at,payload=excluded.payload,updated_at=excluded.updated_at""",
                   (item.key, item.channel, item.namespace, item.external_id, item.title, data["published"]["value"], encode(data), stamp, stamp))
        self._save_source(db, item.source)
        db.execute("INSERT OR IGNORE INTO content_sources VALUES(?,?)", (item.key, item.source.key))
        db.execute("INSERT OR IGNORE INTO content_states(content_id,updated_at) VALUES(?,?)", (item.key, stamp))
        return int(old is None)

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
            coverage = "possible_gaps" if errors else page.coverage
            db.execute("INSERT INTO fetch_runs(job_id,page_index,item_count,new_count,errors,coverage,created_at) VALUES(?,?,?,?,?,?,?)",
                       (job_id, job["pages"] + 1, len(page.items), new_count, encode(page.item_errors), coverage, now()))
            db.execute("UPDATE jobs SET pages=pages+1,items=items+?,new_items=new_items+?,item_errors=?,cursor=?,coverage=?,end_evidence=?,updated_at=? WHERE id=?",
                       (len(page.items), new_count, errors, encode(page.next_cursor) if page.next_cursor else None, coverage,
                        page.end_evidence if page.terminal else None, now(), job_id))
            if job["mode"] == "backfill":
                self._save_progress(db, job, "backfill", {"cursor": page.next_cursor, "coverage": coverage, "complete": False})
        return self.get_job(job_id)

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
        allowed = {"title", "summary", "thumbnail", "duration_seconds", "published"}
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
            data.update({key: jsonable(value) for key, value in patch.fields.items() if value is not None})
            db.execute("UPDATE contents SET title=?,published_at=?,payload=?,updated_at=? WHERE id=?",
                       (data["title"], data["published"]["value"], encode(data), now(), patch.item_key))
            db.execute("UPDATE jobs SET state='succeeded',updated_at=? WHERE id=?", (now(), job_id))

    @staticmethod
    def _content(row):
        return {"id": row["id"], **json.loads(row["payload"]),
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

    def get_content(self, key):
        row = self.db.execute(f"SELECT {self.CONTENT_COLUMNS} FROM contents c JOIN content_states s ON s.content_id=c.id WHERE c.id=?", (key,)).fetchone()
        if not row:
            raise ChannelError("NOT_FOUND", "content.get", "内容不存在")
        return self._content(row)

    def _content_filter(self, *, channel=None, source_id=None, query=None, start=None, end=None,
                        read=None, archived=None, deferred=None, priority=None):
        clauses, args = ["1=1"], []
        if priority == 'none':
            clauses.append(f"{self.EFFECTIVE_PRIORITY} IS NULL")
        elif priority is not None:
            validate_priority(priority)
            clauses.append(f"{self.EFFECTIVE_PRIORITY}=?")
            args.append(priority)
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
                clauses.append(f"c.published_at {operator} ?")
                args.append(value)
        base = "FROM contents c JOIN content_states s ON s.content_id=c.id WHERE " + " AND ".join(clauses)
        return base, args

    def query_contents(self, *, limit=50, offset=0, **filters):
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
            raise ChannelError("INVALID_INPUT", "content.list", "分页参数无效")
        base, args = self._content_filter(**filters)
        total = self.db.execute("SELECT count(*) " + base, args).fetchone()[0]
        records = self.db.execute(f"SELECT {self.CONTENT_COLUMNS} " + base + " ORDER BY c.published_at DESC,c.id DESC LIMIT ? OFFSET ?", (*args, limit, offset))
        return {"items": [self._content(row) for row in records], "total": total, "limit": limit, "offset": offset,
                "next_offset": offset + limit if offset + limit < total else None}


    def calendar_summary(self, month, **filters):
        if not isinstance(month, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}", month):
            raise ChannelError('INVALID_INPUT', 'content.calendar', '月份格式应为 YYYY-MM')
        year, number = map(int, month.split('-'))
        if not 1 <= year <= 9999 or not 1 <= number <= 12:
            raise ChannelError('INVALID_INPUT', 'content.calendar', '月份无效')
        end = f"{month}-{calendar.monthrange(year, number)[1]:02d}T23:59:59Z"
        base, args = self._content_filter(start=month+'-01', end=end, **filters)
        levels = ('high', 'medium', 'low', 'none')
        counts = dict.fromkeys(levels, 0)
        days = {}
        # Group the entire filtered month, not an arbitrary page of content.
        rows = self.db.execute(f"SELECT substr(c.published_at,1,10) AS day, "
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
        previews = self.db.execute(f"""SELECT id,title,day,priority FROM (
            SELECT c.id,c.title,substr(c.published_at,1,10) AS day,
                   {self.EFFECTIVE_PRIORITY} AS priority,
                   ROW_NUMBER() OVER (PARTITION BY substr(c.published_at,1,10)
                                      ORDER BY c.published_at DESC,c.id DESC) AS position
            """ + base + ") WHERE position<=3 ORDER BY day,position", args)
        for row in previews:
            days[row['day']]['items'].append({'id':row['id'], 'title':row['title'], 'priority':row['priority']})
        return {'month':month, 'total':sum(counts.values()), 'priorities':counts, 'days':list(days.values())}
