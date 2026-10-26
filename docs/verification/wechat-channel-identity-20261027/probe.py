"""BUG-143 baseline: exercise both WeChat import orders with offline fixtures.

Run with python/.venv/bin/python from the project root. This records the current
defect; it is not a passing acceptance test for the eventual architecture fix.
"""
import asyncio
import json
import subprocess
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'python'), str(ROOT / 'python' / 'src')]

from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.wxrank import fixtures, protocol
from subscribe_flow.contracts import jsonable
from tests.test_wechat import Bridge, article
from tests.test_wxrank import BIZ, FakeTransport, response


async def scenario(order):
    listing = deepcopy(fixtures.LIST_OK)
    listing['data']['list'] = listing['data']['list'][:1]
    bridge = Bridge()
    row = listing['data']['list'][0]
    identity = protocol.article_identity(row['art_url'])
    external_id = protocol.content_external_id(*identity)
    bridge.row = article(external_id, account=BIZ, name='示例公众号')
    bridge.row['url'] = protocol.normalize_article_url(row['art_url'])
    bridge.row['account']['url'] = bridge.row['url']
    transport = FakeTransport(listing=response(listing))
    with tempfile.TemporaryDirectory(prefix='wechat-channel-identity-') as temporary:
        core = Core(Path(temporary) / 'core.db', browser_bridge=bridge,
                    paid_transport=transport,
                    schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0))
        try:
            core.settings.update('channels', {'wxrank': {'enabled': True}},
                                 credential_refs={'wxrank': 'offline-probe'})
            core.credentials.provide('offline-probe', 'fixture-only-secret')
            subscription = await core.subscriptions.add(
                BIZ, 'wxrank:default', confirmed=True, sync_mode='automatic')
            outcomes = []
            for method in order:
                if method == 'subscription':
                    started = core.sync.start(subscription['id'], page_budget=1, _trigger='automatic')
                    job = await core.sync.wait(started['job_id'])
                    assert job['state'] == 'succeeded', job
                    outcomes.append({'method': method, 'state': job['state'],
                                     'trigger': job['trigger'], 'new_items': job['new_items']})
                else:
                    task = core.intake.start(bridge.row['url'])
                    task = await core.intake.wait(task['task_id'])
                    assert task['state'] == 'preview', task
                    saved = core.intake.save(task['preview_id'])
                    outcomes.append({'method': method, 'state': saved['status'],
                                     'item_id': saved['item_id']})
            contents = [dict(row) for row in core.repository.db.execute(
                'SELECT id,channel,namespace,external_id,intake_method FROM contents ORDER BY channel')]
            sources = core.repository.list_content_sources()['items']
            stats = core.repository.content_stats()
            descriptors = [jsonable(d) for d in core.gateway.describe()]
            node = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const {callUI} = require('./electron/main/app-client.cjs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const sandbox = {window:{}};
vm.runInNewContext(fs.readFileSync('./electron/renderer/scripts/core/catalog.js', 'utf8'), sandbox);
const core = {call: async method => {
  if (method === 'channel.list') return input.descriptors;
  if (method === 'content.stats') return input.stats;
  throw new Error('Unexpected RPC: ' + method);
}};
callUI(core, 'listPlatforms', []).then(platforms => {
  process.stdout.write(JSON.stringify(platforms.filter(p => ['wechat','wxrank'].includes(p.id))
    .map(p => ({...p, name:sandbox.window.SF.catalog.platform(p.id).name,
      short:sandbox.window.SF.catalog.platform(p.id).short}))));
}).catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
"""
            ui = subprocess.run(['node', '-e', node], cwd=ROOT, text=True,
                                input=json.dumps({'descriptors': descriptors, 'stats': stats}),
                                capture_output=True, check=True)
            result = {'order': order, 'outcomes': outcomes, 'contents': contents,
                      'sources': sources, 'stats': stats,
                      'platforms': json.loads(ui.stdout),
                      'filters': {channel: core.repository.query_contents(channel=channel)['total']
                                  for channel in ('wechat', 'wxrank')},
                      'fake_transport_calls': transport.calls,
                      'wechat_capabilities': {
                          d['channel']: [op for op, cap in d['operations'].items() if cap['supported']]
                          for d in descriptors if d['channel'] in ('wechat', 'wxrank')}}
            assert len(contents) == 2 and len(sources) == 2, result
            assert len({row['external_id'] for row in contents}) == 1, result
            assert stats['platforms'] == {'wechat': 1, 'wxrank': 1}, result
            assert len(result['platforms']) == 2, result
            return result
        finally:
            await core.close()


async def main():
    result = {'bug': 'BUG-143', 'date': '2026-10-27',
              'baseline_commit': subprocess.check_output(
                  ['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'scope': 'Production Core/Gateway/Sync/Intake/SQLite and Main listPlatforms/catalog; offline fixtures; no rendered UI or live platform acceptance',
              'cases': [await scenario(['subscription', 'manual']),
                        await scenario(['manual', 'subscription'])]}
    destination = Path(__file__).with_name('result.json')
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
