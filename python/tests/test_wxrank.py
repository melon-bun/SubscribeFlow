"""M45 付费渠道：契约冻结、计费账本、解析缓存与单页入库。

全部离线：传输层换成假传输，因此「没有发请求」是可证明的，
也保证本文件不会产生任何真实费用。

覆盖三批里的前两批能力：
- M45.1 协议契约：biz 归一、身份派生、响应形状、计费口径；
- M45.2 账本与缓存：迁移、已确认／未确认扣费、崩溃遗留、缓存跨重启；
- M45.3 业务层与适配器：解析→确认添加→单页入库、并发合并、限流互斥。
"""

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.bootstrap import Core, resource_key
from subscribe_flow.channels.wxrank import fixtures, protocol
from subscribe_flow.channels.wxrank.transport import WxrankResponse
from subscribe_flow.contracts import ChannelError

BIZ = "MzI4NTEyMzQ1Ng=="
BIZ_PADDED = "MzI4NTEyMzQ1Ng=="
CONNECTION = "wxrank:default"
REFERENCE = "channel-wxrank-test"


def response(document):
    return WxrankResponse(document["code"], document.get("msg") or "", document.get("data"))


class FakeTransport:
    """离线替身：记录每一次请求，因此「没有付费调用」可以被断言。"""

    def __init__(self, info=None, listing=None, fail=None):
        self.info = info if info is not None else response(fixtures.ACCOUNT_OK)
        self.listing = listing if listing is not None else response(fixtures.LIST_OK)
        self.fail = fail
        self.requests = []

    async def post(self, path, payload, context, operation):
        context.check(operation)
        self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
        if self.fail is not None:
            raise self.fail
        return self.info if path == protocol.PATH_INFO else self.listing

    @property
    def calls(self):
        return len(self.requests)


class WxrankTestCase(unittest.IsolatedAsyncioTestCase):
    transport = None

    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "core.db"
        self.transport = self.make_transport()
        self.core = self.make_core()
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": REFERENCE})
        self.core.credentials.provide(REFERENCE, "test-secret")

    def make_transport(self):
        return FakeTransport()

    def make_core(self):
        return Core(self.path, paid_transport=self.transport,
                    schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0),
                    clock=lambda: 1000000.)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    def attempts(self):
        return self.core.repository.paid_channels.list_attempts(channel=protocol.CHANNEL, limit=50)


# ---------------------------------------------------------------------------
# M45.1 契约冻结
# ---------------------------------------------------------------------------
class ContractTests(unittest.TestCase):
    def test_biz_padding_is_normalised_to_the_canonical_form(self):
        # 0／1／2 个填充与缺填充都要归一成同一串。
        self.assertEqual(protocol.normalize_biz("AAAA"), "AAAA")
        self.assertEqual(protocol.normalize_biz("AAAAAA"), "AAAAAA==")
        self.assertEqual(protocol.normalize_biz("AAAAAAA"), "AAAAAAA=")
        self.assertEqual(protocol.normalize_biz("AAAAAA=="), "AAAAAA==")
        self.assertEqual(protocol.normalize_biz("AAAAAAA="), "AAAAAAA=")
        self.assertEqual(protocol.normalize_biz("  AAAAAA  "), "AAAAAA==")

    def test_biz_forms_that_cannot_be_base64_are_rejected(self):
        for value in ("", "A", "AAAAA", "AAAAAA===", "not base64!", "中文", "AAA=AAA", None, 5):
            with self.assertRaises(ValueError, msg=repr(value)):
                protocol.normalize_biz(value)

    def test_urlsafe_alphabet_is_accepted_and_normalised(self):
        # '-' 与 '_' 是 base64 的 url-safe 变体，归一后仍是同一串。
        raw = b"\xfb\xff\xfe"
        standard = protocol.normalize_biz(__import__("base64").b64encode(raw).decode())
        urlsafe = __import__("base64").urlsafe_b64encode(raw).decode().rstrip("=")
        self.assertEqual(protocol.normalize_biz(urlsafe), standard)

    def test_the_same_account_always_yields_one_biz_and_one_source_url(self):
        canonical = protocol.normalize_biz(BIZ)
        self.assertEqual(protocol.extract_biz(BIZ), canonical)
        self.assertEqual(protocol.extract_biz(canonical), canonical)
        self.assertEqual(protocol.extract_biz(protocol.source_url(canonical)), canonical)
        article = ("https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid=1000000001&idx=1&sn=x")
        self.assertEqual(protocol.extract_biz(article), canonical)
        self.assertEqual(protocol.source_url(canonical), protocol.source_url(BIZ))

    def test_content_identity_comes_from_the_validated_article_url(self):
        url = ("https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid=1000000001&idx=2&sn=x")
        biz, mid, idx = protocol.article_identity(url)
        self.assertEqual((biz, mid, idx), (protocol.normalize_biz(BIZ), "1000000001", "2"))
        self.assertEqual(protocol.content_key(biz, mid, idx),
                         f"wxrank:article:{protocol.normalize_biz(BIZ)}_1000000001_2")

    def test_article_url_is_normalised_but_keeps_its_query(self):
        url = "http://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D&mid=1&idx=1&sn=keep#frag"
        normalised = protocol.normalize_article_url(url)
        self.assertTrue(normalised.startswith("https://mp.weixin.qq.com/s?"))
        self.assertIn("sn=keep", normalised)
        self.assertNotIn("#frag", normalised)

    def test_non_official_article_links_are_rejected(self):
        for url in ("https://example.invalid/a", "https://evil-mp.weixin.qq.com.evil/s?__biz=x&mid=1&idx=1",
                    "ftp://mp.weixin.qq.com/s"):
            with self.assertRaises(ValueError, msg=url):
                protocol.normalize_article_url(url)

    def test_published_time_uses_shanghai_and_keeps_its_precision(self):
        second = protocol.published_time("2026-10-20 09:30:00")
        self.assertEqual(second.precision, "second")
        self.assertEqual(second.timezone, "Asia/Shanghai")
        self.assertTrue(second.value.startswith("2026-10-20T09:30:00"))
        self.assertEqual(protocol.published_time("2026-10-20").precision, "date")
        self.assertEqual(protocol.published_time(None).precision, "unknown")
        self.assertIsNone(protocol.published_time("上周").value)

    def test_business_codes_map_to_stable_errors(self):
        code, message, retryable = protocol.error_for_code(protocol.CODE_KEY_INVALID, "")
        self.assertEqual(code, "AUTH_REQUIRED")
        self.assertFalse(retryable)
        code, message, retryable = protocol.error_for_code(protocol.CODE_TIMEOUT, "")
        self.assertEqual(code, "DEPENDENCY_UNAVAILABLE")
        self.assertFalse(retryable, "上游已经答复过，重试只会再花钱")

    def test_balance_is_observed_from_the_message_not_invented(self):
        self.assertEqual(protocol.parse_balance("获取成功，剩余120积分"), 120)
        self.assertIsNone(protocol.parse_balance("获取成功"))
        self.assertIsNone(protocol.parse_balance(None))


