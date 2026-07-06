import os
import time
import asyncio
import urllib.parse
import hashlib
import random
import logging
from datetime import datetime, timedelta, timezone
import httpx
from dotenv import load_dotenv
from backend.db_manager import DBManager

logger = logging.getLogger("quantx.massive")
kline_logger = logging.getLogger("quantx.kline.source")

# 讀取 .env 檔案
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '.env'))

# 預設的 100 檔模擬美股資料，當無 API Key 或連線失敗時使用
MOCK_US_TICKERS = [
    {"ticker": "AAPL", "name": "Apple Inc."},
    {"ticker": "MSFT", "name": "Microsoft Corporation"},
    {"ticker": "NVDA", "name": "NVIDIA Corporation"},
    {"ticker": "TSLA", "name": "Tesla, Inc."},
    {"ticker": "GOOGL", "name": "Alphabet Inc."},
    {"ticker": "AMZN", "name": "Amazon.com, Inc."},
    {"ticker": "META", "name": "Meta Platforms, Inc."},
    {"ticker": "NFLX", "name": "Netflix, Inc."},
    {"ticker": "AMD", "name": "Advanced Micro Devices, Inc."},
    {"ticker": "INTC", "name": "Intel Corporation"},
    {"ticker": "COIN", "name": "Coinbase Global, Inc."},
    {"ticker": "HOOD", "name": "Robinhood Markets, Inc."},
    {"ticker": "PLTR", "name": "Palantir Technologies Inc."},
    {"ticker": "ARM", "name": "Arm Holdings plc"},
    {"ticker": "AVGO", "name": "Broadcom Inc."},
    {"ticker": "QCOM", "name": "Qualcomm Incorporated"},
    {"ticker": "MU", "name": "Micron Technology, Inc."},
    {"ticker": "ASML", "name": "ASML Holding N.V."},
    {"ticker": "TSM", "name": "Taiwan Semiconductor Manufacturing Company"},
    {"ticker": "BABA", "name": "Alibaba Group Holding Limited"},
    {"ticker": "PDD", "name": "PDD Holdings Inc."},
    {"ticker": "JD", "name": "JD.com, Inc."},
    {"ticker": "NIO", "name": "NIO Inc."},
    {"ticker": "LI", "name": "Li Auto Inc."},
    {"ticker": "XPEV", "name": "XPeng Inc."},
    {"ticker": "DIS", "name": "The Walt Disney Company"},
    {"ticker": "NFLX", "name": "Netflix, Inc."},
    {"ticker": "NKE", "name": "NIKE, Inc."},
    {"ticker": "SBUX", "name": "Starbucks Corporation"},
    {"ticker": "MCD", "name": "McDonald's Corporation"},
    {"ticker": "KO", "name": "The Coca-Cola Company"},
    {"ticker": "PEP", "name": "PepsiCo, Inc."},
    {"ticker": "COST", "name": "Costco Wholesale Corporation"},
    {"ticker": "WMT", "name": "Walmart Inc."},
    {"ticker": "JPM", "name": "JPMorgan Chase & Co."},
    {"ticker": "BAC", "name": "Bank of America Corporation"},
    {"ticker": "MS", "name": "Morgan Stanley"},
    {"ticker": "GS", "name": "The Goldman Sachs Group, Inc."},
    {"ticker": "C", "name": "Citigroup Inc."},
    {"ticker": "WFC", "name": "Wells Fargo & Company"},
    {"ticker": "V", "name": "Visa Inc."},
    {"ticker": "MA", "name": "Mastercard Incorporated"},
    {"ticker": "PYPL", "name": "PayPal Holdings, Inc."},
    {"ticker": "SQ", "name": "Block, Inc."},
    {"ticker": "XOM", "name": "Exxon Mobil Corporation"},
    {"ticker": "CVX", "name": "Chevron Corporation"},
    {"ticker": "SHEL", "name": "Shell plc"},
    {"ticker": "BP", "name": "BP p.l.c."},
    {"ticker": "CAT", "name": "Caterpillar Inc."},
    {"ticker": "GE", "name": "General Electric Company"},
    {"ticker": "BA", "name": "The Boeing Company"},
    {"ticker": "LMT", "name": "Lockheed Martin Corporation"},
    {"ticker": "RTX", "name": "RTX Corporation"},
    {"ticker": "UNH", "name": "UnitedHealth Group Incorporated"},
    {"ticker": "LLY", "name": "Eli Lilly and Company"},
    {"ticker": "JNJ", "name": "Johnson & Johnson"},
    {"ticker": "PFE", "name": "Pfizer Inc."},
    {"ticker": "MRNA", "name": "Moderna, Inc."},
    {"ticker": "ABBV", "name": "AbbVie Inc."},
    {"ticker": "MRK", "name": "Merck & Co., Inc."},
    {"ticker": "T", "name": "AT&T Inc."},
    {"ticker": "VZ", "name": "Verizon Communications Inc."},
    {"ticker": "TMUS", "name": "T-Mobile US, Inc."},
    {"ticker": "CSCO", "name": "Cisco Systems, Inc."},
    {"ticker": "ORCL", "name": "Oracle Corporation"},
    {"ticker": "CRM", "name": "Salesforce, Inc."},
    {"ticker": "ADBE", "name": "Adobe Inc."},
    {"ticker": "PANW", "name": "Palo Alto Networks, Inc."},
    {"ticker": "CRWD", "name": "CrowdStrike Holdings, Inc."},
    {"ticker": "SNOW", "name": "Snowflake Inc."},
    {"ticker": "NET", "name": "Cloudflare, Inc."},
    {"ticker": "DDOG", "name": "Datadog, Inc."},
    {"ticker": "TEAM", "name": "Atlassian Corporation"},
    {"ticker": "WDAY", "name": "Workday, Inc."},
    {"ticker": "SHOP", "name": "Shopify Inc."},
    {"ticker": "UBER", "name": "Uber Technologies, Inc."},
    {"ticker": "LYFT", "name": "Lyft, Inc."},
    {"ticker": "ABNB", "name": "Airbnb, Inc."},
    {"ticker": "BKNG", "name": "Booking Holdings Inc."},
    {"ticker": "HD", "name": "The Home Depot, Inc."},
    {"ticker": "LOW", "name": "Lowe's Companies, Inc."},
    {"ticker": "TGT", "name": "Target Corporation"},
    {"ticker": "TJX", "name": "The TJX Companies, Inc."},
    {"ticker": "DG", "name": "Dollar General Corporation"},
    {"ticker": "DLTR", "name": "Dollar Tree, Inc."},
    {"ticker": "F", "name": "Ford Motor Company"},
    {"ticker": "GM", "name": "General Motors Company"},
    {"ticker": "RIVN", "name": "Rivian Automotive, Inc."},
    {"ticker": "LCID", "name": "Lucid Group, Inc."},
    {"ticker": "DKNG", "name": "DraftKings Inc."},
    {"ticker": "PINS", "name": "Pinterest, Inc."},
    {"ticker": "SNAP", "name": "Snap Inc."},
    {"ticker": "RBLX", "name": "Roblox Corporation"},
    {"ticker": "TTD", "name": "The Trade Desk, Inc."},
    {"ticker": "U", "name": "Unity Software Inc."},
    {"ticker": "ZI", "name": "ZoomInfo Technologies Inc."},
    {"ticker": "ZM", "name": "Zoom Video Communications, Inc."},
    {"ticker": "DOCU", "name": "DocuSign, Inc."},
    {"ticker": "OKTA", "name": "Okta, Inc."},
    {"ticker": "SPLK", "name": "Splunk Inc."}
]

