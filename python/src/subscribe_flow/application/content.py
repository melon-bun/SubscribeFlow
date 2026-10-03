class ContentService:
    def __init__(self, repository, emit):
        self.repository, self.emit = repository, emit

    def update(self, item_id, patch):
        self.bulk_update([item_id], patch)
        return self.repository.get_content(item_id)

    def bulk_update(self, item_ids, patch):
        if not item_ids or len(item_ids) > 100:
            from subscribe_flow.contracts import ChannelError
            raise ChannelError("INVALID_INPUT", "content.update", "每次需指定 1 到 100 条内容")
        result = self.repository.update_content_state(item_ids, patch)
        self.emit("content.changed", {"ids": list(dict.fromkeys(item_ids))})
        return result
