"""M15 应用设置存储。

单行表保存当前设置、配置版本与更新时间。版本每次保存递增，
读取方据此判断自己手上的配置是否已经过期。

这里只放非敏感内容：接口地址、模型标识、提醒参数和凭据引用。
密钥由 Electron Main 的凭据服务加密保管，既不写入这个库，
后续读取不向 Renderer 回传密钥 —— 见 §2.4。
"""

import json

from .repositories import now


class SettingsStore:
    def __init__(self, database):
        self.database = database
        self.db = database.connection

    def load(self):
        row = self.db.execute("SELECT version,payload,updated_at FROM app_settings WHERE id=1").fetchone()
        if row is None:
            return {"version": 0, "payload": None, "updatedAt": None}
        return {"version": row["version"], "payload": json.loads(row["payload"]), "updatedAt": row["updated_at"]}

    def save(self, payload, version=None, apply=None):
        """保存设置。

        ``apply`` 是在同一个事务里执行的其他写入。M42 的「优先级设置」要把
        三级名称、智能判断策略和来源默认优先级放在一次保存里生效：来源
        默认值在 subscriptions 表里，设置在 app_settings 表里，两处必须同一
        个事务，否则失败时会留下「名称已保存、来源只保存了一半」的坏状态。
        """
        current = self.load()
        # 单进程写入且保存时递增版本，读到的版本号足以判断自己是否过期。
        next_version = current["version"] + 1 if version is None else version
        stamp = now()
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        with self.database.transaction() as db:
            db.execute("INSERT INTO app_settings(id,version,payload,updated_at) VALUES(1,?,?,?) "
                       "ON CONFLICT(id) DO UPDATE SET version=excluded.version,"
                       "payload=excluded.payload,updated_at=excluded.updated_at",
                       (next_version, encoded, stamp))
            if apply is not None:
                apply(db)
        return {"version": next_version, "payload": payload, "updatedAt": stamp}
