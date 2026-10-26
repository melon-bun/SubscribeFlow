"""One-time v16 identity conversion, inside Database's upgrade transaction.

This module never opens a transport, schedules a worker, or records a new intake.
It rebuilds only affected WeChat rows, retaining originals for local recovery.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone

from subscribe_flow.channels.wxrank.protocol import (
    article_identity, content_external_id, extract_biz, normalize_biz, source_url,
)

CHANNELS = {'wechat', 'wxrank'}
CONNECTION = 'wechat:default'
BACKEND = 'electron-session'
RESOURCE = 'browser:electron-wechat'
CONTENT_TABLES = (
    'content_sources', 'content_states', 'content_tags', 'content_tag_blocks',
    'content_notes', 'content_events', 'tagging_tasks', 'content_priority_decisions',
    'priority_tasks', 'priority_preference_samples',
)


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def _rows(db, table):
    return [dict(row) for row in db.execute(f'SELECT * FROM {table}')]


def _insert(db, table, row):
    columns = ','.join(row)
    marks = ','.join('?' for _ in row)
    db.execute(f'INSERT INTO {table}({columns}) VALUES({marks})', tuple(row.values()))


def _time(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, TypeError, ValueError):
        raise ValueError('WeChat upgrade encountered an invalid record timestamp') from None


def _latest(rows, field='updated_at'):
    return max(rows, key=lambda row: (_time(row[field]), str(row.get('id', row.get('content_id', '')))))


def _identity(external_id):
    try:
        biz, mid, idx = external_id.rsplit('_', 2)
        return normalize_biz(biz), str(mid), str(idx)
    except (AttributeError, ValueError):
        raise ValueError('WeChat upgrade could not confirm an article identity') from None


def _archive(db, kind, key, rows, stamp):
    _insert(db, 'wechat_identity_migration_archive', {
        'kind': kind, 'canonical_id': key, 'originals': _json(rows), 'created_at': stamp,
    })


def _map_strings(value, mapping):
    """Only exact structured identifiers are changed; no text substitutions."""
    if isinstance(value, str):
        return mapping.get(value, value)
    if isinstance(value, list):
        return [_map_strings(part, mapping) for part in value]
    if isinstance(value, dict):
        return {key: _map_strings(part, mapping) for key, part in value.items()}
    return value


def migrate(db):
    stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds')
    sources = [row for row in _rows(db, 'sources') if row['channel'] in CHANNELS]
    contents = [row for row in _rows(db, 'contents') if row['channel'] in CHANNELS]
    connections = [row for row in _rows(db, 'connections') if row['channel'] in CHANNELS]
    caches = _rows(db, 'paid_channel_sources')
    if not (sources or contents or connections or caches):
        return
    db.execute('PRAGMA defer_foreign_keys=ON')

    # First establish a verified mapping. No destructive writes precede this.
    article_biz = {}
    for row in contents:
        if row['namespace'] != 'article':
            raise ValueError('WeChat upgrade encountered an unsupported content namespace')
        biz, mid, idx = _identity(row['external_id'])
        canonical = content_external_id(biz, mid, idx)
        article_biz[row['id']] = (biz, canonical)
        try:
            linked = article_identity(json.loads(row['payload'])['url'])
        except (ValueError, KeyError):
            linked = None  # Official short links have no identity parameters.
        if linked and linked != (biz, mid, idx):
            raise ValueError('WeChat upgrade found inconsistent article identities')

    linked_biz = defaultdict(set)
    original_links = _rows(db, 'content_sources')
    for row in original_links:
        if row['content_id'] in article_biz:
            linked_biz[row['source_id']].add(article_biz[row['content_id']][0])
    source_map, source_groups, source_biz = {}, defaultdict(list), {}
    bindings = {}

    def bind(biz, upstream):
        if not isinstance(upstream, str) or not upstream:
            raise ValueError('WeChat upgrade could not confirm an upstream account')
        previous = bindings.setdefault(biz, upstream)
        if previous != upstream:
            raise ValueError('WeChat upgrade found conflicting upstream account identities')

    for row in caches:
        biz = normalize_biz(row['biz'])
        bind(biz, row['gh_id'])
    cache_biz = defaultdict(set)
    for cached in caches:
        cache_biz[cached['source_id']].add(normalize_biz(cached['biz']))
    for row in sources:
        if row['kind'] != 'account':
            raise ValueError('WeChat upgrade encountered an unsupported source kind')
        candidates = set(linked_biz[row['id']])
        if row['channel'] == 'wechat':
            candidates.add(normalize_biz(row['external_id']))
        try:
            candidates.add(extract_biz(row['url']))
        except ValueError:
            pass
        candidates.update(cache_biz[row['id']])
        if len(candidates) != 1:
            raise ValueError('WeChat upgrade could not unambiguously identify an account')
        biz = candidates.pop()
        if row['channel'] == 'wxrank':
            bind(biz, row['external_id'])
        key = f'wechat:account:{biz}'
        source_map[row['id']] = key
        source_biz[key] = biz
        source_groups[key].append(row)

    new_sources = {}
    for key, group in source_groups.items():
        chosen = max(group, key=lambda row: (row['confirmed'], row['channel'] == 'wechat', row['id']))
        new_sources[key] = {**chosen, 'id': key, 'channel': 'wechat',
                            'external_id': source_biz[key], 'url': source_url(source_biz[key]),
                            'confirmed': max(row['confirmed'] for row in group)}

    groups, content_map = defaultdict(list), {}
    for row in contents:
        biz, external_id = article_biz[row['id']]
        key = f'wechat:article:{external_id}'
        content_map[row['id']] = key
        payload = json.loads(row['payload'])
        raw_source = payload.get('source') or {}
        old_source = f"{raw_source.get('channel')}:{raw_source.get('kind')}:{raw_source.get('external_id')}"
        canonical_source = source_map.get(old_source)
        if canonical_source is None or source_biz[canonical_source] != biz:
            raise ValueError('WeChat upgrade found an unconfirmed article/source association')
        source = new_sources[canonical_source]
        body_state = payload.get('body_state')
        if body_state not in {'full', 'list_only'}:
            body_state = 'full' if row['channel'] == 'wechat' else 'list_only'
        payload.update(channel='wechat', external_id=external_id, body_state=body_state)
        payload['source'] = {**raw_source, 'channel': 'wechat', 'kind': 'account',
                             'external_id': source['external_id'], 'name': source['name'],
                             'url': source['url'], 'confirmed': bool(source['confirmed'])}
        groups[key].append((row, payload))

    # A legacy single-item WeChat channel could not subscribe. An unexpected
    # collision is therefore not something this migration may guess away.
    subscriptions = _rows(db, 'subscriptions')
    affected_subs = [row for row in subscriptions if row['source_id'] in source_map]
    seen_subscriptions = {}
    for row in affected_subs:
        key = source_map[row['source_id']]
        if key in seen_subscriptions:
            raise ValueError('WeChat upgrade found conflicting subscriptions for one account')
        seen_subscriptions[key] = row['id']

    old_ids = set(content_map)
    children = {table: [row for row in _rows(db, table) if row['content_id'] in old_ids]
                for table in CONTENT_TABLES}
    indexed_children = {}
    for table, rows in children.items():
        index = defaultdict(list)
        for row in rows:
            index[row['content_id']].append(row)
        indexed_children[table] = index
    # Capture the exact old rows before any cascade/trigger can remove evidence.
    for key, group in groups.items():
        ids = {row['id'] for row, _ in group}
        originals = {'contents': [row for row, _ in group],
                     **{table: [row for old_id in ids for row in index[old_id]]
                        for table, index in indexed_children.items()}}
        _archive(db, 'content', key, originals, stamp)
    for key, group in source_groups.items():
        _archive(db, 'source', key, group, stamp)
    if connections:
        _archive(db, 'connections', CONNECTION, connections, stamp)

    # Reconstruction is not a user edit. Re-enable exactly the original triggers
    # after copying; do not create new events or invalidate unrelated decisions.
    triggers = [(row['name'], row['sql']) for row in db.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger'")]
    for name, _ in triggers:
        db.execute('DROP TRIGGER "' + name.replace('"', '""') + '"')
    try:
        db.execute('CREATE TEMP TABLE wechat_migrating_contents(id TEXT PRIMARY KEY)')
        db.executemany('INSERT INTO wechat_migrating_contents VALUES(?)', ((key,) for key in old_ids))
        for table in CONTENT_TABLES:
            db.execute(f'DELETE FROM {table} WHERE content_id IN (SELECT id FROM wechat_migrating_contents)')
        db.execute('DELETE FROM contents WHERE id IN (SELECT id FROM wechat_migrating_contents)')
        db.execute('DROP TABLE wechat_migrating_contents')

        # Deferred FKs allow source IDs to be reconstructed without changing
        # subscription IDs, versions, schedules or user preferences.
        for old_id in source_map:
            db.execute('DELETE FROM sources WHERE id=?', (old_id,))
        for row in new_sources.values():
            _insert(db, 'sources', row)

        for key, group in groups.items():
            first = min((row for row, _ in group), key=lambda row: (_time(row['first_seen_at']), row['id']))
            chosen, payload = max(group, key=lambda pair: (
                pair[1]['body_state'] == 'full', _time(pair[0]['updated_at']), pair[0]['id']))
            rebuilt = {**first, 'id': key, 'channel': 'wechat',
                       'external_id': payload['external_id'], 'title': payload['title'],
                       'published_at': (payload.get('published') or {}).get('value'),
                       'payload': _json(payload), 'updated_at': chosen['updated_at']}
            _insert(db, 'contents', rebuilt)

        _restore_children(db, children, content_map, source_map, stamp)
        _migrate_connections(db, connections, subscriptions, affected_subs, source_map,
                             content_map, stamp)
        for row in caches:
            canonical = f"wechat:account:{normalize_biz(row['biz'])}"
            db.execute('UPDATE paid_channel_sources SET source_id=? WHERE biz=?', (canonical, row['biz']))
        for biz, upstream in bindings.items():
            _insert(db, 'wechat_backend_identities', {'provider_id': 'wxrank', 'biz': biz,
                    'upstream_id': upstream, 'updated_at': stamp})
        # Preference aggregates are derived. Mark their old groups dirty; the
        # existing local aggregator will recount without manufacturing AI work.
        if contents:
            for row in _rows(db, 'priority_preference_groups'):
                db.execute('INSERT OR IGNORE INTO priority_preference_dirty VALUES(?,?,?)',
                           (row['priority'], row['tag_id'], stamp))
    finally:
        for _, sql in triggers:
            db.execute(sql)
    violations = db.execute('PRAGMA foreign_key_check').fetchall()
    if violations:
        raise ValueError('WeChat upgrade failed its foreign-key integrity check')


def _restore_children(db, children, content_map, source_map, stamp):
    blocks_by_link = defaultdict(list)
    for row in children['content_tag_blocks']:
        blocks_by_link[(content_map[row['content_id']], row['tag_id'])].append(row)
    for table in ('content_sources', 'content_states', 'content_tags', 'content_tag_blocks',
                  'content_notes', 'content_events', 'tagging_tasks', 'priority_tasks'):
        groups = defaultdict(list)
        for original in children[table]:
            row = {**original, 'content_id': content_map[original['content_id']]}
            if table == 'content_sources':
                row['source_id'] = source_map.get(row['source_id'], row['source_id'])
                key = (row['content_id'], row['source_id'])
            elif table in {'content_tags', 'content_tag_blocks'}:
                key = (row['content_id'], row['tag_id'])
            elif table == 'content_events':
                key = (row['name'], row['content_id'])
            elif table == 'tagging_tasks':
                old_content = original['content_id']
                if row['dedupe_key'].startswith(old_content + ':'):
                    row['dedupe_key'] = row['content_id'] + row['dedupe_key'][len(old_content):]
                key = row['dedupe_key']
            else:
                key = row['content_id']
            groups[key].append(row)
        for group in groups.values():
            if table == 'content_states':
                chosen = dict(_latest(group))
                manual = [row for row in group if row['priority_override'] is not None
                          or row.get('manual_priority_version', 0) > 0]
                priority = _latest(manual or group)
                chosen['priority_override'] = priority['priority_override']
                chosen['manual_priority_version'] = max(row.get('manual_priority_version', 0) for row in group)
            elif table == 'content_tags':
                chosen = max(group, key=lambda row: (row['origin'] == 'manual', _time(row['created_at'])))
                blocks = blocks_by_link[(chosen['content_id'], chosen['tag_id'])]
                if blocks and (chosen['origin'] != 'manual' or
                               _time(_latest(blocks, 'created_at')['created_at']) >= _time(chosen['created_at'])):
                    continue
            elif table == 'content_tag_blocks':
                chosen = _latest(group, 'created_at')
                link = db.execute('SELECT origin,created_at FROM content_tags WHERE content_id=? AND tag_id=?',
                                  (chosen['content_id'], chosen['tag_id'])).fetchone()
                if link and link['origin'] == 'manual' and _time(link['created_at']) > _time(chosen['created_at']):
                    continue
            elif table == 'content_notes':
                chosen = _latest(group)
            elif table == 'content_events':
                # A previously consumed first-intake fact remains consumed.
                chosen = min(group, key=lambda row: row['id'])
                consumed = [row for row in group if row['consumed_at']]
                if consumed:
                    winner = _latest(consumed, 'consumed_at')
                    chosen = {**chosen, 'consumed_at': winner['consumed_at'], 'consumed_by': winner['consumed_by']}
            elif table in {'tagging_tasks', 'priority_tasks'}:
                completed = [row for row in group if row['state'] in {'succeeded', 'skipped', 'cancelled'}]
                chosen = _latest(completed or group)
                # Running work cannot survive the process boundary. Preserve it
                # as cancelled evidence rather than queueing an extra model call.
                if chosen['state'] == 'running':
                    chosen = {**chosen, 'state': 'cancelled', 'updated_at': stamp}
                    if 'lease_expires_at' in chosen:
                        chosen['lease_expires_at'] = None
            else:
                chosen = group[0]
            _insert(db, table, chosen)
    # Two old identities may each have pending work. After merging there must
    # not be two live requests for the same canonical content. Old rows remain
    # in the archive; cancel stale or redundant work without creating a retry.
    for content_id in set(content_map.values()):
        content_version = db.execute('SELECT updated_at FROM contents WHERE id=?', (content_id,)).fetchone()[0]
        pending = [dict(row) for row in db.execute(
            "SELECT * FROM tagging_tasks WHERE content_id=? AND state IN ('queued','retry_wait','blocked')",
            (content_id,))]
        compatible = [row for row in pending if row['content_version'] == content_version]
        winner = max(compatible, key=lambda row: (row['config_version'], _time(row['updated_at']), row['id'])) if compatible else None
        for row in pending:
            if winner is None or row['id'] != winner['id']:
                db.execute("UPDATE tagging_tasks SET state='cancelled',lease_expires_at=NULL,"
                           "error_code='IDENTITY_MIGRATED',error_message='旧身份任务已由迁移归并',updated_at=? WHERE id=?",
                           (stamp, row['id']))
    # Decisions and preference samples contain fingerprints of the old identity
    # and are retained in the archive, not falsely restored as current results.


def _migrate_connections(db, connections, subscriptions, affected_subs, source_map,
                         content_map, stamp):
    connection_map = {row['id']: CONNECTION for row in connections}
    if connections:
        chosen = next((row for row in connections if row['id'] == CONNECTION), connections[0])
        canonical = {**chosen, 'id': CONNECTION, 'channel': 'wechat', 'backend': BACKEND,
                     'resource_key': RESOURCE}
        # Prefer the paid readiness diagnostic; retaining its schedule blocks is
        # what prevents an unknown paid result from becoming an automatic retry.
        paid_readiness = [row for row in connections if row['channel'] == 'wxrank' and row['readiness']]
        if paid_readiness:
            canonical['readiness'] = paid_readiness[0]['readiness']
        id_mapping = {**connection_map, **source_map, **content_map,
                      'wxrank:paid-http': 'wechat:electron-session',
                      'http:wxrank': RESOURCE}
        if canonical['readiness']:
            canonical['readiness'] = _json(_map_strings(json.loads(canonical['readiness']), id_mapping))
        for row in connections:
            db.execute('DELETE FROM connections WHERE id=?', (row['id'],))
        _insert(db, 'connections', canonical)
        # A previously disabled paid implementation must stay disabled even
        # though its connection has been folded into the public channel.
        if any(row['channel'] == 'wxrank' and not row['enabled'] for row in connections):
            setting = db.execute('SELECT payload FROM app_settings WHERE id=1').fetchone()
            if setting:
                payload = json.loads(setting['payload'])
                payload.setdefault('channels', {}).setdefault('wxrank', {})['enabled'] = False
                db.execute('UPDATE app_settings SET payload=? WHERE id=1', (_json(payload),))
    else:
        id_mapping = {**source_map, **content_map}
        canonical = None

    affected_sub_ids = {row['id'] for row in affected_subs}
    for row in subscriptions:
        source = source_map.get(row['source_id'], row['source_id'])
        connection = connection_map.get(row['connection_id'], row['connection_id'])
        if source != row['source_id'] or connection != row['connection_id']:
            db.execute('UPDATE subscriptions SET source_id=?,connection_id=? WHERE id=?',
                       (source, connection, row['id']))
    for row in _rows(db, 'jobs'):
        snapshot = json.loads(row['snapshot'])
        if snapshot.get('connection_id') in connection_map:
            snapshot.update(connection_id=CONNECTION, backend=BACKEND,
                            connection_version=canonical['version'])
        item = content_map.get(row['item_key'], row['item_key'])
        error = _json(_map_strings(json.loads(row['error']), id_mapping)) if row['error'] else None
        cursor = _json(_map_strings(json.loads(row['cursor']), id_mapping)) if row['cursor'] else None
        db.execute('UPDATE jobs SET snapshot=?,item_key=?,error=?,cursor=? WHERE id=?',
                   (_json(snapshot), item, error, cursor, row['id']))
    # Preserve paid cursors and their exact protocol/credential versions.
    for table, key_fields in (
        ('paid_channel_checkpoints', ('source_id', 'connection_id')),
        ('sync_progress', ('subscription_id', 'backend', 'progress_version', 'content_range', 'mode')),
        ('schedule_blocks', ('scope', 'scope_key', 'operation')),
    ):
        original = _rows(db, table)
        mapped = defaultdict(list)
        for row in original:
            new = dict(row)
            if table == 'paid_channel_checkpoints':
                new['source_id'] = source_map.get(row['source_id'], row['source_id'])
                new['connection_id'] = connection_map.get(row['connection_id'], row['connection_id'])
            elif table == 'sync_progress' and row['subscription_id'] in affected_sub_ids:
                new['backend'] = BACKEND
                new['connection_version'] = canonical['version'] if canonical else row['connection_version']
                new['payload'] = _json(_map_strings(json.loads(row['payload']), id_mapping))
            elif table == 'schedule_blocks':
                new['scope_key'] = id_mapping.get(row['scope_key'], row['scope_key'])
                new['error'] = _json(_map_strings(json.loads(row['error']), id_mapping))
            mapped[tuple(new[field] for field in key_fields)].append(new)
        db.execute(f'DELETE FROM {table}')
        for group in mapped.values():
            if len(group) > 1:
                _archive(db, table, ':'.join(str(group[0][field]) for field in key_fields), group, stamp)
            if table == 'paid_channel_checkpoints':
                chosen = _latest(group, 'obtained_at')
            elif table == 'sync_progress':
                chosen = _latest(group)
            else:
                chosen = max(group, key=lambda row: (
                    json.loads(row['error']).get('code') == 'DEPENDENCY_UNAVAILABLE',
                    row['until_at'] is None, row['until_at'] or 0))
            _insert(db, table, chosen)
    for old, new in connection_map.items():
        db.execute('UPDATE paid_channel_attempts SET connection_id=? WHERE connection_id=?', (new, old))
