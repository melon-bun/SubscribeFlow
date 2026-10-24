"""生成本批的上下文样本证据（隔离数据库，不连用户数据、不发任何请求）。

用法：
    cd Subscribe_Flow/python && .venv/bin/python ../docs/verification/priority-minimax/batch-01/make-context-sample.py

它做三件事：
1. 在临时目录里造一个隔离库：两个标签、若干条带人工优先级的内容（含已归档）。
2. 对一条「自动判断」的内容构建统一上下文，打印出真正会发给模型的那份 JSON。
3. 打印本地兜底样本（无标签、没有历史证据），证明它们不发请求。
"""

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'python' / 'src'))

from priority_engine.context import build_context          # noqa: E402
from priority_engine.prompts import jev_questions, llm_system_message  # noqa: E402
from subscribe_flow.contracts import Connection, ContentItem, FetchPage, Source  # noqa: E402
from subscribe_flow.storage.database import Database        # noqa: E402
from subscribe_flow.storage.repositories import Repository   # noqa: E402


def build_case():
    temp = tempfile.TemporaryDirectory()
    db = Database(Path(temp.name) / 'context-sample.sqlite3')
    repo = Repository(db)
    intel = repo.priority_intelligence
    repo.add_connection(Connection('c', 'test', 'test', 'test'))
    source = Source('test', 'author', 'a', '作者', 'https://example.com/a', True)
    sub = repo.subscribe(source, 'c')
    job, _ = repo.create_job(sub['id'], 'refresh')
    repo.set_job_state(job['id'], 'running')
    repo.create_tag('tag-db', '数据库', '数据库原理、SQL 查询与性能优化', 'blue', True, ['SQL', '数据库优化'])
    repo.create_tag('tag-news', '资讯', '行业资讯与产品更新', 'cyan', True, [])

    def add(external_id, title, tags, priority):
        item = ContentItem('test', 'video', external_id, source, title, 'https://example.com/a')
        repo.commit_page(job['id'], FetchPage((item,), None, 'window_only'))
        repo.set_content_tags([item.key], tags)
        repo.update_content_state([item.key], {'priority': priority})
        return item.key

    add('1', '慢查询排查：从执行计划到索引调整', ['tag-db'], 'high')
    add('2', '数据库索引设计实战', ['tag-db'], 'high')
    add('3', '数据库产品更新速览', ['tag-db'], 'medium')
    add('4', '常见数据库工具介绍', ['tag-db'], 'medium')
    add('5', '本周数据库行业新闻汇总', ['tag-db', 'tag-news'], 'low')
    add('6', '数据库厂商融资动态', ['tag-db'], 'low')
    # 一条已归档的人工高优先级：统计必须包含它。
    archived = add('7', '索引设计的常见误区', ['tag-db'], 'high')
    repo.update_content_state([archived], {'archived': True})

    target = ContentItem('test', 'video', '9', source, '如何用执行计划定位数据库慢查询',
                         'https://example.com/a')
    repo.commit_page(job['id'], FetchPage((target,), None, 'window_only'))
    repo.set_content_tags([target.key], ['tag-db'])
    untagged = ContentItem('test', 'video', '10', source, '还没有标签的内容', 'https://example.com/a')
    repo.commit_page(job['id'], FetchPage((untagged,), None, 'window_only'))
    return db, repo, intel, target.key, untagged.key, temp


def main():
    db, repo, intel, target_id, untagged_id, temp = build_case()
    try:
        snapshot = intel.context_snapshot(target_id, policy_version='policy-1',
                                          provider_version='provider-llm:3',
                                          prompt_version='priority_prompt_v1')
        result = build_context(snapshot)
        print('=== 1. 上下文快照（统计、标签目录与版本） ===')
        print(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True))
        print()
        print('=== 2. 真正会发给模型的上下文（payload） ===')
        print(result.payload)
        print()
        print('=== 3. 上下文指纹与本地执行快照 ===')
        print(json.dumps({'status': result.status, 'fingerprint': result.fingerprint,
                          'versions': result.snapshot.to_dict()},
                         ensure_ascii=False, indent=2))
        print()
        print('=== 4. LLM 消息形态（system 开头 + user 开头） ===')
        system = llm_system_message()
        print(json.dumps([{'role': 'system', 'content': system[:120] + ' …'},
                          {'role': 'user', 'content': result.payload[:120] + ' …'}],
                         ensure_ascii=False, indent=2))
        print()
        print('=== 5. Jev 提问形态（state 与四问都基于同一份上下文） ===')
        questions = jev_questions()
        print(json.dumps({'state': result.payload[:120] + ' …',
                          'questions': {key: value[:80] + ' …' for key, value in questions.items()}},
                         ensure_ascii=False, indent=2))
        print()
        print('=== 6. 本地兜底：这些情况不发起请求 ===')
        no_tags = intel.context_snapshot(untagged_id)
        print('无有效标签 →', build_context(no_tags).status)
        no_evidence = dict(snapshot)
        no_evidence['history'] = {'high': {}, 'medium': {}, 'low': {}}
        print('没有历史证据 →', build_context(no_evidence).status)
        print()
        print('=== 7. 统计分布（人工信号，含已归档） ===')
        print(json.dumps(intel.groups_for_tags(['tag-db', 'tag-news']), ensure_ascii=False, indent=2))
    finally:
        db.close()
        temp.cleanup()


if __name__ == '__main__':
    main()
