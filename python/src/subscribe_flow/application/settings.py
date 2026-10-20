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

from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.repositories import now

MODES = ("jev", "llm")
SECTIONS = ("ai", "tagging", "reminder", "priority")

# M21：这两个分区影响识别结果，保存它们要推进配置版本。
# 提醒与优先级别名不影响识别结果，保存它们不推进版本。
RECOGNITION_SECTIONS = ("ai", "tagging")

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

DEFAULTS = {
    # M21：连接参数独立成区，只放“怎么连”。
    "ai": {
        "providers": {
            "jev": {**OFFICIAL_DEFAULTS["jev"], "credentialRef": None},
            "llm": {"endpoint": "", "model": "", "credentialRef": None},
        },
    },
    # M21：识别策略独立成区，只放“用不用、怎么识别”。
    "tagging": {"enabled": False, "mode": "llm", "enabledSince": None},
    "reminder": {"enabled": False, "intervalMinutes": DEFAULT_INTERVAL},
    "priority": {"names": dict(DEFAULT_PRIORITY_NAMES)},
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
    return [label for key, label in (("endpoint", "接口地址"), ("model", "模型标识"), ("credentialRef", "API Key"))
            if not provider.get(key)]


def _stored_providers(stored):
    """从存档里取出两类 API 的连接参数。

    M21 起新结构是 ``ai.providers``；旧结构把同样的参数放在 ``tagging.providers``。
    两者都可能出现：新结构优先，旧结构只补新结构没有的字段。
    转换是幂等的——读一次再存一次，结果与原来等价。
    """
    legacy = stored.get("tagging")
    legacy = legacy.get("providers") if isinstance(legacy, dict) else None
    modern = stored.get("ai")
    modern = modern.get("providers") if isinstance(modern, dict) else None
    result = {}
    for mode in MODES:
        old = legacy.get(mode) if isinstance(legacy, dict) and isinstance(legacy.get(mode), dict) else {}
        new = modern.get(mode) if isinstance(modern, dict) and isinstance(modern.get(mode), dict) else {}
        values = {}
        for key in ("endpoint", "model", "credentialRef"):
            if key in new:
                values[key] = new[key]
            elif key in old:
                values[key] = old[key]
        result[mode] = values
    return result


def _recognition_fingerprint(payload):
    """当前生效的识别配置指纹。

    只有它变了，在途的识别结果才需要作废重跑。因此：
    - 改动当前方式所用的 API、切换方式、启停识别 → 指纹变 → 推进版本；
    - 改另一种暂未使用的 API、改优先级别名、改提醒参数 → 指纹不变 → 版本不动。
    """
    mode = payload["tagging"]["mode"]
    provider = payload["ai"]["providers"][mode]
    return json.dumps({
        "mode": mode,
        "enabled": bool(payload["tagging"]["enabled"]),
        "endpoint": provider.get("endpoint") or "",
        "model": provider.get("model") or "",
        "credentialRef": provider.get("credentialRef") or "",
    }, sort_keys=True, ensure_ascii=False)


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
                if key not in payload[section] or key in ("providers", "names"):
                    continue
                payload[section][key] = value
            if section == "priority":
                # 逐级回落：旧配置没有这一项、或某一档写坏了，都用默认名补齐。
                names = stored_section.get("names") or {}
                for level in PRIORITY_LEVELS:
                    name = _readable_priority_name(names.get(level))
                    if name:
                        payload["priority"]["names"][level] = name
        # 连接参数独立成区；旧结构 tagging.providers 走同一条兼容读取。
        for mode, values in _stored_providers(stored).items():
            payload["ai"]["providers"][mode].update(
                {k: v for k, v in values.items() if k in payload["ai"]["providers"][mode]})
        return record["version"], record["updatedAt"], payload

    def snapshot(self):
        version, updated_at, payload = self._current()
        providers = {}
        for mode in MODES:
            provider = payload["ai"]["providers"][mode]
            missing = _missing_provider_items(provider)
            providers[mode] = {
                "endpoint": provider["endpoint"],
                "model": provider["model"],
                # 引用本身不是秘密，但也没必要给界面：界面只需要知道「有没有配」。
                "credentialRef": provider["credentialRef"],
                "configured": not missing,
                "missing": missing,
                "officialDefaults": OFFICIAL_DEFAULTS.get(mode, None),
            }
        interval = payload["reminder"]["intervalMinutes"]
        return {
            # 配置版本：只在影响识别结果的配置变化时递增（见 _recognition_fingerprint）。
            "version": version,
            "updatedAt": updated_at,
            "ai": {"providers": providers},
            "tagging": {"enabled": payload["tagging"]["enabled"], "mode": payload["tagging"]["mode"],
                        "enabledSince": payload["tagging"]["enabledSince"]},
            "reminder": {"enabled": payload["reminder"]["enabled"], "intervalMinutes": interval,
                         "preset": str(interval) if interval in INTERVAL_PRESETS else "custom"},
            "priority": {"names": dict(payload["priority"]["names"])},
        }

    # ------------------------------------------------------------ 保存

    def update(self, section, patch, credential_refs=None):
        if section not in SECTIONS:
            _fail("未知的设置分区")
        if not isinstance(patch, dict) or not patch:
            _fail("没有需要保存的修改")
        version, _, payload = self._current()
        fingerprint = _recognition_fingerprint(payload)
        if section == "ai":
            # 凭据引用要在完整性校验之前落进草稿：一次提交里同时给出地址、模型和
            # 新密钥是正常流程，先校验再合并会把这次提交误判成「缺 API Key」。
            merged = self._merge_ai(payload["ai"], patch, credential_refs)
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
        # 版本是自动打标判断在途结果是否过期的唯一依据：只在当前生效的识别配置
        # 真的变了才推进。优先级别名、提醒参数、另一种暂未使用的 API 都不动它。
        next_version = None if _recognition_fingerprint(payload) != fingerprint else version
        record = self.store.save(payload, version=next_version)
        result = self.snapshot()
        result["savedVersion"] = record["version"]
        return result

    def _merge_ai(self, current, patch, credential_refs=None):
        """只合并连接参数：接口地址、模型标识与凭据引用。

        允许保存尚未补齐的参数——填一半也要存得住，否则用户得先把另一类
        API 配完才能保存这一类。缺项在快照里如实标成「未配置完整」。
        """
        if set(patch) - {"providers"}:
            _fail("包含不支持的 AI API 配置字段")
        providers = patch.get("providers")
        if not isinstance(providers, dict) or not providers:
            _fail("AI API 配置格式无效", "field", "providers")
        if set(providers) - set(MODES):
            _fail("包含不支持的识别方式", "field", "providers")
        merged = copy.deepcopy(current)
        for mode, fields in providers.items():
            if not isinstance(fields, dict) or set(fields) - {"endpoint", "model"}:
                # 密钥字段永远不接受：密钥只能经凭据引用提交。
                _fail("包含不支持的识别配置字段", "field", "providers")
            target = merged["providers"][mode]
            if "endpoint" in fields:
                target["endpoint"] = _validate_endpoint(fields["endpoint"], mode + ".endpoint")
            if "model" in fields:
                target["model"] = _validate_model(fields["model"], mode + ".model")
        # 凭据引用由 Main 在写入受保护密钥之后给出；引用缺失说明这一版不换密钥。
        merged = self._apply_references(merged, credential_refs, "ai")
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
        """只合并识别策略：开关与方式。连接参数不在这里改。

        API 不完整时不能开启，也不能把已开启的识别切到跑不起来的方式：
        保存策略时若目标方式缺参数，要说清缺什么，而不是存下一个坏状态。
        """
        if set(patch) - {"enabled", "mode"}:
            _fail("包含不支持的自动打标字段")
        merged = copy.deepcopy(current)
        if "enabled" in patch:
            if not isinstance(patch["enabled"], bool):
                _fail("自动打标开关无效", "field", "enabled")
            merged["enabled"] = patch["enabled"]
        if "mode" in patch:
            if patch["mode"] not in MODES:
                _fail("识别方式无效", "field", "mode")
            merged["mode"] = patch["mode"]
        if merged["enabled"] and merged["enabledSince"] is None:
            # 记录生效边界：只覆盖此后首次保存的内容，关闭期间收录的需主动补打。
            merged["enabledSince"] = now()
        if not merged["enabled"]:
            merged["enabledSince"] = None
        if merged["enabled"]:
            missing = _missing_provider_items(providers[merged["mode"]])
            if missing:
                names = {"jev": "Jev 已有标签分类", "llm": "LLM 自由生成标签"}
                name = names[merged["mode"]]
                if current["enabled"]:
                    # 已经开启时切到另一种方式：不是「打不开」，而是「切过去就会坏」，
                    # 错误要说清是切换，否则用户会以为是开关本身坏了。
                    _fail("自动打标已开启，切换到「%s」前请先补齐该方式的%s" % (name, "、".join(missing)))
                _fail("开启自动打标前，请先完成「%s」的%s" % (name, "、".join(missing)))
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
        for mode, reference in credential_refs.items():
            if mode not in MODES:
                _fail("凭据引用对应的识别方式无效")
            merged["providers"][mode]["credentialRef"] = _validate_reference(reference, "credentialRefs")
        return merged
