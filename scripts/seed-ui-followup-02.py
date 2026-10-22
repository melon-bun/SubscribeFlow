"""ui-followup-02（笔记页美化与紧凑原内容卡片）的离线种子。

一条超长的小红书内容：多段正文、话题标签与一个长链接，末尾放一个哨兵句，
用来验证「卡片只展示片段、完整原文在本地 modal 里读、库里原文一字未改」。
另有一条短内容，用来验证短内容自然收缩。
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python' / 'src'))
from subscribe_flow.bootstrap import Core
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.contracts import ContentItem, Source
from subscribe_flow.contracts.models import PublishedTime

SENTINEL = '【哨兵-这是正文最后一句】'
LONG_URL = ('https://www.xiaohongshu.com/explore/'
            + 'a' * 180 + '?xsec_token=' + 'b' * 120)
LONG_BODY = '\n'.join([
    '今天去逛了新的展，入口处排了很久的队，顺便整理一份很长的笔记。',
    '#展览日常 #城市漫步 #周末去哪儿',
    '第一段讲的是装置和灯光的关系：现场比照片好看很多，照片会丢掉很多细节。',
    '第二段讲路线：从地铁站出来一路走到河边，中间有几个很好的取景角度。',
    'https://www.xiaohongshu.com/explore/' + 'c' * 200,
    '第三段讲吃什么：河边那家小店的面不错，价格也还算合理，可以去试试。',
    '第四段补充：下雨的话不太方便，地面湿滑，记得带伞。',
    SENTINEL,
])


def make_item(channel, external_id, title, summary, url):
    source = Source(channel=channel, kind='author', external_id=f'{external_id}-source',
                    name='小红书 种子来源', url=f'https://example.invalid/{external_id}')
    return ContentItem(channel=channel, namespace='feed', external_id=external_id,
                       source=source, title=title, url=url, kind='note', summary=summary,
                       published=PublishedTime(value='2026-10-18T00:00:00+00:00'))


async def seed(folder):
    core = Core(Path(folder) / 'subscribe-flow.sqlite3', gateway=ChannelGateway())
    try:
        long_id = core.repository.save_manual(make_item(
            'xiaohongshu', 'polish-1', '一条很长的小红书笔记：' + '标题' * 40, LONG_BODY, LONG_URL))['item_id']
        short_id = core.repository.save_manual(make_item(
            'zhihu', 'polish-2', '一条很短的内容', '短简介。', 'https://example.invalid/polish-2'))['item_id']
        core.notes.save(long_id, template='general', summary='这条讲的是看展的路线与吃饭。',
                        summary_origin='manual', takeaway='周末可以去看看。')
        core.notes.save(short_id, template='project', summary='一句话总结。',
                        summary_origin='manual', takeaway='打算用它搭个内部工具。', verdict='using')
        core.settings.update('ai', {'providers': {PROVIDER_ID: {
            'name': '总结用连接', 'protocol': 'openai_chat',
            'endpoint': 'https://api.test.invalid/v1', 'model': 'demo-model',
            'enabled': True}}}, {PROVIDER_ID: 'sk-seed-polish'})
        core.settings.update('summarization', {'enabled': True, 'providerId': PROVIDER_ID,
                                               'length': 'brief', 'language': 'zh-CN'})
    finally:
        await core.close()


PROVIDER_ID = 'provider-llm'

if __name__ == '__main__':
    folder = Path(sys.argv[1]).resolve()
    if not folder.name.startswith('subscribe-flow-polish-'):
        raise SystemExit('Fixture requires a polish directory')
    asyncio.run(seed(folder))
