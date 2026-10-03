"""Independent real-adapter probe. No database or Electron required."""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from subscribe_flow.contracts import ChannelError, Connection, Context, FetchRequest, jsonable


async def probe(args):
    from subscribe_flow.bootstrap import build_gateway
    gateway = build_gateway(args.opencli)
    context = Context(Connection("probe", "bilibili", "opencli", "browser:opencli"),
                      "probe", time.monotonic() + args.timeout)
    if args.operation == "describe":
        return gateway.describe()
    if args.operation == "check":
        return await gateway.check_readiness("list_items", context)
    if args.operation == "search":
        return await gateway.search_sources(args.locator, FetchRequest(), context)
    if args.operation == "detail":
        return await gateway.get_item_detail(args.locator, context)
    source = await gateway.resolve_source(args.locator, context)
    if args.operation == "resolve":
        return source
    cursor, seen, pages = None, set(), []
    for _ in range(args.pages):
        page = await gateway.fetch_page(source, FetchRequest(mode="backfill", cursor=cursor, limit=args.limit), context)
        pages.append(jsonable(page))
        new = {item.key for item in page.items} - seen
        seen.update(item.key for item in page.items)
        if page.terminal or not page.next_cursor:
            break
        if not new:
            return dict(source=jsonable(source), pages=pages, unique_count=len(seen), complete=False, stop="no_progress")
        cursor = page.next_cursor
    return dict(source=jsonable(source), pages=pages, unique_count=len(seen),
                complete=bool(pages and pages[-1]["terminal"] and not any(p["item_errors"] for p in pages)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["describe", "resolve", "search", "fetch", "detail", "check"])
    parser.add_argument("locator", nargs="?", default="946974")
    parser.add_argument("--opencli", default="opencli")
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    if args.pages < 1 or not 1 <= args.limit <= 100 or args.timeout <= 0:
        parser.error("pages / timeout must be positive and limit must be 1..100")
    try:
        print(json.dumps({"ok": True, "result": jsonable(asyncio.run(probe(args)))}, ensure_ascii=False, indent=2))
    except ChannelError as error:
        print(json.dumps({"ok": False, "error": error.to_dict()}, ensure_ascii=False, indent=2))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
