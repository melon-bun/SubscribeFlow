from subscribe_flow.contracts import ChannelError


LEVELS = ('high', 'medium', 'low')


def validate_priority(value):
    if value is not None and (type(value) is not str or value not in LEVELS):
        raise ChannelError('INVALID_INPUT', 'priority', '优先级需为高、中、低，或清除设置')
