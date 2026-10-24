"""M38 统一上下文的构建器。

这一层是**纯数据变换**：输入一份从数据库读出来的快照，输出统一上下文。
它不查库、不读环境、不发请求——读取在存储层，调用在判断层，两边都不在这里。

为什么单独一层：LLM 与 Jev 必须拿到**同一份**上下文。如果各自查库、各自挑
样本，两条路径就会在不同证据上得出不同结论，而这种偏差很难被发现。

几条硬约束（计划 §3.5）：

- 只用当前内容**已关联且启用**的标签，ID 匹配，不做名称模糊匹配；
- 三个档位都要出现，缺失的分组显式填 ``content_count: 0`` 与空样本，
  空组只表示没有证据，不表示低优先级；
- 样本按内容 ID 去重，同一条内容出现在两个标签下仍是同一份证据；
- 当前待判内容不能成为自己的样本；
- 标题按 Unicode 字符边界截断，发生截断必须如实标记；
- 序列化后超预算就直接返回本地结论，不截坏 JSON、不删掉某一档的反例。
"""

from __future__ import annotations

import hashlib
import json

from .contracts import (
    ContextSample,
    HistoryGroup,
    MAX_CONTEXT_CHARS,
    MAX_SAMPLE_TITLE,
    MAX_SAMPLES_PER_GROUP,
    MAX_TARGET_TAGS,
    MAX_TARGET_TITLE,
    PRIORITY_HIGH,
    PRIORITY_LOW,
    PRIORITY_MEDIUM,
    STATUS_INCONSISTENT,
    STATUS_INPUT_BUDGET_EXCEEDED,
    STATUS_NO_EVIDENCE,
    STATUS_NO_TAGS,
    STATUS_NO_TITLE,
    STATUS_OK,
    PriorityContextResult,
    PriorityContextSnapshot,
    PriorityContextV1,
    TagCatalogEntry,
)
from .prompts import PROMPT_VERSION

#: 三个档位的固定顺序。上下文与收敛都按这个顺序，避免同一份证据有两种排列。
LEVEL_ORDER = (PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)


def _truncate(text: str, limit: int) -> tuple[str, bool]:
    """按 Unicode 字符边界截断。返回文本与是否发生截断。"""
    if len(text) <= limit:
        return text, False
    return text[:limit], True