# ---------------------------------------------------------------------------
# M45.2 账本、设置与缓存
# ---------------------------------------------------------------------------
class LedgerTests(WxrankTestCase):
    async def test_migration_creates_the_paid_channel_tables(self):
        names = {row[0] for row in self.core.repository.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertIn("paid_channel_attempts", names)
        self.assertIn("paid_channel_sources", names)
        self.assertIn("paid_channel_checkpoints", names)

    async def test_a_successful_call_is_recorded_as_confirmed_consumption(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        rows = self.attempts()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["charge_state"], "confirmed")
        self.assertEqual(rows[0]["confirmed_credits"], protocol.CREDITS_PER_CALL)
        self.assertEqual(rows[0]["status"], "succeeded")

    async def test_the_ledger_never_stores_the_key(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        blob = repr(self.attempts())
        self.assertNotIn("test-secret", blob)
        request = self.transport.requests[0]
        self.assertEqual(request["payload"]["key"], "test-secret")
        self.assertNotIn("test-secret", request["path"])

    async def test_a_business_failure_is_recorded_as_not_charged(self):
        self.transport.info = response(fixtures.ACCOUNT_KEY_INVALID)
        with self.assertRaises(ChannelError) as raised:
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(raised.exception.code, "AUTH_REQUIRED")
        rows = self.attempts()
        self.assertEqual(rows[0]["charge_state"], "not_charged")
        self.assertEqual(rows[0]["confirmed_credits"], 0)

    async def test_code_zero_with_broken_data_is_still_a_confirmed_charge(self):
        # code=0 已经产生了费用，即使数据是坏的也不能记成零消费。
        self.transport.info = response(fixtures.ACCOUNT_BAD_DATA)
        with self.assertRaises(ChannelError) as raised:
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(raised.exception.code, "SCHEMA_CHANGED")
        rows = self.attempts()
        self.assertEqual(rows[0]["charge_state"], "confirmed")
        self.assertEqual(rows[0]["confirmed_credits"], protocol.CREDITS_PER_CALL)

    async def test_an_unresolved_request_is_never_reported_as_zero_consumption(self):
        self.transport.fail = ChannelError("TIMEOUT", "resolve_source", "上游请求超时，扣费结果未知")
        with self.assertRaises(ChannelError):
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        rows = self.attempts()
        self.assertEqual(rows[0]["charge_state"], "unknown")
        self.assertEqual(rows[0]["confirmed_credits"], 0)

    async def test_a_cancelled_request_is_unknown_when_it_was_already_sent(self):
        self.transport.fail = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        rows = self.attempts()
        self.assertEqual(rows[0]["charge_state"], "unknown")

    async def test_pending_attempts_from_a_previous_run_become_unknown(self):
        self.core.repository.paid_channels.begin_attempt(
            channel=protocol.CHANNEL, operation="list_items", credential_version=1)
        self.assertEqual(self.core.repository.paid_channels.recover_pending(), 1)
        rows = self.attempts()
        self.assertEqual(rows[0]["charge_state"], "unknown")
        self.assertEqual(rows[0]["status"], "unknown")

    async def test_the_month_summary_separates_confirmed_and_unknown(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        # 另一个公众号：解析缓存不命中，才会真的再发一次付费请求。
        other = protocol.normalize_biz("AAAAAAAAAAAAAAAAAAAAAA==")
        self.transport.fail = ChannelError("TIMEOUT", "resolve_source", "上游请求超时，扣费结果未知")
        with self.assertRaises(ChannelError):
            await self.core.subscriptions.resolve(other, CONNECTION)
        summary = self.core.paid_channels.usage()
        self.assertEqual(summary["confirmed_credits"], protocol.CREDITS_PER_CALL)
        self.assertEqual(summary["unknown_count"], 1)
        self.assertEqual(summary["calls"], 2)
        self.assertTrue(summary["configured"])

    async def test_a_new_key_never_inherits_the_old_key_balance(self):
        self.transport.info = WxrankResponse(0, "获取成功，剩余120积分", fixtures.ACCOUNT_OK["data"])
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        first = self.core.paid_channels.usage()
        self.assertEqual(first["balance"], 120)
        # 换一把密钥：调用版本前进，旧余额不得冒充新密钥的余额。
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-second"})
        second = self.core.paid_channels.usage()
        self.assertGreater(second["credentialVersion"], first["credentialVersion"])
        self.assertIsNone(second["balance"])


# ---------------------------------------------------------------------------
# 设置分区
# ---------------------------------------------------------------------------
class ChannelSettingsTests(WxrankTestCase):
    def test_the_channel_section_survives_a_restart(self):
        snapshot = self.core.settings.snapshot()
        self.assertIn("wxrank", snapshot["channels"])
        self.assertTrue(snapshot["channels"]["wxrank"]["configured"])
        self.assertEqual(snapshot["channels"]["wxrank"]["revision"], 2)

    def test_the_channel_section_has_no_budget_field(self):
        snapshot = self.core.settings.snapshot()
        self.assertEqual(set(snapshot["channels"]["wxrank"]),
                         {"id", "credentialRef", "revision", "enabled", "configured"})

    def test_unknown_channels_and_budget_fields_are_rejected(self):
        with self.assertRaises(ChannelError):
            self.core.settings.update("channels", {"other": {"enabled": True}})
        with self.assertRaises(ChannelError):
            self.core.settings.update("channels", {"wxrank": {"budget": 100}})
        with self.assertRaises(ChannelError):
            self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                      credential_refs={"other": "ref"})

    def test_changing_the_key_advances_the_call_version(self):
        before = self.core.settings.snapshot()["channels"]["wxrank"]["revision"]
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-other"})
        after = self.core.settings.snapshot()["channels"]["wxrank"]["revision"]
        self.assertEqual(after, before + 1)

    def test_the_ai_section_is_untouched_by_a_channel_save(self):
        before = self.core.settings.snapshot()["ai"]
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-other"})
        self.assertEqual(self.core.settings.snapshot()["ai"], before)


# ---------------------------------------------------------------------------
# M45.3 业务层与适配器
# ---------------------------------------------------------------------------
class ServiceTests(WxrankTestCase):
    async def test_the_adapter_declares_exactly_the_supported_operations(self):
        descriptor = self.core.gateway.describe()
        wxrank = [d for d in descriptor if d.channel == protocol.CHANNEL]
        self.assertEqual(len(wxrank), 1)
        self.assertEqual(wxrank[0].backend, "paid-http")
        self.assertEqual(resource_key(wxrank[0]), "http:wxrank")
        operations = wxrank[0].operations
        self.assertTrue(operations["resolve_source"].supported)
        self.assertTrue(operations["list_items"].supported)
        for name in ("search_sources", "get_item_detail", "match_item_url", "resolve_item", "read_item"):
            self.assertFalse(operations[name].supported, name)

    async def test_the_check_makes_no_network_request(self):
        readiness = await self.core.check_connection(CONNECTION, "list_items")
        self.assertEqual(readiness.state, "ready")
        self.assertEqual(self.transport.calls, 0)

    async def test_the_check_reports_a_missing_key_without_touching_the_network(self):
        self.core.credentials.clear()
        readiness = await self.core.check_connection(CONNECTION, "list_items")
        self.assertEqual(readiness.state, "blocked")
        self.assertEqual(self.transport.calls, 0)

    async def test_resolve_then_confirm_add_charges_only_once(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 1)
        self.assertEqual(source.key, "wxrank:account:gh_demo0001")
        # 确认添加时界面传回来源地址；命中缓存，不再产生付费调用。
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        self.assertEqual(self.transport.calls, 1, "确认添加不得再次扣费")
        self.assertEqual(subscription["source_id"], source.key)

    async def test_the_cache_survives_a_core_restart(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 1)
        await self.core.close()
        self.core = self.make_core()
        self.core.credentials.provide(REFERENCE, "test-secret")
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 1, "重启后必须复用缓存，不得再付费")
        self.assertEqual(source.key, "wxrank:account:gh_demo0001")

    async def test_concurrent_resolutions_of_one_account_issue_one_request(self):
        results = await asyncio.gather(*[self.core.subscriptions.resolve(BIZ, CONNECTION)
                                         for _ in range(4)])
        self.assertEqual(self.transport.calls, 1, "同一个 biz 的并发解析必须合并成一次请求")
        self.assertEqual({source.key for source in results}, {"wxrank:account:gh_demo0001"})

    async def test_one_page_is_collected_into_the_database(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        self.assertEqual(self.core.queries.contents()["total"], 2)
        rows = self.core.repository.db.execute(
            "SELECT id,channel,namespace FROM contents ORDER BY id").fetchall()
        self.assertEqual({row["channel"] for row in rows}, {"wxrank"})
        self.assertEqual({row["namespace"] for row in rows}, {"article"})
        # 一次解析 + 一页列表 = 两次付费调用。
        self.assertEqual(self.transport.calls, 2)

    async def test_the_cached_resolution_means_a_second_refresh_only_pays_for_the_page(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        for _ in range(2):
            job = self.core.sync.start(subscription["id"], mode="refresh")
            await self.core.sync.wait(job["job_id"])
        self.assertEqual(self.transport.calls, 3, "两次刷新各付一次列表费，解析不再重复付费")
        self.assertEqual(self.core.queries.contents()["total"], 2)

    async def test_the_empty_page_is_terminal_evidence(self):
        self.transport.listing = response(fixtures.LIST_EMPTY)
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        self.assertEqual(finished["coverage"], "history_end")
        self.assertEqual(finished["end_evidence"], "empty_list")

    async def test_broken_list_data_is_a_schema_change_but_the_page_was_charged(self):
        self.transport.listing = response(fixtures.LIST_BAD_DATA)
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "failed")
        rows = [row for row in self.attempts() if row["operation"] == "list_items"]
        self.assertEqual(rows[0]["charge_state"], "confirmed")
        self.assertEqual(rows[0]["confirmed_credits"], protocol.CREDITS_PER_CALL)

    async def test_clearing_the_cache_forces_a_new_paid_resolution(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 1)
        cleared = self.core.paid_channels.clear_cache()
        self.assertEqual(cleared["cleared"], 1)
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 2)

    async def test_the_explicit_paid_test_always_costs_one_call(self):
        result = await self.core.paid_channels.test(BIZ, CONNECTION)
        self.assertEqual(result["credits"], protocol.CREDITS_PER_CALL)
        self.assertEqual(self.transport.calls, 1)
        # 再测一次仍然要付费：显式测试不走缓存。
        await self.core.paid_channels.test(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 2)

    async def test_a_missing_key_blocks_paid_calls_before_any_request(self):
        self.core.credentials.clear()
        with self.assertRaises(ChannelError) as raised:
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(raised.exception.code, "NOT_CONFIGURED")
        self.assertEqual(self.transport.calls, 0)
        self.assertEqual(self.attempts(), [], "没有发出去的调用不应记账为已消费")

    async def test_paid_calls_are_serialised_by_the_shared_resource_key(self):
        from subscribe_flow.contracts import Connection, Context
        context = Context(Connection(CONNECTION, protocol.CHANNEL, "paid-http", "http:wxrank"),
                          "job", time.monotonic() + 30)
        service = self.core.paid
        stamps = []

        async def call():
            await service._paid_request(operation="paid_test", path=protocol.PATH_INFO,
                                         fields={"biz": BIZ}, context=context)
            stamps.append(time.monotonic())

        await asyncio.gather(call(), call())
        self.assertEqual(len(stamps), 2)
        self.assertGreaterEqual(stamps[1] - stamps[0], service.min_interval * 0.9)

    async def test_two_different_accounts_use_one_account_free_cache_each(self):
        other = protocol.normalize_biz("AAAAAAAAAAAAAAAAAAAAAA==")
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        await self.core.subscriptions.resolve(other, CONNECTION)
        self.assertEqual(self.transport.calls, 2)
        self.assertEqual(self.core.repository.paid_channels.count_source_cache(), 2)


# ---------------------------------------------------------------------------
# 凭据互不破坏
# ---------------------------------------------------------------------------
class CredentialIsolationTests(WxrankTestCase):
    async def test_replacing_the_channel_key_keeps_the_ai_settings_intact(self):
        before = self.core.settings.snapshot()["ai"]
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-replaced"})
        self.assertEqual(self.core.settings.snapshot()["ai"], before)

    async def test_a_core_restart_does_not_break_the_ai_credentials(self):
        self.core.credentials.provide("provider-llm", "ai-secret")
        await self.core.close()
        self.core = self.make_core()
        self.core.credentials.provide("provider-llm", "ai-secret")
        self.core.credentials.provide(REFERENCE, "test-secret")
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(source.key, "wxrank:account:gh_demo0001")
        self.assertEqual(self.core.credentials.secret_for("provider-llm"), "ai-secret")

    async def test_changing_the_channel_key_advances_the_version_but_keeps_the_old_ledger(self):
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        before = self.core.paid_channels.usage()
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-next"})
        after = self.core.paid_channels.usage()
        self.assertEqual(after["confirmed_credits"], before["confirmed_credits"])
        self.assertGreater(after["credentialVersion"], before["credentialVersion"])


class PagedTransport(FakeTransport):
    """按游标分页的假传输：每页 10 条，最后一页为空（终止证据）。"""

    def __init__(self, pages=3, items=10):
        super().__init__()
        self.pages = pages
        self.items = items

    async def post(self, path, payload, context, operation):
        context.check(operation)
        self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
        if self.fail is not None:
            raise self.fail
        if path == protocol.PATH_INFO:
            return self.info
        cursor = payload.get("cursor")
        page = 1 if not cursor else int(str(cursor).split("-")[-1])
        rows = [{
            "url": (f"https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D"
                    f"&mid={1000000000 + page * 100 + index}&idx=1&sn=demo{page}{index}"),
            "title": f"示例文章 {page}-{index + 1}",
            "pub_time": "2026-10-20 09:30:00",
        } for index in range(self.items)] if page < self.pages else []
        next_cursor = f"page-{page + 1}" if page < self.pages else None
        return WxrankResponse(0, "获取成功，剩余120积分",
                              {"wxid": "gh_demo0001", "cursor": next_cursor, "list": rows})


class WidePagedTransport(PagedTransport):
    """宽付费页：一次调用买下 16 篇（两次推送各 8 篇）。

    头条 idx=1，同一次推送的副条 idx=2..8 共享同一个 mid——副条必须一起保存。
    """

    def __init__(self, pages=3, pushes=2, articles=8):
        super().__init__(pages=pages, items=0)
        self.pushes = pushes
        self.articles = articles

    async def post(self, path, payload, context, operation):
        context.check(operation)
        self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
        if self.fail is not None:
            raise self.fail
        if path == protocol.PATH_INFO:
            return self.info
        cursor = payload.get("cursor")
        page = 1 if not cursor else int(str(cursor).split("-")[-1])
        rows = []
        if page < self.pages:
            for push in range(self.pushes):
                mid = 1000000000 + page * 100 + push
                for index in range(self.articles):
                    rows.append({
                        "url": (f"https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D"
                                f"&mid={mid}&idx={index + 1}&sn=wide{page}{push}{index}"),
                        "title": f"宽页文章 {page}-{push + 1}-{index + 1}",
                        "pub_time": "2026-10-20 09:30:00",
                    })
        next_cursor = f"page-{page + 1}" if page < self.pages else None
        return WxrankResponse(0, "获取成功，剩余120积分",
                              {"wxid": "gh_demo0001", "cursor": next_cursor, "list": rows})


# ---------------------------------------------------------------------------
# BUG-129：上游答复的身份必须与当前来源一致
# ---------------------------------------------------------------------------
class IdentityTests(WxrankTestCase):
    async def test_a_response_for_another_account_is_rejected_whole(self):
        # 上游把别的公众号（gh_other0001）的文章发了过来。
        self.transport = PagedTransport(pages=1)
        self.transport.info = response(fixtures.ACCOUNT_OK)
        self.core.paid.transport = self.transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        # 让列表返回别的账号。
        original = self.transport.post

        async def mismatched(path, payload, context, operation):
            if path == protocol.PATH_LIST:
                self.transport.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                return WxrankResponse(0, "获取成功", {
                    "wxid": "gh_other0001", "cursor": None,
                    "list": [{"url": ("https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D"
                                      "&mid=1000000001&idx=1&sn=x"), "title": "串来源"}]})
            return await original(path, payload, context, operation)

        self.transport.post = mismatched
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "failed")
        self.assertEqual(finished["error"]["code"], "INVALID_RESULT")
        # 错来源的文章一条都不能入库。
        self.assertEqual(self.core.queries.contents()["total"], 0)
        # 但这一次调用已经 code=0，费用照记。
        rows = [row for row in self.attempts() if row["operation"] == "list_items"]
        self.assertEqual(rows[0]["charge_state"], "confirmed")
        self.assertEqual(rows[0]["confirmed_credits"], protocol.CREDITS_PER_CALL)

    async def test_an_article_of_another_biz_is_rejected_whole(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        original = self.transport.post

        async def mismatched(path, payload, context, operation):
            if path == protocol.PATH_LIST:
                self.transport.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                return WxrankResponse(0, "获取成功", {
                    "wxid": "gh_demo0001", "cursor": None,
                    "list": [{"url": ("https://mp.weixin.qq.com/s?__biz=QUJDRA%3D%3D"
                                      "&mid=2000000001&idx=1&sn=x"), "title": "别人的文章"}]})
            return await original(path, payload, context, operation)

        self.transport.post = mismatched
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "failed")
        self.assertEqual(finished["error"]["code"], "INVALID_RESULT")
        self.assertEqual(self.core.queries.contents()["total"], 0)
        rows = [row for row in self.attempts() if row["operation"] == "list_items"]
        self.assertEqual(rows[0]["charge_state"], "confirmed")


