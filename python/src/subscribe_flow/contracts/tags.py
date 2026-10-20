"""标签契约：校验规则、识别输入/输出契约、建议应用边界。

本模块不依赖存储、采集或桌面层。人工标签与自动识别共用这里的校验，
使「同一套校验及持久化逻辑」在两条路径上保持一致（计划要求）。
"""

from subscribe_flow.contracts import ChannelError, Source


# 与前端 tag-catalog.js 的 11 档色板一一对应，键名即数据库存储值。
COLORS = ('violet', 'blue', 'cyan', 'green', 'lime', 'yellow', 'amber',
          'red', 'pink', 'plum', 'slate')

MAX_NAME = 40
MAX_DESCRIPTION = 200
MAX_SYNONYMS = 8
MAX_SYNONYM = 40
MAX_CANDIDATES = 8
# 自动打标两种模式共用的最终数量上限；人工标签不受影响。
AUTO_TAG_LIMIT = 2


def validate_tag_name(name, field='name'):
    if type(name) is not str:
        raise ChannelError('INVALID_INPUT', field, '标签名称需为文本')
    name = name.strip()
    if not name or len(name) > MAX_NAME:
        raise ChannelError('INVALID_INPUT', field, f'标签名称需为 1 到 {MAX_NAME} 个字符')
    if any(ord(ch) < 32 for ch in name):
        raise ChannelError('INVALID_INPUT', field, '标签名称不能包含控制字符')
    return name


def validate_tag_color(color, field='color'):
    if color is None:
        return 'slate'
    if type(color) is not str or color not in COLORS:
        raise ChannelError('INVALID_INPUT', field, '标签颜色需为色板内的取值')
    return color


def validate_synonyms(synonyms, field='synonyms'):
    if synonyms is None:
        return []
    if type(synonyms) is not list or len(synonyms) > MAX_SYNONYMS:
        raise ChannelError('INVALID_INPUT', field, f'别名需为不超过 {MAX_SYNONYMS} 项的列表')
    cleaned, seen = [], set()
    for raw in synonyms:
        if type(raw) is not str:
            raise ChannelError('INVALID_INPUT', field, '别名需为文本')
        value = raw.strip()
        if not value or len(value) > MAX_SYNONYM:
            raise ChannelError('INVALID_INPUT', field, f'每个别名需为 1 到 {MAX_SYNONYM} 个字符')
        if value.casefold() in seen:
            continue
        seen.add(value.casefold())
        cleaned.append(value)
    return cleaned


def validate_description(description, field='description'):
    if description is None:
        return ''
    if type(description) is not str or len(description) > MAX_DESCRIPTION:
        raise ChannelError('INVALID_INPUT', field, f'描述需为不超过 {MAX_DESCRIPTION} 个字符的文本')
    return description.strip()


def validate_tag_ids(tag_ids, field='tag_ids'):
    """校验标签 ID 列表。数量上限与内容批量操作保持同一量级。"""
    if type(tag_ids) is not list or len(tag_ids) > 100:
        raise ChannelError('INVALID_INPUT', field, '每次需指定 0 到 100 个标签')
    cleaned = []
    for tag_id in tag_ids:
        if type(tag_id) is not str or not tag_id or len(tag_id) > 2000:
            raise ChannelError('INVALID_INPUT', field, '标签 ID 无效')
        if tag_id not in cleaned:
            cleaned.append(tag_id)
    return cleaned


def validate_tag_filter(tags, mode):
    """内容按标签筛选：任一符合（any）或全部符合（all）。"""
    if tags is None:
        return [], 'any'
    if type(tags) is not list or len(tags) > 20:
        raise ChannelError('INVALID_INPUT', 'tags', '每次最多按 20 个标签筛选')
    cleaned = []
    for tag_id in tags:
        if type(tag_id) is not str or not tag_id or len(tag_id) > 2000:
            raise ChannelError('INVALID_INPUT', 'tags', '标签 ID 无效')
        if tag_id not in cleaned:
            cleaned.append(tag_id)
    if mode is None:
        mode = 'any'
    if mode not in ('any', 'all'):
        raise ChannelError('INVALID_INPUT', 'tag_mode', '标签筛选方式需为任一符合或全部符合')
    return cleaned, mode


# --------------------------------------------------------------------------
# 识别契约
#
# 识别输入只用稳定内容 ID 和标准化字段表达，不携带任何平台原始响应；
# 正文、摘要等字段允许缺失，缺失就是 None，识别方必须自行判断能否工作。
# --------------------------------------------------------------------------

