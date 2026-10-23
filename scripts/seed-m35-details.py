"""M35 细节验收的隔离样本：只使用合成内容和不可访问的示例地址。"""
import asyncio
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ContentItem, PublishedTime, Source


async def seed(folder):
    for filename in ('seed-v049-batch01.py', 'seed-ui-followup-02.py'):
        spec = importlib.util.spec_from_file_location(filename, ROOT / 'scripts' / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        await module.seed(folder)
    core = Core(folder / 'subscribe-flow.sqlite3', gateway=ChannelGateway())
    try:
        tags = [core.repository.create_tag('m35-tag-' + str(i), name, '', color, True, [])
                for i, (name, color) in enumerate((('长名称的视觉检查标签', 'amber'), ('另一枚用于检索的长标签', 'cyan')))]
        for i in range(12):
            # 来源名要够长：原生 <select> 的宽度由最长选项决定，
            # 名字一长整条筛选行就会被撑爆（「重置筛选」被挤到第二行）。
            # 隔离样本必须能复现真实库里长来源名的情形。
            source = Source('zhihu', 'author', 'm35-source',
                            '长名称创作者用于检查筛选行宽度是否被撑爆的超长来源名',
                            'https://example.invalid/m35-source')
            item = ContentItem('zhihu', 'feed', 'm35-' + str(i), source,
                               ('长标题与英文边界检查 ' + 'LongUnbrokenTitle' * 8) if i == 0 else '布局检查内容 ' + str(i),
                               'https://example.invalid/' + 'long-path-' * 35,
                               summary='LongUnbrokenSummary' * 20,
                               published=PublishedTime('2026-10-18T00:00:00+00:00'))
            key = core.repository.save_manual(item, tag_ids=[t['id'] for t in tags])['item_id']
            core.repository.update_content_state([key], {'priority': ['high', 'medium', 'low'][i % 3]})
            if i == 0:
                core.notes.save(key, template='general', summary='短摘要用于检查左对齐。',
                                summary_origin='manual', takeaway='检查编辑器宽度与底部操作。')
    finally:
        await core.close()


if __name__ == '__main__':
    target = Path(sys.argv[1]).resolve()
    if not target.name.startswith('subscribe-flow-m35-details-'):
        raise SystemExit('Fixture requires an isolated m35 details directory')
    asyncio.run(seed(target))
