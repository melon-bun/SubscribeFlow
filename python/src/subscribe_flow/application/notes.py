"""笔记服务（M26）。

一条内容最多一条笔记；写入是**全量替换**：一次保存就是这条笔记的全部内容，
不做字段级合并——那样半截旧内容会悄悄留在笔记里。

几条边界是这一层负责的：

- 笔记只写 ``content_notes``：不动内容的更新时间、首次收录信息，
  也不动已读／稍后／归档。内容归内容，笔记归笔记。
- 空笔记（总结与收获都空、也没有项目结论）就是「没有笔记」：删掉那一行，
  不留 template='none' 的空行。通用模板不能有项目结论。
- 每次真正写入换一个版本令牌；带着旧令牌来写就是冲突，不写入，
  并把当前这一份带回去，界面不必瞎猜。
- 写笔记不发 ``content.created``：它不是新内容，不该触发自动打标，
  也不该推进打标的配置版本。
- 总结的来路由用户决定：手写是 manual，AI 草稿未改是 ai，用户改过是 ai_edited；
  总结被清空，来路一并清空。项目结论只能由用户自己写。
"""

from __future__ import annotations

import uuid

from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.repositories import now

NOTE_TEMPLATES = ("general", "project")
SUMMARY_ORIGINS = ("manual", "ai", "ai_edited")
NOTE_VERDICTS = ("using", "watching", "dropped")

SUMMARY_MAX = 2000          # 总结建议 2000 字
TAKEAWAY_MAX = 20000        # 个人心得建议 20000 字


class NoteService:
    def __init__(self, repository, emit):
        self.repository, self.emit = repository, emit

    # ------------------------------------------------------------------ 读

    def get(self, item_id):
        """取一条笔记。内容不存在与「内容没有笔记」是两回事，要分开说。"""
        self._require_content(item_id)
        return self.repository.notes.get(item_id)

    def list_notes(self, **filters):
        return self.repository.notes.list_notes(**filters)

    def facets(self, **filters):
        return self.repository.notes.facets(**filters)

    # ------------------------------------------------------------------ 写

    def save(self, item_id, *, expected_version=None, template="general", summary="",
             summary_origin=None, takeaway="", verdict=None):
        """保存笔记（全量替换）。返回保存后的笔记；没有笔记时返回 None。"""
        self._require_content(item_id)
        template = self._check_template(template)
        summary = self._check_text(summary, SUMMARY_MAX, "总结")
        takeaway = self._check_text(takeaway, TAKEAWAY_MAX, "个人心得")
        verdict = self._check_verdict(verdict, template)
        summary_origin = self._check_origin(summary_origin)
        if not summary:
            # 总结空了，来路也就没有意义了。
            summary_origin = None

        current = self.repository.notes.get(item_id)
        self._check_version(expected_version, current, "note.save")

        # 空的笔记就是没有笔记：删行，不留空行，也不为旧内容回填。
        if not summary and not takeaway and verdict is None:
            if current is None:
                return None
            self.repository.notes.remove(item_id)
            self._changed(item_id)
            return None

        version = str(uuid.uuid4())
        note = self.repository.notes.write(
            item_id, template=template, summary=summary, summary_origin=summary_origin,
            takeaway=takeaway, verdict=verdict, version=version, stamp=now())
        self._changed(item_id)
        return note

    def delete(self, item_id, *, expected_version=None):
        """删掉一条笔记。内容本身不动。"""
        self._require_content(item_id)
        if not expected_version:
            raise ChannelError("INVALID_INPUT", "note.delete", "删除笔记需要先读取当前版本")
        current = self.repository.notes.get(item_id)
        if current is None:
            raise ChannelError("NOT_FOUND", "note.delete", "这条内容还没有笔记")
        self._check_version(expected_version, current, "note.delete")
        self.repository.notes.remove(item_id)
        self._changed(item_id)
        return {"ok": True}

    # ------------------------------------------------------------------ 内部

    def _changed(self, item_id):
        """笔记变了，告诉界面内容这块要重画。

        只发 content.changed：不是 content.created——笔记不是新内容，
        不该触发自动打标，也不该推进打标的配置版本。
        """
        self.emit("content.changed", {"ids": [item_id]})

    def _require_content(self, item_id):
        if not isinstance(item_id, str) or not item_id:
            raise ChannelError("INVALID_INPUT", "note", "缺少内容 ID")
        if self.repository.get_content(item_id) is None:
            raise ChannelError("NOT_FOUND", "note", "内容不存在")

    def _check_template(self, template):
        if template not in NOTE_TEMPLATES:
            raise ChannelError("INVALID_INPUT", "note.save", "笔记模板无效")
        return template

    def _check_text(self, value, limit, label):
        if value is None:
            value = ""
        if not isinstance(value, str):
            raise ChannelError("INVALID_INPUT", "note.save", f"{label}必须是文本")
        value = value.strip()
        if len(value) > limit:
            raise ChannelError("INVALID_INPUT", "note.save", f"{label}超过 {limit} 字上限")
        return value

    def _check_verdict(self, verdict, template):
        if verdict is None:
            return None
        if verdict not in NOTE_VERDICTS:
            raise ChannelError("INVALID_INPUT", "note.save", "项目结论无效")
        if template != "project":
            # 通用模板没有项目结论这一栏：不能让它悄悄挂一个。
            raise ChannelError("INVALID_INPUT", "note.save", "通用笔记不能有项目结论")
        return verdict

    def _check_origin(self, origin):
        if origin is None:
            return None
        if origin not in SUMMARY_ORIGINS:
            raise ChannelError("INVALID_INPUT", "note.save", "总结来源无效")
        return origin

    def _check_version(self, expected_version, current, operation="note.save"):
        """版本令牌比对。新建传 null，更新与删除传读到的令牌。"""
        if expected_version is None:
            if current is not None:
                # 已经有人写过：拿着「新建」的令牌来写就是冲突。
                raise ChannelError("CONFLICT", operation, "这条内容已经有笔记了，请刷新后再保存",
                                   details={"current": current})
            return
        if not isinstance(expected_version, str) or not expected_version:
            raise ChannelError("INVALID_INPUT", operation, "笔记版本无效")
        if current is None:
            # 笔记已经被删掉：旧令牌不能把它盖回来。
            raise ChannelError("CONFLICT", operation, "这条内容的笔记已经被删除，请重新读取",
                               details={"current": None})
        if current["version"] != expected_version:
            raise ChannelError("CONFLICT", operation, "笔记已经被改过，请刷新后再保存",
                               details={"current": current})
