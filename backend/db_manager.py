import os
import random
import time
import asyncio
import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
import aiosqlite

# 資料庫路徑 (預設為本機 quant.db)
DB_PATH_ENV = os.getenv("DATABASE_URL")
if DB_PATH_ENV:
    DB_PATH = Path(DB_PATH_ENV)
else:
    DB_PATH = Path(__file__).parent.parent / "quant.db"

KLINE_TIMEFRAMES = ("15m", "1h", "4h", "1d", "1w", "1M")
KLINE_HISTORY_COUNT = 10000
KLINE_SEED_BATCH_SIZE = 1000
MAX_KLINE_VOLUME = 2_000_000_000
INTRADAY_TIMEFRAMES = {"15m", "1h", "4h"}
TRADING_DAY_TIMEFRAMES = INTRADAY_TIMEFRAMES | {"1d"}
SESSION_GAP_LIMITS = {
    "15m": 0.0025,
    "1h": 0.0055,
    "4h": 0.008,
    "1d": 0.008,
}
ADJACENT_OPEN_GAP_TRIGGER = 0.005
ADJACENT_OPEN_GAP_MIN = 0.003
ADJACENT_OPEN_GAP_MAX = 0.01
MARKET_SESSIONS = {
    "US": {
        "timezone": ZoneInfo("America/New_York"),
        "open_minute": 9 * 60 + 30,
        "close_minute": 16 * 60,
    },
    "TW": {
        "timezone": ZoneInfo("Asia/Taipei"),
        "open_minute": 9 * 60,
        "close_minute": 13 * 60 + 30,
    },
}

def timeframe_interval_ms(timeframe: str):
    if timeframe == '15m':
        return 15 * 60 * 1000
    if timeframe == '4h':
        return 4 * 60 * 60 * 1000
    if timeframe == '1d':
        return 24 * 60 * 60 * 1000
    if timeframe == '1w':
        return 7 * 24 * 60 * 60 * 1000
    if timeframe == '1M':
        return 30 * 24 * 60 * 60 * 1000
    return 60 * 60 * 1000