# ---------------------------------------------------------------------------
# BUG-130：付费任务的生命周期纳入关闭
# ---------------------------------------------------------------------------
class CloseRaceTests(WxrankTestCase):
    async def test_a_late_response_after_close_does_not_touch_the_closed_database(self):
        release = asyncio.Event()

        class Delayed(FakeTransport):
            async def post(self, path, payload, context, operation):
                context.check(operation)
                self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                await release.wait()
                document = fixtures.ACCOUNT_OK if path == protocol.PATH_INFO else fixtures.LIST_OK
                return response(document)

        transport = Delayed()
        self.core.paid.transport = transport
        pending = asyncio.ensure_future(self.core.subscriptions.resolve(BIZ, CONNECTION))
        await asyncio.sleep(0.05)
        # 关闭：Core 先收束付费任务，再关数据库。
        await self.core.close()
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        # 关库之后不得再写库：不得抛「database has been closed」。
        await asyncio.sleep(0.05)
        # 那次调用留在账本里，重启后按「结果未知」结算，费用可追溯。
        restarted = self.make_core()
        try:
            rows = restarted.repository.paid_channels.list_attempts(
                channel=protocol.CHANNEL, limit=10)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["charge_state"], "unknown")
        finally:
            await restarted.close()

    async def test_no_paid_call_is_accepted_after_close(self):
        await self.core.close()
        with self.assertRaises(Exception):
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 0, "关闭之后不得再发起付费调用")

    async def test_disabling_the_channel_stops_paid_calls(self):
        # 停用必须真的生效：调用被拒，且不产生任何付费请求。
        self.core.settings.update("channels", {"wxrank": {"enabled": False}})
        with self.assertRaises(ChannelError) as raised:
            await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(raised.exception.code, "DEPENDENCY_UNAVAILABLE")
        self.assertEqual(self.transport.calls, 0)
        readiness = await self.core.check_connection(CONNECTION, "list_items")
        self.assertEqual(readiness.state, "blocked")
        # 重新启用后恢复正常。
        self.core.settings.update("channels", {"wxrank": {"enabled": True}})
        await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, 1)


