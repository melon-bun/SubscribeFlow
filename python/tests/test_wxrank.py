"""M45 付费渠道：契约冻结、计费账本、解析缓存与单页入库。

全部离线：传输层换成假传输，因此「没有发请求」是可证明的，
也保证本文件不会产生任何真实费用。

覆盖三批里的前两批能力：
- M45.1 协议契约：biz 归一、身份派生、响应形状、计费口径；
- M45.2 账本与缓存：迁移、已确认／未确认扣费、崩溃遗留、缓存跨重启；
- M45.3 业务层与适配器：解析→确认添加→单页入库、并发合并、限流互斥。
"""

import asyncio
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


class ControlledRpcTests(WxrankTestCase):
    """受控 RPC：三条路由在真实的分发器上可用，且只有一条会花钱。"""

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


if __name__ == "__main__":
    unittest.main()
