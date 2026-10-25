"""M45 付费渠道仓储：调用账本、来源解析缓存与回溯检查点。

只存非敏感信息：没有密钥、没有请求体、没有响应原文。
账本里的扣费判定只有三种（已确认消费／服务端明确拒绝／结果未知），
不提供「大概没扣」这种会骗人的中间状态。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

CHARGE_CONFIRMED = "confirmed"
CHARGE_NOT_CHARGED = "not_charged"
CHARGE_UNKNOWN = "unknown"

STATUS_PENDING = "pending"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_UNKNOWN = "unknown"
STATUS_CANCELLED = "cancelled"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class PaidChannelRepository:
    def __init__(self, database):
        self.database, self.db = database, database.connection

    # ------------------------------------------------------------------
    # 调用账本
    # ------------------------------------------------------------------
    def begin_attempt(self, *, channel: str, operation: str, connection_id: str | None = None,
                      credential_version: int = 0, biz: str | None = None,
                      wxid: str | None = None) -> str:
        """登记一次付费调用的开始。请求发出前就落账，避免崩溃后账本里没有痕迹。"""
        attempt_id = uuid.uuid4().hex
        with self.database.transaction() as db:
            db.execute("""INSERT INTO paid_channel_attempts
                         (id,channel,connection_id,credential_version,operation,biz,wxid,started_at,
                          status,charge_state,confirmed_credits)
                         VALUES(?,?,?,?,?,?,?,?,?,?,0)""",
                       (attempt_id, channel, connection_id, int(credential_version), operation,
                        biz, wxid, now(), STATUS_PENDING, "pending"))
        return attempt_id

    def finish_attempt(self, attempt_id: str, *, status: str, charge_state: str,
                       confirmed_credits: int = 0, balance: int | None = None,
                       error_code: str | None = None, error_message: str | None = None) -> None:
        """结算一次付费调用。charge_state 是唯一的扣费事实来源。"""
        if charge_state not in (CHARGE_CONFIRMED, CHARGE_NOT_CHARGED, CHARGE_UNKNOWN):
            raise ValueError("Unsupported charge state")
        credits = int(confirmed_credits) if charge_state == CHARGE_CONFIRMED else 0
        with self.database.transaction() as db:
            db.execute("""UPDATE paid_channel_attempts
                          SET finished_at=?,status=?,charge_state=?,confirmed_credits=?,
                              balance_credits=?,balance_observed_at=?,error_code=?,error_message=?
                          WHERE id=?""",
                       (now(), status, charge_state, credits, balance,
                        now() if balance is not None else None, error_code, error_message, attempt_id))

    def recover_pending(self) -> int:
        """把上次崩溃遗留的未完成尝试结算为「结果未知」。

        这些调用可能已经扣过费，因此不能按零消费处理。
        """
        with self.database.transaction() as db:
            cursor = db.execute("""UPDATE paid_channel_attempts
                                   SET status=?,charge_state=?,finished_at=?,
                                       error_code=?,error_message=?
                                   WHERE status=? OR charge_state='pending'""",
                                (STATUS_UNKNOWN, CHARGE_UNKNOWN, now(), "INTERRUPTED",
                                 "上次运行未完成，扣费结果未知", STATUS_PENDING))
            return cursor.rowcount

    def usage_summary(self, *, channel: str, since: str, until: str) -> dict:
        """自然月汇总：已确认用量、结果未知次数与调用次数。"""
        rows = self.db.execute("""SELECT charge_state,COUNT(*) AS total,
                                         COALESCE(SUM(confirmed_credits),0) AS credits
                                  FROM paid_channel_attempts
                                  WHERE channel=? AND started_at>=? AND started_at<?
                                  GROUP BY charge_state""",
                               (channel, since, until)).fetchall()
        confirmed_credits = 0
        unknown_count = 0
        calls = 0
        for row in rows:
            calls += int(row["total"])
            if row["charge_state"] == CHARGE_CONFIRMED:
                confirmed_credits += int(row["credits"])
            elif row["charge_state"] == CHARGE_UNKNOWN:
                unknown_count += int(row["total"])
        return {"confirmed_credits": confirmed_credits, "unknown_count": unknown_count, "calls": calls}

    def list_attempts(self, *, channel: str, limit: int = 50) -> list[dict]:
        rows = self.db.execute("""SELECT * FROM paid_channel_attempts
                                  WHERE channel=? ORDER BY started_at DESC LIMIT ?""",
                               (channel, int(limit))).fetchall()
        return [dict(row) for row in rows]

    def latest_balance(self, *, channel: str, credential_version: int) -> dict | None:
        """当前密钥版本下最近一次观察到的服务端余额。

        余额只是服务端观察值，不是本地账本算出来的数；
        换了密钥以后旧快照不会再被当成新密钥的余额。
        """
        row = self.db.execute("""SELECT balance_credits,balance_observed_at,credential_version
                                  FROM paid_channel_attempts
                                  WHERE channel=? AND credential_version=? AND balance_credits IS NOT NULL
                                  ORDER BY finished_at DESC LIMIT 1""",
                              (channel, int(credential_version))).fetchone()
        return dict(row) if row else None

    # ------------------------------------------------------------------
    # 来源解析缓存
    # ------------------------------------------------------------------
    def cached_source(self, biz: str) -> dict | None:
        row = self.db.execute("SELECT * FROM paid_channel_sources WHERE biz=?", (biz,)).fetchone()
        return dict(row) if row else None

    def save_source_cache(self, *, biz: str, gh_id: str, name: str, source_id: str,
                          avatar: str | None = None, description: str | None = None,
                          credential_version: int = 0, parser_version: str = "1") -> None:
        with self.database.transaction() as db:
            db.execute("""INSERT INTO paid_channel_sources
                         (biz,gh_id,name,avatar,description,source_id,credential_version,parser_version,resolved_at)
                         VALUES(?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(biz) DO UPDATE SET
                           gh_id=excluded.gh_id,name=excluded.name,avatar=excluded.avatar,
                           description=excluded.description,source_id=excluded.source_id,
                           credential_version=excluded.credential_version,
                           parser_version=excluded.parser_version,resolved_at=excluded.resolved_at""",
                       (biz, gh_id, name, avatar, description, source_id,
                        int(credential_version), parser_version, now()))

    def clear_source_cache(self, biz: str | None = None) -> int:
        with self.database.transaction() as db:
            if biz is None:
                cursor = db.execute("DELETE FROM paid_channel_sources")
            else:
                cursor = db.execute("DELETE FROM paid_channel_sources WHERE biz=?", (biz,))
            return cursor.rowcount

    def count_source_cache(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM paid_channel_sources").fetchone()[0])

    # ------------------------------------------------------------------
    # 回溯检查点
    # ------------------------------------------------------------------
    def checkpoint(self, source_id: str, connection_id: str) -> dict | None:
        row = self.db.execute("""SELECT * FROM paid_channel_checkpoints
                                  WHERE source_id=? AND connection_id=?""",
                              (source_id, connection_id)).fetchone()
        return dict(row) if row else None

    def save_checkpoint(self, *, source_id: str, connection_id: str, cursor: str | None,
                        expires_at: str | None = None, credential_version: int = 0,
                        parser_version: str = "1", progress_version: str = "1") -> None:
        with self.database.transaction() as db:
            db.execute("""INSERT INTO paid_channel_checkpoints
                         (id,source_id,connection_id,cursor,obtained_at,expires_at,
                          credential_version,parser_version,progress_version)
                         VALUES(?,?,?,?,?,?,?,?,?)
                         ON CONFLICT(source_id,connection_id) DO UPDATE SET
                           cursor=excluded.cursor,obtained_at=excluded.obtained_at,
                           expires_at=excluded.expires_at,credential_version=excluded.credential_version,
                           parser_version=excluded.parser_version,progress_version=excluded.progress_version""",
                       (uuid.uuid4().hex, source_id, connection_id, cursor, now(), expires_at,
                        int(credential_version), parser_version, progress_version))

    def clear_checkpoint(self, source_id: str, connection_id: str) -> int:
        with self.database.transaction() as db:
            cursor = db.execute("""DELETE FROM paid_channel_checkpoints
                                   WHERE source_id=? AND connection_id=?""",
                                (source_id, connection_id))
            return cursor.rowcount
