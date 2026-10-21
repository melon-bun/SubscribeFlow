"""M15 应用设置服务（M21 拆分 AI API 与识别策略）。

职责边界：
- 只处理非敏感配置。密钥由 Main 的凭据服务保管，这里只保存凭据引用，
  因此这个类无论被谁调用都不可能返回或保存明文密钥。
- 按页保存：一次只提交一个分区（AI API 配置 / 识别策略 / 提醒设置 / 优先级名称），
  避免修改提醒参数时顺手把另一页没填完的 API 配置一起存进去（§2.1）。
- M21 起配置职责分开：
  ``ai.providers`` 只放连接参数（接口地址、模型标识、凭据引用），
  ``tagging.enabled/mode/enabledSince`` 只放识别策略。
  保存 API 不碰策略，保存策略不碰 API；两边互不覆盖。
- 配置版本只在「当前生效的识别配置」变化时递增。自动打标以它判断在途结果
  是否过期；优先级别名、提醒参数这类无关保存不该让在跑的打标任务重跑。
"""

import copy
import json
import re
from urllib.parse import urlparse

from subscribe_flow.ai.contracts import PROTOCOLS, PROTOCOL_LABELS, ProviderConfig
from subscribe_flow.ai.registry import (
    CALL_FIELDS, LEGACY_PROTOCOLS, LEGACY_SLOT_IDS, call_changed, capabilities_of,
    migrate_providers, normalize_providers, provider_id_pattern_ok, references,
)
from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.repositories import now

# 打标的两种识别方式：这是打标业务的策略，不是连接的固定槽位。
# 同一个连接可以被多种方式之外的业务引用，连接数量不受这里限制。
MODES = ("jev", "llm")
SECTIONS = ("ai", "tagging", "reminder", "priority", "summarization")

# M25：AI 配置格式版本。1 是 0.4.9 的固定 llm／jev 两槽结构。
AI_FORMAT_VERSION = 2

# 总结详细程度：业务策略，不属于连接配置。
SUMMARY_LENGTHS = ("brief", "detailed")
DEFAULT_SUMMARY_LENGTH = "brief"
SUMMARY_LENGTH_LABELS = {"brief": "简略（一句话）", "detailed": "复杂（300 字）"}

INTERVAL_PRESETS = (15, 30, 60, 120)
INTERVAL_MIN = 5
INTERVAL_MAX = 1440
DEFAULT_INTERVAL = 60

# M20 优先级名称：三级固定，顺序固定，只有显示名可改。
# 「未设置」是无优先级状态，不是第四个等级，因此不能被占用为名称。
PRIORITY_LEVELS = ("high", "medium", "low")
PRIORITY_NONE_LABEL = "未设置"
PRIORITY_NAME_MAX = 12
DEFAULT_PRIORITY_NAMES = {
    "high": "高优先级",
    "medium": "中优先级",
    "low": "低优先级",
}

# 初始设置含官方默认值；用户明确清空后仍保留空值，不在界面偷偷恢复。
OFFICIAL_DEFAULTS = {
    "jev": {"endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest"},
}

REFERENCE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MODEL_PATTERN = re.compile(r"^[^\s\x00-\x1f\x7f]{1,256}$")

# 新装时的初始连接：与 0.4.9 的两个固定槽位一一对应，迁移后 ID 与引用保持一致。
DEFAULT_PROVIDERS = {
    "provider-llm": {
        "id": "provider-llm", "name": "LLM", "protocol": LEGACY_PROTOCOLS["llm"],
        "endpoint": "", "model": "", "credentialRef": None, "enabled": True, "revision": 1,
    },
    "provider-jev": {
        "id": "provider-jev", "name": "Jev", "protocol": LEGACY_PROTOCOLS["jev"],
        "endpoint": OFFICIAL_DEFAULTS["jev"]["endpoint"],
        "model": OFFICIAL_DEFAULTS["jev"]["model"],
        "credentialRef": None, "enabled": True, "revision": 1,
    },
}

