import asyncio
import json
import signal
import sys

from subscribe_flow.contracts import jsonable
from .dispatcher import Dispatcher

MAX_LINE_BYTES = 65536


async def serve(core):
    loop = asyncio.get_running_loop()
    # Browser responses carry raw bounded API envelopes, ordinary requests stay 64 KiB.
    reader = asyncio.StreamReader(limit=4 * 1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    stopping = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopping.set)
    dispatcher = Dispatcher(core, stopping.set)
    queue = asyncio.Queue(maxsize=256)
    browser = getattr(core, "browser_bridge", None)
    if browser:
        browser.send = queue.put
    pending = set()

    def event(name, data):
        if dispatcher.handshaken and not stopping.is_set():
            try:
                queue.put_nowait({"jsonrpc": "2.0", "method": name, "params": jsonable(data)})
            except asyncio.QueueFull:
                # Notifications are hints; clients recover by querying persisted state.
                pass

    core.listeners.append(event)

    async def writer():
        while True:
            message = await queue.get()
            try:
                if message is None:
                    return
                line = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
                # Keep stdout exclusively for protocol; slow consumers cannot block
                # cancellation and acquisition in the Core event loop.
                await asyncio.to_thread(write_line, line)
            except (BrokenPipeError, OSError):
                stopping.set()
                return
            finally:
                queue.task_done()

    async def request(message):
        response = await dispatcher.handle(message)
        if response is not None:
            await queue.put(response)

    output = asyncio.create_task(writer())
    stop_wait = asyncio.create_task(stopping.wait())
    read_wait = None
    try:
        while not stopping.is_set():
            read_wait = asyncio.create_task(reader.readline())
            done, _ = await asyncio.wait({read_wait, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
            if stop_wait in done:
                read_wait.cancel()
                await asyncio.gather(read_wait, return_exceptions=True)
                break
            try:
                line = read_wait.result()
            except ValueError:
                await queue.put(Dispatcher.error(None, -32600, "Protocol line exceeds size limit"))
                break
            if not line:
                break
            try:
                message = json.loads(line.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            except (ValueError, UnicodeError):
                await queue.put(Dispatcher.error(None, -32700, "Parse error"))
                continue
            if browser and browser.receive(message):
                continue
            if len(line) > MAX_LINE_BYTES:
                await queue.put(Dispatcher.error(None, -32600, "Request line exceeds 64 KiB"))
                continue
            if len(pending) >= 32:
                await queue.put(Dispatcher.error(message.get("id") if isinstance(message, dict) else None, -32002, "Too many pending requests"))
                continue
            task = asyncio.create_task(request(message))
            pending.add(task)
            task.add_done_callback(pending.discard)
    finally:
        transport.close()
        stop_wait.cancel()
        await asyncio.gather(stop_wait, return_exceptions=True)
        # A shutdown request completes quickly; long remote checks are cancelled.
        if pending:
            _, unfinished = await asyncio.wait(pending, timeout=0.1)
            for task in unfinished:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        core.listeners.remove(event)
        await core.close()
        if browser:
            browser.send = None
        if not output.done():
            await queue.put(None)
        await output


def write_line(line):
    sys.stdout.write(line)
    sys.stdout.flush()
