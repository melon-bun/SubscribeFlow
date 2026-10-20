"""M9 统一标签服务。

人工打标与自动识别都从这里进出：
- 人工路径 validate + 写入，规则简单，结果确定；
- 识别路径先把结构化建议解析成受约束的形状，再交给同一个仓储写入。

识别提供者通过构造参数注入。没配置提供者时，人工标签的所有能力照常工作，
识别接口只是明确返回「未接入」，不会伪造任何识别结果。
"""

import uuid

from subscribe_flow.contracts import ChannelError
from subscribe_flow.contracts.tags import (
    RecognitionInput, TagSuggestion, validate_description, validate_synonyms,
    validate_tag_color, validate_tag_ids, validate_tag_name,
)
from subscribe_flow.storage.repositories import TAG_SORTS


class TagService:
    def __init__(self, repository, emit, recognition_provider=None):
        self.repository, self.emit = repository, emit
        # 依赖注入点：将来接入模型时替换这一个对象即可，页面与存储都不用改。
        self.recognition_provider = recognition_provider

    # ------------------------------------------------------------ 标签管理

    def list_tags(self, query=None, enabled=None, sort=None):
        # M23：排序是可选参数，不传就是按名称排（旧调用照常工作）。
        if sort is not None and sort not in TAG_SORTS:
            raise ChannelError("INVALID_INPUT", "tag.list", "不支持的标签排序方式")
        tags = self.repository.list_tags(query, enabled, sort)
        return {"items": tags, "total": len(tags)}

    def get(self, tag_id):
        return self.repository.get_tag(tag_id)

    def create(self, name, description=None, color=None, enabled=True, synonyms=None):
        draft = self.repository.create_tag(uuid.uuid4().hex, validate_tag_name(name),
                                           validate_description(description), validate_tag_color(color),
                                           bool(enabled), validate_synonyms(synonyms))
        self.emit("tags.changed", {"id": draft["id"]})
        return draft

    def update(self, tag_id, **patch):
        allowed = {"name", "description", "color", "synonyms"}
        if set(patch) - allowed:
            raise ChannelError("INVALID_INPUT", "tag.update", "不支持的标签字段")
        cleaned = {}
        if "name" in patch:
            cleaned["name"] = validate_tag_name(patch["name"])
        if "description" in patch:
            cleaned["description"] = validate_description(patch["description"])
        if "color" in patch:
            cleaned["color"] = validate_tag_color(patch["color"])
        if "synonyms" in patch:
            cleaned["synonyms"] = validate_synonyms(patch["synonyms"])
        # 改名不触碰 content_tags：关联挂在稳定 ID 上，显示名变化与之无关。
        draft = self.repository.update_tag(tag_id, **cleaned)
        self.emit("tags.changed", {"id": tag_id})
        return draft

    def set_enabled(self, tag_id, enabled):
        draft = self.repository.set_tag_enabled(tag_id, bool(enabled))
        self.emit("tags.changed", {"id": tag_id})
        return draft

    def remove(self, tag_id):
        result = self.repository.delete_tag(tag_id)
        self.emit("tags.changed", {"id": tag_id})
        self.emit("content.changed", {"ids": []})
        return result

    def contents(self, tag_id, limit=50, offset=0, **filters):
        return self.repository.tag_contents(tag_id, limit, offset, **filters)

    # ------------------------------------------------------------ 人工打标

    def set_content(self, item_id, tag_ids):
        result = self.repository.set_content_tags([item_id], validate_tag_ids(tag_ids))
        self.emit("content.changed", {"ids": [item_id]})
        # 打标会改变标签的使用次数，标签视图的使用量条依赖这个值。
        self.emit("tags.changed", {"ids": list(result["tags"])})
        return self.repository.get_content(item_id)

    def bulk_set(self, item_ids, tag_ids):
        if not item_ids or len(item_ids) > 100:
            raise ChannelError("INVALID_INPUT", "content.bulk_set_tags", "每次需指定 1 到 100 条内容")
        result = self.repository.set_content_tags(item_ids, validate_tag_ids(tag_ids))
        self.emit("content.changed", {"ids": list(dict.fromkeys(item_ids))})
        self.emit("tags.changed", {"ids": list(tag_ids)})
        return result

    # ------------------------------------------------------------ 识别边界

    def recognize(self, item_id):
        """对单条内容请求识别建议。未配置提供者时明确报未接入。"""
        if self.recognition_provider is None:
            raise ChannelError("NOT_CONFIGURED", "tag.recognize", "自动识别尚未接入，人工标签不受影响")
        content = self.repository.get_content(item_id)
        suggestion = self.recognition_provider.suggest(RecognitionInput.from_content(content))
        if not isinstance(suggestion, TagSuggestion):
            raise ChannelError("INVALID_INPUT", "tag.recognize", "识别提供者返回的结构不符合契约")
        return suggestion

    def apply_suggestion(self, raw):
        """把一次识别建议落成标签关联。

        边界在这里收口：本方法只调用 add_suggested_tags（只增不删），代码路径上
        不存在删除，因此任何来源的人工修改都不会被旧建议静默撤销。建议里的
        「新标签」不自动创建——建标签是人的决定，这里只回报给调用方。
        """
        suggestion = raw if isinstance(raw, TagSuggestion) else TagSuggestion.from_dict(raw)
        content = self.repository.get_content(suggestion.item_id)
        current_version = content.get("updated_at")
        if suggestion.content_updated_at and current_version and suggestion.content_updated_at != current_version:
            # 内容在建议生成之后已经变化，这份建议不再反映当前内容。
            return {"applied": 0, "skipped": 0, "blocked": 0, "stale": True,
                    "reason": "内容已更新，该建议基于旧版本", "itemId": suggestion.item_id,
                    "provider": suggestion.provider, "newTags": []}
        applied, new_tags = [], []
        for candidate in suggestion.candidates:
            tag_id = candidate.tag_id
            if tag_id is None and candidate.name:
                # 建议新标签：按名称找已有标签，找不到就只回报，不擅自创建。
                tag_id = self.repository.find_tag_by_name(candidate.name)
                if tag_id is None:
                    new_tags.append({"name": candidate.name, "reason": candidate.reason,
                                     "confidence": candidate.confidence})
                    continue
            if tag_id is None:
                continue
            applied.append({"tagId": tag_id, "reason": candidate.reason,
                            "confidence": candidate.confidence})
        added, blocked = (0, [])
        if applied:
            added, blocked = self.repository.add_suggested_tags(
                suggestion.item_id, [a["tagId"] for a in applied])
            if added:
                self.emit("content.changed", {"ids": [suggestion.item_id]})
        blocked_set = set(blocked)
        return {"applied": added,
                "skipped": len(applied) - added - len(blocked),
                "blocked": len(blocked),
                "blockedTags": blocked,
                "stale": False, "itemId": suggestion.item_id,
                "provider": suggestion.provider, "newTags": new_tags,
                "candidates": [a for a in applied if a["tagId"] not in blocked_set]}