TOP_MARKET_CAP_TICKERS = [
    {"ticker": "NVDA", "name": "NVIDIA Corporation"},
    {"ticker": "MSFT", "name": "Microsoft Corporation"},
    {"ticker": "AAPL", "name": "Apple Inc."},
    {"ticker": "GOOGL", "name": "Alphabet Inc."},
    {"ticker": "AMZN", "name": "Amazon.com, Inc."},
    {"ticker": "META", "name": "Meta Platforms, Inc."},
    {"ticker": "AVGO", "name": "Broadcom Inc."},
    {"ticker": "TSLA", "name": "Tesla, Inc."},
    {"ticker": "WMT", "name": "Walmart Inc."},
    {"ticker": "LLY", "name": "Eli Lilly and Company"},
    {"ticker": "JPM", "name": "JPMorgan Chase & Co."},
    {"ticker": "V", "name": "Visa Inc."},
    {"ticker": "MA", "name": "Mastercard Incorporated"},
    {"ticker": "XOM", "name": "Exxon Mobil Corporation"},
    {"ticker": "COST", "name": "Costco Wholesale Corporation"},
    {"ticker": "NFLX", "name": "Netflix, Inc."},
    {"ticker": "ORCL", "name": "Oracle Corporation"},
    {"ticker": "HD", "name": "The Home Depot, Inc."},
    {"ticker": "JNJ", "name": "Johnson & Johnson"},
    {"ticker": "BAC", "name": "Bank of America Corporation"},
    {"ticker": "PG", "name": "Procter & Gamble Company"},
    {"ticker": "KO", "name": "The Coca-Cola Company"},
    {"ticker": "CSCO", "name": "Cisco Systems, Inc."},
    {"ticker": "AMD", "name": "Advanced Micro Devices, Inc."},
    {"ticker": "ADBE", "name": "Adobe Inc."},
    {"ticker": "CRM", "name": "Salesforce, Inc."},
    {"ticker": "MCD", "name": "McDonald's Corporation"},
    {"ticker": "PEP", "name": "PepsiCo, Inc."},
    {"ticker": "DIS", "name": "The Walt Disney Company"},
    {"ticker": "NKE", "name": "NIKE, Inc."},
    {"ticker": "QCOM", "name": "Qualcomm Incorporated"},
    {"ticker": "INTC", "name": "Intel Corporation"},
    {"ticker": "IBM", "name": "International Business Machines Corporation"},
    {"ticker": "GE", "name": "GE Aerospace"},
    {"ticker": "CAT", "name": "Caterpillar Inc."},
    {"ticker": "UBER", "name": "Uber Technologies, Inc."},
    {"ticker": "RTX", "name": "RTX Corporation"},
    {"ticker": "LMT", "name": "Lockheed Martin Corporation"},
    {"ticker": "BA", "name": "The Boeing Company"},
    {"ticker": "SBUX", "name": "Starbucks Corporation"},
    {"ticker": "AMAT", "name": "Applied Materials, Inc."},
    {"ticker": "MU", "name": "Micron Technology, Inc."},
    {"ticker": "PANW", "name": "Palo Alto Networks, Inc."},
    {"ticker": "CRWD", "name": "CrowdStrike Holdings, Inc."},
    {"ticker": "SHOP", "name": "Shopify Inc."},
]

