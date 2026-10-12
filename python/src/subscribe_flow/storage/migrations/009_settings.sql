-- M15 应用设置。只保存非敏感配置与凭据引用；密钥本身由桌面凭据服务
-- 用系统保护能力加密后单独保管，任何情况下都不进入这个库。
CREATE TABLE app_settings(
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL CHECK(version>=0),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
