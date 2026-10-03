import json
import unittest
from pathlib import Path

from subscribe_flow.channels.bilibili.adapter import BilibiliAdapter
from subscribe_flow.channels.bilibili.backends.opencli import mapped_error
from subscribe_flow.channels.bilibili.parsers import parse_detail, parse_sources, parse_videos, source_from_locator
from subscribe_flow.contracts import ChannelError, FetchRequest
from tests.test_contracts import context

FIXTURES = Path(__file__).parent / "fixtures" / "bilibili"


class ParserTests(unittest.TestCase):
    def test_source_identity_is_separate_from_remote_confirmation(self):
        a = source_from_locator("000946974")
        b = source_from_locator("https://space.bilibili.com/946974?from=test")
        self.assertEqual(a, b)
        self.assertFalse(a.confirmed)
        for value in ("0", "影视飓风", "https://space.bilibili.com.evil/946974", "https://evil@space.bilibili.com/1", "https://space.bilibili.com:999/1", "1;touch x"):
            with self.assertRaises(ChannelError):
                source_from_locator(value)

    def test_date_precision_and_item_failure(self):
        payload = json.loads((FIXTURES / "list.json").read_text())
        payload.append({"title": "broken", "url": ""})
        items, errors = parse_videos(payload, source_from_locator("946974"))
        self.assertEqual(len(items), 2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(items[0].published.precision, "date")
        self.assertEqual(items[0].published.timezone, "UTC")
        self.assertIsNone(items[0].thumbnail)

    def test_unknown_empty_and_schema_error_are_not_empty_success(self):
        for payload, code in (([], "UNVERIFIED_EMPTY"), ({"data": []}, "SCHEMA_CHANGED"), ([{}], "SCHEMA_CHANGED")):
            with self.assertRaises(ChannelError) as error:
                parse_videos(payload, source_from_locator("1"))
            self.assertEqual(error.exception.code, code)

    def test_search_keeps_distinct_stable_uids(self):
        page = parse_sources(json.loads((FIXTURES / "search.json").read_text()))
        self.assertEqual(len({source.key for source in page.items}), 3)
        self.assertTrue(all(source.confirmed for source in page.items))

    def test_detail_missing_fields_do_not_erase_data(self):
        patch = parse_detail([{"field": "bvid", "value": "BV1yEaJ6CEUk"}, {"field": "title", "value": "Title"}], "BV1yEaJ6CEUk")
        self.assertEqual(patch.fields, {"title": "Title"})
        with self.assertRaises(ChannelError):
            parse_detail([{"field": "bvid", "value": "BV1yEaJ6CEUk"}], "BV1hGaG6vEX2")

    def test_real_second_page_and_detail_samples(self):
        source = source_from_locator("946974")
        first, _ = parse_videos(json.loads((FIXTURES / "list.json").read_text()), source)
        second, _ = parse_videos(json.loads((FIXTURES / "page2.json").read_text()), source)
        self.assertFalse({item.key for item in first} & {item.key for item in second})
        detail = parse_detail(json.loads((FIXTURES / "detail.json").read_text()), "BV1yEaJ6CEUk")
        self.assertEqual(detail.fields["published"].precision, "minute")
        self.assertEqual(detail.fields["duration_seconds"], 1042)

    def test_access_rejection_is_not_assumed_login_failure(self):
        self.assertEqual(mapped_error("Navigation rejected", "get_item_detail", context()).code, "ACCESS_FAILED")
        cases = {"AUTH_REQUIRED": "AUTH_REQUIRED", "browser not connected": "DEPENDENCY_UNAVAILABLE",
                 "429": "RATE_LIMITED", "captcha": "INTERACTION_REQUIRED", "timed out": "TIMEOUT"}
        for message, code in cases.items():
            self.assertEqual(mapped_error(message, "list_items", context()).code, code)


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_short_page_has_no_terminal_claim_and_cursor_is_bound(self):
        class Backend:
            async def call(self, args, context, operation):
                self.args = args
                return json.loads((FIXTURES / "list.json").read_text())
        backend = Backend()
        adapter = BilibiliAdapter(backend)
        source = source_from_locator("946974")
        page = await adapter.fetch_page(source, FetchRequest(limit=5), context())
        self.assertFalse(page.terminal)
        self.assertEqual(page.coverage, "window_only")
        self.assertEqual(page.next_cursor["page"], 2)
        with self.assertRaises(ChannelError) as error:
            await adapter.fetch_page(source_from_locator("1"), FetchRequest(cursor=page.next_cursor, limit=5), context())
        self.assertEqual(error.exception.code, "INVALID_CURSOR")
