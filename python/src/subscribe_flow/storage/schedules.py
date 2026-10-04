import json

from .repositories import encode


class ScheduleStore:
    def __init__(self, repository):
        self.repository, self.db = repository, repository.db

    def get(self, sub_id):
        row = self.db.execute('SELECT * FROM schedules WHERE subscription_id=?', (sub_id,)).fetchone()
        return dict(row) if row else None

    def ensure(self, sub, timestamp):
        row = self.get(sub['id'])
        if row is None:
            self.db.execute('INSERT INTO schedules(subscription_id,version,next_due) VALUES(?,?,?)',
                            (sub['id'], sub['version'], timestamp + sub['interval_seconds']))
        elif row['version'] != sub['version']:
            self.update(sub['id'], version=sub['version'], next_due=timestamp + sub['interval_seconds'],
                        failures=0, retry_job_id=None, reason='')
        return self.get(sub['id'])

    def update(self, sub_id, **patch):
        allowed = {'version', 'next_due', 'failures', 'last_job_id', 'last_state', 'retry_job_id', 'reason'}
        if not patch or not patch.keys() <= allowed:
            raise ValueError('Invalid schedule patch')
        columns = ','.join(f'{key}=?' for key in patch)
        self.db.execute(f'UPDATE schedules SET {columns} WHERE subscription_id=?', (*patch.values(), sub_id))

    def blocks(self):
        return [{**dict(row), 'error': json.loads(row['error'])} for row in self.db.execute('SELECT * FROM schedule_blocks')]

    def block(self, scope, key, operation, error, until_at=None):
        self.db.execute('''INSERT INTO schedule_blocks VALUES(?,?,?,?,?)
            ON CONFLICT(scope,scope_key,operation) DO UPDATE SET error=excluded.error,until_at=excluded.until_at''',
                        (scope, key, operation, encode(error), until_at))

    def clear(self, block):
        self.db.execute('DELETE FROM schedule_blocks WHERE scope=? AND scope_key=? AND operation=?',
                        (block['scope'], block['scope_key'], block['operation']))
