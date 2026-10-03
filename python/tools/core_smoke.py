"""Opt-in live Core smoke test using an isolated temporary data directory."""
import argparse
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from subscribe_flow.bootstrap import Core


async def run(args, folder):
    core = Core(Path(folder) / "smoke.sqlite3", opencli_path=args.opencli)
    try:
        sub = await core.subscriptions.add(args.uid, "bilibili:default", confirmed=True)
        started = core.sync.start(sub["id"], mode="refresh", page_budget=1)
        job = await core.sync.wait(started["job_id"])
        result = core.queries.contents()
        if result["items"]:
            core.content.update(result["items"][0]["id"], {"read": True})
        print(json.dumps({"state": job["state"], "coverage": job["coverage"], "pages": job["pages"],
                          "saved_items": result["total"], "error": job["error"],
                          "read_state_saved": bool(result["items"] and core.queries.content(result["items"][0]["id"])["state"]["read"])}, ensure_ascii=False, indent=2))
        return 0 if result["total"] and job["state"] == "succeeded" else 1
    finally:
        await core.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("uid", nargs="?", default="946974")
    parser.add_argument("--opencli", default="opencli")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="subscribe-flow-smoke-") as folder:
        raise SystemExit(asyncio.run(run(args, folder)))


if __name__ == "__main__":
    main()
