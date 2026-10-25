"""M45 付费渠道脱敏样本。

这些样本只保留协议结构，字段值全部是构造出来的假数据：
不含任何真实密钥、真实公众号身份或真实文章地址。
测试用它们离线复现协议行为（成功、业务失败、超时、坏数据、余额文案）。

字段名与真实上游一致（2026-10-25 用真实样本核对）：
``getinfo`` 返 ``name``／``user_name``／``signature``／``hd_head_img``，
``getps`` 返 ``list[]``／``wxid``／``cursor``，
列表项是 ``art_url``／``title``／``pub_time``／``pic_url``／``sn``，
而且 ``art_url`` 是 http 且参数之间用 ``&amp;`` 分隔。
"""

from __future__ import annotations

#: 公众号信息（getinfo 成功）。字段值是脱敏假数据。
ACCOUNT_OK = {
    "code": 0,
    "msg": "获取成功",
    "data": {
        "name": "示例公众号",
        "user_name": "gh_demo0001",
        "signature": "用于离线复现协议的示例账号",
        # 真实上游的头像是 http：解析层要统一升成 https。
        "hd_head_img": "http://mmbiz.qpic.cn/demo/avatar",
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

#: 文章列表（getps 成功），含一条头条文章与一条同推送的副条。
#: 真实上游的 art_url 是 http 且参数之间是 ``&amp;``；
#: 不解一层实体就取不到 mid／idx，整页会被误判成结构变化。
LIST_OK = {
    "code": 0,
    "msg": "获取成功，剩余120积分",
    "data": {
        "wxid": "gh_demo0001",
        "cursor": "cursor-2",
        "list": [
            {
                "art_url": ("http://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng=="
                            "&amp;mid=1000000001&amp;idx=1&amp;sn=demotoken0001"),
                "title": "示例文章一",
                "pub_time": "2026-10-20 09:30:00",
                "pic_url": "http://mmbiz.qpic.cn/demo/cover-1",
                "sn": "demotoken0001",
            },
            {
                "art_url": ("http://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng=="
                            "&amp;mid=1000000001&amp;idx=2&amp;sn=demotoken0002"),
                "title": "示例文章二",
                "pub_time": 1792000000,
                "pic_url": "http://mmbiz.qpic.cn/demo/cover-2",
                "sn": "demotoken0002",
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
