"""M45 付费渠道脱敏样本。

这些样本只保留协议结构，字段值全部是构造出来的假数据：
不含任何真实密钥、真实公众号身份或真实文章地址。
测试用它们离线复现协议行为（成功、业务失败、超时、坏数据、余额文案）。
"""

from __future__ import annotations

#: 公众号信息（getinfo 成功）。字段值是脱敏假数据。
ACCOUNT_OK = {
    "code": 0,
    "msg": "获取成功",
    "data": {
        "user_name": "gh_demo0001",
        "name": "示例公众号",
        "avatar": "https://mmbiz.qpic.cn/demo/avatar",
        "description": "用于离线复现协议的示例账号",
    },
}

#: 公众号信息（getinfo 成功但 data 缺稳定 ID）：属于「坏数据」。
#: 上游仍然回了 code=0，因此这一次调用已经产生费用，必须按已确认消费记账。
ACCOUNT_BAD_DATA = {
    "code": 0,
    "msg": "获取成功",
    "data": {"name": "缺少稳定 ID 的示例"},
}

#: 密钥无效或积分不足。服务端明确拒绝，未产生消费。
ACCOUNT_KEY_INVALID = {
    "code": 1000,
    "msg": "key无效或积分不足",
    "data": None,
}

#: 上游超时。服务端明确答复失败，未产生消费。
ACCOUNT_TIMEOUT = {
    "code": 1005,
    "msg": "服务超时",
    "data": None,
}

#: 文章列表（getps 成功），含一条正常文章与一条坏地址文章。
LIST_OK = {
    "code": 0,
    "msg": "获取成功，剩余120积分",
    "data": {
        "wxid": "gh_demo0001",
        "cursor": "cursor-2",
        "list": [
            {
                "url": "https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid=1000000001&idx=1&sn=demotoken0001",
                "title": "示例文章一",
                "pub_time": "2026-10-20 09:30:00",
                "cover": "https://mmbiz.qpic.cn/demo/cover-1",
            },
            {
                "url": "https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid=1000000001&idx=2&sn=demotoken0002",
                "title": "示例文章二",
                "pub_time": 1792000000,
                "cover": "https://mmbiz.qpic.cn/demo/cover-2",
            },
        ],
    },
}

#: 文章列表（getps 成功但地址不是官方域名）：属于「坏数据」。
#: code=0 仍然成立，这一次调用已经产生费用。
LIST_BAD_DATA = {
    "code": 0,
    "msg": "获取成功",
    "data": {
        "wxid": "gh_demo0001",
        "cursor": None,
        "list": [{"url": "https://example.invalid/article/1", "title": "非法地址"}],
    },
}

#: 文章列表末页：空列表，是「服务端当前数据集已扫完」的终止证据。
LIST_EMPTY = {
    "code": 0,
    "msg": "获取成功",
    "data": {"wxid": "gh_demo0001", "cursor": None, "list": []},
}

#: 文章列表业务失败：密钥无效。
LIST_KEY_INVALID = {
    "code": 1000,
    "msg": "key无效或积分不足",
    "data": None,
}