class MassiveClient:
    def __init__(self, db_manager: DBManager):
        self.db_manager = db_manager
        # 同時相容 MASSIVE_API_KEY 與 POLYGON_API_KEY
        self.api_key = os.environ.get("MASSIVE_API_KEY") or os.environ.get("POLYGON_API_KEY")
        self.alpaca_api_key = os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID")
        self.alpaca_secret_key = os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY")
        self.kline_data_source = (
            os.environ.get("KLINE_DATA_SOURCE")
            or os.environ.get("MARKET_DATA_SOURCE")
            or "massive"
        ).strip().lower()
        # 官方新域名是 api.massive.com，保留舊域名 api.polygon.io 作為相容
        self.base_url = "https://api.polygon.io"  # 如果您使用的是真實 Massive API，可以使用 "https://api.massive.com"
        self.alpaca_data_url = "https://data.alpaca.markets"
        logger.info(
            "MASSIVE_CLIENT_INIT base_url=%s api_key_present=%s kline_data_source=%s alpaca_key_present=%s",
            self.base_url,
            bool(self.api_key and self.api_key.strip()),
            self.kline_data_source,
            bool(self.alpaca_api_key and self.alpaca_secret_key),
        )

    def _response_body_preview(self, response: httpx.Response, max_length: int = 300):
        text = response.text.replace("\r", " ").replace("\n", " ").strip()
        if len(text) > max_length:
            return f"{text[:max_length]}..."
        return text

    def _mock_market_cap(self, ticker: str):
        known_caps = {
            "NVDA": 3_600_000_000_000,
            "MSFT": 3_300_000_000_000,
            "AAPL": 3_200_000_000_000,
            "GOOGL": 2_200_000_000_000,
            "AMZN": 2_100_000_000_000,
            "META": 1_500_000_000_000,
            "AVGO": 900_000_000_000,
            "TSLA": 800_000_000_000,
            "WMT": 650_000_000_000,
            "LLY": 620_000_000_000,
            "JPM": 600_000_000_000,
            "V": 560_000_000_000,
            "MA": 480_000_000_000,
            "XOM": 470_000_000_000,
            "COST": 440_000_000_000,
            "NFLX": 420_000_000_000,
            "ORCL": 400_000_000_000,
            "HD": 390_000_000_000,
            "JNJ": 360_000_000_000,
            "BAC": 340_000_000_000,
            "PG": 330_000_000_000,
            "KO": 300_000_000_000,
            "CSCO": 250_000_000_000,
            "AMD": 240_000_000_000,
            "ADBE": 230_000_000_000,
            "CRM": 220_000_000_000,
            "MCD": 210_000_000_000,
            "PEP": 200_000_000_000,
            "DIS": 190_000_000_000,
            "NKE": 120_000_000_000,
        }
        if ticker in known_caps:
            return known_caps[ticker]

        h = hashlib.md5(ticker.encode("utf-8")).hexdigest()
        return 5_000_000_000 + (int(h[:8], 16) % 120_000_000_000)

    async def _fetch_market_caps(self, client: httpx.AsyncClient, symbols: list[str]):
        async def fetch_one(symbol: str):
            url = f"{self.base_url}/v3/reference/tickers/{urllib.parse.quote(symbol)}?apiKey={self.api_key}"
            try:
                response = await client.get(url)
                if response.status_code != 200:
                    logger.warning(
                        "MASSIVE_MARKET_CAP_ERROR symbol=%s status_code=%s body=%s",
                        symbol,
                        response.status_code,
                        self._response_body_preview(response),
                    )
                    return symbol, None

                data = response.json()
                result = data.get("results") or {}
                market_cap = result.get("market_cap")
                if market_cap is None:
                    logger.warning("MASSIVE_MARKET_CAP_MISSING symbol=%s", symbol)
                    return symbol, None
                return symbol, float(market_cap)
            except Exception as exc:
                logger.exception("MASSIVE_MARKET_CAP_EXCEPTION symbol=%s error=%s", symbol, exc)
                return symbol, None

        pairs = await asyncio.gather(*(fetch_one(symbol) for symbol in symbols))
        return {symbol: market_cap for symbol, market_cap in pairs}
        
    def _generate_price_details(self, ticker: str):
        """基於 Ticker 的 Hash 值生成穩定的基準價與隨機跳動價格"""
        # 使用 MD5 算出一個固定的 hash
        h = hashlib.md5(ticker.encode('utf-8')).hexdigest()
        hash_int = int(h[:6], 16)
        
        # 基準價在 25 ~ 425 之間
        base_price = (hash_int % 400) + 25.0
        
        # 加入一個基於當前時間的微小隨機跳動，使之看起來像即時價格
        # 每分鐘跳動範圍限制在 -1% ~ +1%
        now_minute = int(time.time() / 15)  # 每 15 秒跳動一次
        random.seed(hash_int + now_minute)
        
        pct_change = random.uniform(-0.015, 0.015)
        price = round(base_price * (1 + pct_change), 2)
        change = round(base_price * pct_change, 2)
        change_percent = round(pct_change * 100, 2)
        high_24h = round(price * random.uniform(1.002, 1.02), 2)
        low_24h = round(price * random.uniform(0.98, 0.998), 2)
        
        return {
            "price": price,
            "change": change,
            "changePercent": change_percent,
            "high24h": high_24h,
            "low24h": low_24h
        }

    def _timeframe_to_polygon_range(self, timeframe: str):
        if timeframe == "15m":
            return 15, "minute"
        if timeframe == "1d":
            return 1, "day"
        return 1, "hour"

    def _timeframe_to_alpaca(self, timeframe: str):
        if timeframe == "15m":
            return "15Min"
        if timeframe == "1d":
            return "1Day"
        return "1Hour"

    def _lookback_start_date(self, timeframe: str, limit: int, before: int = None):
        now = (
            datetime.fromtimestamp(before / 1000, timezone.utc)
            if before
            else datetime.now(timezone.utc)
        )
        if timeframe == "15m":
            start = now - timedelta(days=max(10, int(limit / 12)))
        elif timeframe == "1d":
            start = now - timedelta(days=max(365, int(limit * 2.4)))
        else:
            start = now - timedelta(days=max(45, int(limit / 4)))
        return start.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")

    def _lookback_start_iso(self, timeframe: str, limit: int, before: int = None):
        now = (
            datetime.fromtimestamp(before / 1000, timezone.utc)
            if before
            else datetime.now(timezone.utc)
        )
        if timeframe == "15m":
            start = now - timedelta(days=max(10, int(limit / 12)))
        elif timeframe == "1d":
            start = now - timedelta(days=max(365, int(limit * 2.4)))
        else:
            start = now - timedelta(days=max(45, int(limit / 4)))
        return start.isoformat().replace("+00:00", "Z"), now.isoformat().replace("+00:00", "Z")

    def _parse_alpaca_timestamp(self, timestamp_value):
        if not timestamp_value:
            return 0
        if isinstance(timestamp_value, (int, float)):
            return int(timestamp_value)
        try:
            return int(datetime.fromisoformat(str(timestamp_value).replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0

    async def get_stock_klines(self, symbol: str, timeframe: str = "1h", limit: int = 200, before: int = None):
        """Fetch historical aggregate bars from the configured provider and normalize them for the chart."""
        normalized_symbol = (symbol or "").strip().upper()
        normalized_timeframe = timeframe if timeframe in {"15m", "1h", "1d"} else "1h"
        capped_limit = max(1, min(int(limit or 200), 1000))
        before_ts = int(before) if before else None
        configured_source = self.kline_data_source
        if configured_source in {"alpaca", "alpaca_iex", "iex"}:
            configured_source = "alpaca_iex"
        elif configured_source not in {"massive", "polygon"}:
            kline_logger.warning(
                "KLINE_SOURCE_INVALID configured_source=%s fallback_source=massive",
                self.kline_data_source,
            )
            configured_source = "massive"

        if not normalized_symbol:
            kline_logger.error(
                "KLINE_REQUEST_INVALID symbol=%s timeframe=%s reason=missing_symbol",
                symbol,
                normalized_timeframe,
            )
            return {
                "symbol": normalized_symbol,
                "timeframe": normalized_timeframe,
                "source": "error",
                "klines": [],
                "error": "Missing symbol",
            }

        use_mock = False
        if configured_source == "alpaca_iex":
            alpaca_key_present = bool(self.alpaca_api_key and self.alpaca_secret_key)
            kline_logger.info(
                "KLINE_SOURCE_DECISION symbol=%s timeframe=%s limit=%s configured_source=alpaca_iex api_key_present=%s initial_source=%s",
                normalized_symbol,
                normalized_timeframe,
                capped_limit,
                alpaca_key_present,
                "alpaca_iex" if alpaca_key_present else "local_fallback",
            )
            if not alpaca_key_present:
                kline_logger.warning(
                    "KLINE_ALPACA_SKIPPED symbol=%s timeframe=%s reason=missing_credentials env_keys=ALPACA_API_KEY|ALPACA_SECRET_KEY|APCA_API_KEY_ID|APCA_API_SECRET_KEY",
                    normalized_symbol,
                    normalized_timeframe,
                )
                use_mock = True
            else:
                alpaca_timeframe = self._timeframe_to_alpaca(normalized_timeframe)
                start_iso, end_iso = self._lookback_start_iso(normalized_timeframe, capped_limit, before_ts)
                url = f"{self.alpaca_data_url}/v2/stocks/bars"
                params = {
                    "symbols": normalized_symbol,
                    "timeframe": alpaca_timeframe,
                    "start": start_iso,
                    "end": end_iso,
                    "limit": capped_limit,
                    "adjustment": "raw",
                    "feed": "iex",
                    "sort": "desc",
                }
                headers = {
                    "APCA-API-KEY-ID": self.alpaca_api_key,
                    "APCA-API-SECRET-KEY": self.alpaca_secret_key,
                }

                try:
                    async with httpx.AsyncClient(timeout=12.0) as client:
                        kline_logger.info(
                            "KLINE_ALPACA_REQUEST symbol=%s timeframe=%s alpaca_timeframe=%s feed=iex start=%s end=%s limit=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            alpaca_timeframe,
                            start_iso,
                            end_iso,
                            capped_limit,
                        )
                        response = await client.get(url, params=params, headers=headers)

                    if response.status_code == 200:
                        data = response.json()
                        bars_by_symbol = data.get("bars") or {}
                        bars = bars_by_symbol.get(normalized_symbol, []) or []
                        klines = [
                            {
                                "timestamp": self._parse_alpaca_timestamp(bar.get("t")),
                                "open": round(float(bar.get("o", 0)), 4),
                                "high": round(float(bar.get("h", 0)), 4),
                                "low": round(float(bar.get("l", 0)), 4),
                                "close": round(float(bar.get("c", 0)), 4),
                                "volume": int(bar.get("v", 0) or 0),
                            }
                            for bar in bars
                            if bar.get("t") is not None
                        ]
                        klines = [bar for bar in klines if bar["timestamp"] > 0]
                        if before_ts:
                            klines = [bar for bar in klines if bar["timestamp"] < before_ts]

                        if not klines:
                            kline_logger.warning(
                                "KLINE_ALPACA_FALLBACK symbol=%s timeframe=%s reason=empty_results status_code=%s",
                                normalized_symbol,
                                normalized_timeframe,
                                response.status_code,
                            )
                            use_mock = True
                        else:
                            kline_logger.info(
                                "KLINE_SOURCE_USED symbol=%s timeframe=%s source=alpaca_iex status_code=%s bars=%s capped_bars=%s",
                                normalized_symbol,
                                normalized_timeframe,
                                response.status_code,
                                len(klines),
                                len(klines[-capped_limit:]),
                            )
                            return {
                                "symbol": normalized_symbol,
                                "timeframe": normalized_timeframe,
                                "source": "alpaca_iex",
                                "klines": list(reversed(klines[:capped_limit])),
                            }
                    else:
                        kline_logger.warning(
                            "KLINE_ALPACA_RESPONSE_ERROR symbol=%s timeframe=%s status_code=%s body=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                            self._response_body_preview(response),
                        )
                        kline_logger.warning(
                            "KLINE_ALPACA_FALLBACK symbol=%s timeframe=%s reason=http_error status_code=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                        )
                        use_mock = True
                except Exception as e:
                    kline_logger.exception(
                        "KLINE_ALPACA_FALLBACK symbol=%s timeframe=%s reason=exception error=%s",
                        normalized_symbol,
                        normalized_timeframe,
                        e,
                    )
                    use_mock = True
        else:
            use_mock = not self.api_key or self.api_key.strip() == ""
            kline_logger.info(
                "KLINE_SOURCE_DECISION symbol=%s timeframe=%s limit=%s configured_source=massive api_key_present=%s initial_source=%s",
                normalized_symbol,
                normalized_timeframe,
                capped_limit,
                not use_mock,
                "massive" if not use_mock else "local_fallback",
            )
            if use_mock:
                kline_logger.warning(
                    "KLINE_MASSIVE_SKIPPED symbol=%s timeframe=%s reason=missing_api_key env_keys=MASSIVE_API_KEY|POLYGON_API_KEY",
                    normalized_symbol,
                    normalized_timeframe,
                )

            if not use_mock:
                multiplier, timespan = self._timeframe_to_polygon_range(normalized_timeframe)
                from_date, to_date = self._lookback_start_date(normalized_timeframe, capped_limit, before_ts)
                url = (
                    f"{self.base_url}/v2/aggs/ticker/{urllib.parse.quote(normalized_symbol)}/range/"
                    f"{multiplier}/{timespan}/{from_date}/{to_date}"
                    f"?adjusted=true&sort=asc&limit=50000&apiKey={self.api_key}"
                )

                try:
                    async with httpx.AsyncClient(timeout=12.0) as client:
                        kline_logger.info(
                            "KLINE_MASSIVE_REQUEST symbol=%s timeframe=%s multiplier=%s timespan=%s from=%s to=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            multiplier,
                            timespan,
                            from_date,
                            to_date,
                        )
                        response = await client.get(url)

                    if response.status_code == 200:
                        data = response.json()
                        bars = data.get("results", []) or []
                        klines = [
                            {
                                "timestamp": int(bar.get("t")),
                                "open": round(float(bar.get("o", 0)), 4),
                                "high": round(float(bar.get("h", 0)), 4),
                                "low": round(float(bar.get("l", 0)), 4),
                                "close": round(float(bar.get("c", 0)), 4),
                                "volume": int(bar.get("v", 0) or 0),
                            }
                            for bar in bars
                            if bar.get("t") is not None
                        ]
                        if before_ts:
                            klines = [bar for bar in klines if bar["timestamp"] < before_ts]

                        if not klines:
                            kline_logger.warning(
                                "KLINE_MASSIVE_FALLBACK symbol=%s timeframe=%s reason=empty_results status_code=%s provider_status=%s",
                                normalized_symbol,
                                normalized_timeframe,
                                response.status_code,
                                data.get("status"),
                            )
                            use_mock = True
                        else:
                            kline_logger.info(
                                "KLINE_SOURCE_USED symbol=%s timeframe=%s source=massive status_code=%s bars=%s capped_bars=%s",
                                normalized_symbol,
                                normalized_timeframe,
                                response.status_code,
                                len(klines),
                                len(klines[-capped_limit:]),
                            )
                            return {
                                "symbol": normalized_symbol,
                                "timeframe": normalized_timeframe,
                                "source": "massive",
                                "klines": klines[-capped_limit:],
                            }
                    elif response.status_code == 429:
                        kline_logger.info(
                            "KLINE_MASSIVE_RESPONSE_ERROR symbol=%s timeframe=%s status_code=%s body=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                            self._response_body_preview(response),
                        )
                        kline_logger.warning(
                            "KLINE_MASSIVE_FALLBACK symbol=%s timeframe=%s reason=rate_limit status_code=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                        )
                        use_mock = True
                    else:
                        kline_logger.warning(
                            "KLINE_MASSIVE_RESPONSE_ERROR symbol=%s timeframe=%s status_code=%s body=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                            self._response_body_preview(response),
                        )
                        kline_logger.warning(
                            "KLINE_MASSIVE_FALLBACK symbol=%s timeframe=%s reason=http_error status_code=%s",
                            normalized_symbol,
                            normalized_timeframe,
                            response.status_code,
                        )
                        use_mock = True
                except Exception as e:
                    kline_logger.exception(
                        "KLINE_MASSIVE_FALLBACK symbol=%s timeframe=%s reason=exception error=%s",
                        normalized_symbol,
                        normalized_timeframe,
                        e,
                    )
                    use_mock = True

        if use_mock:
            klines = await self.db_manager.get_klines(normalized_symbol, normalized_timeframe, capped_limit, before_ts)
            if klines:
                kline_logger.info(
                    "KLINE_SOURCE_USED symbol=%s timeframe=%s source=sqlite bars=%s capped_bars=%s",
                    normalized_symbol,
                    normalized_timeframe,
                    len(klines),
                    len(klines),
                )
                return {
                    "symbol": normalized_symbol,
                    "timeframe": normalized_timeframe,
                    "source": "sqlite",
                    "klines": klines,
                }

            from backend.db_manager import generate_history_klines

            price_info = self._generate_price_details(normalized_symbol)
            generated_klines = generate_history_klines(
                normalized_symbol,
                price_info["price"],
                capped_limit,
                normalized_timeframe,
            )
            kline_logger.info(
                "KLINE_SOURCE_USED symbol=%s timeframe=%s source=generated bars=%s base_price=%s",
                normalized_symbol,
                normalized_timeframe,
                len(generated_klines),
                price_info["price"],
            )
            return {
                "symbol": normalized_symbol,
                "timeframe": normalized_timeframe,
                "source": "generated",
                "klines": generated_klines,
            }

    async def get_all_us_stocks(self, limit: int = 20, cursor: str = None, search: str = None, sort: str = None):
        """獲取所有美股股票清單 (支援滾動分頁與搜尋)"""
        # 1. 取得資料庫中已加入自選的股票，以便在結果中標註 isFav=True
        fav_stocks = await self.db_manager.get_stocks("US")
        fav_symbols_map = {s["symbol"]: s for s in fav_stocks}
        
        results = []
        next_cursor = None
        use_ranked_market_cap_universe = sort == "market_cap" and not search
        
        # 2. 判斷是否使用真實 API
        use_mock = not self.api_key or self.api_key.strip() == ""
        if use_ranked_market_cap_universe:
            logger.info(
                "MASSIVE_STOCKS_MARKET_CAP_UNIVERSE source=ranked_universe reason=avoid_reference_ticker_alpha_sort limit=%s cursor=%s",
                limit,
                cursor or "",
            )
            use_mock = True
        
        if not use_mock:
            try:
                # 建立 HTTP 非同步 client
                async with httpx.AsyncClient(timeout=10.0) as client:
                    # 如果有 cursor，代表請求下一頁
                    if cursor:
                        # cursor 通常是 Polygon 返回的下一個 cursor 參數值
                        url = f"{self.base_url}/v3/reference/tickers?cursor={cursor}&apiKey={self.api_key}"
                    else:
                        url = f"{self.base_url}/v3/reference/tickers?market=stocks&active=true&limit={limit}&apiKey={self.api_key}"
                        if search:
                            url += f"&search={search}"
                            
                    logger.info(
                        "MASSIVE_STOCKS_REQUEST limit=%s cursor_present=%s search_present=%s sort=%s",
                        limit,
                        bool(cursor),
                        bool(search),
                        sort or "default",
                    )
                    response = await client.get(url)
                    
                    if response.status_code == 200:
                        data = response.json()
                        tickers_data = data.get("results", [])
                        market_caps = {}
                        if sort == "market_cap" and tickers_data:
                            symbols = [t.get("ticker") for t in tickers_data if t.get("ticker")]
                            market_caps = await self._fetch_market_caps(client, symbols)
                            logger.info(
                                "MASSIVE_MARKET_CAP_ENRICHED requested=%s found=%s",
                                len(symbols),
                                sum(1 for value in market_caps.values() if value is not None),
                            )
                        
                        # 萃取下一頁的 cursor
                        next_url = data.get("next_url")
                        if next_url:
                            parsed_url = urllib.parse.urlparse(next_url)
                            query_params = urllib.parse.parse_qs(parsed_url.query)
                            cursors = query_params.get("cursor")
                            if cursors:
                                next_cursor = cursors[0]
                                
                        # 處理取得的股票資料
                        for t in tickers_data:
                            symbol = t.get("ticker")
                            name = t.get("name", symbol)
                            
                            # 預設價格屬性
                            price_info = self._generate_price_details(symbol)
                            
                            # 如果該股票已經在自選庫中，使用自選庫內與即時更新同步的價格
                            is_fav = symbol in fav_symbols_map
                            if is_fav:
                                db_stock = fav_symbols_map[symbol]
                                price_info["price"] = db_stock["price"]
                                price_info["change"] = db_stock["change"]
                                price_info["changePercent"] = db_stock["changePercent"]
                                price_info["high24h"] = db_stock["high24h"]
                                price_info["low24h"] = db_stock["low24h"]
                                
                            results.append({
                                "symbol": symbol,
                                "name": name,
                                "price": price_info["price"],
                                "change": price_info["change"],
                                "changePercent": price_info["changePercent"],
                                "high24h": price_info["high24h"],
                                "low24h": price_info["low24h"],
                                "marketCap": market_caps.get(symbol),
                                "market": "US",
                                "isFav": is_fav
                            })
                        if sort == "market_cap":
                            results.sort(key=lambda item: item.get("marketCap") or 0, reverse=True)
                    elif response.status_code == 429:
                        logger.warning(
                            "MASSIVE_STOCKS_FALLBACK reason=rate_limit status_code=%s body=%s",
                            response.status_code,
                            self._response_body_preview(response),
                        )
                        use_mock = True
                    else:
                        logger.warning(
                            "MASSIVE_STOCKS_FALLBACK reason=http_error status_code=%s body=%s",
                            response.status_code,
                            self._response_body_preview(response),
                        )
                        use_mock = True
            except Exception as e:
                logger.exception("MASSIVE_STOCKS_FALLBACK reason=exception error=%s", e)
                use_mock = True
                
        # 3. Mock Fallback 模式
        if use_mock:
            # 對靜態清單做搜尋過濾
            source_tickers = TOP_MARKET_CAP_TICKERS if use_ranked_market_cap_universe else MOCK_US_TICKERS
            if search:
                s_query = search.strip().lower()
                source_tickers = [
                    t for t in source_tickers 
                    if s_query in t["ticker"].lower() or s_query in t["name"].lower()
                ]
            if sort == "market_cap":
                source_tickers = sorted(
                    source_tickers,
                    key=lambda t: self._mock_market_cap(t["ticker"]),
                    reverse=True,
                )
                
            # 分頁邏輯 (以 page 模擬 cursor)
            page = 1
            if cursor and cursor.startswith("page_"):
                try:
                    page = int(cursor.split("_")[1])
                except:
                    page = 1
                    
            start_idx = (page - 1) * limit
            end_idx = start_idx + limit
            
            sliced_tickers = source_tickers[start_idx:end_idx]
            
            # 判斷是否還有下一頁
            if end_idx < len(source_tickers):
                next_cursor = f"page_{page + 1}"
            else:
                next_cursor = None
                
            for t in sliced_tickers:
                symbol = t["ticker"]
                name = t["name"]
                
                # 取得價格
                price_info = self._generate_price_details(symbol)
                
                is_fav = symbol in fav_symbols_map
                if is_fav:
                    db_stock = fav_symbols_map[symbol]
                    price_info["price"] = db_stock["price"]
                    price_info["change"] = db_stock["change"]
                    price_info["changePercent"] = db_stock["changePercent"]
                    price_info["high24h"] = db_stock["high24h"]
                    price_info["low24h"] = db_stock["low24h"]
                    
                results.append({
                    "symbol": symbol,
                    "name": name,
                    "price": price_info["price"],
                    "change": price_info["change"],
                    "changePercent": price_info["changePercent"],
                    "high24h": price_info["high24h"],
                    "low24h": price_info["low24h"],
                    "marketCap": self._mock_market_cap(symbol),
                    "market": "US",
                    "isFav": is_fav
                })
                
        return {
            "results": results,
            "next_cursor": next_cursor
        }