def bar_start_timestamp(timestamp_ms: int, timeframe: str):
    interval = timeframe_interval_ms(timeframe)
    return (timestamp_ms // interval) * interval

def _clamp(value: float, min_value: float, max_value: float):
    return max(min_value, min(max_value, value))

def _session_gap_limit(timeframe: str):
    return SESSION_GAP_LIMITS.get(timeframe, 0.03)

def _intraday_return_cap(timeframe: str):
    return {
        "15m": 0.0025,
        "1h": 0.0065,
        "4h": 0.015,
    }.get(timeframe, 0.03)

def has_session_gap(previous_timestamp: int, next_timestamp: int, timeframe: str):
    interval = timeframe_interval_ms(timeframe)
    return int(next_timestamp) - int(previous_timestamp) > interval * 1.5

def smooth_session_gap_bar(previous_close: float, bar: dict, timeframe: str):
    safe_previous_close = max(float(previous_close or 0), 0.01)
    safe_open = max(float(bar.get("open") or safe_previous_close), 0.01)
    safe_close = max(float(bar.get("close") or safe_open), 0.01)
    gap_limit = _session_gap_limit(timeframe)
    body_limit = gap_limit
    wick_limit = gap_limit * 1.2
    open_gap_pct = (safe_open - safe_previous_close) / safe_previous_close
    close_gap_pct = (safe_close - safe_previous_close) / safe_previous_close
    high_gap_pct = (max(float(bar.get("high") or safe_open), safe_open, safe_close) - safe_previous_close) / safe_previous_close
    low_gap_pct = (min(float(bar.get("low") or safe_open), safe_open, safe_close) - safe_previous_close) / safe_previous_close
    clamped_open_gap_pct = _clamp(open_gap_pct, -gap_limit, gap_limit)
    clamped_close_gap_pct = _clamp(close_gap_pct, -body_limit, body_limit)
    clamped_high_gap_pct = _clamp(high_gap_pct, -wick_limit, wick_limit)
    clamped_low_gap_pct = _clamp(low_gap_pct, -wick_limit, wick_limit)

    if (
        clamped_open_gap_pct == open_gap_pct
        and clamped_close_gap_pct == close_gap_pct
        and clamped_high_gap_pct == high_gap_pct
        and clamped_low_gap_pct == low_gap_pct
    ):
        return bar

    target_open = safe_previous_close * (1 + clamped_open_gap_pct)
    target_close = safe_previous_close * (1 + clamped_close_gap_pct)
    target_high = safe_previous_close * (1 + clamped_high_gap_pct)
    target_low = safe_previous_close * max(0.01, 1 + clamped_low_gap_pct)
    next_bar = dict(bar)
    next_bar["open"] = round(max(target_open, 0.01), 2)
    next_bar["close"] = round(max(target_close, 0.01), 2)
    next_bar["high"] = round(max(target_high, target_open, target_close, 0.01), 2)
    next_bar["low"] = round(max(min(target_low, target_open, target_close), 0.01), 2)
    next_bar["high"] = max(next_bar["high"], next_bar["open"], next_bar["close"])
    next_bar["low"] = min(next_bar["low"], next_bar["open"], next_bar["close"])
    return next_bar

def clamp_bar_return_range(previous_close: float, bar: dict, timeframe: str):
    safe_previous_close = max(float(previous_close or 0), 0.01)
    cap = _intraday_return_cap(timeframe)
    if cap <= 0:
        return bar

    next_bar = dict(bar)
    for key in ("open", "high", "low", "close"):
        value = max(float(next_bar.get(key) or safe_previous_close), 0.01)
        pct = (value - safe_previous_close) / safe_previous_close
        clamped_value = safe_previous_close * (1 + _clamp(pct, -cap, cap))
        next_bar[key] = round(max(clamped_value, 0.01), 2)

    next_bar["high"] = max(next_bar["high"], next_bar["open"], next_bar["close"])
    next_bar["low"] = min(next_bar["low"], next_bar["open"], next_bar["close"])
    return next_bar

def smooth_adjacent_open_gap(previous_close: float, bar: dict, timeframe: str):
    safe_previous_close = max(float(previous_close or 0), 0.01)
    safe_open = max(float(bar.get("open") or safe_previous_close), 0.01)
    gap_pct = (safe_open - safe_previous_close) / safe_previous_close
    abs_gap_pct = abs(gap_pct)
    if abs_gap_pct <= ADJACENT_OPEN_GAP_TRIGGER:
        return bar

    target_gap_pct = _clamp(abs_gap_pct, ADJACENT_OPEN_GAP_MIN, ADJACENT_OPEN_GAP_MAX)
    target_open = safe_previous_close * (1 + (target_gap_pct if gap_pct >= 0 else -target_gap_pct))
    rounded_open = round(max(target_open, 0.01), 2)
    min_open = safe_previous_close * (1 + (ADJACENT_OPEN_GAP_MIN if gap_pct >= 0 else -ADJACENT_OPEN_GAP_MAX))
    max_open = safe_previous_close * (1 + (ADJACENT_OPEN_GAP_MAX if gap_pct >= 0 else -ADJACENT_OPEN_GAP_MIN))
    if gap_pct >= 0:
        rounded_open = min(rounded_open, round(max_open, 2))
        while rounded_open > 0 and ((rounded_open - safe_previous_close) / safe_previous_close) > ADJACENT_OPEN_GAP_MAX:
            rounded_open = round(rounded_open - 0.01, 2)
        while ((rounded_open - safe_previous_close) / safe_previous_close) < ADJACENT_OPEN_GAP_MIN:
            rounded_open = round(rounded_open + 0.01, 2)
    else:
        rounded_open = max(rounded_open, round(max_open, 2))
        while rounded_open > 0 and ((safe_previous_close - rounded_open) / safe_previous_close) > ADJACENT_OPEN_GAP_MAX:
            rounded_open = round(rounded_open + 0.01, 2)
        while ((safe_previous_close - rounded_open) / safe_previous_close) < ADJACENT_OPEN_GAP_MIN:
            rounded_open = round(rounded_open - 0.01, 2)
    next_bar = dict(bar)
    next_bar["open"] = max(rounded_open, 0.01)
    next_bar["high"] = round(max(float(next_bar.get("high") or next_bar["open"]), next_bar["open"], float(next_bar.get("close") or next_bar["open"]), 0.01), 2)
    next_bar["low"] = round(max(min(float(next_bar.get("low") or next_bar["open"]), next_bar["open"], float(next_bar.get("close") or next_bar["open"])), 0.01), 2)
    next_bar["high"] = max(next_bar["high"], next_bar["open"], next_bar["close"])
    next_bar["low"] = min(next_bar["low"], next_bar["open"], next_bar["close"])
    return next_bar

def scale_kline_bar(bar: dict, scale: float):
    if scale == 1:
        return dict(bar)

    next_bar = dict(bar)
    next_bar["open"] = round(max(float(next_bar["open"]) * scale, 0.01), 2)
    next_bar["high"] = round(max(float(next_bar["high"]) * scale, 0.01), 2)
    next_bar["low"] = round(max(float(next_bar["low"]) * scale, 0.01), 2)
    next_bar["close"] = round(max(float(next_bar["close"]) * scale, 0.01), 2)
    next_bar["high"] = max(next_bar["high"], next_bar["open"], next_bar["close"])
    next_bar["low"] = min(next_bar["low"], next_bar["open"], next_bar["close"])
    return next_bar

def smooth_session_gaps(data: list[dict], timeframe: str):
    if not data:
        return data

    smoothed = [dict(data[0])]
    carry_scale = 1.0
    for bar in data[1:]:
        next_bar = scale_kline_bar(bar, carry_scale)
        previous_bar = smoothed[-1]
        if has_session_gap(previous_bar["timestamp"], next_bar["timestamp"], timeframe):
            original_close = max(float(next_bar["close"] or 0), 0.01)
            next_bar = smooth_session_gap_bar(previous_bar["close"], next_bar, timeframe)
            carry_scale *= max(float(next_bar["close"] or 0), 0.01) / original_close
        next_bar = smooth_adjacent_open_gap(previous_bar["close"], next_bar, timeframe)
        smoothed.append(next_bar)

    original_last_close = max(float(data[-1].get("close") or 0), 0.01)
    smoothed_last_close = max(float(smoothed[-1].get("close") or 0), 0.01)
    level_scale = original_last_close / smoothed_last_close
    if abs(level_scale - 1) > 0.000001:
        smoothed = [scale_kline_bar(bar, level_scale) for bar in smoothed]
    return smoothed

def market_for_symbol(symbol: str):
    return "TW" if (symbol or "").strip().upper().endswith(".TW") else "US"

def _market_session(symbol: str):
    return MARKET_SESSIONS[market_for_symbol(symbol)]

def _local_datetime_to_ms(local_dt: datetime):
    return int(local_dt.timestamp() * 1000)

def _is_weekday(local_dt: datetime):
    return local_dt.weekday() < 5

def is_trading_bar_timestamp(symbol: str, timeframe: str, timestamp_ms: int):
    normalized_timeframe = timeframe if timeframe in KLINE_TIMEFRAMES else "1h"
    if normalized_timeframe not in TRADING_DAY_TIMEFRAMES:
        return True

    session = _market_session(symbol)
    local_dt = datetime.fromtimestamp(int(timestamp_ms) / 1000, session["timezone"])
    if not _is_weekday(local_dt):
        return False
    if normalized_timeframe == "1d":
        return True

    minute = local_dt.hour * 60 + local_dt.minute
    return session["open_minute"] <= minute < session["close_minute"]

def is_local_kline_timestamp(symbol: str, timeframe: str, timestamp_ms: int):
    if not is_trading_bar_timestamp(symbol, timeframe, timestamp_ms):
        return False
    if timeframe == "4h":
        session = _market_session(symbol)
        local_dt = datetime.fromtimestamp(int(timestamp_ms) / 1000, session["timezone"])
        minute_of_day = local_dt.hour * 60 + local_dt.minute
        interval_minutes = timeframe_interval_ms("4h") // (60 * 1000)
        return minute_of_day >= session["open_minute"] and (minute_of_day - session["open_minute"]) % interval_minutes == 0
    if timeframe != "1h":
        return True

    session = _market_session(symbol)
    local_dt = datetime.fromtimestamp(int(timestamp_ms) / 1000, session["timezone"])
    return local_dt.minute == 0

def _trading_bar_starts_for_day(symbol: str, timeframe: str, local_day):
    session = _market_session(symbol)
    if local_day.weekday() >= 5:
        return []

    open_minute = session["open_minute"]
    close_minute = session["close_minute"]
    interval_minutes = timeframe_interval_ms(timeframe) // (60 * 1000)
    start_minute = open_minute
    if timeframe == "1h":
        start_minute = math.ceil(open_minute / interval_minutes) * interval_minutes

    starts = []
    minute = start_minute
    while minute < close_minute:
        starts.append(_local_datetime_to_ms(datetime(
            local_day.year,
            local_day.month,
            local_day.day,
            minute // 60,
            minute % 60,
            tzinfo=session["timezone"],
        )))
        minute += interval_minutes
    return starts

def _first_weekday_of_month(local_dt: datetime, session):
    day = local_dt.replace(day=1, hour=session["open_minute"] // 60, minute=session["open_minute"] % 60, second=0, microsecond=0)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day

def aggregate_kline_bucket_timestamp(symbol: str, timestamp_ms: int, target_timeframe: str):
    session = _market_session(symbol)
    local_dt = datetime.fromtimestamp(int(timestamp_ms) / 1000, session["timezone"])
    session_open = local_dt.replace(
        hour=session["open_minute"] // 60,
        minute=session["open_minute"] % 60,
        second=0,
        microsecond=0,
    )

    if target_timeframe == "1h":
        return _local_datetime_to_ms(local_dt.replace(minute=0, second=0, microsecond=0))
    if target_timeframe == "4h":
        # Align 4h candles to the market session open instead of midnight so
        # intraday bars stay anchored to real trading hours.
        interval_minutes = timeframe_interval_ms("4h") // (60 * 1000)
        open_minute = session["open_minute"]
        minutes_since_open = (local_dt.hour * 60 + local_dt.minute) - open_minute

        if minutes_since_open < 0:
            bucket_start = session_open
        else:
            bucket_offset = (minutes_since_open // interval_minutes) * interval_minutes
            bucket_start = session_open + timedelta(minutes=bucket_offset)

        return _local_datetime_to_ms(bucket_start.replace(second=0, microsecond=0))
    if target_timeframe == "1d":
        return _local_datetime_to_ms(session_open)
    if target_timeframe == "1w":
        week_start = local_dt - timedelta(days=local_dt.weekday())
        week_open = week_start.replace(
            hour=session["open_minute"] // 60,
            minute=session["open_minute"] % 60,
            second=0,
            microsecond=0,
        )
        return _local_datetime_to_ms(week_open)
    if target_timeframe == "1M":
        return _local_datetime_to_ms(_first_weekday_of_month(local_dt, session))
    return int(timestamp_ms)

def aggregate_klines_from_15m(symbol: str, base_rows: list[dict], target_timeframe: str):
    if target_timeframe == "15m":
        return [dict(row) for row in base_rows]

    buckets: dict[int, dict] = {}
    order: list[int] = []
    for row in sorted(base_rows, key=lambda item: int(item["timestamp"])):
        bucket_ts = aggregate_kline_bucket_timestamp(symbol, int(row["timestamp"]), target_timeframe)
        if bucket_ts not in buckets:
            buckets[bucket_ts] = {
                "timestamp": bucket_ts,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row.get("volume") or 0),
            }
            order.append(bucket_ts)
            continue

        bucket = buckets[bucket_ts]
        bucket["high"] = max(float(bucket["high"]), float(row["high"]))
        bucket["low"] = min(float(bucket["low"]), float(row["low"]))
        bucket["close"] = float(row["close"])
        bucket["volume"] = min(MAX_KLINE_VOLUME, int(bucket.get("volume") or 0) + int(row.get("volume") or 0))

    return [buckets[timestamp] for timestamp in order]

def generate_trading_timestamps(symbol: str, timeframe: str, count: int, before_timestamp: int = None):
    normalized_timeframe = timeframe if timeframe in KLINE_TIMEFRAMES else "1h"
    target_count = max(0, int(count or 0))
    if target_count == 0:
        return []

    session = _market_session(symbol)
    cutoff_ms = int(before_timestamp) if before_timestamp else int(time.time() * 1000) + 1
    cutoff_local = datetime.fromtimestamp((cutoff_ms - 1) / 1000, session["timezone"])
    timestamps = []

    if normalized_timeframe in INTRADAY_TIMEFRAMES:
        local_day = cutoff_local.date()
        while len(timestamps) < target_count:
            day_starts = _trading_bar_starts_for_day(symbol, normalized_timeframe, local_day)
            timestamps.extend(ts for ts in reversed(day_starts) if ts < cutoff_ms)
            local_day -= timedelta(days=1)
        return list(reversed(timestamps[:target_count]))

    if normalized_timeframe == "1d":
        local_day = cutoff_local.date()
        while len(timestamps) < target_count:
            if local_day.weekday() < 5:
                ts = _local_datetime_to_ms(datetime(
                    local_day.year,
                    local_day.month,
                    local_day.day,
                    session["open_minute"] // 60,
                    session["open_minute"] % 60,
                    tzinfo=session["timezone"],
                ))
                if ts < cutoff_ms:
                    timestamps.append(ts)
            local_day -= timedelta(days=1)
        return list(reversed(timestamps[:target_count]))

    if normalized_timeframe == "1w":
        local_day = cutoff_local.date()
        local_day -= timedelta(days=local_day.weekday())
        while len(timestamps) < target_count:
            ts = _local_datetime_to_ms(datetime(
                local_day.year,
                local_day.month,
                local_day.day,
                session["open_minute"] // 60,
                session["open_minute"] % 60,
                tzinfo=session["timezone"],
            ))
            if ts < cutoff_ms:
                timestamps.append(ts)
            local_day -= timedelta(days=7)
        return list(reversed(timestamps[:target_count]))

    month_cursor = cutoff_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    while len(timestamps) < target_count:
        month_open = _first_weekday_of_month(month_cursor, session)
        ts = _local_datetime_to_ms(month_open)
        if ts < cutoff_ms:
            timestamps.append(ts)
        previous_month_last_day = month_cursor.replace(day=1) - timedelta(days=1)
        month_cursor = previous_month_last_day.replace(day=1)
    return list(reversed(timestamps[:target_count]))

# ??
INITIAL_STOCKS_US = [
    { "symbol": 'AAPL', "name": 'Apple Inc.', "price": 182.52, "change": 1.25, "changePercent": 0.69, "high24h": 184.20, "low24h": 181.12, "volume": 54.2, "isFav": 1 },
    { "symbol": 'MSFT', "name": 'Microsoft Corp.', "price": 415.50, "change": -2.45, "changePercent": -0.59, "high24h": 420.12, "low24h": 413.20, "volume": 22.8, "isFav": 1 },
    { "symbol": 'TSLA', "name": 'Tesla Inc.', "price": 175.34, "change": 8.42, "changePercent": 5.04, "high24h": 178.50, "low24h": 166.30, "volume": 88.5, "isFav": 1 },
    { "symbol": 'NVDA', "name": 'NVIDIA Corp.', "price": 875.12, "change": 24.15, "changePercent": 2.84, "high24h": 884.80, "low24h": 850.10, "volume": 48.9, "isFav": 1 },
    { "symbol": 'GOOGL', "name": 'Alphabet Inc.', "price": 151.60, "change": -0.85, "changePercent": -0.56, "high24h": 153.20, "low24h": 150.50, "volume": 28.3, "isFav": 0 },
    { "symbol": 'AMZN', "name": 'Amazon.com Inc.', "price": 178.15, "change": 1.98, "changePercent": 1.12, "high24h": 179.43, "low24h": 176.02, "volume": 31.4, "isFav": 0 },
]

LOCAL_TRADING_PAIRS_US = [
    *INITIAL_STOCKS_US,
    { "symbol": 'META', "name": 'Meta Platforms Inc.', "price": 506.30, "change": 2.10, "changePercent": 0.42, "high24h": 511.25, "low24h": 500.80, "volume": 18.4, "isFav": 1 },
    { "symbol": 'NFLX', "name": 'Netflix Inc.', "price": 642.12, "change": -3.20, "changePercent": -0.50, "high24h": 651.40, "low24h": 638.30, "volume": 4.9, "isFav": 0 },
    { "symbol": 'AMD', "name": 'Advanced Micro Devices Inc.', "price": 162.44, "change": 1.90, "changePercent": 1.18, "high24h": 165.80, "low24h": 159.20, "volume": 42.1, "isFav": 1 },
    { "symbol": 'INTC', "name": 'Intel Corp.', "price": 35.72, "change": -0.18, "changePercent": -0.50, "high24h": 36.40, "low24h": 35.10, "volume": 38.6, "isFav": 0 },
    { "symbol": 'AVGO', "name": 'Broadcom Inc.', "price": 1342.50, "change": 18.30, "changePercent": 1.38, "high24h": 1360.10, "low24h": 1318.60, "volume": 3.8, "isFav": 0 },
    { "symbol": 'QCOM', "name": 'Qualcomm Inc.', "price": 198.12, "change": 1.05, "changePercent": 0.53, "high24h": 200.80, "low24h": 195.30, "volume": 9.7, "isFav": 0 },
    { "symbol": 'MU', "name": 'Micron Technology Inc.', "price": 141.80, "change": 2.44, "changePercent": 1.75, "high24h": 144.10, "low24h": 138.90, "volume": 19.8, "isFav": 0 },
    { "symbol": 'ADBE', "name": 'Adobe Inc.', "price": 512.62, "change": -1.72, "changePercent": -0.33, "high24h": 518.20, "low24h": 508.40, "volume": 2.7, "isFav": 0 },
    { "symbol": 'CRM', "name": 'Salesforce Inc.', "price": 284.15, "change": 0.95, "changePercent": 0.34, "high24h": 288.90, "low24h": 281.30, "volume": 5.6, "isFav": 0 },
    { "symbol": 'ORCL', "name": 'Oracle Corp.', "price": 128.44, "change": 0.55, "changePercent": 0.43, "high24h": 130.20, "low24h": 126.90, "volume": 8.2, "isFav": 0 },
    { "symbol": 'IBM', "name": 'International Business Machines', "price": 185.30, "change": -0.42, "changePercent": -0.23, "high24h": 187.10, "low24h": 183.60, "volume": 4.1, "isFav": 0 },
    { "symbol": 'JPM', "name": 'JPMorgan Chase & Co.', "price": 198.80, "change": 0.72, "changePercent": 0.36, "high24h": 201.20, "low24h": 196.40, "volume": 11.4, "isFav": 0 },
    { "symbol": 'BAC', "name": 'Bank of America Corp.', "price": 39.20, "change": 0.12, "changePercent": 0.31, "high24h": 39.80, "low24h": 38.70, "volume": 43.0, "isFav": 0 },
    { "symbol": 'V', "name": 'Visa Inc.', "price": 276.45, "change": 1.15, "changePercent": 0.42, "high24h": 279.00, "low24h": 273.80, "volume": 6.5, "isFav": 0 },
    { "symbol": 'MA', "name": 'Mastercard Inc.', "price": 462.10, "change": 2.35, "changePercent": 0.51, "high24h": 466.40, "low24h": 458.20, "volume": 3.2, "isFav": 0 },
    { "symbol": 'UNH', "name": 'UnitedHealth Group Inc.', "price": 492.25, "change": -2.18, "changePercent": -0.44, "high24h": 498.60, "low24h": 489.70, "volume": 4.4, "isFav": 0 },
    { "symbol": 'LLY', "name": 'Eli Lilly and Co.', "price": 812.70, "change": 7.20, "changePercent": 0.89, "high24h": 820.00, "low24h": 802.30, "volume": 3.1, "isFav": 0 },
    { "symbol": 'JNJ', "name": 'Johnson & Johnson', "price": 151.22, "change": -0.28, "changePercent": -0.18, "high24h": 153.00, "low24h": 150.10, "volume": 7.0, "isFav": 0 },
    { "symbol": 'XOM', "name": 'Exxon Mobil Corp.', "price": 112.75, "change": 0.84, "changePercent": 0.75, "high24h": 114.10, "low24h": 111.20, "volume": 15.9, "isFav": 0 },
    { "symbol": 'CVX', "name": 'Chevron Corp.', "price": 154.85, "change": 0.66, "changePercent": 0.43, "high24h": 156.40, "low24h": 153.30, "volume": 7.5, "isFav": 0 },
    { "symbol": 'COST', "name": 'Costco Wholesale Corp.', "price": 824.30, "change": 4.80, "changePercent": 0.59, "high24h": 831.10, "low24h": 815.60, "volume": 2.1, "isFav": 0 },
    { "symbol": 'WMT', "name": 'Walmart Inc.', "price": 68.40, "change": 0.31, "changePercent": 0.46, "high24h": 69.20, "low24h": 67.70, "volume": 20.5, "isFav": 0 },
    { "symbol": 'HD', "name": 'Home Depot Inc.', "price": 356.50, "change": -1.24, "changePercent": -0.35, "high24h": 360.80, "low24h": 353.90, "volume": 4.0, "isFav": 0 },
    { "symbol": 'KO', "name": 'Coca-Cola Co.', "price": 62.12, "change": 0.10, "changePercent": 0.16, "high24h": 62.80, "low24h": 61.50, "volume": 14.1, "isFav": 0 },
]

# ???
INITIAL_STOCKS_TW = [
    { "symbol": '2330.TW', "name": '????(TSMC)', "price": 790.00, "change": 12.00, "changePercent": 1.54, "high24h": 796.00, "low24h": 782.00, "volume": 32.4, "isFav": 1 },
    { "symbol": '2317.TW', "name": ' (Foxconn)', "price": 155.50, "change": -1.50, "changePercent": -0.96, "high24h": 158.00, "low24h": 154.00, "volume": 45.2, "isFav": 1 },
    { "symbol": '2454.TW', "name": '??(MediaTek)', "price": 1120.00, "change": 25.00, "changePercent": 2.28, "high24h": 1135.00, "low24h": 1095.00, "volume": 4.8, "isFav": 1 },
    { "symbol": '2308.TW', "name": '????(Delta)', "price": 342.00, "change": 5.50, "changePercent": 1.63, "high24h": 345.00, "low24h": 338.00, "volume": 8.9, "isFav": 0 },
    { "symbol": '2881.TW', "name": '??(Fubon)', "price": 71.20, "change": -0.30, "changePercent": -0.42, "high24h": 71.90, "low24h": 70.80, "volume": 15.6, "isFav": 0 },
    { "symbol": '2603.TW', "name": '? (Evergreen)', "price": 172.50, "change": -4.50, "changePercent": -2.54, "high24h": 178.00, "low24h": 171.00, "volume": 22.1, "isFav": 0 },
]

def _timeframe_volatility(timeframe: str):
    return {
        "15m": 0.0028,
        "1h": 0.0038,
        "4h": 0.008,
        "1d": 0.013,
        "1w": 0.026,
        "1M": 0.045,
    }.get(timeframe, 0.004)

def _timeframe_market_profile(timeframe: str):
    return {
        "15m": {
            "segment": (70, 220),
            "trend_probability": 0.34,
            "squeeze_probability": 0.18,
            "shock_probability": 0.055,
            "trend_strength": 0.55,
            "mean_reversion": 0.08,
        },
        "1h": {
            "segment": (60, 200),
            "trend_probability": 0.35,
            "squeeze_probability": 0.2,
            "shock_probability": 0.03,
            "trend_strength": 0.5,
            "mean_reversion": 0.085,
        },
        "4h": {
            "segment": (55, 180),
            "trend_probability": 0.54,
            "squeeze_probability": 0.13,
            "shock_probability": 0.045,
            "trend_strength": 0.9,
            "mean_reversion": 0.05,
        },
        "1d": {
            "segment": (45, 150),
            "trend_probability": 0.64,
            "squeeze_probability": 0.1,
            "shock_probability": 0.035,
            "trend_strength": 1.05,
            "mean_reversion": 0.035,
        },
        "1w": {
            "segment": (32, 105),
            "trend_probability": 0.74,
            "squeeze_probability": 0.07,
            "shock_probability": 0.025,
            "trend_strength": 1.2,
            "mean_reversion": 0.025,
        },
        "1M": {
            "segment": (20, 72),
            "trend_probability": 0.84,
            "squeeze_probability": 0.04,
            "shock_probability": 0.016,
            "trend_strength": 1.35,
            "mean_reversion": 0.018,
        },
    }.get(timeframe, {
        "segment": (60, 200),
        "trend_probability": 0.45,
        "squeeze_probability": 0.14,
        "shock_probability": 0.04,
        "trend_strength": 0.75,
        "mean_reversion": 0.06,
    })

def _stable_seed(*parts):
    text = "|".join(str(part) for part in parts)
    seed = 2166136261
    for char in text:
        seed ^= ord(char)
        seed = (seed * 16777619) & 0xffffffff
    return seed

def _choose_market_regime(rng, profile, previous_regime=None):
    roll = rng.random()
    trend_probability = profile["trend_probability"]
    squeeze_probability = profile["squeeze_probability"]
    shock_probability = profile["shock_probability"]

    if previous_regime in ("uptrend", "downtrend", "trend_up_chop", "trend_down_chop"):
        trend_probability = min(trend_probability + 0.14, 0.9)
    elif previous_regime in ("squeeze", "range"):
        squeeze_probability = max(squeeze_probability - 0.03, 0.02)

    if roll < shock_probability:
        return "capitulation_down" if rng.random() < 0.52 else "breakout_up"
    if roll < shock_probability + squeeze_probability:
        return "squeeze"
    if roll < shock_probability + squeeze_probability + trend_probability:
        up_bias = 0.54
        if previous_regime in ("downtrend", "trend_down_chop", "capitulation_down"):
            up_bias = 0.62
        elif previous_regime in ("uptrend", "trend_up_chop", "breakout_up"):
            up_bias = 0.48
        direction = "up" if rng.random() < up_bias else "down"
        if rng.random() < 0.28:
            return f"trend_{direction}_chop"
        return "uptrend" if direction == "up" else "downtrend"
    if rng.random() < 0.2:
        return "accumulation" if rng.random() < 0.55 else "distribution"
    return "range"

def _regime_parameters(regime: str, rng, vol: float, profile):
    trend = profile["trend_strength"]
    params = {
        "drift": 0.0,
        "vol": vol,
        "reversion": profile["mean_reversion"],
        "volume": 1.0,
        "wick": 0.8,
    }

    if regime == "uptrend":
        params.update({"drift": vol * rng.uniform(0.22, 0.42) * trend, "vol": vol * 0.85, "volume": 1.15, "wick": 0.7})
    elif regime == "downtrend":
        params.update({"drift": -vol * rng.uniform(0.22, 0.42) * trend, "vol": vol * 0.95, "volume": 1.25, "wick": 0.85})
    elif regime == "trend_up_chop":
        params.update({"drift": vol * rng.uniform(0.12, 0.25) * trend, "vol": vol * 1.18, "volume": 1.05, "wick": 1.05})
    elif regime == "trend_down_chop":
        params.update({"drift": -vol * rng.uniform(0.12, 0.25) * trend, "vol": vol * 1.25, "volume": 1.15, "wick": 1.15})
    elif regime == "breakout_up":
        params.update({"drift": vol * rng.uniform(0.25, 0.48) * trend, "vol": vol * 1.12, "reversion": 0.02, "volume": 1.65, "wick": 0.85})
    elif regime == "capitulation_down":
        params.update({"drift": -vol * rng.uniform(0.28, 0.5) * trend, "vol": vol * 1.28, "reversion": 0.015, "volume": 1.8, "wick": 1.0})
    elif regime == "squeeze":
        params.update({"drift": vol * rng.uniform(-0.025, 0.025), "vol": vol * 0.24, "reversion": profile["mean_reversion"] * 1.8, "volume": 0.42, "wick": 0.5})
    elif regime == "accumulation":
        params.update({"drift": vol * rng.uniform(0.035, 0.08), "vol": vol * 0.55, "reversion": profile["mean_reversion"] * 1.35, "volume": 0.82, "wick": 0.65})
    elif regime == "distribution":
        params.update({"drift": -vol * rng.uniform(0.035, 0.08), "vol": vol * 0.62, "reversion": profile["mean_reversion"] * 1.25, "volume": 0.98, "wick": 0.85})
    else:
        params.update({"drift": vol * rng.uniform(-0.035, 0.035), "vol": vol * 0.62, "reversion": profile["mean_reversion"] * 1.5, "volume": 0.72, "wick": 0.75})

    return params

def _timeframe_price_bounds(timeframe: str):
    return {
        "15m": (0.55, 1.75),
        "1h": (0.45, 2.2),
        "4h": (0.34, 3.2),
        "1d": (0.24, 4.5),
        "1w": (0.16, 6.5),
        "1M": (0.10, 9.0),
    }.get(timeframe, (0.45, 2.2))

def _compress_price_to_market_bounds(price: float, anchor: float, min_multiple: float, max_multiple: float):
    safe_price = max(float(price), 0.01)
    safe_anchor = max(float(anchor), 0.01)
    log_ratio = math.log(safe_price / safe_anchor)
    upper = math.log(max_multiple)
    lower = abs(math.log(min_multiple))
    limit = upper if log_ratio >= 0 else lower
    if limit <= 0:
        return safe_price
    return safe_anchor * math.exp(limit * math.tanh(log_ratio / limit))

def _normalize_market_range(data, timeframe: str, anchor_price: float):
    min_multiple, max_multiple = _timeframe_price_bounds(timeframe)
    for item in data:
        item["open"] = round(_compress_price_to_market_bounds(item["open"], anchor_price, min_multiple, max_multiple), 2)
        item["close"] = round(_compress_price_to_market_bounds(item["close"], anchor_price, min_multiple, max_multiple), 2)
        item["high"] = round(_compress_price_to_market_bounds(item["high"], anchor_price, min_multiple, max_multiple), 2)
        item["low"] = round(_compress_price_to_market_bounds(item["low"], anchor_price, min_multiple, max_multiple), 2)
        item["high"] = max(item["high"], item["open"], item["close"])
        item["low"] = min(item["low"], item["open"], item["close"])
    return data

def _generate_anchored_klines(
    symbol: str,
    base_price: float,
    count: int,
    timeframe: str,
    start_timestamp: int,
    end_price: float,
    timestamps: list[int] = None,
):
    """Generate synthetic OHLCV with market-like regimes and volume behavior."""
    data = []
    interval = timeframe_interval_ms(timeframe)
    normalized_base = max(float(base_price or 100), 0.01)
    normalized_end = max(float(end_price or normalized_base), 0.01)
    rng = random.Random(_stable_seed(symbol, timeframe, count, start_timestamp, round(normalized_end, 2)))
    vol = _timeframe_volatility(timeframe)
    profile = _timeframe_market_profile(timeframe)
    total_trend = rng.uniform(-0.36, 0.62) * (0.75 + profile["trend_probability"])
    start_price = normalized_end / max(0.25, 1 + total_trend)
    current_price = start_price * (1 + rng.gauss(0, vol * 1.4))
    trading_timestamps = timestamps or []
    current_timestamp = trading_timestamps[0] if trading_timestamps else start_timestamp
    index = 0
    previous_regime = None
    long_cycle_phase = rng.uniform(0, math.pi * 2)
    volume_base = rng.uniform(140000, 850000)

    while index < count:
        regime = _choose_market_regime(rng, profile, previous_regime)
        min_len, max_len = profile["segment"]
        segment_len = min(rng.randint(min_len, max_len), count - index)
        params = _regime_parameters(regime, rng, vol, profile)
        segment_center = current_price * (1 + rng.gauss(0, vol * 3.5))
        oscillation_amp = params["vol"] * rng.uniform(0.6, 2.2)
        oscillation_period = max(8, segment_len * rng.uniform(0.35, 0.95))

        for offset in range(segment_len):
            progress = index / max(count - 1, 1)
            global_anchor = start_price + ((normalized_end - start_price) * progress)
            cycle = math.sin(long_cycle_phase + progress * math.pi * 8)
            local_wave = math.sin((offset / oscillation_period) * math.pi * 2)
            center = (segment_center * 0.58) + (global_anchor * 0.42)
            reversion = (math.log(max(center, 0.01)) - math.log(max(current_price, 0.01))) * params["reversion"]
            cycle_component = cycle * vol * 0.045
            wave_component = local_wave * oscillation_amp * (0.12 if "trend" in regime or regime in ("breakout_up", "capitulation_down") else 0.38)
            shock = rng.gauss(0, params["vol"])

            if regime in ("breakout_up", "capitulation_down") and offset < max(3, segment_len // 8):
                shock += params["drift"] * rng.uniform(1.5, 2.8)
            elif regime == "squeeze" and offset > segment_len * 0.75 and rng.random() < 0.035:
                shock += rng.choice([-1, 1]) * vol * rng.uniform(1.4, 2.8)

            log_return = params["drift"] + reversion + cycle_component + wave_component + shock
            if timeframe in {"15m", "1h"}:
                log_return = _clamp(log_return, -_intraday_return_cap(timeframe), _intraday_return_cap(timeframe))
            open_gap = rng.gauss(0, params["vol"] * 0.16)
            open_val = current_price * math.exp(open_gap)
            close_val = current_price * math.exp(log_return)
            body_pct = abs(close_val / max(open_val, 0.01) - 1)
            wick_base = max(params["vol"] * 0.2, abs(rng.gauss(params["vol"] * params["wick"] * 0.55, params["vol"] * 0.24)))
            if rng.random() < profile["shock_probability"] * 0.6:
                wick_base *= rng.uniform(1.7, 3.2)
            high_val = max(open_val, close_val) * (1 + wick_base + body_pct * rng.uniform(0.04, 0.2))
            low_val = min(open_val, close_val) * max(0.01, 1 - wick_base - body_pct * rng.uniform(0.04, 0.2))
            volume_noise = rng.lognormvariate(0, 0.24)
            body_volume = 1 + min(body_pct / max(vol, 0.0001), 5) * 0.18
            volume_trend = 0.85 + (progress * rng.uniform(-0.12, 0.32))
            volume_val = round(volume_base * params["volume"] * volume_noise * body_volume * volume_trend)

            timestamp = trading_timestamps[index] if index < len(trading_timestamps) else current_timestamp
            bar = {
                "timestamp": timestamp,
                "open": round(max(open_val, 0.01), 2),
                "high": round(max(high_val, 0.01), 2),
                "low": round(max(low_val, 0.01), 2),
                "close": round(max(close_val, 0.01), 2),
                "volume": max(volume_val, 1),
            }
            if data and has_session_gap(data[-1]["timestamp"], bar["timestamp"], timeframe):
                bar = smooth_session_gap_bar(data[-1]["close"], bar, timeframe)
            bar = smooth_adjacent_open_gap(data[-1]["close"], bar, timeframe) if data else bar
            if data and timeframe in {"15m", "1h"}:
                bar = clamp_bar_return_range(data[-1]["close"], bar, timeframe)
            data.append(bar)
            current_price = max(float(bar["close"]), 0.01)
            if trading_timestamps and index + 1 < len(trading_timestamps):
                current_timestamp = trading_timestamps[index + 1]
            else:
                current_timestamp += interval
            index += 1

        previous_regime = regime

    if data and data[-1]["close"] > 0:
        scale = normalized_end / data[-1]["close"]
        for item in data:
            item["open"] = round(max(item["open"] * scale, 0.01), 2)
            item["high"] = round(max(item["high"] * scale, 0.01), 2)
            item["low"] = round(max(item["low"] * scale, 0.01), 2)
            item["close"] = round(max(item["close"] * scale, 0.01), 2)
            item["high"] = max(item["high"], item["open"], item["close"])
            item["low"] = min(item["low"], item["open"], item["close"])

    _normalize_market_range(data, timeframe, normalized_end)
    for idx in range(1, len(data)):
        if has_session_gap(data[idx - 1]["timestamp"], data[idx]["timestamp"], timeframe):
            data[idx] = smooth_session_gap_bar(data[idx - 1]["close"], data[idx], timeframe)
        data[idx] = smooth_adjacent_open_gap(data[idx - 1]["close"], data[idx], timeframe)
        if timeframe in {"15m", "1h"}:
            data[idx] = clamp_bar_return_range(data[idx - 1]["close"], data[idx], timeframe)
    return data

def generate_history_klines(symbol: str, base_price: float, count: int = 200, timeframe: str = '1h'):
    """Generate deterministic-shaped random OHLCV history ending near base_price."""
    interval = timeframe_interval_ms(timeframe)
    timestamps = generate_trading_timestamps(symbol, timeframe, count)
    start_timestamp = timestamps[0] if timestamps else bar_start_timestamp(int(time.time() * 1000), timeframe) - ((count - 1) * interval)
    return _generate_anchored_klines(symbol, base_price, count, timeframe, start_timestamp, base_price, timestamps)

def generate_history_klines_before(
    symbol: str,
    base_price: float,
    count: int,
    timeframe: str,
    before_timestamp: int,
):
    """Generate older bars that end immediately before before_timestamp."""
    interval = timeframe_interval_ms(timeframe)
    timestamps = generate_trading_timestamps(symbol, timeframe, count, before_timestamp)
    start_timestamp = timestamps[0] if timestamps else before_timestamp - (count * interval)
    return _generate_anchored_klines(symbol, base_price, count, timeframe, start_timestamp, base_price, timestamps)


class DBManager:
    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path

    async def init_db(self):
        """Initialize SQLite tables and local stock universe."""
        print(f"[DB] Initializing SQLite database at: {self.db_path}")
        async with aiosqlite.connect(self.db_path) as db:
            # 1. stocks
            await db.execute("""
                CREATE TABLE IF NOT EXISTS stocks (
                    symbol TEXT PRIMARY KEY,
                    name TEXT,
                    price REAL,
                    change REAL,
                    changePercent REAL,
                    high24h REAL,
                    low24h REAL,
                    volume REAL,
                    market TEXT,
                    isFav INTEGER DEFAULT 0
                )
            """)
            
            # 2. klines
            await db.execute("""
                CREATE TABLE IF NOT EXISTS klines (
                    symbol TEXT,
                    timeframe TEXT,
                    timestamp INTEGER,
                    open REAL,
                    high REAL,
                    low REAL,
                    close REAL,
                    volume INTEGER,
                    PRIMARY KEY (symbol, timeframe, timestamp)
                )
            """)

            # 2.5. strategies
            await db.execute("""
                CREATE TABLE IF NOT EXISTS strategies (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT,
                    concept TEXT,
                    logic TEXT,
                    indicators TEXT,
                    parameters TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            await db.commit()
            
            # 3. Insert local US symbols
            for s in LOCAL_TRADING_PAIRS_US:
                await db.execute(
                    """
                    INSERT INTO stocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol) DO UPDATE SET
                        name = excluded.name,
                        market = excluded.market
                    """,
                    (s["symbol"], s["name"], s["price"], s["change"], s["changePercent"], s["high24h"], s["low24h"], s["volume"], "US", s["isFav"])
                )

            # 4. Insert local TW symbols
            for s in INITIAL_STOCKS_TW:
                await db.execute(
                    """
                    INSERT INTO stocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol) DO UPDATE SET
                        name = excluded.name,
                        market = excluded.market
                    """,
                    (s["symbol"], s["name"], s["price"], s["change"], s["changePercent"], s["high24h"], s["low24h"], s["volume"], "TW", s["isFav"])
                )
            await db.commit()

    async def _initialize_all_klines(self, db):
        """Legacy helper: ensure all K-line history exists."""
        print("[DB] Initializing KLine history database...")
        async with db.execute("SELECT symbol, price FROM stocks") as cursor:
            stocks = await cursor.fetchall()
            
        for symbol, price in stocks:
            for tf in KLINE_TIMEFRAMES:
                await self.ensure_symbol_timeframe_klines(symbol, tf, float(price or 100), KLINE_HISTORY_COUNT)
        await db.commit()
        print("[DB] KLines database initialized successfully!")

    async def get_stocks(self, market: str):
        """Return stocks for one market."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM stocks WHERE market = ?", (market,)) as cursor:
                rows = await cursor.fetchall()
                stocks = []
                for r in rows:
                    stock_dict = dict(r)
                    stock_dict["isFav"] = stock_dict["isFav"] == 1
                    stocks.append(stock_dict)
                return stocks

    async def save_strategy(self, strategy_id: str, name: str, description: str, concept: str, logic: str, indicators: str, parameters: str):
        """Save a new strategy generated by AI to database."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                INSERT INTO strategies (id, name, description, concept, logic, indicators, parameters)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    description = excluded.description,
                    concept = excluded.concept,
                    logic = excluded.logic,
                    indicators = excluded.indicators,
                    parameters = excluded.parameters
                """,
                (strategy_id, name, description, concept, logic, indicators, parameters)
            )
            await db.commit()

    async def get_strategies(self):
        """Get all strategies from database."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM strategies ORDER BY created_at DESC") as cursor:
                rows = await cursor.fetchall()
                return [dict(r) for r in rows]

    async def delete_strategy(self, strategy_id: str):
        """Delete a strategy by id."""
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM strategies WHERE id = ?", (strategy_id,))
            await db.commit()

    def normalize_timeframe(self, timeframe: str):
        tf = (timeframe or "1h").strip()
        aliases = {
            "1D": "1d",
            "1W": "1w"
,
            "1m": "1M",
            "1mo": "1M",
            "1month": "1M",
        }
        tf = aliases.get(tf, tf)
        return tf if tf in KLINE_TIMEFRAMES else "1h"

    def get_local_trading_pairs(self):
        return [dict(stock, market="US") for stock in LOCAL_TRADING_PAIRS_US]

    async def delete_non_trading_klines(self, db, symbol: str, timeframe: str):
        normalized_timeframe = self.normalize_timeframe(timeframe)
        if normalized_timeframe not in TRADING_DAY_TIMEFRAMES:
            return 0

        async with db.execute(
            """
            SELECT timestamp
            FROM klines
            WHERE symbol = ? AND timeframe = ?
            """,
            (symbol, normalized_timeframe),
        ) as cursor:
            rows = await cursor.fetchall()

        invalid_timestamps = [
            int(row["timestamp"] if isinstance(row, aiosqlite.Row) else row[0])
            for row in rows
            if not is_local_kline_timestamp(symbol, normalized_timeframe, int(row["timestamp"] if isinstance(row, aiosqlite.Row) else row[0]))
        ]
        if not invalid_timestamps:
            return 0

        for start in range(0, len(invalid_timestamps), KLINE_SEED_BATCH_SIZE):
            await db.executemany(
                """
                DELETE FROM klines
                WHERE symbol = ? AND timeframe = ? AND timestamp = ?
                """,
                [(symbol, normalized_timeframe, timestamp) for timestamp in invalid_timestamps[start:start + KLINE_SEED_BATCH_SIZE]],
            )
        await db.commit()
        return len(invalid_timestamps)

    async def get_kline_seed_status(self):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            total_required = len(LOCAL_TRADING_PAIRS_US) * len(KLINE_TIMEFRAMES) * KLINE_HISTORY_COUNT
            async with db.execute(
                """
                SELECT COUNT(*) AS rows
                FROM klines
                WHERE symbol IN (%s) AND timeframe IN (%s)
                """ % (
                    ",".join("?" for _ in LOCAL_TRADING_PAIRS_US),
                    ",".join("?" for _ in KLINE_TIMEFRAMES),
                ),
                tuple([stock["symbol"] for stock in LOCAL_TRADING_PAIRS_US]) + tuple(KLINE_TIMEFRAMES),
            ) as cursor:
                row = await cursor.fetchone()

            rows = int(row["rows"] or 0) if row else 0
            return {
                "symbols": len(LOCAL_TRADING_PAIRS_US),
                "timeframes": list(KLINE_TIMEFRAMES),
                "targetPerSeries": KLINE_HISTORY_COUNT,
                "totalRequiredRows": total_required,
                "currentRows": rows,
                "ready": rows >= total_required,
                "progress": round(min(rows / total_required, 1) * 100, 2) if total_required else 100,
            }

    async def ensure_symbol_timeframe_klines(
        self,
        symbol: str,
        timeframe: str,
        base_price: float,
        target_count: int = KLINE_HISTORY_COUNT,
    ):
        normalized_timeframe = self.normalize_timeframe(timeframe)
        symbol = (symbol or "").strip().upper()
        if not symbol:
            return 0

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            await self.delete_non_trading_klines(db, symbol, normalized_timeframe)
            async with db.execute(
                """
                SELECT COUNT(*) AS total, MIN(timestamp) AS firstTs
                FROM klines
                WHERE symbol = ? AND timeframe = ?
                """,
                (symbol, normalized_timeframe),
            ) as cursor:
                row = await cursor.fetchone()

            total = int(row["total"] or 0) if row else 0
            if total >= target_count:
                return 0

            first_ts = int(row["firstTs"] or 0) if row and row["firstTs"] else 0
            missing_count = target_count - total
            if first_ts > 0:
                async with db.execute(
                    """
                    SELECT open
                    FROM klines
                    WHERE symbol = ? AND timeframe = ? AND timestamp = ?
                    LIMIT 1
                    """,
                    (symbol, normalized_timeframe, first_ts),
                ) as first_cursor:
                    first_row = await first_cursor.fetchone()
                anchor_price = float(first_row["open"] or base_price or 100) if first_row else float(base_price or 100)
                seed_klines = generate_history_klines_before(symbol, anchor_price, missing_count, normalized_timeframe, first_ts)
            else:
                seed_klines = generate_history_klines(symbol, float(base_price or 100), target_count, normalized_timeframe)

            rows = [
                (symbol, normalized_timeframe, k["timestamp"], k["open"], k["high"], k["low"], k["close"], k["volume"])
                for k in seed_klines
            ]
            for start in range(0, len(rows), KLINE_SEED_BATCH_SIZE):
                await db.executemany(
                    "INSERT OR IGNORE INTO klines VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    rows[start:start + KLINE_SEED_BATCH_SIZE],
                )
                await db.commit()

            return len(rows)

    async def ensure_local_kline_universe(self):
        inserted_total = 0
        for stock in LOCAL_TRADING_PAIRS_US:
            for timeframe in KLINE_TIMEFRAMES:
                inserted_total += await self.ensure_symbol_timeframe_klines(
                    stock["symbol"],
                    timeframe,
                    float(stock.get("price") or 100),
                    KLINE_HISTORY_COUNT,
                )
                await asyncio.sleep(0)
        return inserted_total

    async def reseed_local_kline_universe(self):
        symbols = [stock["symbol"] for stock in LOCAL_TRADING_PAIRS_US]
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                """
                DELETE FROM klines
                WHERE symbol IN (%s) AND timeframe IN (%s)
                """ % (
                    ",".join("?" for _ in symbols),
                    ",".join("?" for _ in KLINE_TIMEFRAMES),
                ),
                tuple(symbols) + tuple(KLINE_TIMEFRAMES),
            )
            await db.commit()
        return await self.ensure_local_kline_universe()

    async def normalize_all_kline_open_gaps(self):
        """Normalize adjacent open gaps for every stored symbol/timeframe pair."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT rowid, symbol, timeframe, timestamp, open, high, low, close
                FROM klines
                ORDER BY symbol, timeframe, timestamp
                """
            ) as cursor:
                rows = await cursor.fetchall()

            updates = []
            previous_by_key: dict[tuple[str, str], float] = {}
            for row in rows:
                key = (row["symbol"], row["timeframe"])
                previous_close = previous_by_key.get(key)
                bar = {
                    "timestamp": int(row["timestamp"]),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                }
                if previous_close is not None:
                    adjusted = smooth_adjacent_open_gap(previous_close, bar, row["timeframe"])
                    if (
                        adjusted["open"] != bar["open"]
                        or adjusted["high"] != bar["high"]
                        or adjusted["low"] != bar["low"]
                        or adjusted["close"] != bar["close"]
                    ):
                        updates.append((
                            adjusted["open"],
                            adjusted["high"],
                            adjusted["low"],
                            adjusted["close"],
                            row["rowid"],
                        ))
                    previous_by_key[key] = float(adjusted["close"])
                else:
                    previous_by_key[key] = float(bar["close"])

            if updates:
                await db.executemany(
                    """
                    UPDATE klines
                    SET open = ?, high = ?, low = ?, close = ?
                    WHERE rowid = ?
                    """,
                    updates,
                )
                await db.commit()

            return len(updates)

    async def upsert_stocks(self, stocks_list: list, market: str = "US"):
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            for stock in stocks_list:
                symbol = stock.get("symbol")
                if not symbol:
                    continue

                async with db.execute("SELECT isFav FROM stocks WHERE symbol = ?", (symbol,)) as cursor:
                    row = await cursor.fetchone()

                is_fav = int(row["isFav"]) if row else int(bool(stock.get("isFav")))
                await db.execute(
                    """
                    INSERT INTO stocks (symbol, name, price, change, changePercent, high24h, low24h, volume, market, isFav)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol) DO UPDATE SET
                        name = excluded.name,
                        price = excluded.price,
                        change = excluded.change,
                        changePercent = excluded.changePercent,
                        high24h = excluded.high24h,
                        low24h = excluded.low24h,
                        volume = excluded.volume,
                        market = excluded.market
                    """,
                    (
                        symbol,
                        stock.get("name") or f"{symbol} Inc.",
                        float(stock.get("price") or 0),
                        float(stock.get("change") or 0),
                        float(stock.get("changePercent") or 0),
                        float(stock.get("high24h") or stock.get("price") or 0),
                        float(stock.get("low24h") or stock.get("price") or 0),
                        float(stock.get("volume") or 0),
                        market,
                        is_fav,
                    ),
                )
            await db.commit()

        return

    async def get_klines(self, symbol: str, timeframe: str, limit: int = None, before: int = None):
        """Read K-line history from local SQLite only."""
        normalized_timeframe = self.normalize_timeframe(timeframe)
        normalized_symbol = (symbol or "").strip().upper()
        if not normalized_symbol:
            return []

        stocks = await self.get_stocks("US")
        stock = next((item for item in stocks if item["symbol"] == normalized_symbol), None)
        await self.ensure_symbol_timeframe_klines(
            normalized_symbol,
            "15m" if normalized_timeframe != "15m" else normalized_timeframe,
            float((stock or {}).get("price") or 100),
            KLINE_HISTORY_COUNT,
        )

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            source_timeframe = "15m" if normalized_timeframe != "15m" else normalized_timeframe
            params = [normalized_symbol, source_timeframe]
            before_clause = ""
            if before and normalized_timeframe == "15m":
                before_clause = " AND timestamp < ?"
                params.append(int(before))

            if limit and normalized_timeframe == "15m":
                params.append(int(limit))
                query = f"""
                    SELECT timestamp, open, high, low, close, volume
                    FROM (
                        SELECT timestamp, open, high, low, close, volume
                        FROM klines
                        WHERE symbol = ? AND timeframe = ?{before_clause}
                        ORDER BY timestamp DESC
                        LIMIT ?
                    )
                    ORDER BY timestamp ASC
                """
            else:
                query = f"""
                    SELECT timestamp, open, high, low, close, volume
                    FROM klines
                    WHERE symbol = ? AND timeframe = ?{before_clause}
                    ORDER BY timestamp ASC
                """

            async with db.execute(query, tuple(params)) as cursor:
                rows = await cursor.fetchall()
                data = [dict(r) for r in rows]
                if normalized_timeframe == "15m":
                    return data

                aggregated = aggregate_klines_from_15m(normalized_symbol, data, normalized_timeframe)
                if before:
                    aggregated = [bar for bar in aggregated if int(bar["timestamp"]) < int(before)]
                if limit:
                    aggregated = aggregated[-int(limit):]
                return aggregated

    async def initialize_stock_klines(self, symbol: str, base_price: float):
        """Ensure all supported local K-line timeframes exist for one symbol."""
        for tf in KLINE_TIMEFRAMES:
            await self.ensure_symbol_timeframe_klines(symbol, tf, base_price, KLINE_HISTORY_COUNT)

    async def toggle_fav(self, symbol: str, name: str = None, market: str = "US"):
        """Toggle favorite state for a stock, creating it locally if needed."""
        symbol = (symbol or "").strip().upper()
        if not symbol:
            return False

        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT isFav FROM stocks WHERE symbol = ?", (symbol,)) as cursor:
                row = await cursor.fetchone()

            if row is None:
                stock_name = name if name else f"{symbol} Inc."
                price = round(random.uniform(50, 400), 2)
                change = round(random.uniform(-5, 5), 2)
                change_percent = round((change / price) * 100, 2)
                high_24h = price * 1.02
                low_24h = price * 0.98
                volume = round(random.uniform(1.0, 50.0), 1)
                await db.execute(
                    "INSERT INTO stocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                    (symbol, stock_name, price, change, change_percent, high_24h, low_24h, volume, market),
                )
                await db.commit()
                await self.initialize_stock_klines(symbol, price)
                return True

            next_fav = 0 if row["isFav"] == 1 else 1
            await db.execute("UPDATE stocks SET isFav = ? WHERE symbol = ?", (next_fav, symbol))
            await db.commit()
            return next_fav == 1

    async def update_all_prices_and_klines(self, stocks_list: list, market_type: str):
        """Persist simulated quote updates and roll them into every local K-line timeframe."""
        now_ts = int(time.time() * 1000)
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                """
                SELECT symbol, timeframe, MAX(timestamp) as lastTs, open, high, low, close, volume
                FROM klines
                GROUP BY symbol, timeframe
                """
            ) as cursor:
                last_bars = await cursor.fetchall()

            bar_map = {f"{bar['symbol']}_{bar['timeframe']}": dict(bar) for bar in last_bars}
            await db.execute("BEGIN TRANSACTION")
            for stock in stocks_list:
                await db.execute(
                    """
                    UPDATE stocks
                    SET price = ?, change = ?, changePercent = ?, high24h = ?, low24h = ?, volume = ?
                    WHERE symbol = ?
                    """,
                    (
                        stock["price"],
                        stock["change"],
                        stock["changePercent"],
                        stock["high24h"],
                        stock["low24h"],
                        stock.get("volume", 0),
                        stock["symbol"],
                    ),
                )

                for tf in ("15m",):
                    key = f"{stock['symbol']}_{tf}"
                    last_bar = bar_map.get(key)
                    if not last_bar:
                        continue
                    if tf in INTRADAY_TIMEFRAMES and not is_trading_bar_timestamp(stock["symbol"], tf, now_ts):
                        continue
                    tick_volume = max(1, min(MAX_KLINE_VOLUME, int(stock.get("tickVolume") or (float(stock.get("volume") or 1) * 1000))))

                    current_trading_timestamps = generate_trading_timestamps(stock["symbol"], tf, 1)
                    current_bar_start = current_trading_timestamps[-1] if current_trading_timestamps else bar_start_timestamp(now_ts, tf)
                    last_bar_start = int(last_bar["lastTs"])
                    if current_bar_start > last_bar_start:
                        open_val = last_bar["close"]
                        high_val = max(open_val, stock["price"])
                        low_val = min(open_val, stock["price"])
                        close_val = stock["price"]
                        volume_val = min(MAX_KLINE_VOLUME, round(tick_volume * random.uniform(2.5, 6.0)))
                        if has_session_gap(last_bar_start, current_bar_start, tf):
                            smoothed_bar = smooth_session_gap_bar(
                                last_bar["close"],
                                {
                                    "timestamp": current_bar_start,
                                    "open": open_val,
                                    "high": high_val,
                                    "low": low_val,
                                    "close": close_val,
                                    "volume": volume_val,
                                },
                                tf,
                            )
                            open_val = smoothed_bar["open"]
                            high_val = smoothed_bar["high"]
                            low_val = smoothed_bar["low"]
                            close_val = smoothed_bar["close"]
                        aligned_bar = smooth_adjacent_open_gap(
                            last_bar["close"],
                            {
                                "timestamp": current_bar_start,
                                "open": open_val,
                                "high": high_val,
                                "low": low_val,
                                "close": close_val,
                                "volume": volume_val,
                            },
                            tf,
                        )
                        open_val = aligned_bar["open"]
                        high_val = aligned_bar["high"]
                        low_val = aligned_bar["low"]
                        close_val = aligned_bar["close"]
                        if tf in {"15m"}:
                            bounded_bar = clamp_bar_return_range(
                                last_bar["close"],
                                {
                                    "timestamp": current_bar_start,
                                    "open": open_val,
                                    "high": high_val,
                                    "low": low_val,
                                    "close": close_val,
                                    "volume": volume_val,
                                },
                                tf,
                            )
                            open_val = bounded_bar["open"]
                            high_val = bounded_bar["high"]
                            low_val = bounded_bar["low"]
                            close_val = bounded_bar["close"]
                        await db.execute(
                            """
                            INSERT INTO klines (symbol, timeframe, timestamp, open, high, low, close, volume)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (stock["symbol"], tf, current_bar_start, open_val, high_val, low_val, close_val, volume_val),
                        )
                    else:
                        open_val = last_bar["open"]
                        high_val = max(last_bar["high"], stock["price"])
                        low_val = min(last_bar["low"], stock["price"])
                        close_val = stock["price"]
                        volume_val = min(MAX_KLINE_VOLUME, max(0, int(last_bar["volume"] or 0)) + tick_volume)
                        await db.execute(
                            """
                            UPDATE klines
                            SET open = ?, high = ?, low = ?, close = ?, volume = ?
                            WHERE symbol = ? AND timeframe = ? AND timestamp = ?
                            """,
                            (open_val, high_val, low_val, close_val, volume_val, stock["symbol"], tf, last_bar["lastTs"]),
                        )
            await db.commit()
