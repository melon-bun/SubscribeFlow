"""M15 应用设置服务。

职责边界：
- 只处理非敏感配置。密钥由 Main 的凭据服务保管，这里只保存凭据引用，
  因此这个类无论被谁调用都不可能返回或保存明文密钥。
- 按页保存：一次只提交一个分区（AI 模型配置 / 提醒设置），
  避免修改提醒参数时顺手把另一页没填完的 API 配置一起存进去（§2.1）。
- 每次保存递增配置版本。自动打标与提醒都以这个版本判断自己是否过期。
"""

import copy
import re
from urllib.parse import urlparse

from subscribe_flow.contracts import ChannelError
from subscribe_flow.storage.repositories import now

MODES = ("jev", "llm")
SECTIONS = ("tagging", "reminder")

INTERVAL_PRESETS = (15, 30, 60, 120)
INTERVAL_MIN = 5
INTERVAL_MAX = 1440
DEFAULT_INTERVAL = 60

# 初始设置含官方默认值；用户明确清空后仍保留空值，不在界面偷偷恢复。
OFFICIAL_DEFAULTS = {
    "jev": {"endpoint": "https://api.typesafe.ai/v1/systemone", "model": "jev-latest"},
}

REFERENCE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
MODEL_PATTERN = re.compile(r"^[^\s\x00-\x1f\x7f]{1,256}$")

DEFAULTS = {
    "tagging": {
        "enabled": False,
        "mode": "llm",
        "enabledSince": None,
        "providers": {
            "jev": {**OFFICIAL_DEFAULTS["jev"], "credentialRef": None},
            "llm": {"endpoint": "", "model": "", "credentialRef": None},
        },
    },
    "reminder": {"enabled": False, "intervalMinutes": DEFAULT_INTERVAL},
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


def _missing_provider_items(provider):
    return [label for key, label in (("endpoint", "接口地址"), ("model", "模型标识"), ("credentialRef", "API Key"))
            if not provider.get(key)]


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
                if key not in payload[section] or key == "providers":
                    continue
                payload[section][key] = value
            if section == "tagging":
                providers = stored_section.get("providers") or {}
                for mode in MODES:
                    if isinstance(providers.get(mode), dict):
                        payload["tagging"]["providers"][mode].update(
                            {k: v for k, v in providers[mode].items() if k in payload["tagging"]["providers"][mode]})
        return record["version"], record["updatedAt"], payload

    def snapshot(self):
        version, updated_at, payload = self._current()
        providers = {}
        for mode in MODES:
            provider = payload["tagging"]["providers"][mode]
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
            "version": version,
            "updatedAt": updated_at,
            "tagging": {"enabled": payload["tagging"]["enabled"], "mode": payload["tagging"]["mode"],
                        "enabledSince": payload["tagging"]["enabledSince"], "providers": providers},
            "reminder": {"enabled": payload["reminder"]["enabled"], "intervalMinutes": interval,
                         "preset": str(interval) if interval in INTERVAL_PRESETS else "custom"},
        }

    # ------------------------------------------------------------ 保存

    def update(self, section, patch, credential_refs=None):
        if section not in SECTIONS:
            _fail("未知的设置分区")
        if not isinstance(patch, dict) or not patch:
            _fail("没有需要保存的修改")
        _, _, payload = self._current()
        if section == "tagging":
            # 凭据引用要在完整性校验之前落进草稿：一次提交里同时给出地址、模型和
            # 新密钥是正常流程，先校验再合并会把这次提交误判成「缺 API Key」。
            merged = self._merge_tagging(payload["tagging"], patch, credential_refs)
        else:
            if credential_refs:
                _fail("提醒设置不接受凭据引用")
            merged = self._merge_reminder(payload["reminder"], patch)
        payload[section] = merged
        record = self.store.save(payload)
        result = self.snapshot()
        result["savedVersion"] = record["version"]
        return result

    def _merge_tagging(self, current, patch, credential_refs=None):
        if set(patch) - {"enabled", "mode", "providers"}:
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
        providers = patch.get("providers")
        if providers is not None:
            if not isinstance(providers, dict) or set(providers) - set(MODES):
                _fail("包含不支持的识别方式")
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
        merged = self._apply_references(merged, credential_refs, "tagging")
        if merged["enabled"] and merged["enabledSince"] is None:
            # 记录生效边界：只覆盖此后首次保存的内容，关闭期间收录的需主动补打。
            merged["enabledSince"] = now()
        if not merged["enabled"]:
            merged["enabledSince"] = None
        if merged["enabled"]:
            missing = _missing_provider_items(merged["providers"][merged["mode"]])
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
        if section != "tagging" and credential_refs:
            _fail("提醒设置不接受凭据引用")
        for mode, reference in credential_refs.items():
            if mode not in MODES:
                _fail("凭据引用对应的识别方式无效")
            merged["providers"][mode]["credentialRef"] = _validate_reference(reference, "credentialRefs")
        return merged