DEFAULTS = {
    # M25：连接是独立资源，按稳定 ID 组织；同一协议可以配多条。
    "ai": {"formatVersion": AI_FORMAT_VERSION, "providers": copy.deepcopy(DEFAULT_PROVIDERS)},
    # 识别策略独立成区：只放“用不用、怎么识别、用哪条连接”。
    # revision 是打标的有效配置版本：只在策略或当前所用连接真的变了时前进。
    # 它才是打标任务的有效性依据（任务表的 config_version 存的就是它）；
    # 设置的 version 是保存计数，用于并发保存检查，两件事不要混用。
    "tagging": {"enabled": False, "mode": "llm", "enabledSince": None, "revision": 1,
                "providerIds": {"llm": "provider-llm", "jev": "provider-jev"}},
    "reminder": {"enabled": False, "intervalMinutes": DEFAULT_INTERVAL},
    "priority": {"names": dict(DEFAULT_PRIORITY_NAMES)},
    # M29 接入总结时用的策略位。本批只留边界：它不是连接字段，也不影响打标。
    # revision 的确切语义（总结策略、Provider revision 与 prompt 版本的合成）
    # 留给 M29 定义；此处只占位，保证结构与计划 §4.3 的形状一致。
    "summarization": {"enabled": True, "providerId": None,
                      "length": DEFAULT_SUMMARY_LENGTH, "language": "zh-CN", "revision": 1},
}


def _fail(message, scope="operation", scope_key=None):
    raise ChannelError("INVALID_INPUT", "settings.update", message, scope=scope, scope_key=scope_key)


def _validate_endpoint(value, scope_key):
    if not isinstance(value, str):
        _fail("接口地址必须是文本", "field", scope_key)
    endpoint = value.strip()
    if not endpoint:
        return ""
    if re.search(r"[\s\x00-\x1f\x7f]", endpoint):
        _fail("接口地址不能包含空格或控制字符", "field", scope_key)
    try:
        parsed = urlparse(endpoint)
        valid = parsed.scheme in ("http", "https") and bool(parsed.hostname)
        # 访问 port 属性才能捕获非数字或越界端口；凭据不得藏在普通配置的 URL 中。
        port = parsed.port
        valid = valid and (port is None or port > 0) and parsed.username is None and parsed.password is None
    except ValueError:
        valid = False
    if not valid:
        _fail("接口地址必须是完整的 http(s) 地址", "field", scope_key)
    if len(endpoint) > 2000:
        _fail("接口地址过长", "field", scope_key)
    return endpoint


def _validate_model(value, scope_key):
    if not isinstance(value, str):
        _fail("模型标识必须是文本", "field", scope_key)
    model = value.strip()
    if not model:
        return ""
    if not MODEL_PATTERN.fullmatch(model):
        _fail("模型标识不能包含空格或控制字符，长度不能超过 256", "field", scope_key)
    return model


def _validate_reference(value, scope_key):
    if value is None:
        return None
    if not isinstance(value, str) or not REFERENCE_PATTERN.match(value):
        _fail("凭据引用格式无效", "field", scope_key)
    return value


def _validate_priority_name(value, scope_key):
    """单个优先级名称：去首尾空格后 1–12 字符，且不能占用「未设置」。"""
    if not isinstance(value, str):
        _fail("优先级名称必须是文本", "field", scope_key)
    name = value.strip()
    if not name:
        _fail("优先级名称不能为空", "field", scope_key)
    if len(name) > PRIORITY_NAME_MAX:
        _fail("优先级名称不能超过 %d 个字符" % PRIORITY_NAME_MAX, "field", scope_key)
    if name == PRIORITY_NONE_LABEL:
        _fail("「%s」表示无优先级，不能用作优先级名称" % PRIORITY_NONE_LABEL, "field", scope_key)
    return name


def _readable_priority_name(value):
    """读取时的宽松版本：存档被写坏就退回默认名，不让界面读到半个空名。"""
    if not isinstance(value, str):
        return None
    name = value.strip()
    if not name or len(name) > PRIORITY_NAME_MAX or name == PRIORITY_NONE_LABEL:
        return None
    return name


def _missing_provider_items(provider):
    """一条连接还缺什么。连接不存在时按「缺可用连接」算。"""
    if not provider:
        return ["可用连接"]
    return [label for key, label in (("endpoint", "接口地址"), ("model", "模型标识"), ("credentialRef", "API Key"))
            if not provider.get(key)]