class RecognitionInput:
    """交给识别提供者的一条内容。字段缺失即 None，不以空串或猜测值代替。"""

    __slots__ = ('item_id', 'channel', 'source_id', 'title', 'summary', 'published_at', 'content_updated_at')

    def __init__(self, item_id, channel=None, source_id=None, title=None,
                 summary=None, published_at=None, content_updated_at=None):
        self.item_id = item_id
        self.channel = channel
        self.source_id = source_id
        self.title = title
        self.summary = summary
        self.published_at = published_at
        self.content_updated_at = content_updated_at

    @classmethod
    def from_content(cls, content):
        payload = content.get('payload') or content
        summary = payload.get('summary')
        if summary is not None and type(summary) is not str:
            summary = None
        source = payload.get('source')
        source_id = Source(**source).key if source else None
        published = payload.get('published') or {}
        return cls(content['id'], payload.get('channel'), source_id,
                   payload.get('title'), summary, published.get('value'),
                   payload.get('updated_at') or content.get('updated_at'))

    def to_dict(self):
        return {name: getattr(self, name) for name in self.__slots__}

    def __repr__(self):
        return f'<RecognitionInput {self.item_id} title={self.title!r}>'


class TagCandidate:
    """一条候选标签。

    tag_id 指向已有标签；为 None 表示这是一个建议新标签，只有名称。
    confidence 允许为 None —— 识别方没有给出就是没有，本模块绝不代填。
    """

    __slots__ = ('name', 'tag_id', 'reason', 'confidence', 'origin')

    def __init__(self, name, tag_id=None, reason=None, confidence=None, origin=None):
        self.name = name
        self.tag_id = tag_id
        self.reason = reason
        self.confidence = confidence
        self.origin = origin

    def to_dict(self):
        return {'name': self.name, 'tag_id': self.tag_id, 'reason': self.reason,
                'confidence': self.confidence, 'origin': self.origin}

    @classmethod
    def from_dict(cls, raw):
        if not isinstance(raw, dict):
            raise ChannelError('INVALID_INPUT', 'candidates', '候选标签需为结构化对象')
        name = raw.get('name')
        if name is not None:
            name = validate_tag_name(name, 'candidate.name')
        tag_id = raw.get('tag_id')
        if tag_id is not None and (type(tag_id) is not str or not tag_id):
            raise ChannelError('INVALID_INPUT', 'candidate.tag_id', '候选标签的已有标签 ID 无效')
        if name is None and tag_id is None:
            raise ChannelError('INVALID_INPUT', 'candidate', '候选标签需提供名称或已有标签 ID')
        confidence = raw.get('confidence')
        if confidence is not None:
            if type(confidence) not in (int, float) or isinstance(confidence, bool):
                raise ChannelError('INVALID_INPUT', 'candidate.confidence', '置信度需为数值')
            if not 0.0 <= float(confidence) <= 1.0:
                raise ChannelError('INVALID_INPUT', 'candidate.confidence', '置信度需在 0 到 1 之间')
        reason = raw.get('reason')
        if reason is not None and type(reason) is not str:
            raise ChannelError('INVALID_INPUT', 'candidate.reason', '理由需为文本')
        return cls(name, tag_id, reason, confidence, raw.get('origin'))

    def __repr__(self):
        return f'<TagCandidate {self.tag_id or self.name!r} conf={self.confidence}>'


class TagSuggestion:
    """一次识别对一条内容产出的完整建议。

    content_updated_at 是建议生成时看到的内容版本；应用建议时会与当前版本
    比较，内容已经变过的旧建议被识别为过期而不是盲目写入。
    """

    __slots__ = ('item_id', 'content_updated_at', 'provider', 'candidates')

    def __init__(self, item_id, candidates, content_updated_at=None, provider='unknown'):
        self.item_id = item_id
        # 在构造时就归一化：提供者即使交回普通 dict，调用方拿到的也是受约束的形状。
        self.candidates = [c if isinstance(c, TagCandidate) else TagCandidate.from_dict(c)
                           for c in (candidates or [])]
        self.content_updated_at = content_updated_at
        self.provider = provider

    @classmethod
    def from_dict(cls, raw):
        if not isinstance(raw, dict):
            raise ChannelError('INVALID_INPUT', 'suggestion', '识别建议需为结构化对象')
        item_id = raw.get('item_id')
        if type(item_id) is not str or not item_id:
            raise ChannelError('INVALID_INPUT', 'suggestion.item_id', '识别建议需指定稳定的内容 ID')
        candidates = raw.get('candidates')
        if type(candidates) is not list or not candidates or len(candidates) > MAX_CANDIDATES:
            raise ChannelError('INVALID_INPUT', 'suggestion.candidates',
                               f'识别建议需提供 1 到 {MAX_CANDIDATES} 条候选标签')
        version = raw.get('content_updated_at')
        if version is not None and type(version) is not str:
            raise ChannelError('INVALID_INPUT', 'suggestion.content_updated_at', '内容版本需为文本')
        provider = raw.get('provider')
        if provider is not None and type(provider) is not str:
            raise ChannelError('INVALID_INPUT', 'suggestion.provider', '生成来源需为文本')
        return cls(item_id, [TagCandidate.from_dict(c) for c in candidates], version, provider or 'unknown')

    def to_dict(self):
        return {'item_id': self.item_id, 'content_updated_at': self.content_updated_at,
                'provider': self.provider, 'candidates': [c.to_dict() for c in self.candidates]}

    def __repr__(self):
        return f'<TagSuggestion {self.item_id} x{len(self.candidates)} from {self.provider}>'