# ---------------------------------------------------------------------------
# M45.4：有界分页、持久检查点与调度策略
# ---------------------------------------------------------------------------
class BackfillTests(WxrankTestCase):
    def make_transport(self):
        return PagedTransport(pages=5)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.core.paid.transport = self.transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)

    async def run_backfill(self, mode="backfill", collect_items=None):
        if collect_items is not None:
            self.core.subscriptions.update(self.subscription["id"], collect_items=collect_items)
        job = self.core.sync.start(self.subscription["id"], mode=mode)
        return await self.core.sync.wait(job["job_id"])

    def checkpoint(self):
        return self.core.repository.paid_channels.checkpoint(
            self.subscription["source_id"], CONNECTION)

    async def test_a_backfill_is_bounded_by_the_page_budget(self):
        finished = await self.run_backfill(collect_items=30)
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        self.assertEqual(finished["pages"], 3)
        self.assertEqual(self.core.queries.contents()["total"], 30)
        # 一次解析 + 三页列表 = 四次付费调用。
        self.assertEqual(self.transport.calls, 4)

    async def test_the_checkpoint_advances_with_the_committed_page(self):
        await self.run_backfill(collect_items=30)
        saved = self.checkpoint()
        self.assertIsNotNone(saved)
        self.assertEqual(json.loads(saved["cursor"])["cursor"], "page-4")

    async def test_a_refresh_also_advances_the_checkpoint(self):
        # 刷新提交的就是头部页：回溯必须从它后面接着走。
        # 否则第一次回溯会把刚采过的头页再买一遍——那是白花的一次钱。
        finished = await self.run_backfill(mode="refresh")
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        saved = self.checkpoint()
        self.assertIsNotNone(saved, "刷新提交成功后必须留下检查点")
        self.assertEqual(json.loads(saved["cursor"])["cursor"], "page-2")
        before = len([row for row in self.transport.requests if row["path"] == protocol.PATH_LIST])
        await self.run_backfill(collect_items=10)
        pages = [row for row in self.transport.requests if row["path"] == protocol.PATH_LIST]
        self.assertEqual(pages[before]["payload"].get("cursor"), "page-2",
                         "回溯必须接着刷新提交的那页走")

    async def test_two_backfills_take_different_pages(self):
        await self.run_backfill(collect_items=30)
        first = self.core.queries.contents()["total"]
        before = len([row for row in self.transport.requests if row["path"] == protocol.PATH_LIST])
        await self.run_backfill(collect_items=30)
        self.assertGreater(self.core.queries.contents()["total"], first)
        pages = [row for row in self.transport.requests if row["path"] == protocol.PATH_LIST]
        # 第二次回溯从上次的位置继续，不重买前三页。
        self.assertEqual(pages[before]["payload"].get("cursor"), "page-4")

    async def test_a_restart_continues_from_the_checkpoint(self):
        await self.run_backfill(collect_items=30)
        calls = self.transport.calls
        await self.core.close()
        self.core = self.make_core()
        self.core.paid.transport = self.transport
        self.core.credentials.provide(REFERENCE, "test-secret")
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.assertEqual(self.transport.calls, calls, "重启后解析必须命中缓存")
        before = len([row for row in self.transport.requests if row["path"] == protocol.PATH_LIST])
        job = self.core.sync.start(self.subscription["id"], mode="backfill")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        # 续采从第四页开始，不重买前三页。
        pages = [row["payload"].get("cursor") for row in self.transport.requests
                 if row["path"] == protocol.PATH_LIST]
        self.assertEqual(pages[before], "page-4")

    async def test_a_new_key_invalidates_the_checkpoint(self):
        await self.run_backfill(collect_items=30)
        self.core.settings.update("channels", {"wxrank": {"enabled": True}},
                                  credential_refs={"wxrank": "channel-wxrank-new"})
        self.core.credentials.provide("channel-wxrank-new", "test-secret")
        state = self.core.paid.checkpoint_state(self.subscription["source_id"], CONNECTION)
        self.assertEqual(state["state"], "version_mismatch")
        self.assertIn("从头重扫", state["note"])

    async def test_an_expired_checkpoint_falls_back_to_a_rescan(self):
        await self.run_backfill(collect_items=30)
        with self.core.repository.database.transaction() as db:
            db.execute("UPDATE paid_channel_checkpoints SET expires_at='2020-01-01T00:00:00.000+00:00'")
        state = self.core.paid.checkpoint_state(self.subscription["source_id"], CONNECTION)
        self.assertEqual(state["state"], "expired")
        self.assertIn("从头重扫", state["note"])

    async def test_the_terminal_page_ends_the_dataset_without_an_extra_paid_head_check(self):
        finished = await self.run_backfill(collect_items=50)
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        self.assertEqual(finished["coverage"], "history_end")
        self.assertEqual(finished["end_evidence"], "empty_list")
        # 五页列表 + 一次解析 = 六次调用；终止后没有额外的头部重查。
        self.assertEqual(self.transport.calls, 6)

    async def test_duplicate_pages_do_not_buy_extra_pages(self):
        # 服务端一直返回同一页：重复内容不算进展，不得为了追新而超页数。
        class SamePage(FakeTransport):
            async def post(self, path, payload, context, operation):
                context.check(operation)
                self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                if path == protocol.PATH_INFO:
                    return response(fixtures.ACCOUNT_OK)
                return WxrankResponse(0, "获取成功", {
                    "wxid": "gh_demo0001", "cursor": "page-2",
                    "list": [{"url": ("https://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng%3D%3D"
                                      "&mid=1000000001&idx=1&sn=x"), "title": "同一篇"}]})

        self.core.paid.transport = SamePage()
        finished = await self.run_backfill(collect_items=30)
        self.assertIn(finished["state"], {"partial", "succeeded"})
        pages = [row for row in self.transport.requests if row["path"] == protocol.PATH_LIST]
        self.assertLessEqual(len(pages), 3, "重复页面不得让调用次数超出页数上限")

    async def test_the_cost_derivation_matches_the_collector(self):
        from subscribe_flow.application.sync import SyncService
        descriptor = next(d for d in self.core.gateway.describe() if d.channel == protocol.CHANNEL)
        cases = {0: (3, 15), 10: (1, 5), 30: (3, 15), 50: (5, 25)}
        for collect_items, (pages, credits) in cases.items():
            self.core.subscriptions.update(self.subscription["id"], collect_items=collect_items)
            sub = dict(self.subscription, collect_items=collect_items)
            expected = SyncService.page_budget_for(sub, "backfill", None, descriptor)
            self.assertEqual(expected, pages, collect_items)
            status = self.core.paid_channels.status()
            entry = next(s for s in status["sources"] if s["sourceId"] == self.subscription["source_id"])
            self.assertEqual(entry["backfill"]["pages"], pages)
            self.assertEqual(entry["backfill"]["credits"], credits)

    async def test_a_refresh_starts_from_the_head(self):
        await self.run_backfill(collect_items=30)
        calls = len([row for row in self.transport.requests if row["path"] == protocol.PATH_LIST])
        await self.run_backfill(mode="refresh")
        pages = [row for row in self.transport.requests if row["path"] == protocol.PATH_LIST]
        self.assertEqual(pages[calls]["payload"].get("cursor"), None,
                         "刷新必须从头开始，不接着回溯的游标")

    async def test_metadata_is_marked_complete_but_has_no_body(self):
        await self.run_backfill(collect_items=10)
        items = self.core.repository.db.execute(
            "SELECT payload FROM contents LIMIT 1").fetchone()
        payload = json.loads(items["payload"])
        self.assertEqual(payload["acquisition_complete"], True)
        self.assertFalse(payload.get("summary"))