def _validate_provider_name(value, scope_key):
    """连接名称：给用户看的，可以随时改（改名不推进调用版本）。"""
    if not isinstance(value, str):
        _fail("连接名称必须是文本", "field", scope_key)
    name = value.strip()
    if not name:
        _fail("连接名称不能为空", "field", scope_key)
    if len(name) > 60:
        _fail("连接名称不能超过 60 个字符", "field", scope_key)
    return name


def _recognition_fingerprint(payload):
    """当前生效的识别配置指纹。

    只有它变了，在途的识别结果才需要作废重跑。因此：
    - 改动当前方式所用的连接、切换方式、启停识别 → 指纹变 → 推进版本；
    - 改另一种暂未使用的连接、改优先级别名、改提醒参数、改总结设置 → 指纹不变 → 版本不动。
    """
    tagging = payload["tagging"]
    provider_ids = tagging.get("providerIds") or {}
    mode = tagging["mode"]
    provider_id = provider_ids.get(mode)
    parts = {
        "enabled": bool(tagging["enabled"]),
        "mode": mode,
        "providerId": provider_id or "",
    }
    providers = normalize_providers(payload["ai"].get("providers"))
    provider = providers.get(provider_id) if provider_id else None
    # 只有当前方式真正用到的那条连接进指纹：改另一种方式的连接不影响在途结果。
    # 连接不存在也要进指纹——少了一条连接同样改变了在途结果的有效性。
    parts["provider"] = provider.call_signature() if provider else None
    return json.dumps(parts, sort_keys=True, ensure_ascii=False)


