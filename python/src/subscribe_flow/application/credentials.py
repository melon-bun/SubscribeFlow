"""M15 桌面凭据桥接的 Core 侧容器。

主进程把已经加密保存的密钥按「引用」推进来，Core 只在内存里留一份，
供自动打标调用模型时取用：

- 不落库、不进日志、不经过 Renderer，也拿不到「读出所有密钥」的接口；
- Core 重启即全部丢失，主进程在 Core 就绪后按设置里的引用重新推送；
- 撤销引用后立即不可取用，配置换密钥时不会继续用旧值。

真正的加密、落盘与保护能力检查都在 Main 的 credentials.cjs，这里不做也不该做。
"""

from subscribe_flow.contracts import ChannelError


class CredentialBroker:
    LIMIT = 8

    def __init__(self, limit=LIMIT):
        self._secrets = {}
        self._limit = limit

    def provide(self, reference, secret):
        if not isinstance(reference, str) or not reference or len(reference) > 64:
            raise ChannelError("INVALID_INPUT", "credential.provide", "凭据引用无效")
        if not isinstance(secret, str) or not secret or len(secret) > 4000:
            raise ChannelError("INVALID_INPUT", "credential.provide", "凭据内容无效")
        # 重复推送同一引用时先删后插，让它排到队尾，裁剪时保留的是最近使用的。
        self._secrets.pop(reference, None)
        self._secrets[reference] = secret
        while len(self._secrets) > self._limit:
            del self._secrets[next(iter(self._secrets))]

    def revoke(self, reference):
        if not isinstance(reference, str) or not reference:
            raise ChannelError("INVALID_INPUT", "credential.revoke", "凭据引用无效")
        self._secrets.pop(reference, None)
        return {"revoked": True}

    def clear(self):
        self._secrets.clear()

    def secret_for(self, reference):
        """供自动打标调用模型时取用；引用不存在一律返回 None，不抛错也不猜。"""
        return self._secrets.get(reference) if isinstance(reference, str) else None

    def references(self):
        return sorted(self._secrets)
