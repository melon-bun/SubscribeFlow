"""Manual-date fixture, restricted to the formal renderer's temporary directory."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from subscribe_flow.contracts import ContentItem, PublishedTime, Source
from subscribe_flow.storage.database import Database
from subscribe_flow.storage.repositories import Repository


folder, mode = Path(sys.argv[1]).resolve(), sys.argv[2]
if not folder.name.startswith('subscribe-flow-renderer-') or mode not in {'add', 'remove'}:
    raise SystemExit('Fixture requires an isolated renderer smoke directory and a known mode')
source = Source('bilibili', 'author', 'm11-renderer-fixture', '隔离 M11 收录样本', 'https://example.com/author', True)
item = ContentItem('bilibili', 'video', 'm11-renderer-fixture', source,
                   '隔离 M11 手动收录：保留早期发布日期', 'https://example.com/content',
                   published=PublishedTime('2000-01-02', 'date', 'offline-smoke', 'UTC'),
                   summary='仅用于隔离界面验收，不是平台采集结果。', acquisition_complete=True)
db = Database(folder / 'subscribe-flow.sqlite3')
try:
    repo = Repository(db)
    if mode == 'add':
        assert repo.query_contents()['total'] == 0 and not repo.list_subscriptions()
        assert repo.save_manual(item, priority='high')['status'] == 'created'
    else:
        assert repo.get_content(item.key)['title'] == item.title
        with db.transaction() as sql:
            for table in ('content_tags', 'content_tag_blocks', 'content_sources', 'content_states'):
                sql.execute(f'DELETE FROM {table} WHERE content_id=?', (item.key,))
            sql.execute('DELETE FROM contents WHERE id=?', (item.key,))
            sql.execute('DELETE FROM sources WHERE id=?', (source.key,))
        assert repo.query_contents()['total'] == 0 and not repo.list_subscriptions()
finally:
    db.close()
