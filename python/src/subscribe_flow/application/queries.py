class QueryService:
    def __init__(self, repository):
        self.repository = repository

    def contents(self, **query):
        return self.repository.query_contents(**query)

    def content(self, item_id):
        return self.repository.get_content(item_id)

    def subscriptions(self, include_cancelled=False):
        return self.repository.list_subscriptions(include_cancelled)

    def jobs(self, limit=100, offset=0):
        from subscribe_flow.contracts import ChannelError
        if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 1000000:
            raise ChannelError("INVALID_INPUT", "sync.list", "分页参数无效")
        return self.repository.list_jobs(limit, offset)

    def coverage(self, subscription_id):
        self.repository.get_subscription(subscription_id)
        snapshot = self.repository.snapshot(subscription_id)
        rows = self.repository.get_progress(subscription_id)
        for row in rows:
            row["compatible"] = (row["backend"] == snapshot["backend"] and
                                 row["progress_version"] == snapshot["progress_version"] and
                                 row["subscription_version"] == snapshot["subscription_version"] and
                                 row["connection_version"] == snapshot["connection_version"])
        return {"subscription_id": subscription_id, "progress": rows}
