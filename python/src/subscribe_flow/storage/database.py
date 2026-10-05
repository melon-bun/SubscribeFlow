import sqlite3
from uuid import uuid4
from contextlib import contextmanager
from pathlib import Path


class Database:
    def __init__(self, path: Path):
        self.path = Path(path).expanduser()
        if not self.path.is_absolute():
            raise ValueError("Database path must be an absolute application-data path")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.path, isolation_level=None, timeout=5)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA busy_timeout=5000")
        try:
            self._migrate()
        except BaseException:
            self.connection.close()
            raise

    def _migrate(self):
        current = self.connection.execute("PRAGMA user_version").fetchone()[0]
        migrations = sorted((Path(__file__).parent / "migrations").glob("[0-9]*.sql"))
        latest = max(int(path.name.split("_")[0]) for path in migrations)
        if current > latest:
            raise RuntimeError("Database schema is newer than this application")
        if current < latest and self.connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").fetchone():
            destination = self.path.with_suffix(f".before-v{latest}.backup")
            if destination.exists():
                destination = self.path.with_suffix(f".before-v{latest}.{uuid4().hex[:12]}.backup")
            self.backup(destination)
        pending = [path for path in migrations if int(path.name.split("_")[0]) > current]
        if pending:
            # Treat a multi-version upgrade as one transaction. If a later migration
            # fails, neither an intermediate schema nor partial data can be committed.
            script = "\n".join(path.read_text() for path in pending)
            try:
                self.connection.executescript("BEGIN IMMEDIATE;\n" + script + f"\nPRAGMA user_version={latest};\nCOMMIT;")
            except BaseException:
                if self.connection.in_transaction:
                    self.connection.rollback()
                raise

    @contextmanager
    def transaction(self):
        if self.connection.in_transaction:
            raise RuntimeError("Nested write transactions are not supported")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield self.connection
            self.connection.commit()
        except BaseException:
            self.connection.rollback()
            raise

    def backup(self, destination: Path):
        destination = Path(destination)
        if not destination.is_absolute() or destination.resolve() == self.path.resolve():
            raise ValueError("Backup must use a distinct absolute path")
        if self.connection.in_transaction:
            raise RuntimeError("Backup cannot run inside a write transaction")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(destination) as target:
            self.connection.backup(target)

    def close(self):
        self.connection.close()
