from pathlib import Path


class CoreLease:
    """Prevent two Core instances from recovering or writing the same live DB."""
    def __init__(self, database_path):
        path = Path(database_path)
        if not path.is_absolute():
            raise ValueError("Application-data path must be absolute")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(path.with_suffix(path.suffix + ".lock"), "a+b")
        try:
            import fcntl
            fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, OSError) as error:
            self.file.close()
            raise RuntimeError("Core 数据目录已被占用，或系统尚不支持本版本的进程锁") from error

    def close(self):
        self.file.close()