class PriorityContextBuilder:
    """把一份统计快照变成统一上下文。

    构造函数不带任何外部依赖：这是它能被单独测试的原因。
    """

    def __init__(self, *, prompt_version: str = PROMPT_VERSION):
        self.prompt_version = prompt_version

    # ------------------------------------------------------------------ 入口

    def build(self, snapshot: dict) -> PriorityContextResult:
        """构建上下文。返回结果对象，不抛业务异常。

        本地就能判定不发请求的情况，用有界状态说明原因：
        没有标题、没有有效标签、标签超出预算、没有历史证据、输入超限、
        以及本地数据不一致。
        """
        if not isinstance(snapshot, dict):
            raise ValueError('上下文快照必须是对象')
        versions = self._snapshot(snapshot)
        content_id = str(snapshot.get('content_id') or '')

        title = str(snapshot.get('title') or '').strip()
        if not title:
            return self._local(STATUS_NO_TITLE, versions)

        tag_ids = self._tag_ids(snapshot)
        if not tag_ids:
            return self._local(STATUS_NO_TAGS, versions)
        if len(tag_ids) > MAX_TARGET_TAGS:
            # 不只选「更像高优先级」的标签：超出预算就整体不判断。
            return self._local(STATUS_INPUT_BUDGET_EXCEEDED, versions)

        catalog = self._catalog(snapshot, tag_ids)
        history, samples, error = self._history(snapshot, tag_ids, content_id)
        if error:
            return self._local(error, versions)

        if not any(group.content_count for groups in history.values() for group in groups):
            # 相关历史计数全为零：没有可用的个人偏好证据，不发请求。
            return self._local(STATUS_NO_EVIDENCE, versions)

        truncated = False
        target_title, cut = _truncate(title, MAX_TARGET_TITLE)
        truncated = truncated or cut
        cut_samples = []
        for sample in samples:
            text, cut = _truncate(sample.title, MAX_SAMPLE_TITLE)
            truncated = truncated or cut
            cut_samples.append(ContextSample(id=sample.id, title=text))

        context = PriorityContextV1(
            target_title=target_title,
            target_tag_ids=tag_ids,
            tag_catalog=catalog,
            history=history,
            samples=tuple(cut_samples),
            titles_truncated=truncated,
        )
        payload = json.dumps(context.to_dict(), ensure_ascii=False, separators=(',', ':'))
        if len(payload) > MAX_CONTEXT_CHARS:
            # 超限不截坏 JSON，也不删掉某一优先级的反例：直接不判断。
            return self._local(STATUS_INPUT_BUDGET_EXCEEDED, versions)

        return PriorityContextResult(
            status=STATUS_OK,
            context=context,
            payload=payload,
            fingerprint=hashlib.sha256(payload.encode('utf-8')).hexdigest(),
            snapshot=versions,
        )

    # ------------------------------------------------------------------ 内部

    def _local(self, status: str, versions: PriorityContextSnapshot) -> PriorityContextResult:
        """本地结论：没有可发送的上下文。"""
        return PriorityContextResult(status=status, context=None, payload=None,
                                     fingerprint='', snapshot=versions)

    @staticmethod
    def _snapshot(snapshot: dict) -> PriorityContextSnapshot:
        """本地执行快照。版本不齐就留空，不伪造。"""
        versions = snapshot.get('versions') or {}
        if not isinstance(versions, dict):
            versions = {}
        manual = versions.get('manual_version', 0)
        return PriorityContextSnapshot(
            content_version=str(versions.get('content_version') or ''),
            tag_version=str(versions.get('tag_version') or ''),
            manual_version=int(manual) if isinstance(manual, int) else 0,
            preference_version=str(versions.get('preference_version') or ''),
            policy_version=str(versions.get('policy_version') or ''),
            provider_version=str(versions.get('provider_version') or ''),
            prompt_version=str(versions.get('prompt_version') or ''),
        )

    @staticmethod
    def _tag_ids(snapshot: dict) -> tuple[str, ...]:
        """当前内容的有效标签 ID：去重后按标签 ID 固定排序。"""
        raw = snapshot.get('tag_ids') or []
        seen = {str(tag_id) for tag_id in raw if str(tag_id)}
        return tuple(sorted(seen))

    @staticmethod
    def _catalog(snapshot: dict, tag_ids: tuple[str, ...]) -> tuple[TagCatalogEntry, ...]:
        """标签目录：只保留当前内容的标签，描述与别名缺失就留空。"""
        entries = {}
        for item in snapshot.get('tags') or []:
            if not isinstance(item, dict):
                continue
            tag_id = str(item.get('id') or '')
            if not tag_id:
                continue
            synonyms = item.get('synonyms') or []
            if isinstance(synonyms, str):
                synonyms = [synonyms]
            entries[tag_id] = TagCatalogEntry(
                id=tag_id,
                name=str(item.get('name') or ''),
                description=str(item.get('description') or ''),
                synonyms=tuple(str(word) for word in synonyms),
            )
        return tuple(entries.get(tag_id, TagCatalogEntry(id=tag_id, name=''))
                     for tag_id in tag_ids)

    @staticmethod
    def _history(snapshot: dict, tag_ids: tuple[str, ...], content_id: str):
        """读三档分布、给样本编号。

        返回 (history, samples, error)。error 非空表示本地数据不一致，
        这种输入不能发给模型。
        """
        raw = snapshot.get('history') or {}
        titles = snapshot.get('sample_titles') or {}
        if not isinstance(raw, dict) or not isinstance(titles, dict):
            return {}, [], STATUS_INCONSISTENT

        # 样本按内容 ID 去重；编号顺序＝先高档、再中档、再低档，
        # 档内按当前标签顺序，组内按样本顺序。同一内容只出现一次。
        keys: dict[str, str] = {}
        order: list[str] = []

        history: dict[str, tuple[HistoryGroup, ...]] = {}
        for level in LEVEL_ORDER:
            groups = []
            bucket = raw.get(level) or {}
            if not isinstance(bucket, dict):
                return {}, [], STATUS_INCONSISTENT
            for tag_id in tag_ids:
                entry = bucket.get(tag_id) or {}
                if not isinstance(entry, dict):
                    return {}, [], STATUS_INCONSISTENT
                count = entry.get('content_count', 0)
                if type(count) is not int or count < 0:
                    return {}, [], STATUS_INCONSISTENT
                sample_ids = entry.get('sample_ids') or []
                if not isinstance(sample_ids, (list, tuple)):
                    return {}, [], STATUS_INCONSISTENT
                picked = []
                for sample_id in list(sample_ids)[:MAX_SAMPLES_PER_GROUP]:
                    sample_id = str(sample_id)
                    if not sample_id:
                        return {}, [], STATUS_INCONSISTENT
                    if sample_id == content_id:
                        # 当前待判内容不能成为自己的样本。
                        return {}, [], STATUS_INCONSISTENT
                    if sample_id not in titles:
                        # 引用缺失：本地数据错误，重读或兜底，不发给模型。
                        return {}, [], STATUS_INCONSISTENT
                    if sample_id not in keys:
                        keys[sample_id] = f's{len(order) + 1}'
                        order.append(sample_id)
                    picked.append(keys[sample_id])
                groups.append(HistoryGroup(tag_id=tag_id, content_count=count,
                                           recent_sample_ids=tuple(picked)))
            history[level] = tuple(groups)

        samples = [ContextSample(id=keys[sample_id], title=str(titles.get(sample_id) or ''))
                   for sample_id in order]
        return history, samples, None


def build_context(snapshot: dict, *, prompt_version: str = PROMPT_VERSION) -> PriorityContextResult:
    """构建上下文的便捷入口。"""
    return PriorityContextBuilder(prompt_version=prompt_version).build(snapshot)


__all__ = ['PriorityContextBuilder', 'build_context', 'LEVEL_ORDER']