class SchedulerPolicyTests(WxrankTestCase):
    async def test_a_paid_timeout_is_not_replayed_automatically(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(
            source.url, CONNECTION, confirmed=True, sync_mode="automatic")
        self.transport.fail = ChannelError("TIMEOUT", "list_items", "上游请求超时，扣费结果未知")
        job = self.core.sync.start(subscription["id"], mode="refresh")
        await self.core.sync.wait(job["job_id"])
        plan = self.core.scheduler.store.get(subscription["id"])
        self.assertIsNone(plan["retry_job_id"], "扣费结果未知的付费请求不得自动重放")
        self.assertIn("不自动重放", plan["reason"])

    async def test_a_paid_interruption_is_not_replayed_automatically(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(
            source.url, CONNECTION, confirmed=True, sync_mode="automatic")
        self.core.sync.interrupted.add("no-such-job")
        job = self.core.sync.start(subscription["id"], mode="refresh")
        await self.core.sync.wait(job["job_id"])
        plan = self.core.scheduler.store.get(subscription["id"])
        self.assertIsNone(plan["retry_job_id"])

    async def test_a_key_error_stops_the_channel_until_it_is_fixed(self):
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(
            source.url, CONNECTION, confirmed=True, sync_mode="automatic")
        self.transport.listing = response(fixtures.LIST_KEY_INVALID)
        job = self.core.sync.start(subscription["id"], mode="refresh")
        await self.core.sync.wait(job["job_id"])
        blocks = self.core.scheduler.blocked(subscription)
        self.assertTrue(blocks, "密钥错误必须停住该连接")


class ControlledRpcTests(WxrankTestCase):

    async def asyncSetUp(self):
        await super().asyncSetUp()
        from subscribe_flow.rpc.dispatcher import Dispatcher, PROTOCOL_VERSION
        self.dispatcher = Dispatcher(self.core, lambda: None)
        hello = await self.dispatcher.handle({"jsonrpc": "2.0", "id": 0, "method": "core.hello",
                                              "params": {"protocol_version": PROTOCOL_VERSION}})
        self.assertIn("result", hello)
        self.methods = hello["result"]["methods"]

    async def call(self, method, params=None):
        response = await self.dispatcher.handle({"jsonrpc": "2.0", "id": 1, "method": method,
                                                 "params": params or {}})
        self.assertIn("result", response, response)
        return response["result"]

    async def test_the_three_routes_are_published(self):
        for name in ("wxrank.usage", "wxrank.cache_clear", "wxrank.test"):
            self.assertIn(name, self.methods)

    async def test_usage_and_cache_clear_never_spend(self):
        usage = await self.call("wxrank.usage")
        self.assertEqual(usage["confirmed_credits"], 0)
        self.assertEqual(usage["calls"], 0)
        self.assertTrue(usage["configured"])
        cleared = await self.call("wxrank.cache_clear")
        self.assertEqual(cleared["cleared"], 0)
        self.assertEqual(self.transport.calls, 0, "本地读数不得触发付费调用")

    async def test_the_paid_test_spends_exactly_one_call(self):
        result = await self.call("wxrank.test", {"locator": BIZ, "connection_id": CONNECTION})
        self.assertEqual(result["credits"], protocol.CREDITS_PER_CALL)
        self.assertEqual(self.transport.calls, 1)
        usage = await self.call("wxrank.usage")
        self.assertEqual(usage["confirmed_credits"], protocol.CREDITS_PER_CALL)
        self.assertEqual(usage["calls"], 1)

    async def test_the_paid_test_reports_a_missing_key_without_spending(self):
        self.core.credentials.clear()
        response = await self.dispatcher.handle({"jsonrpc": "2.0", "id": 1, "method": "wxrank.test",
                                                 "params": {"locator": BIZ, "connection_id": CONNECTION}})
        self.assertIn("error", response)
        self.assertEqual(self.transport.calls, 0)


# ---------------------------------------------------------------------------
# M45.6：按真实上游样本锁住解析口径与付费页语义
# ---------------------------------------------------------------------------
class RealUpstreamContractTests(unittest.TestCase):
    """2026-10-25 真实上游样本：字段名、业务码与链接转义形态。"""

    def test_the_real_article_link_loses_its_escaping_and_gains_https(self):
        url = ("http://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng=="
               "&amp;mid=1000000001&amp;idx=1&amp;sn=token")
        link = protocol.normalize_article_url(url)
        self.assertTrue(link.startswith("https://mp.weixin.qq.com/s?"))
        self.assertNotIn("&amp;", link)
        self.assertIn("mid=1000000001", link)
        biz, mid, idx = protocol.article_identity(url)
        self.assertEqual(biz, protocol.normalize_biz(BIZ))
        self.assertEqual((mid, idx), ("1000000001", "1"))

    def test_only_one_layer_of_entities_is_removed(self):
        # 只解一层：&amp;lt; 变成 &lt;，不能继续变成 <。
        self.assertEqual(protocol.safe_unescape("a&amp;lt;b"), "a&lt;b")
        self.assertEqual(protocol.safe_unescape("a&amp;amp;b"), "a&amp;b")

    def test_entity_names_are_not_confused_with_entities(self):
        # &times=1、&timestamp=123 都不是实体：不能像 html.unescape 那样改坏。
        self.assertEqual(protocol.safe_unescape("&times=1"), "&times=1")
        self.assertEqual(protocol.safe_unescape("&timestamp=123"), "&timestamp=123")

    def test_the_real_account_fields_are_read(self):
        account = protocol.parse_account(fixtures.ACCOUNT_OK["data"])
        self.assertEqual(account["gh_id"], "gh_demo0001")
        self.assertEqual(account["name"], "示例公众号")
        self.assertEqual(account["avatar"], "https://mmbiz.qpic.cn/demo/avatar")
        self.assertEqual(account["description"], "用于离线复现协议的示例账号")

    def test_the_real_list_keeps_the_sub_article_and_reads_every_field(self):
        parsed = protocol.parse_list(fixtures.LIST_OK["data"])
        self.assertEqual(parsed["wxid"], "gh_demo0001")
        self.assertEqual(parsed["cursor"], "cursor-2")
        self.assertEqual(len(parsed["items"]), 2)
        first, second = parsed["items"]
        # 同一条推送共享 mid，idx 区分头条与副条：副条必须留下。
        self.assertEqual((first["mid"], second["mid"]), ("1000000001", "1000000001"))
        self.assertEqual((first["idx"], second["idx"]), ("1", "2"))
        self.assertEqual(first["cover"], "https://mmbiz.qpic.cn/demo/cover-1")
        self.assertEqual(first["published_raw"], "2026-10-20 09:30:00")
        self.assertEqual(protocol.published_time(first["published_raw"]).precision, "second")

    def test_every_business_code_has_its_own_explanation(self):
        expected = {
            protocol.CODE_KEY_INVALID: "AUTH_REQUIRED",
            protocol.CODE_MISSING_WXID: "INVALID_INPUT",
            protocol.CODE_WXID_REJECTED: "INVALID_RESULT",
            protocol.CODE_CURSOR_REJECTED: "CURSOR_INVALID",
            protocol.CODE_REQUEST_FAILED: "DEPENDENCY_UNAVAILABLE",
            protocol.CODE_TIMEOUT: "DEPENDENCY_UNAVAILABLE",
            protocol.CODE_QPS_EXCEEDED: "RATE_LIMITED",
        }
        for code, want in expected.items():
            got, message, retryable = protocol.error_for_code(code, "")
            self.assertEqual(got, want, f"code={code}")
            self.assertTrue(message, f"code={code}")
            self.assertFalse(retryable, "上游已经答复过，重试只会再花钱")


def real_row(index, mid=1000000001):
    """真实上游形态的列表项：http 地址 + ``&amp;`` 分隔 + 副条 idx。"""
    return {
        "art_url": (f"http://mp.weixin.qq.com/s?__biz=MzI4NTEyMzQ1Ng==&amp;mid={mid}"
                    f"&amp;idx={index + 1}&amp;sn=demo{index}"),
        "title": f"示例文章 {index + 1}",
        "pub_time": "2026-10-20 09:30:00",
    }


class PaidPageSemanticsTests(WxrankTestCase):
    """付费页是原子的：一次调用买下这一页的全部条目。"""

    async def test_a_wider_page_is_not_truncated_by_the_estimate(self):
        # 真实一页可能是「10 次推送 × 每次最多 8 篇」：
        # 已经付过钱的文章不能按「每页 10 条」的估算丢掉。
        class WidePage(FakeTransport):
            async def post(self, path, payload, context, operation):
                context.check(operation)
                self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                if path == protocol.PATH_INFO:
                    return response(fixtures.ACCOUNT_OK)
                rows = [real_row(index) for index in range(18)]
                return WxrankResponse(0, "获取成功，剩余120积分",
                                      {"wxid": "gh_demo0001", "cursor": None, "list": rows})

        transport = WidePage()
        self.core.paid.transport = transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        job = self.core.sync.start(subscription["id"], mode="refresh")
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        self.assertEqual(self.core.queries.contents()["total"], 18)

    async def test_a_rejected_cursor_drops_the_checkpoint(self):
        # 上游说游标非法：留着它只会让下一次回溯再花一次钱、再失败一次。
        class CursorRejected(FakeTransport):
            async def post(self, path, payload, context, operation):
                context.check(operation)
                self.requests.append({"path": path, "payload": dict(payload), "operation": operation})
                if path == protocol.PATH_INFO:
                    return response(fixtures.ACCOUNT_OK)
                if payload.get("cursor"):
                    return WxrankResponse(protocol.CODE_CURSOR_REJECTED, "cursor校验失败", None)
                rows = [real_row(index) for index in range(10)]
                return WxrankResponse(0, "获取成功，剩余120积分",
                                      {"wxid": "gh_demo0001", "cursor": "page-2", "list": rows})

        transport = CursorRejected()
        self.core.paid.transport = transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        job = self.core.sync.start(subscription["id"], mode="backfill")
        finished = await self.core.sync.wait(job["job_id"])
        # 第一页已经入库，所以任务结束在 partial：已保存内容保留，错误如实上报。
        self.assertIn(finished["state"], {"failed", "partial"})
        self.assertEqual(finished["error"]["code"], "CURSOR_INVALID")
        # 检查点被丢掉：下一次回溯会从头开始，而不是再买同一个坏游标。
        saved = self.core.repository.paid_channels.checkpoint(
            subscription["source_id"], CONNECTION)
        self.assertIsNone(saved)
        # 业务失败不扣费：上游 code≠0 一律不扣。
        rejected = [row for row in self.attempts() if row.get("error_code") == "CURSOR_INVALID"]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["charge_state"], "not_charged")


class CheckpointDepthTests(WxrankTestCase):
    """BUG-132（重开）：刷新不得把更深的回溯进度退回去。"""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.transport = PagedTransport(pages=5)
        self.core.paid.transport = self.transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        # 采集条数 10 → 每次任务一页，正好复现 Codex 的请求序列。
        self.core.subscriptions.update(self.subscription["id"], collect_items=10)

    def checkpoint(self):
        row = self.core.repository.paid_channels.checkpoint(
            self.subscription["source_id"], CONNECTION)
        return json.loads(row["cursor"])["cursor"] if row else None

    def cursors(self):
        return [row["payload"].get("cursor") for row in self.transport.requests
                if row["path"] == protocol.PATH_LIST]

    async def run_job(self, mode):
        job = self.core.sync.start(self.subscription["id"], mode=mode)
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        return finished

    async def test_a_refresh_does_not_regress_a_deeper_backfill_checkpoint(self):
        await self.run_job("backfill")
        await self.run_job("backfill")
        self.assertEqual(self.checkpoint(), "page-3", "两页回溯后应停在第三页")
        # 刷新从头开始，但它拿到的只是「头页之后」的位置。
        await self.run_job("refresh")
        self.assertEqual(self.checkpoint(), "page-3",
                         "刷新不得把已经推进的历史检查点退回去")
        before = len(self.cursors())
        finished = await self.run_job("backfill")
        self.assertEqual(self.cursors()[before], "page-3",
                         "续采必须从深层位置继续，不能重买 page-2")
        self.assertGreater(finished["new_items"], 0, "续采必须真的拿到新条目")
        self.assertEqual(self.cursors()[:4], [None, "page-2", None, "page-3"])

    async def test_the_first_refresh_may_establish_the_backfill_starting_point(self):
        # 没有历史进度时，刷新可以建立回溯起点（否则第一次回溯会重买头页）。
        await self.run_job("refresh")
        self.assertEqual(self.checkpoint(), "page-2")
        before = len(self.cursors())
        await self.run_job("backfill")
        self.assertEqual(self.cursors()[before], "page-2",
                         "回溯必须接着刷新提交的那页走")


class WidePaidPageTests(WxrankTestCase):
    """BUG-137：付费整页与采集窗口的关系——整页保存，不丢已付费条目。"""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.transport = WidePagedTransport(pages=3)
        self.core.paid.transport = self.transport
        source = await self.core.subscriptions.resolve(BIZ, CONNECTION)
        self.subscription = await self.core.subscriptions.add(source.url, CONNECTION, confirmed=True)
        self.core.subscriptions.update(self.subscription["id"], collect_items=10)

    def cursors(self):
        return [row["payload"].get("cursor") for row in self.transport.requests
                if row["path"] == protocol.PATH_LIST]

    async def run_job(self, mode):
        job = self.core.sync.start(self.subscription["id"], mode=mode)
        finished = await self.core.sync.wait(job["job_id"])
        self.assertEqual(finished["state"], "succeeded", finished.get("error"))
        return finished

    def checkpoint(self):
        row = self.core.repository.paid_channels.checkpoint(
            self.subscription["source_id"], CONNECTION)
        return json.loads(row["cursor"])["cursor"] if row else None

    async def test_the_whole_paid_page_is_saved_with_its_sub_articles(self):
        await self.run_job("refresh")
        contents = self.core.queries.contents()
        # 一次调用买下 16 篇：全部保存，副条一条都不丢。
        self.assertEqual(contents["total"], 16)
        titles = {item["title"] for item in contents["items"]}
        self.assertIn("宽页文章 1-1-1", titles, "头条必须保存")
        self.assertIn("宽页文章 1-1-8", titles, "同一次推送的最后一篇副条必须保存")
        self.assertIn("宽页文章 1-2-1", titles, "第二次推送的头条必须保存")
        # 采集条数只是扫描窗口：调用次数不超上限。
        self.assertEqual(len(self.cursors()), 1, "一页就是一次付费调用")
        self.assertEqual(self.checkpoint(), "page-2", "整页保存后检查点必须推进")

    async def test_the_next_backfill_continues_instead_of_buying_the_head_again(self):
        await self.run_job("refresh")
        before = len(self.cursors())
        finished = await self.run_job("backfill")
        self.assertEqual(self.cursors()[before], "page-2",
                         "回溯必须接着整页保存后的检查点走，不得重买头页")
        self.assertEqual(finished["new_items"], 16, "续采必须拿到下一页的 16 篇")
        self.assertEqual(self.core.queries.contents()["total"], 32)
        self.assertEqual(self.checkpoint(), "page-3")

    async def test_the_wide_page_progress_survives_a_restart(self):
        await self.run_job("refresh")
        await self.core.close()
        self.core = self.make_core()
        self.core.paid.transport = self.transport
        self.core.credentials.provide(REFERENCE, "test-secret")
        before = len(self.cursors())
        finished = await self.run_job("backfill")
        self.assertEqual(self.cursors()[before], "page-2",
                         "重启后必须接着上次的检查点走")
        self.assertEqual(finished["new_items"], 16)


if __name__ == "__main__":
    unittest.main()
