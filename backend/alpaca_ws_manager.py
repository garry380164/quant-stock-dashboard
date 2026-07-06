import asyncio
import json
import logging
import os
import time
from datetime import datetime
from typing import Awaitable, Callable

import websockets
from dotenv import load_dotenv


logger = logging.getLogger("quantx.alpaca.websocket")

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))


class AlpacaWebSocketAuthError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(f"Alpaca websocket auth failed: code={code} message={message}")
        self.code = code
        self.message = message


class AlpacaWebSocketManager:
    def __init__(
        self,
        api_key: str | None,
        secret_key: str | None,
        get_symbols: Callable[[], Awaitable[list[str]]],
        apply_ticks: Callable[[dict[str, dict]], Awaitable[None]],
        subscription_limit: int = 30,
    ):
        self.api_key = (api_key or "").strip()
        self.secret_key = (secret_key or "").strip()
        self.get_symbols = get_symbols
        self.apply_ticks = apply_ticks
        self.subscription_limit = subscription_limit
        self.ws_url = "wss://stream.data.alpaca.markets/v2/iex"
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._connected = False
        self._last_tick_at = 0.0
        self._subscribed_symbols: set[str] = set()
        self._pending_ticks: dict[str, dict] = {}
        self._last_flush_at = 0.0
        self._last_no_tick_log_at = 0.0
        self._disabled_reason: str | None = None

    @classmethod
    def from_environment(
        cls,
        get_symbols: Callable[[], Awaitable[list[str]]],
        apply_ticks: Callable[[dict[str, dict]], Awaitable[None]],
        subscription_limit: int = 30,
    ):
        api_key = os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID")
        secret_key = os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY")
        return cls(
            api_key=api_key,
            secret_key=secret_key,
            get_symbols=get_symbols,
            apply_ticks=apply_ticks,
            subscription_limit=subscription_limit,
        )

    def start(self) -> None:
        enabled = os.environ.get("ALPACA_WS_ENABLED", "true").strip().lower()
        if enabled in {"0", "false", "no", "off"}:
            self._disabled_reason = "disabled_by_env"
            logger.warning("ALPACA_WS_DISABLED reason=disabled_by_env env_key=ALPACA_WS_ENABLED")
            return
        if self._disabled_reason:
            logger.warning("ALPACA_WS_DISABLED reason=%s", self._disabled_reason)
            return
        if not self.api_key or not self.secret_key:
            logger.warning(
                "ALPACA_WS_DISABLED reason=missing_credentials env_keys=ALPACA_API_KEY|ALPACA_SECRET_KEY|APCA_API_KEY_ID|APCA_API_SECRET_KEY"
            )
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

    def is_connected(self) -> bool:
        return self._connected

    def has_received_tick(self) -> bool:
        return self._last_tick_at > 0

    async def _run_forever(self) -> None:
        reconnect_delay = 3
        while not self._stop_event.is_set():
            try:
                await self._connect_and_consume()
                reconnect_delay = 3
            except asyncio.CancelledError:
                raise
            except AlpacaWebSocketAuthError as exc:
                self._connected = False
                if exc.code == 406:
                    self._disabled_reason = "connection_limit_exceeded"
                    logger.warning(
                        "ALPACA_WS_DISABLED reason=connection_limit_exceeded message=%s fallback=simulated_quotes action=stop_extra_backend_processes_or_wait_for_provider_release",
                        exc.message,
                    )
                    return

                logger.exception(
                    "ALPACA_WS_AUTH_FAILED code=%s message=%s reconnect_in_seconds=%s",
                    exc.code,
                    exc.message,
                    reconnect_delay,
                )
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 60)
            except Exception as exc:
                self._connected = False
                logger.exception(
                    "ALPACA_WS_DISCONNECTED error=%s reconnect_in_seconds=%s",
                    exc,
                    reconnect_delay,
                )
                await asyncio.sleep(reconnect_delay)
                reconnect_delay = min(reconnect_delay * 2, 60)

    async def _connect_and_consume(self) -> None:
        logger.info("ALPACA_WS_CONNECTING url=%s feed=iex", self.ws_url)
        async with websockets.connect(self.ws_url, ping_interval=20, ping_timeout=20) as websocket:
            self._connected = True
            self._last_tick_at = 0.0
            logger.info("ALPACA_WS_CONNECTED")

            await self._wait_for_connected(websocket)
            await websocket.send(json.dumps({
                "action": "auth",
                "key": self.api_key,
                "secret": self.secret_key,
            }))
            await self._wait_for_authenticated(websocket)
            await self._subscribe_current_symbols(websocket)

            resubscribe_task = asyncio.create_task(self._resubscribe_loop(websocket))
            try:
                async for raw_message in websocket:
                    await self._handle_message(raw_message)
            finally:
                resubscribe_task.cancel()
                self._connected = False
                self._subscribed_symbols.clear()

    async def _wait_for_connected(self, websocket) -> None:
        raw_message = await asyncio.wait_for(websocket.recv(), timeout=10)
        events = self._decode_events(raw_message)
        for event in events:
            logger.info(
                "ALPACA_WS_STATUS event_type=%s code=%s message=%s",
                event.get("T"),
                event.get("code"),
                event.get("msg"),
            )
            if event.get("T") == "success" and event.get("msg") == "connected":
                return
        raise RuntimeError(f"Alpaca websocket did not return connected: {raw_message[:300]}")

    async def _wait_for_authenticated(self, websocket) -> None:
        deadline = time.monotonic() + 10
        last_status_message = ""

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(
                    f"Alpaca websocket auth timed out waiting for authenticated. last_status={last_status_message}"
                )

            raw_message = await asyncio.wait_for(websocket.recv(), timeout=remaining)
            events = self._decode_events(raw_message)
            for event in events:
                event_type = event.get("T")
                message = event.get("msg")
                code = event.get("code")
                last_status_message = f"{event_type}: {code}: {message}"
                logger.info(
                    "ALPACA_WS_AUTH_STATUS event_type=%s code=%s message=%s",
                    event_type,
                    code,
                    message,
                )

                if event_type == "success" and message == "authenticated":
                    return
                if event_type == "error":
                    raise AlpacaWebSocketAuthError(code, message)

    async def _subscribe_current_symbols(self, websocket) -> None:
        symbols = await self.get_symbols()
        symbols = [symbol.strip().upper() for symbol in symbols if symbol and not symbol.endswith(".TW")]
        symbols = list(dict.fromkeys(symbols))[: self.subscription_limit]
        desired_symbols = set(symbols)
        new_symbols = sorted(desired_symbols - self._subscribed_symbols)
        if not new_symbols:
            return

        await websocket.send(json.dumps({"action": "subscribe", "trades": new_symbols}))
        self._subscribed_symbols.update(new_symbols)
        logger.info(
            "ALPACA_WS_SUBSCRIBE feed=iex channel=trades count=%s limit=%s symbols=%s",
            len(new_symbols),
            self.subscription_limit,
            ",".join(new_symbols),
        )

    async def _resubscribe_loop(self, websocket) -> None:
        while True:
            await asyncio.sleep(30)
            if self._connected and not self.has_received_tick():
                logger.info(
                    "ALPACA_WS_NO_TICKS_YET feed=iex subscribed_count=%s likely_reason=market_closed_or_no_iex_trades",
                    len(self._subscribed_symbols),
                )
            await self._subscribe_current_symbols(websocket)

    def _decode_events(self, raw_message: str) -> list[dict]:
        try:
            payload = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.warning("ALPACA_WS_BAD_JSON message=%s", raw_message[:300])
            return []
        return payload if isinstance(payload, list) else [payload]

    async def _handle_message(self, raw_message: str) -> None:
        events = self._decode_events(raw_message)
        for event in events:
            event_type = event.get("T")
            if event_type in {"success", "subscription"}:
                logger.info(
                    "ALPACA_WS_STATUS event_type=%s message=%s trades=%s",
                    event_type,
                    event.get("msg"),
                    ",".join(event.get("trades", []) or []),
                )
                continue
            if event_type == "error":
                logger.error(
                    "ALPACA_WS_ERROR code=%s message=%s likely_reason=%s",
                    event.get("code"),
                    event.get("msg"),
                    self._describe_error(event.get("code")),
                )
                continue
            if event_type != "t":
                continue

            symbol = event.get("S")
            price = event.get("p")
            if not symbol or price is None:
                continue

            self._pending_ticks[symbol] = {
                "symbol": symbol,
                "price": float(price),
                "size": int(event.get("s") or 0),
                "timestamp": self._parse_timestamp(event.get("t")),
                "source": "alpaca_iex_ws",
            }
            self._last_tick_at = time.time()

        if self._pending_ticks and (time.time() - self._last_flush_at) >= 1:
            pending = self._pending_ticks
            self._pending_ticks = {}
            self._last_flush_at = time.time()
            await self.apply_ticks(pending)

    def _parse_timestamp(self, value) -> int:
        if not value:
            return int(time.time() * 1000)
        if isinstance(value, (int, float)):
            return int(value)
        try:
            return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return int(time.time() * 1000)

    def _describe_error(self, code) -> str:
        if code == 405:
            return "symbol_limit_exceeded"
        if code == 406:
            return "connection_limit_exceeded"
        if code == 409:
            return "insufficient_subscription"
        return "provider_error"