class SettingsService:
    def __init__(self, store):
        self.store = store

    # ------------------------------------------------------------ 读取

    def _current(self):
        record = self.store.load()
        payload = copy.deepcopy(DEFAULTS)
        stored = record["payload"] or {}
        for section in SECTIONS:
            stored_section = stored.get(section)
            if not isinstance(stored_section, dict):
                continue
            for key, value in stored_section.items():
                if key not in payload[section] or key in ("providers", "names", "providerIds"):
                    continue
                payload[section][key] = value
            if section == "priority":
                # 逐级回落：旧配置没有这一项、或某一档写坏了，都用默认名补齐。
                names = stored_section.get("names") or {}
                for level in PRIORITY_LEVELS:
                    name = _readable_priority_name(names.get(level))
                    if name:
                        payload["priority"]["names"][level] = name
        # M25：连接按稳定 ID 读。旧结构（0.4.9 的 ai.providers 与更早的
        # tagging.providers）在这里转换，地址、模型与同一个凭据引用都保留。
        payload["ai"]["providers"] = self._read_providers(stored)
        payload["ai"]["formatVersion"] = AI_FORMAT_VERSION
        # 打标策略引用哪条连接。
        # 存档里显式写了的值优先——哪怕是 null：那是用户解除引用，不能被默认复活。
        # 存档里没写的那一项才用默认补上；默认指向的连接不存在时留空，不留悬空引用。
        provider_ids = dict(payload["tagging"]["providerIds"])
        stored_tagging = stored.get("tagging")
        if isinstance(stored_tagging, dict) and isinstance(stored_tagging.get("providerIds"), dict):
            stored_ids = stored_tagging["providerIds"]
            for mode in MODES:
                if mode in stored_ids:
                    provider_ids[mode] = stored_ids[mode] or None
        providers = payload["ai"]["providers"]
        payload["tagging"]["providerIds"] = {
            mode: (provider_ids.get(mode) if provider_ids.get(mode) in providers else None)
            for mode in MODES
        }
        # 打标的有效配置版本：旧配置没有这一项时用当前保存版本起头，
        # 升级前就在跑的任务因此不会被结构迁移白白作废。
        stored_revision = (stored.get("tagging") or {}).get("revision")
        if isinstance(stored_revision, int) and stored_revision >= 1:
            payload["tagging"]["revision"] = stored_revision
        else:
            payload["tagging"]["revision"] = max(1, int(record["version"] or 1))
        return record["version"], record["updatedAt"], payload

    @staticmethod
    def _read_providers(stored):
        """存档 → 连接资源。写坏的条目直接跳过，不让一条坏配置拖垮整个设置。

        新结构（formatVersion≥2）存什么就是什么——包括用户把连接全删了；
        旧结构走迁移；两者都没有才给默认的两条连接。
        """
        ai = stored.get("ai") if isinstance(stored, dict) else None
        version = ai.get("formatVersion") if isinstance(ai, dict) else None
        if isinstance(version, int) and version >= 2:
            raw = ai.get("providers") if isinstance(ai.get("providers"), dict) else {}
        else:
            raw = migrate_providers(stored) or copy.deepcopy(DEFAULT_PROVIDERS)
        result = {}
        for provider_id, value in raw.items():
            try:
                provider = ProviderConfig.from_dict(value)
            except ValueError:
                continue
            result[provider_id] = provider.to_dict()
        return result

    def snapshot(self):
        version, updated_at, payload = self._current()
        providers = {}
        for provider_id, value in payload["ai"]["providers"].items():
            missing = _missing_provider_items(value)
            providers[provider_id] = {
                "id": provider_id,
                "name": value["name"],
                "protocol": value["protocol"],
                "protocolLabel": PROTOCOL_LABELS.get(value["protocol"], value["protocol"]),
                "endpoint": value["endpoint"],
                "model": value["model"],
                # 引用本身不是秘密，但也没必要给界面：界面只需要知道「有没有配」。
                "credentialRef": value["credentialRef"],
                "enabled": bool(value["enabled"]),
                "revision": int(value["revision"]),
                "configured": not missing,
                "missing": missing,
                "capabilities": list(capabilities_of(value["protocol"])),
                # 哪些业务在用这条连接：删除被引用的连接时要说明使用方。
                "usedBy": references(payload, provider_id),
            }
        interval = payload["reminder"]["intervalMinutes"]
        return {
            # 配置版本：只在影响识别结果的配置变化时递增（见 _recognition_fingerprint）。
            "version": version,
            "updatedAt": updated_at,
            "ai": {"formatVersion": AI_FORMAT_VERSION, "providers": providers},
            "tagging": {"enabled": payload["tagging"]["enabled"], "mode": payload["tagging"]["mode"],
                        "enabledSince": payload["tagging"]["enabledSince"],
                        "providerIds": dict(payload["tagging"]["providerIds"]),
                        # 打标的有效配置版本：打标任务的有效性依据。
                        "revision": int(payload["tagging"]["revision"])},
            "reminder": {"enabled": payload["reminder"]["enabled"], "intervalMinutes": interval,
                         "preset": str(interval) if interval in INTERVAL_PRESETS else "custom"},
            "priority": {"names": dict(payload["priority"]["names"])},
            "summarization": dict(payload["summarization"]),
        }

    # ------------------------------------------------------------ 保存

    def update(self, section, patch, credential_refs=None):
        if section not in SECTIONS:
            _fail("未知的设置分区")
        if not isinstance(patch, dict) or not patch:
            _fail("没有需要保存的修改")
        _, _, payload = self._current()
        fingerprint = _recognition_fingerprint(payload)
        if section == "ai":
            # 凭据引用要在完整性校验之前落进草稿：一次提交里同时给出地址、模型和
            # 新密钥是正常流程，先校验再合并会把这次提交误判成「缺 API Key」。
            merged = self._merge_ai(payload, patch, credential_refs)
        elif section == "tagging":
            if credential_refs:
                _fail("识别策略不接受凭据引用")
            merged = self._merge_tagging(payload["tagging"], patch, payload["ai"]["providers"])
        elif section == "priority":
            if credential_refs:
                _fail("优先级名称不接受凭据引用")
            merged = self._merge_priority(payload["priority"], patch)
        else:
            if credential_refs:
                _fail("提醒设置不接受凭据引用")
            merged = self._merge_reminder(payload["reminder"], patch)
        payload[section] = merged
        # 打标的有效配置版本：只在当前生效的识别配置真的变了才推进。
        # 优先级别名、提醒参数、另一种暂未使用的连接都不动它——
        # 在途的识别结果因此不会被无关保存作废。
        if _recognition_fingerprint(payload) != fingerprint:
            payload["tagging"]["revision"] = int(payload["tagging"].get("revision") or 1) + 1
        # 设置的 version 是保存计数：每次保存都前进，供并发保存检查用。
        record = self.store.save(payload)
        result = self.snapshot()
        result["savedVersion"] = record["version"]
        return result

    def _merge_ai(self, payload, patch, credential_refs=None):
        """只合并连接：名称、协议、地址、模型、启用状态与凭据引用。

        连接按稳定 ID 组织，同一协议可以有多条；这里不再有「两个固定槽位」。
        允许保存尚未补齐的参数——填一半也要存得住。缺项在快照里如实标出。
        """
        if set(patch) - {"providers"}:
            _fail("包含不支持的 AI API 配置字段")
        providers = patch.get("providers")
        if not isinstance(providers, dict) or not providers:
            _fail("AI API 配置格式无效", "field", "providers")
        merged = copy.deepcopy(payload["ai"])
        existing = merged["providers"]
        touched = []
        for provider_id, fields in providers.items():
            if not provider_id_pattern_ok(provider_id):
                _fail("连接 ID 格式无效", "field", "providers")
            if fields is None:
                # 删除：被业务引用时拦下来，并说明是谁在用。
                users = references(payload, provider_id)
                if users:
                    _fail("这条连接正在被使用，不能删除：" + "、".join(users), "field", "providers." + provider_id)
                existing.pop(provider_id, None)
                continue
            if not isinstance(fields, dict) or set(fields) - {"name", "protocol", "endpoint", "model", "enabled"}:
                # 密钥字段永远不接受：密钥只能经凭据引用提交。
                _fail("包含不支持的连接配置字段", "field", "providers." + provider_id)
            current = existing.get(provider_id)
            resource = dict(current) if current else {
                "id": provider_id, "name": "", "protocol": PROTOCOLS[0],
                "endpoint": "", "model": "", "credentialRef": None,
                "enabled": True, "revision": 1,
            }
            resource["id"] = provider_id
            if "name" in fields:
                resource["name"] = _validate_provider_name(fields["name"], provider_id)
            if not resource["name"]:
                resource["name"] = provider_id
            if "protocol" in fields:
                protocol = fields["protocol"]
                if protocol not in PROTOCOLS:
                    _fail("连接协议无效", "field", "providers." + provider_id + ".protocol")
                resource["protocol"] = protocol
            if "endpoint" in fields:
                resource["endpoint"] = _validate_endpoint(fields["endpoint"], "providers." + provider_id + ".endpoint")
            if "model" in fields:
                resource["model"] = _validate_model(fields["model"], "providers." + provider_id + ".model")
            if "enabled" in fields:
                if not isinstance(fields["enabled"], bool):
                    _fail("连接启用状态无效", "field", "providers." + provider_id + ".enabled")
                resource["enabled"] = fields["enabled"]
            existing[provider_id] = resource
            touched.append(provider_id)
        # 凭据引用由 Main 在写入受保护密钥之后给出；引用缺失说明这一版不换密钥。
        merged = self._apply_references(merged, credential_refs, "ai")
        # 调用配置变了才推进这条连接自己的版本：改名不动它。
        for provider_id in touched:
            old = payload["ai"]["providers"].get(provider_id)
            new = merged["providers"][provider_id]
            if call_changed(old, new):
                merged["providers"][provider_id]["revision"] = int(new.get("revision") or 1) + 1
        return merged

    def _merge_priority(self, current, patch):
        """三级名称只能改显示名：等级本身固定，缺失的沿用当前值。"""
        if set(patch) - {"names"}:
            _fail("包含不支持的优先级名称字段")
        names = patch.get("names")
        if not isinstance(names, dict):
            _fail("优先级名称格式无效", "field", "names")
        if set(names) - set(PRIORITY_LEVELS):
            _fail("包含不支持的优先级等级", "field", "names")
        merged = copy.deepcopy(current)
        for level in PRIORITY_LEVELS:
            if level in names:
                merged["names"][level] = _validate_priority_name(names[level], "names." + level)
        # 整体校验：不重名，也不占用「未设置」。
        seen = {}
        for level in PRIORITY_LEVELS:
            value = merged["names"][level]
            if value in seen:
                _fail("三个优先级名称不能相同", "field", "names." + level)
            seen[value] = level
        return merged

    def _merge_tagging(self, current, patch, providers):
        """只合并识别策略：开关、方式与每种方式使用哪条连接。

        连接参数不在这里改。目标方式没有可用连接时不能开启，
        也不能把已开启的识别切到跑不起来的方式：要说清缺什么，
        而不是存下一个坏状态。
        """
        if set(patch) - {"enabled", "mode", "providerIds"}:
            _fail("包含不支持的自动打标字段")
        merged = copy.deepcopy(current)
        merged.setdefault("providerIds", {})
        if "enabled" in patch:
            if not isinstance(patch["enabled"], bool):
                _fail("自动打标开关无效", "field", "enabled")
            merged["enabled"] = patch["enabled"]
        if "mode" in patch:
            if patch["mode"] not in MODES:
                _fail("识别方式无效", "field", "mode")
            merged["mode"] = patch["mode"]
        if "providerIds" in patch:
            provider_ids = patch["providerIds"]
            if not isinstance(provider_ids, dict):
                _fail("识别方式与连接的对应关系无效", "field", "providerIds")
            if set(provider_ids) - set(MODES):
                _fail("包含不支持的识别方式", "field", "providerIds")
            for mode, provider_id in provider_ids.items():
                if provider_id is None:
                    # 明确的「不选这条连接」：解除引用。引用解除后连接才能被删除。
                    merged["providerIds"][mode] = None
                    continue
                if not isinstance(provider_id, str) or provider_id not in providers:
                    _fail("所选连接不存在", "field", "providerIds." + mode)
                merged["providerIds"][mode] = provider_id
        if merged["enabled"] and merged["enabledSince"] is None:
            # 记录生效边界：只覆盖此后首次保存的内容，关闭期间收录的需主动补打。
            merged["enabledSince"] = now()
        if not merged["enabled"]:
            merged["enabledSince"] = None
        if merged["enabled"]:
            mode = merged["mode"]
            provider_id = (merged.get("providerIds") or {}).get(mode)
            provider = providers.get(provider_id) if provider_id else None
            names = {"jev": "Jev 已有标签分类", "llm": "LLM 自由生成标签"}
            name = names[mode]
            if provider_id is None:
                # 当前方式没有连接：开着识别时这是坏状态，不能存。
                # 解除引用要么先选一条，要么先关闭识别。
                if current["enabled"]:
                    _fail("自动打标已开启，「%s」还没有选连接：请先选一条可用连接，"
                          "或关闭自动打标后再解除引用。" % name)
                _fail("开启自动打标前，请先为「%s」选择一条连接。" % name)
            missing = _missing_provider_items(provider)
            if missing:
                if current["enabled"]:
                    # 已经开启时切到另一种方式：不是「打不开」，而是「切过去就会坏」，
                    # 错误要说清是切换，否则用户会以为是开关本身坏了。
                    _fail("自动打标已开启，切换到「%s」前请先补齐该方式的%s" % (name, "、".join(missing)))
                _fail("开启自动打标前，请先完成「%s」的%s" % (name, "、".join(missing)))
            if not provider.get("enabled", True):
                # 停用的连接跑不起来：开着识别时不能存下这种配置。
                if current["enabled"]:
                    _fail("自动打标已开启，「%s」用的连接已停用：请先在「AI API 配置」里启用它。" % name)
                _fail("开启自动打标前，请先在「AI API 配置」里启用「%s」用的连接（该连接已停用）。" % name)
        return merged

    def _merge_reminder(self, current, patch):
        if set(patch) - {"enabled", "intervalMinutes"}:
            _fail("包含不支持的提醒字段")
        merged = copy.deepcopy(current)
        if "enabled" in patch:
            if not isinstance(patch["enabled"], bool):
                _fail("提醒开关无效", "field", "enabled")
            merged["enabled"] = patch["enabled"]
        if "intervalMinutes" in patch:
            interval = patch["intervalMinutes"]
            if type(interval) is not int or not INTERVAL_MIN <= interval <= INTERVAL_MAX:
                _fail("提醒间隔需为 %d–%d 分钟的整数" % (INTERVAL_MIN, INTERVAL_MAX), "field", "intervalMinutes")
            merged["intervalMinutes"] = interval
        return merged

    def _apply_references(self, merged, credential_refs, section):
        if credential_refs is None:
            return merged
        if not isinstance(credential_refs, dict):
            _fail("凭据引用格式无效")
        if section != "ai":
            _fail("当前分区不接受凭据引用")
        for provider_id, reference in credential_refs.items():
            if provider_id not in merged["providers"]:
                _fail("凭据引用对应的连接不存在", "field", "credentialRefs")
            merged["providers"][provider_id]["credentialRef"] = _validate_reference(reference, "credentialRefs")
        return merged
