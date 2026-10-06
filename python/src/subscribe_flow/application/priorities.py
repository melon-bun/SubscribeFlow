from subscribe_flow.contracts.priorities import validate_priority


class PriorityService:
    def __init__(self, repository, emit):
        self.repository, self.emit = repository, emit

    def set_source(self, subscription_id, priority):
        validate_priority(priority)
        result = self.repository.set_source_priority(subscription_id, priority)
        self.emit('subscription.changed', {'id': subscription_id})
        self.emit('content.changed', {'source_id': result['source_id']})
        return result
