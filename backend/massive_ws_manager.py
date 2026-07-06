import asyncio
import json
import logging
import time
from typing import Awaitable, Callable

import websockets

from backend.db_manager import DBManager


logger = logging.getLogger("quantx.massive.websocket")


class MassiveWebSocketManager:
    def __init__(
        self,
        api_key: str | None,
        db_manager: DBManager,
        get_symbols: Callable[[], Awaitable[list[str]]],
        apply_ticks: Callable[[dict[str, dict]], Awaitable[None]],
    ):
        self.api_key = (api_key or "").strip()
        self.db_manager = db_manager
        self.get_symbols = get_symbols
        self.apply_ticks = apply_ticks
        self.ws_url = "wss://socket.polygon.io/stocks"
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._connected = False
        self._last_tick_at = 0.0
        self._subscribed_symbols: set[str] = set()
        self._pending_ticks: dict[str, dict] = {}
        self._last_flush_at = 0.0

    def start(self) -> None:
        if not self.api_key:
            logger.warning("MASSIVE_WS_DISABLED reason=missing_api_key")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._run_forever())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def is_live(self) -> bool:
        return self._connected and (time.time() - self._last_tick_at) < 15

    async def _run_forever(self) -> None:
        reconnect_delay = 3
        while not self._stop_event.is_set():
            try:
                await self._connect_and_consume()
                reconnect_delay = 3
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connected = False
                logger.exception(
                    "MASSIVE_WS_DISCONNECTED error=%s reconnect_in_seconds=%s",
                    exc,
                    reconnect_delay,
                )
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 60)

    async def _connect_and_consume(self) -> None:
        logger.info("MASSIVE_WS_CONNECTING url=%s", self.ws_url)
        async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20) as websocket:
            self._connected = True
            self._last_tick_at = 0.0
            logger.info("MASSIVE_WS_CONNECTED")

            await websocket.send(json.dumps({"action": "auth", "params": self.api_key}))
            await self._wait_for_auth(websocket)
            await self._subscribe_current_symbols(websocket)

            resubscribe_task = asyncio.create_task(self._resubscribe_loop(websocket))
            try:
                async for raw_message in websocket:
                    await self._handle_message(raw_message)
            finally:
                resubscribe_task.cancel()
                self._connected = False
                self._subscribed_symbols.clear()

    async def _wait_for_auth(self, websocket) -> None:
        deadline = time.monotonic() + 10
        last_status_message = ""

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(
                    f"Massive websocket auth timed out waiting for auth_success. last_status={last_status_message}"
                )

            raw_message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid auth response: {raw_message[:300]}") from exc

            events = payload if isinstance(payload, list) else [payload]
            saw_status = False
            for event in events:
                if event.get("ev") != "status":
                    continue

                saw_status = True
                status = event.get("status")
                message = event.get("message")
                last_status_message = f"{status}: {message}"
                logger.info("MASSIVE_WS_AUTH_STATUS status=%s message=%s", status, message)

                if status == "auth_success":
                    return
                if status == "auth_failed":
                    raise RuntimeError(f"Massive websocket auth failed: {message}")

            if not saw_status:
                await self._handle_message(raw_message)

    async def _subscribe_current_symbols(self, websocket) -> None:
        symbols = await self.get_symbols()
        symbols = [symbol for symbol in symbols if symbol and not symbol.endswith(".TW")]
        desired_symbols = set(symbols)
        new_symbols = sorted(desired_symbols - self._subscribed_symbols)
        if not new_symbols:
            return

        params = ",".join(f"T.{symbol}" for symbol in new_symbols)
        await websocket.send(json.dumps({"action": "subscribe", "params": params}))
        self._subscribed_symbols.update(new_symbols)
        logger.info(
            "MASSIVE_WS_SUBSCRIBE count=%s symbols=%s",
            len(new_symbols),
            ",".join(new_symbols),
        )

    async def _resubscribe_loop(self, websocket) -> None:
        while True:
            await asyncio.sleep(30)
            await self._subscribe_current_symbols(websocket)

    async def _handle_message(self, raw_message: str) -> None:
        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.warning("MASSIVE_WS_BAD_JSON message=%s", raw_message[:300])
            return

        events = payload if isinstance(payload, list) else [payload]
        for event in events:
            event_type = event.get("ev")
            if event_type == "status":
                logger.info(
                    "MASSIVE_WS_STATUS status=%s message=%s",
                    event.get("status"),
                    event.get("message"),
                )
                continue

            if event_type != "T":
                continue

            symbol = event.get("sym")
            price = event.get("p")
            if not symbol or price is None:
                continue

            self._pending_ticks[symbol] = {
                "symbol": symbol,
                "price": float(price),
                "size": int(event.get("s") or 0),
                "timestamp": int(event.get("t") or time.time() * 1000),
            }
            self._last_tick_at = time.time()

        if self._pending_ticks and (time.time() - self._last_flush_at) >= 1:
            pending = self._pending_ticks
            self._pending_ticks = {}
            self._last_flush_at = time.time()
            await self.apply_ticks(pending)
