"""连接资源注册表：读、写、能力派生、版本推进、引用检查与旧结构迁移。

这一层只处理「连接」这种资源。它不知道打标怎么用、总结怎么用，
但知道谁在用：删除被引用的连接必须拦下来并说明使用方。
"""

from __future__ import annotations

from .contracts import PROTOCOL_CAPABILITIES, PROTOCOL_JEV_SYSTEMONE, PROTOCOL_OPENAI_CHAT, ProviderConfig

# 旧结构（0.4.9 及更早）里的固定槽位 → 新结构的稳定资源 ID。
# 转换是幂等的：读一次再存一次，ID、地址、模型与凭据引用都不变。
LEGACY_SLOT_IDS = {
    'llm': 'provider-llm',
    'jev': 'provider-jev',
}
LEGACY_PROTOCOLS = {
    'llm': PROTOCOL_OPENAI_CHAT,
    'jev': PROTOCOL_JEV_SYSTEMONE,
}
LEGACY_NAMES = {
    'llm': 'LLM',
    'jev': 'Jev',
}

# 参与「调用配置是否变化」判定的字段。展示名不在其中：改名不该让在途结果作废。
CALL_FIELDS = ('protocol', 'endpoint', 'model', 'credentialRef', 'enabled')


def provider_id_pattern_ok(provider_id: str) -> bool:
    return bool(provider_id) and len(provider_id) <= 64 and all(
        ch.isalnum() or ch in '._-' for ch in provider_id)


def normalize_providers(raw) -> dict:
    """把存档里的连接读成 {id: ProviderConfig}，跳过写坏的条目。"""
    result: dict[str, ProviderConfig] = {}
    if not isinstance(raw, dict):
        return result
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        candidate = dict(value)
        candidate.setdefault('id', key)
        try:
            provider = ProviderConfig.from_dict(candidate)
        except ValueError:
            continue
        if provider.id != key:
            continue
        result[provider.id] = provider
    return result


def migrate_providers(stored) -> dict:
    """旧结构 → 新结构。

    两处旧来源：新结构 ``ai.providers``（0.4.9）与更旧的 ``tagging.providers``。
    现代优先、旧字段补缺；地址、模型与**同一个** credentialRef 都保留，
    不复制也不新建密钥。

    补缺是**按字段**做的，不是按整条：现代显式写了的值优先（哪怕是空串或
    null，那表示用户自己清过，不能被旧值复活），现代没写的那一项才用旧值补上。
    """
    ai = stored.get('ai') if isinstance(stored, dict) else None
    ai = ai if isinstance(ai, dict) else {}
    version = ai.get('formatVersion')
    modern_raw = ai.get('providers') if isinstance(ai.get('providers'), dict) else {}
    legacy_raw: dict = {}
    tagging = stored.get('tagging') if isinstance(stored, dict) else None
    if isinstance(tagging, dict) and isinstance(tagging.get('providers'), dict):
        legacy_raw = tagging['providers']
    looks_modern = (isinstance(version, int) and version >= 2) or any(
        isinstance(value, dict) and ('protocol' in value or 'id' in value)
        for value in modern_raw.values())

    merged_raw: dict[str, dict] = {}
    # 资源 ID → 旧槽位名。槽位名决定协议与名称的兜底（llm／jev 的旧约定）。
    slots: dict[str, str | None] = {}
    if looks_modern:
        # 已经是新结构：键就是稳定 ID，原样保留。
        # 用户删光连接也是事实：这里不凭空补回旧连接。
        for key, value in modern_raw.items():
            if isinstance(value, dict):
                merged_raw[key] = dict(value)
                slots[key] = None
    else:
        for slot, value in modern_raw.items():
            if not isinstance(value, dict):
                continue
            provider_id = LEGACY_SLOT_IDS.get(slot)
            if not provider_id:
                merged_raw[slot] = dict(value)
                slots[slot] = None
                continue
            merged_raw[provider_id] = dict(value)
            slots[provider_id] = slot
    # 更旧的 tagging.providers：按字段补缺。
    for slot, value in legacy_raw.items():
        if not isinstance(value, dict):
            continue
        provider_id = LEGACY_SLOT_IDS.get(slot)
        if not provider_id:
            continue
        if provider_id not in merged_raw:
            # 旧结构里多出来的一条：补进来（用户当年只填过一半槽位）。
            # 新结构已经是权威的，不在这里凭空添加——否则删掉的连接会复活。
            if not looks_modern:
                merged_raw[provider_id] = dict(value)
                slots[provider_id] = slot
            continue
        # 现代显式写的值优先；现代没写的那一项用旧值补上。
        merged_raw[provider_id] = {**value, **merged_raw[provider_id]}
        if slots.get(provider_id) is None:
            slots[provider_id] = slot
    return {provider_id: _as_resource(provider_id, value, slots.get(provider_id))
            for provider_id, value in merged_raw.items()}


def _as_resource(provider_id: str, value: dict, slot: str | None) -> dict:
    resource = {
        'id': provider_id,
        'name': value.get('name') or (LEGACY_NAMES.get(slot, '') if slot else ''),
        'protocol': value.get('protocol') or (LEGACY_PROTOCOLS.get(slot, PROTOCOL_OPENAI_CHAT) if slot else PROTOCOL_OPENAI_CHAT),
        'endpoint': value.get('endpoint') or '',
        'model': value.get('model') or '',
        'credentialRef': value.get('credentialRef'),
        'enabled': bool(value.get('enabled', True)),
        'revision': value.get('revision') if isinstance(value.get('revision'), int) else 1,
    }
    if not resource['name']:
        resource['name'] = provider_id
    return resource


def capabilities_of(protocol: str) -> tuple:
    return PROTOCOL_CAPABILITIES.get(protocol, ())


def call_changed(old: dict | None, new_fields: dict) -> bool:
    """调用配置是否变化。展示名不算。

    `old` 是存档里的连接字典，`new_fields` 是合并后的新值。
    """
    if old is None:
        return True
    current = {
        'protocol': old.get('protocol'),
        'endpoint': old.get('endpoint') or '',
        'model': old.get('model') or '',
        'credentialRef': old.get('credentialRef') or '',
        'enabled': bool(old.get('enabled')),
    }
    for field in CALL_FIELDS:
        value = new_fields.get(field, current.get(field))
        if field == 'credentialRef':
            value = value or ''
        elif field == 'enabled':
            value = bool(value)
        if value != current[field]:
            return True
    return False


def references(payload: dict, provider_id: str) -> list:
    """哪些业务在用这条连接。删除被引用的连接时据此拦下来并说明使用方。"""
    users: list[str] = []
    tagging = payload.get('tagging') or {}
    provider_ids = tagging.get('providerIds') or {}
    if isinstance(provider_ids, dict):
        for mode, reference in provider_ids.items():
            if reference == provider_id:
                users.append(f'标签管理·{mode} 识别')
    summarization = payload.get('summarization') or {}
    if summarization.get('providerId') == provider_id:
        users.append('AI 总结')
    return users


__all__ = [
    'LEGACY_SLOT_IDS', 'LEGACY_PROTOCOLS', 'LEGACY_NAMES', 'CALL_FIELDS',
    'normalize_providers', 'migrate_providers', 'capabilities_of', 'call_changed',
    'references', 'provider_id_pattern_ok',
]
