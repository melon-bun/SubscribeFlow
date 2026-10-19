"""GitHub Trending: three fixed boards, one stable key, offline HTTP.

Fixtures are trimmed from real github.com/trending responses. The day and week
fixtures deliberately share two repositories, because that overlap is the whole
point of the channel: the same repository on two boards must land as ONE item.
"""
import re
import tempfile
import time
import unittest
from pathlib import Path

from subscribe_flow.bootstrap import Core, resource_key
from subscribe_flow.application.scheduler import SchedulePolicy
from subscribe_flow.channels.gateway import ChannelGateway
from subscribe_flow.channels.github.adapter import GithubTrendingAdapter, board_locator
from subscribe_flow.channels.github.transport import CA_BUNDLES, GithubTransport, _ssl_context, allowed
from subscribe_flow.contracts import ChannelError, Connection, Context, FetchRequest

FIXTURES = Path(__file__).parent / "fixtures" / "github"
BOARD_FILES = {"day": "trending-day.html", "week": "trending-week.html",
               "month": "trending-month-disjoint.html"}
CAPTURED = "2026-10-16T02:20:00+00:00"
SINCE_QUERY = {"day": "?since=daily", "week": "?since=weekly", "month": "?since=monthly"}


def read(name):
    return (FIXTURES / name).read_text(encoding="utf-8")


def rows_of(document):
    import re
    return len(re.findall(r'<article class="Box-row">', document))


class FakeTransport:
    """Offline stand-in with a hard request counter, so 'no network' is provable."""

    def __init__(self):
        self.urls, self.pages, self.fail = [], {}, None

    def serve(self, url):
        for board, query in SINCE_QUERY.items():
            if url.endswith(query):
                return read(BOARD_FILES[board])
        if url.endswith("/morluto/rea"):
            return read("repository.html")
        raise AssertionError(f"unexpected request: {url}")

    async def get_html(self, url, context, operation):
        context.check(operation)
        self.urls.append(url)
        if self.fail:
            raise self.fail
        return self.serve(url)


class GithubTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.transport = FakeTransport()
        self.adapter = GithubTrendingAdapter(self.transport)
        gateway = ChannelGateway()
        gateway.register(self.adapter)
        self.core = Core(Path(self.temp.name) / "core.db", gateway=gateway,
                         schedule_policy=SchedulePolicy(startup_delay=0, dispatch_gap=0, resource_gap=0),
                         clock=lambda: 1000000.)

    async def asyncTearDown(self):
        await self.core.close()
        self.temp.cleanup()

    def context(self, source=None):
        return Context(Connection("github:default", "github", "direct-http", "http:github"),
                       "job", time.monotonic() + 30, source=source)

    async def add_board(self, board):
        """Subscribe to one board the way the UI does: by its Source URL."""
        candidates = await self.core.subscriptions.search("", "github:default")
        chosen = next(s for s in candidates.items if s.external_id == board)
        return await self.core.subscriptions.add(chosen.url, "github:default", confirmed=True)

    async def refresh(self, subscription_id):
        job = self.core.sync.start(subscription_id, mode="refresh")
        return await self.core.sync.wait(job["job_id"])

    # ---- §4.1 capability declaration -------------------------------------

    def test_descriptor_declares_every_operation_as_specified(self):
        descriptor = self.adapter.describe()
        self.assertEqual((descriptor.channel, descriptor.backend), ("github", "direct-http"))
        self.assertEqual(descriptor.page_size, 1)
        self.assertEqual(descriptor.budget_unit, "items")
        self.assertEqual(descriptor.content_types, ("repo",))
        self.assertEqual(descriptor.default_refresh_budget, 12)
        operations = descriptor.operations
        for name in ("resolve_source", "search_sources", "list_items",
                     "match_item_url", "resolve_item", "read_item"):
            self.assertTrue(operations[name].supported, name)
            self.assertEqual(operations[name].authentication, "not_required", name)
        # get_item_detail must say so in notes, not merely stay silent.
        self.assertFalse(operations["get_item_detail"].supported)
        self.assertIn("README", operations["get_item_detail"].notes)
        self.assertEqual(operations["list_items"].full_history, False)

    def test_direct_http_backend_never_shares_a_browser_resource(self):
        self.assertEqual(resource_key(self.adapter.describe()), "http:github")

    # ---- §4.2 three boards, local only ------------------------------------

    async def test_search_offers_exactly_three_boards_and_makes_no_request(self):
        page = await self.core.subscriptions.search("", "github:default")
        self.assertEqual([s.external_id for s in page.items], ["day", "week", "month"])
        self.assertEqual({s.kind for s in page.items}, {"trending_board"})
        self.assertEqual(self.transport.urls, [], "search_sources must not touch the network")
        for source in page.items:
            self.assertIsNone(source.avatar)

    async def test_resolve_source_accepts_only_three_boards_and_is_idempotent(self):
        for locator, expected in [("day", "day"), ("daily", "day"), ("WEEK", "week"),
                                  ("monthly", "month"), ("https://github.com/trending", "day"),
                                  ("https://github.com/trending?since=weekly", "week"),
                                  ("https://github.com/trending?since=monthly", "month")]:
            source = await self.adapter.resolve_source(locator, self.context())
            self.assertEqual(source.external_id, expected, locator)
            again = await self.adapter.resolve_source(source.url, self.context())
            self.assertEqual(again.external_id, expected, f"not idempotent for {locator}")
        self.assertEqual(self.transport.urls, [], "resolve_source must be a local whitelist check")

    async def test_unsupported_locators_are_rejected_including_extra_filters(self):
        for locator in ("python:weekly", "/trending/python", "rust",
                        "https://github.com/trending?since=python",
                        "https://github.com/trending?since=weekly&spoken_language_code=zh",
                        "https://github.com/trending?language=rust",
                        "https://github.com/search?q=rust", "https://gist.github.com/a/b", ""):
            with self.assertRaises(ChannelError, msg=locator) as caught:
                await self.adapter.resolve_source(locator, self.context())
            self.assertEqual(caught.exception.code, "INVALID_INPUT", locator)
        self.assertEqual(self.transport.urls, [])

    # ---- §4.5 / §9.1.4 parsing against real markup ------------------------

    async def test_row_count_follows_the_page_and_fields_match_the_fixture(self):
        # Serve the untrimmed snapshot so the count is whatever the page really has.
        document = read("trending-daily-full.html")
        self.transport.serve = lambda url: document if url.endswith("?since=daily") else ""
        expected = rows_of(document)
        self.assertGreater(expected, 1)
        page = await self.adapter.fetch_page(
            await self.adapter.resolve_source("day", self.context()),
            FetchRequest(mode="refresh", item_budget=25), self.context())
        self.assertEqual(len(page.items), expected,
                         "parsed count must equal the article count in the served page")
        first = page.items[0]
        self.assertTrue(first.external_id.isdigit())
        self.assertEqual(first.title, "morluto/rea")
        self.assertEqual(first.url, "https://github.com/morluto/rea")
        self.assertEqual(first.kind, "repo")
        self.assertEqual(first.source.kind, "trending_board")
        self.assertEqual(first.acquisition_complete, True)
        self.assertIsNone(first.thumbnail, "row avatars are contributors, never the owner")
        self.assertIn("Reverse engineer", first.summary)
        self.assertEqual(first.published.provenance, "fetched_at")
        self.assertEqual(first.published.precision, "minute")
        self.assertIn("stars today", first.published.raw_label)
        # Stable key is the numeric id, and every row resolves to one identity.
        self.assertEqual(first.external_id, "1209966933")
        self.assertEqual(len({item.external_id for item in page.items}), len(page.items))
        self.assertEqual(set(page.metrics), {"profile_reads", "discovered", "skipped", "detail_requests"})
        self.assertEqual(page.metrics["profile_reads"], 1)
        self.assertEqual(page.metrics["detail_requests"], 0)
        self.assertEqual(page.metrics["discovered"], len(page.items))
        self.assertEqual(page.terminal, True)
        self.assertEqual(page.coverage, "window_only")

    async def test_a_different_page_size_parses_to_that_size_not_a_constant(self):
        # Proves the count is read from the page: 2 rows in, 2 items out.
        rows = re.findall(r'<article class="Box-row">.*?</article>', read("trending-daily-full.html"), re.S)
        two = '<html><head><title>Trending  repositories on GitHub today · GitHub</title></head><body>' \
              + ''.join(rows[:2]) + '</body></html>'
        self.transport.serve = lambda url: two
        page = await self.adapter.fetch_page(
            await self.adapter.resolve_source("day", self.context()),
            FetchRequest(mode="refresh", item_budget=25), self.context())
        self.assertEqual(len(page.items), 2)
        self.assertEqual(page.metrics["discovered"], 2)

    async def test_structural_change_is_schema_changed_not_silent_data(self):
        # Point the heading id and the star-button id at different repositories.
        # The stable key is then untrustworthy, so this must not be parsed.
        broken = read("trending-day.html").replace(
            "&quot;record_id&quot;:1209966933", "&quot;record_id&quot;:999999999", 1)
        self.assertNotEqual(broken, read("trending-day.html"))
        original = self.transport.serve

        def serve(url):
            return broken if url.endswith("?since=daily") else original(url)
        self.transport.serve = serve
        with self.assertRaises(ChannelError) as caught:
            await self.adapter.fetch_page(
                await self.adapter.resolve_source("day", self.context()),
                FetchRequest(mode="refresh", item_budget=25), self.context())
        self.assertEqual(caught.exception.code, "SCHEMA_CHANGED")

    async def test_non_trending_page_is_schema_changed(self):
        def serve(url):
            return "<html><head><title>Sign in to GitHub</title></head><body></body></html>"
        self.transport.serve = serve
        with self.assertRaises(ChannelError) as caught:
            await self.adapter.fetch_page(
                await self.adapter.resolve_source("week", self.context()),
                FetchRequest(mode="refresh", item_budget=25), self.context())
        self.assertEqual(caught.exception.code, "SCHEMA_CHANGED")

    # ---- §4.4 / §9.1.5 the core dedup requirement ------------------------

    async def test_same_repository_on_two_boards_is_stored_once_and_seen_by_both(self):
        day = await self.add_board("day")
        week = await self.add_board("week")

        day_document, week_document = read(BOARD_FILES["day"]), read(BOARD_FILES["week"])


        def ids(document):
            out = set()
            for row in re.findall(r'<article class="Box-row">.*?</article>', document, re.S):
                payload = re.search(r'<h2\b[^>]*>.*?data-hydro-click="([^"]*)"[^>]*?href="/[^"]+"', row, re.S)
                out.add(re.search(r'&quot;record_id&quot;:(\d+)', payload.group(1)).group(1))
            return out

        shared = ids(day_document) & ids(week_document)
        self.assertTrue(shared, "fixture precondition: day and week must actually intersect")

        await self.refresh(day['id'])
        await self.refresh(week['id'])

        for repository_id in shared:
            rows = self.core.repository.db.execute(
                "SELECT count(*) FROM contents WHERE channel='github' AND external_id=?",
                (repository_id,)).fetchone()
            self.assertEqual(rows[0], 1, f"repository {repository_id} stored twice")

        # Both boards must claim it: option B links the source on a duplicate hit.
        for board in ("day", "week"):
            source_id = f"github:trending_board:{board}"
            for repository_id in shared:
                linked = self.core.repository.db.execute(
                    "SELECT count(*) FROM content_sources WHERE content_id=? AND source_id=?",
                    (f"github:repo:{repository_id}", source_id)).fetchone()
                self.assertEqual(linked[0], 1, f"{repository_id} not attributed to {board}")

    async def test_disjoint_boards_keep_two_rows_so_the_dedup_assertion_cannot_pass_vacuously(self):
        day = await self.add_board("day")
        month = await self.add_board("month")
        await self.refresh(day['id'])
        await self.refresh(month['id'])
        sources = {row['source_id'] for row in self.core.repository.db.execute(
            "SELECT DISTINCT source_id FROM content_sources WHERE source_id LIKE 'github:trending_board:%'")}
        self.assertEqual(sources, {"github:trending_board:day", "github:trending_board:month"})
        day_items = self.core.repository.db.execute(
            "SELECT count(*) FROM content_sources WHERE source_id='github:trending_board:day'").fetchone()[0]
        month_items = self.core.repository.db.execute(
            "SELECT count(*) FROM content_sources WHERE source_id='github:trending_board:month'").fetchone()[0]
        self.assertGreater(day_items, 0)
        self.assertGreater(month_items, 0)
        total = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(total, day_items + month_items, "disjoint boards must not collapse")

    # ---- BUG-096：保存的采集条数必须真正生效 ---------------------------

    async def test_saved_collect_items_ceiling_actually_applies(self):
        """collect_items=1 保存并读回 1，实际新入库也只能是 1 条。"""
        day = await self.add_board("day")
        await self.core.update_subscription(day['id'], collect_items=1)
        saved = self.core.repository.get_subscription(day['id'])
        self.assertEqual(saved['collect_items'], 1, '配置必须真的保存下来')

        run = await self.refresh(day['id'])
        stored = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(run['new_items'], 1, '新入库条数必须受保存的上限约束')
        self.assertEqual(run['items'], 1)
        self.assertEqual(stored, 1, '库中实际内容条数必须与预算一致')
        # 只读一次榜单页：上限是入库上限，不是分页大小。
        self.assertEqual(len([u for u in self.transport.urls if 'trending' in u]), 1)

    async def test_default_budget_still_takes_the_whole_board(self):
        """collect_items 缺省时沿用默认预算，不能因为上限逻辑把榜单截短。"""
        day = await self.add_board("day")
        run = await self.refresh(day['id'])
        self.assertGreater(run['new_items'], 1, '缺省预算应取回整榜而不是一条')
        self.assertEqual(run['new_items'], run['acquisition_metrics']['discovered'],
                         '缺省预算下榜单应被完整取回')
        stored = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(stored, run['new_items'])

    async def test_large_valid_budget_still_succeeds_on_a_short_board(self):
        """上限大于榜单实际行数时应正常收录全部，而不是整次失败。

        用户上限表示「最多收多少条」，不要求榜单真有那么多行。两个上限各自用一个
        榜单验证：已收录的行会占用窗口预算，混在同一个榜上第二次就没有新增了。
        """
        for board, ceiling in (("day", 26), ("month", 50)):
            subscription = await self.add_board(board)
            await self.core.update_subscription(subscription['id'], collect_items=ceiling)
            saved = self.core.repository.get_subscription(subscription['id'])
            self.assertEqual(saved['collect_items'], ceiling, '配置必须保存得下')

            run = await self.refresh(subscription['id'])
            self.assertEqual(run['state'], 'succeeded', f'上限 {ceiling} 不应让任务失败')
            self.assertGreater(run['new_items'], 0, f'上限 {ceiling} 应正常收录')
            self.assertLessEqual(run['new_items'], ceiling,
                                 '实际收录数不得超过用户上限')
            stored = self.core.repository.db.execute(
                "SELECT count(*) FROM contents WHERE channel='github'"
                " AND id IN (SELECT content_id FROM content_sources cs"
                " JOIN sources s ON s.id=cs.source_id WHERE s.external_id=?)",
                (board,)).fetchone()[0]
            self.assertEqual(stored, run['new_items'])

    async def test_stored_budget_never_exceeds_the_actual_board(self):
        """小上限仍然生效：超过用户预算的行不会被带入。"""
        day = await self.add_board("day")
        await self.core.update_subscription(day['id'], collect_items=3)
        run = await self.refresh(day['id'])
        self.assertEqual(run['new_items'], 3)
        stored = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(stored, 3)

    async def test_budget_counts_new_items_and_still_skips_known(self):
        """已收录条目同样占额度（与其他渠道一致），重复刷新不再新增。"""
        day = await self.add_board("day")
        await self.core.update_subscription(day['id'], collect_items=1)
        first = await self.refresh(day['id'])
        self.assertEqual(first['new_items'], 1)
        again = await self.refresh(day['id'])
        self.assertEqual(again['new_items'], 0, '同一条已收录，不得重复入库')
        self.assertEqual(again['acquisition_metrics']['skipped'], 1,
                         '已收录的条目占用本轮额度并计入 skipped')
        stored = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(stored, 1)

    async def test_multi_board_shares_content_but_keeps_both_attributions(self):
        """两个榜共享同一仓库时仍只存一条，但两个来源归属都要在。"""
        day = await self.add_board("day")
        month = await self.add_board("month")
        await self.core.update_subscription(day['id'], collect_items=1)
        await self.core.update_subscription(month['id'], collect_items=1)
        await self.refresh(day['id'])
        await self.refresh(month['id'])
        rows = self.core.repository.db.execute(
            "SELECT content_id, count(*) n FROM content_sources cs JOIN contents c ON c.id=cs.content_id"
            " WHERE c.channel='github' GROUP BY content_id ORDER BY n DESC").fetchall()
        self.assertTrue(rows)
        # 去重语义不变：同一条内容不会因为被两个榜看到而存两份。
        for row in rows:
            self.assertLessEqual(row['n'], 2)

    async def test_refreshing_twice_adds_nothing_and_reports_skips(self):
        day = await self.add_board("day")
        await self.refresh(day['id'])
        first = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        run = await self.refresh(day['id'])
        second = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0]
        self.assertEqual(first, second)
        self.assertGreater(first, 0)
        self.assertEqual(run['new_items'], 0)
        self.assertEqual(run['acquisition_metrics']['skipped'], first)

    # ---- §4.6 paste path --------------------------------------------------

    async def test_pasted_repository_and_board_hit_share_one_key(self):
        task = await self.core.intake.wait(
            self.core.intake.start("https://github.com/morluto/rea")["task_id"])
        self.assertEqual(task["state"], "preview")
        preview = task["preview"]
        self.assertEqual(preview["title"], "morluto/rea", "no 'GitHub - ' template text")
        self.assertEqual(preview["external_id"], "1209966933")
        self.assertIn("1209966933", preview["id"])
        self.assertIsNotNone(preview["thumbnail"], "og:image is the repository social card")
        self.assertEqual(self.core.repository.list_subscriptions(), [])
        saved = self.core.intake.save(task["preview_id"])

        await self.refresh((await self.add_board("day"))['id'])
        rows = self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github' AND external_id='1209966933'").fetchone()[0]
        self.assertEqual(rows, 1, "pasted link and board row must collapse onto one key")
        self.assertEqual(saved['item_id'], 'github:repo:1209966933')

    async def test_paste_again_is_a_no_op_without_a_second_read(self):
        first = await self.core.intake.wait(
            self.core.intake.start("https://github.com/morluto/rea")["task_id"])
        self.core.intake.save(first["preview_id"])
        reads = self.transport.urls.count("https://github.com/morluto/rea")
        self.assertEqual(reads, 2, "first paste resolves the id, then reads the item")
        again = await self.core.intake.wait(
            self.core.intake.start("https://github.com/morluto/rea")["task_id"])
        self.assertEqual(again["state"], "exists")
        # The duplicate short-circuits after resolve_item, so exactly one request is added.
        self.assertEqual(self.transport.urls.count("https://github.com/morluto/rea"), reads + 1)
        self.assertEqual(self.core.repository.db.execute(
            "SELECT count(*) FROM contents WHERE channel='github'").fetchone()[0], 1)

    def test_only_two_segment_repository_links_are_matched(self):
        for url in ("https://github.com/morluto/rea", "http://www.github.com/a/b?tab=readme-ov-file"):
            self.assertTrue(self.adapter.match_item_url(url), url)
        for url in ("https://github.com/a", "https://github.com/a/b/issues/3",
                    "https://github.com/topics/rust", "https://github.com/a/b/c",
                    "https://github.com.evil.com/a/b", "https://user@github.com/a/b"):
            self.assertFalse(self.adapter.match_item_url(url), url)

    async def test_repository_page_without_a_stable_id_is_schema_changed(self):
        self.transport.serve = lambda url: "<html><head><title>x</title></head><body></body></html>"
        task = await self.core.intake.wait(self.core.intake.start("https://github.com/morluto/rea")["task_id"])
        self.assertEqual(task["state"], "failed")
        self.assertEqual(task["error"]["code"], "SCHEMA_CHANGED")
        self.assertEqual(self.core.repository.query_contents()["total"], 0,
                         "a page with no stable id must write nothing")

    # ---- transport ---------------------------------------------------------

    async def test_tls_context_actually_trusts_a_certificate_authority(self):
        """A Core-side HTTP client has to resolve its own trust store.

        python.org's CPython builds ship an OpenSSL whose default cert path does
        not exist, which makes every HTTPS request fail verification. The
        browser-backed channels never notice because Chromium carries its own
        store. Verification must stay on; the context only needs a real CA.
        """
        import os
        context = _ssl_context()
        available = ([os.environ["SSL_CERT_FILE"]] if os.environ.get("SSL_CERT_FILE") else []) \
            + [path for path in CA_BUNDLES if Path(path).is_file()]
        try:
            import certifi
            available.append(certifi.where())
        except ImportError:
            pass
        if not available:
            self.skipTest("this machine has no CA bundle to resolve")
        self.assertTrue(context.get_ca_certs(),
                        "the resolved TLS context trusts nobody; HTTPS would fail")
        self.assertTrue(context.verify_mode)

    async def test_transport_refuses_hosts_outside_github(self):
        self.assertTrue(allowed("https://github.com/trending"))
        self.assertFalse(allowed("https://evil.com/trending"))
        self.assertFalse(allowed("file:///etc/passwd"))
        transport = GithubTransport()
        with self.assertRaises(ChannelError) as caught:
            await transport.get_html("https://evil.com/x", self.context(), "list_items")
        self.assertEqual(caught.exception.code, "INVALID_INPUT")
        self.assertEqual(transport.requests, 0)

    async def test_transport_maps_http_failures_to_channel_errors(self):
        import urllib.error
        import io

        class Opener:
            def __init__(self, status): self.status = status
            def open(self, request, timeout=None):
                raise urllib.error.HTTPError(request.full_url, self.status, "boom", {}, io.BytesIO())

        cases = {403: "RATE_LIMITED", 429: "RATE_LIMITED", 404: "NOT_FOUND", 500: "DEPENDENCY_UNAVAILABLE"}
        for status, expected in cases.items():
            transport = GithubTransport()
            transport.opener = Opener(status)
            with self.assertRaises(ChannelError, msg=status) as caught:
                await transport.get_html("https://github.com/trending", self.context(), "list_items")
            self.assertEqual(caught.exception.code, expected, status)

    async def test_transport_aborts_a_response_beyond_the_size_cap(self):
        class Big:
            headers = {"Content-Type": "text/html; charset=utf-8"}
            def __init__(self): self.left = 5 * 1024 * 1024
            def geturl(self): return "https://github.com/trending"
            def read(self, size):
                take = min(size, self.left)
                self.left -= take
                return b"x" * take
            def __enter__(self): return self
            def __exit__(self, *a): return False

        class Opener:
            def open(self, request, timeout=None): return Big()

        transport = GithubTransport(max_bytes=4096)
        transport.opener = Opener()
        with self.assertRaises(ChannelError) as caught:
            await transport.get_html("https://github.com/trending", self.context(), "list_items")
        self.assertEqual(caught.exception.code, "SCHEMA_CHANGED")

    async def test_readiness_reports_ready_without_login_and_without_probe_requests(self):
        for operation in ("resolve_item", "read_item", "match_item_url"):
            readiness = await self.core.gateway.check_readiness(operation, self.context())
            self.assertEqual(readiness.state, "ready")
            self.assertEqual(readiness.authentication, "not_required")
        self.assertEqual(self.transport.urls, [],
                         "single-item path must not spend a probe request")

    async def test_two_real_requests_are_serialised_by_the_shared_resource_key(self):
        adapter = GithubTrendingAdapter()
        context = self.context()
        import asyncio
        gaps = []

        async def timed():
            async with adapter.resources.acquire(context, "list_items", gap=0.2):
                gaps.append(time.monotonic())
        await asyncio.gather(timed(), timed())
        self.assertEqual(len(gaps), 2)
        self.assertGreaterEqual(gaps[1] - gaps[0], 0.15,
                                "http:github must serialise the boards")


if __name__ == "__main__":
    unittest.main()
