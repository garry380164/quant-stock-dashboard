import asyncio
import logging
import random
import time
import os
import uuid
import json
import httpx
from datetime import datetime
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from backend.db_manager import DBManager
from backend.logging_config import configure_logging

load_dotenv()
configure_logging()
logger = logging.getLogger("quantx.backend")

kline_logger = logging.getLogger("quantx.kline.api")

allowed_origins_str = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [origin.strip() for origin in allowed_origins_str.split(",") if origin.strip()]

app = FastAPI(title="QUANT-X B2B Python Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

db_manager = DBManager()
LOCAL_SYMBOL_LIMIT = 30
SIMULATED_PRICE_UPDATE_MIN_INTERVAL_SECONDS = 0.6
SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_SECONDS = 2.4
SIMULATED_PRICE_UPDATE_MAX_INTERVAL_SECONDS = 8.0
SIMULATED_PRICE_UPDATE_FAST_PROBABILITY = 0.55
SIMULATED_PRICE_UPDATE_POLL_INTERVAL_SECONDS = 0.4
SIMULATED_INDEX_UPDATE_MIN_INTERVAL_SECONDS = 3.0
SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_SECONDS = 7.0
SIMULATED_INDEX_UPDATE_MAX_INTERVAL_SECONDS = 10.0
SIMULATED_INDEX_UPDATE_FAST_PROBABILITY = 0.6
connected_clients: set[WebSocket] = set()
client_states: dict[WebSocket, dict] = {}
kline_seed_task: asyncio.Task | None = None
tick_persist_task: asyncio.Task | None = None
live_stocks_us: list[dict] | None = None
live_stocks_tw: list[dict] | None = None
next_symbol_tick_at: dict[str, float] = {}
next_index_tick_at: dict[str, float] = {}
simulated_quote_states: dict[str, dict] = {}
MAX_SIMULATED_STOCK_VOLUME_MILLIONS = 250.0
MAX_SIMULATED_TICK_VOLUME = 2_000_000
MAX_SIMULATED_TICK_STEP_RATIO = 0.0018
MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO = 0.012

indices_us = [
    {"symbol": ".SPX", "name": "S&P 500", "price": 5137.08, "changePercent": 0.82, "sparkline": [5095.0, 5102.0, 5098.0, 5110.0, 5108.0, 5122.0, 5118.0, 5125.0, 5130.0, 5127.0, 5137.0]},
    {"symbol": ".IXIC", "name": "Nasdaq", "price": 16274.94, "changePercent": 1.14, "sparkline": [16050.0, 16110.0, 16080.0, 16150.0, 16120.0, 16200.0, 16180.0, 16230.0, 16250.0, 16240.0, 16274.0]},
    {"symbol": ".DJI", "name": "Dow Jones", "price": 39087.38, "changePercent": 0.23, "sparkline": [38980.0, 39020.0, 39000.0, 39040.0, 39030.0, 39070.0, 39050.0, 39060.0, 39080.0, 39070.0, 39087.0]},
    {"symbol": ".SOX", "name": "SOX", "price": 4929.58, "changePercent": 2.15, "sparkline": [4810.0, 4850.0, 4830.0, 4880.0, 4860.0, 4910.0, 4890.0, 4920.0, 4940.0, 4915.0, 4929.0]},
    {"symbol": ".RUT", "name": "Russell 2000", "price": 2207.83, "changePercent": 0.64, "sparkline": [2189.0, 2192.0, 2190.0, 2195.0, 2198.0, 2201.0, 2199.0, 2203.0, 2205.0, 2204.0, 2207.0]},
    {"symbol": ".VIX", "name": "VIX", "price": 14.86, "changePercent": -1.08, "sparkline": [15.2, 15.05, 14.95, 15.1, 14.98, 14.92, 14.88, 14.9, 14.84, 14.87, 14.86]},
]

indices_tw = [
    {"symbol": ".TWII", "name": "TAIEX", "price": 20337.54, "changePercent": 1.25, "sparkline": [20050.0, 20120.0, 20080.0, 20180.0, 20150.0, 20240.0, 20210.0, 20280.0, 20310.0, 20290.0, 20337.0]},
    {"symbol": ".TWOI", "name": "TPEx", "price": 252.32, "changePercent": 0.88, "sparkline": [249.5, 250.2, 249.8, 250.8, 250.5, 251.4, 251.1, 251.9, 252.1, 252.0, 252.32]},
    {"symbol": ".TWSE", "name": "TWSE", "price": 169.52, "changePercent": 0.41, "sparkline": [168.8, 169.0, 168.9, 169.1, 169.3, 169.2, 169.4, 169.45, 169.48, 169.5, 169.52]},
    {"symbol": ".OTC", "name": "OTC", "price": 262.08, "changePercent": 0.56, "sparkline": [260.8, 261.0, 260.9, 261.2, 261.4, 261.6, 261.8, 261.95, 262.0, 262.05, 262.08]},
]

mock_signal_templates = [
    {"symbol": "AAPL", "strategy": "LSTM", "confidence": 88, "type": "BUY", "priceOffset": 1.002},
    {"symbol": "TSLA", "strategy": "MOMENTUM", "confidence": 79, "type": "BUY", "priceOffset": 1.015},
    {"symbol": "NVDA", "strategy": "BOLLINGER", "confidence": 91, "type": "SELL", "priceOffset": 0.992},
    {"symbol": "MSFT", "strategy": "MOMENTUM", "confidence": 82, "type": "BUY", "priceOffset": 1.004},
    {"symbol": "AMD", "strategy": "BOLLINGER", "confidence": 76, "type": "BUY", "priceOffset": 1.006},
    {"symbol": "META", "strategy": "LSTM", "confidence": 81, "type": "SELL", "priceOffset": 0.996},
]


def calculate_weights(portfolio, stocks_list):
    updated = []
    for asset in portfolio:
        matched = next((stock for stock in stocks_list if stock["symbol"] == asset["symbol"]), None)
        current_price = matched["price"] if matched else asset["avgPrice"]
        value = round(asset["shares"] * current_price, 2)
        updated.append({**asset, "currentPrice": current_price, "value": value})

    total_value = sum(item["value"] for item in updated) or 1
    return [{**item, "weight": round((item["value"] / total_value) * 100, 1)} for item in updated]


def get_portfolio(stocks_list, market_type):
    if market_type == "US":
        portfolio = [
            {"symbol": "AAPL", "name": "Apple Inc.", "shares": 150, "avgPrice": 175.20, "color": "#06b6d4"},
            {"symbol": "MSFT", "name": "Microsoft Corp.", "shares": 60, "avgPrice": 395.40, "color": "#3b82f6"},
            {"symbol": "NVDA", "name": "NVIDIA Corp.", "shares": 45, "avgPrice": 720.00, "color": "#10b981"},
            {"symbol": "TSLA", "name": "Tesla Inc.", "shares": 110, "avgPrice": 185.00, "color": "#f59e0b"},
            {"symbol": "GOOGL", "name": "Alphabet Inc.", "shares": 5, "avgPrice": 148.00, "color": "#ec4899"},
        ]
    else:
        portfolio = [
            {"symbol": "2330.TW", "name": "TSMC", "shares": 5000, "avgPrice": 710.00, "color": "#10b981"},
            {"symbol": "2317.TW", "name": "Foxconn", "shares": 12000, "avgPrice": 120.00, "color": "#06b6d4"},
            {"symbol": "2454.TW", "name": "MediaTek", "shares": 800, "avgPrice": 1050.00, "color": "#3b82f6"},
            {"symbol": "2881.TW", "name": "Fubon", "shares": 1000, "avgPrice": 70.00, "color": "#f59e0b"},
        ]
    return calculate_weights(portfolio, stocks_list)


def generate_random_signal(market_type, current_stocks):
    if not current_stocks:
        return None
    templates = [item for item in mock_signal_templates if not item["symbol"].endswith(".TW")]
    template = random.choice(templates)
    base_stock = next((stock for stock in current_stocks if stock["symbol"] == template["symbol"]), current_stocks[0])
    return {
        "id": f"{template['symbol']}-{int(time.time() * 1000)}",
        "time": datetime.now().strftime("%H:%M:%S"),
        "type": template["type"],
        "symbol": template["symbol"],
        "price": round(base_stock["price"] * template["priceOffset"], 2),
        "confidence": template["confidence"] + random.randint(-5, 5),
        "strategy": template["strategy"],
    }


async def refresh_us_stock_universe(limit: int = LOCAL_SYMBOL_LIMIT):
    pairs = db_manager.get_local_trading_pairs()[:limit]
    await db_manager.upsert_stocks(pairs, "US")
    logger.info("US_STOCK_UNIVERSE_READY source=sqlite count=%s symbols=%s", len(pairs), ",".join(item["symbol"] for item in pairs))
    return pairs


async def get_local_symbols():
    return [item["symbol"] for item in db_manager.get_local_trading_pairs()]


async def get_us_dashboard_stocks():
    symbols = await get_local_symbols()
    stocks = await db_manager.get_stocks("US")
    stocks_by_symbol = {stock["symbol"]: stock for stock in stocks}
    return [stocks_by_symbol[symbol] for symbol in symbols if symbol in stocks_by_symbol]


def get_quote_source(_market_type: str, fallback: str = "simulated_sqlite"):
    return fallback


def get_next_simulated_tick_delay():
    if random.random() < SIMULATED_PRICE_UPDATE_FAST_PROBABILITY:
        return random.uniform(
            SIMULATED_PRICE_UPDATE_MIN_INTERVAL_SECONDS,
            SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_SECONDS,
        )
    return random.uniform(
        SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_SECONDS,
        SIMULATED_PRICE_UPDATE_MAX_INTERVAL_SECONDS,
    )


def get_next_index_tick_delay():
    if random.random() < SIMULATED_INDEX_UPDATE_FAST_PROBABILITY:
        return random.uniform(
            SIMULATED_INDEX_UPDATE_MIN_INTERVAL_SECONDS,
            SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_SECONDS,
        )
    return random.uniform(
        SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_SECONDS,
        SIMULATED_INDEX_UPDATE_MAX_INTERVAL_SECONDS,
    )


async def broadcast_market_update(market_type, stocks, indices):
    for ws in list(connected_clients):
        if client_states.get(ws, {}).get("market") != market_type:
            continue
        try:
            await ws.send_json({
                "type": "TICK_UPDATE",
                "stocks": stocks,
                "indices": indices,
                "priceSource": "simulated_sqlite",
            })
        except Exception as send_err:
            logger.warning("WS_BROADCAST_FAILED market=%s error=%s", market_type, send_err)


async def seed_kline_universe_task():
    try:
        inserted = await db_manager.ensure_local_kline_universe()
        status = await db_manager.get_kline_seed_status()
        logger.info("KLINE_SQLITE_SEED_DONE inserted=%s progress=%s ready=%s", inserted, status["progress"], status["ready"])
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("KLINE_SQLITE_SEED_FAILED error=%s", exc)


@app.on_event("startup")
async def startup_event():
    global kline_seed_task
    await db_manager.init_db()
    await refresh_us_stock_universe()
    kline_seed_task = asyncio.create_task(seed_kline_universe_task())
    asyncio.create_task(background_tick_loop())


@app.on_event("shutdown")
async def shutdown_event():
    if kline_seed_task and not kline_seed_task.done():
        kline_seed_task.cancel()
        try:
            await kline_seed_task
        except asyncio.CancelledError:
            pass
    if tick_persist_task and not tick_persist_task.done():
        tick_persist_task.cancel()
        try:
            await tick_persist_task
        except asyncio.CancelledError:
            pass


@app.get("/api/massive/stocks")
async def get_massive_stocks(limit: int = 20, cursor: str = None, search: str = None, sort: str = None):
    pairs = db_manager.get_local_trading_pairs()
    if search:
        query = search.strip().lower()
        pairs = [item for item in pairs if query in item["symbol"].lower() or query in item["name"].lower()]
    limited = pairs[: max(1, min(int(limit or 20), LOCAL_SYMBOL_LIMIT))]
    return {"results": limited, "next_cursor": None, "source": "sqlite"}


@app.get("/api/kline-seed/status")
async def get_kline_seed_status():
    return await db_manager.get_kline_seed_status()


@app.get("/api/klines")
@app.get("/api/massive/klines")
async def get_klines(symbol: str, timeframe: str = "1h", limit: int = 1000, before: int = None):
    started_at = time.perf_counter()
    normalized_timeframe = db_manager.normalize_timeframe(timeframe)
    capped_limit = max(1, min(int(limit or 1000), 10000))
    klines = await db_manager.get_klines(symbol=symbol, timeframe=normalized_timeframe, limit=capped_limit, before=before)
    elapsed_ms = round((time.perf_counter() - started_at) * 1000, 2)
    kline_logger.info(
        "HTTP_KLINE_RESPONSE symbol=%s timeframe=%s source=sqlite bars=%s elapsed_ms=%s before=%s",
        symbol,
        normalized_timeframe,
        len(klines),
        elapsed_ms,
        before,
    )
    return {"symbol": (symbol or "").strip().upper(), "timeframe": normalized_timeframe, "source": "sqlite", "klines": klines}


@app.get("/api/strategies")
async def get_strategies():
    """Get all saved custom AI strategies."""
    try:
        strategies = await db_manager.get_strategies()
        return {"status": "success", "strategies": strategies}
    except Exception as e:
        logger.exception("GET_STRATEGIES_FAILED")
        return {"status": "error", "message": str(e)}


@app.delete("/api/strategies/{strategy_id}")
async def delete_strategy(strategy_id: str):
    """Delete a saved custom AI strategy."""
    try:
        await db_manager.delete_strategy(strategy_id)
        return {"status": "success", "message": f"Strategy {strategy_id} deleted successfully"}
    except Exception as e:
        logger.exception("DELETE_STRATEGY_FAILED")
        return {"status": "error", "message": str(e)}


class GenerateStrategyRequest(httpx.Model if False else dict): # Use dict style parsing or simple json parsing
    pass

@app.post("/api/strategies/generate")
async def generate_strategy(request_data: dict):
    """Generate a quantitative trading strategy using Gemini API."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return {
            "status": "error", 
            "message": "找不到 GEMINI_API_KEY。請先在 backend/.env 檔案中填入您的 Gemini API Key 並重啟後端。"
        }
    
    symbol = request_data.get("symbol", "AAPL")
    timeframe = request_data.get("timeframe", "1h")
    
    # 建立適合發送給 Gemini 的 prompt，限制它返回特定 JSON 格式
    prompt = f"""你是一個專業的量化交易策略專家。請幫我為 {symbol} 在 {timeframe} 時框下設計一個基於技術指標的交易策略。
請為該標的設計一個具備指標、開單條件、止盈、止損、倉位管理和風險控制的量化交易策略。

請嚴格返回以下 JSON 結構的內容：
{{
  "name": "策略名稱（例如：雙均線動能突破策略）",
  "description": "策略的簡短描述",
  "concept": "策略的概念與原理說明（繁體中文，詳細說明）",
  "logic": "策略的交易邏輯說明，包含買入和賣出信號（繁體中文，詳細說明）",
  "indicators": ["MA_10", "MA_20", "RSI_14", "Bollinger_20_2"], 
  "parameters": {{
    "stopLoss": 2.5,
    "takeProfit": 6.0,
    "positionSize": 10,
    "riskControl": "單筆交易最大虧損不超過總倉位的 2%"
  }}
}}

規範限制：
1. "indicators" 只能挑選並使用以下格式的指標：
   - 移動平均線：MA_X (例如 MA_10, MA_20, MA_60，X為整數週期)
   - 指數移動平均線：EMA_X (例如 EMA_12, EMA_26，X為整數週期)
   - 相對強弱指標：RSI_X (例如 RSI_14，X為整數週期)
   - 布林通道：Bollinger_X_Y (例如 Bollinger_20_2，X為週期，Y為標準差倍數，通常為2)
2. parameters.stopLoss 和 parameters.takeProfit 必須是浮點數，代表百分比（例如 2.5 代表 2.5%）。
3. parameters.positionSize 必須是整數，代表倉位權重或百分比。
4. 所有說明文字（name、description、concept、logic、riskControl）請務必使用繁體中文（Taiwan Traditional Chinese）。
"""

    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": prompt}
                ]
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json"
        }
    }
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(gemini_url, json=payload)
            if response.status_code != 200:
                logger.error("GEMINI_API_ERROR status=%s body=%s", response.status_code, response.text)
                return {"status": "error", "message": f"Gemini API 回傳錯誤碼 {response.status_code}: {response.text}"}
            
            res_json = response.json()
            # 解析 Gemini 回傳的 JSON 內容
            try:
                candidate = res_json["candidates"][0]
                text_content = candidate["content"]["parts"][0]["text"]
                strategy_data = json.loads(text_content)
            except Exception as parse_err:
                logger.error("PARSE_GEMINI_RESPONSE_FAILED raw=%s error=%s", res_json, parse_err)
                return {"status": "error", "message": f"解析 Gemini 回傳格式失敗: {parse_err}"}
            
            # 生成唯一的策略 ID
            strategy_id = f"AI_{uuid.uuid4().hex[:8].upper()}"
            name = strategy_data.get("name", f"AI 策略 {strategy_id}")
            description = strategy_data.get("description", "")
            concept = strategy_data.get("concept", "")
            logic = strategy_data.get("logic", "")
            
            indicators_json = json.dumps(strategy_data.get("indicators", []))
            parameters_json = json.dumps(strategy_data.get("parameters", {}))
            
            # 儲存至資料庫
            await db_manager.save_strategy(
                strategy_id=strategy_id,
                name=name,
                description=description,
                concept=concept,
                logic=logic,
                indicators=indicators_json,
                parameters=parameters_json
            )
            
            return {
                "status": "success",
                "strategy": {
                    "id": strategy_id,
                    "name": name,
                    "description": description,
                    "concept": concept,
                    "logic": logic,
                    "indicators": strategy_data.get("indicators", []),
                    "parameters": strategy_data.get("parameters", {})
                }
            }
            
    except Exception as e:
        logger.exception("GENERATE_STRATEGY_FAILED")
        return {"status": "error", "message": f"生成策略時發生異常: {str(e)}"}


@app.websocket("/")

async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    client_states[websocket] = {"market": "US"}
    logger.info("WS_CLIENT_CONNECTED active_clients=%s", len(connected_clients))

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type in {"SUBSCRIBE_MARKET", "SUBSCRIBE_ALL_PAIRS"}:
                target_market = data.get("market", "US")
                client_states[websocket]["market"] = target_market
                client_states[websocket]["subscription"] = "all_pairs"
                stocks = await get_us_dashboard_stocks() if target_market == "US" else await db_manager.get_stocks(target_market)
                indices = indices_us if target_market == "US" else indices_tw
                await websocket.send_json({
                    "type": "INITIAL_DATA",
                    "market": target_market,
                    "stocks": stocks,
                    "indices": indices,
                    "portfolio": get_portfolio(stocks, target_market),
                    "priceSource": "simulated_sqlite",
                })

            elif msg_type == "GET_KLINES":
                symbol = data.get("symbol")
                timeframe = db_manager.normalize_timeframe(data.get("timeframe", "1h"))
                limit = max(1, min(int(data.get("limit") or 1000), 10000))
                before = data.get("before")
                klines = await db_manager.get_klines(symbol, timeframe, limit=limit, before=before)
                await websocket.send_json({"type": "KLINES_DATA", "symbol": symbol, "timeframe": timeframe, "klines": klines})

            elif msg_type == "TOGGLE_FAV":
                symbol = data.get("symbol")
                await db_manager.toggle_fav(symbol, name=data.get("name"), market=data.get("market", "US"))
                current_market = client_states[websocket]["market"]
                stocks = await get_us_dashboard_stocks() if current_market == "US" else await db_manager.get_stocks(current_market)
                indices = indices_us if current_market == "US" else indices_tw
                await websocket.send_json({"type": "TICK_UPDATE", "stocks": stocks, "indices": indices, "priceSource": "simulated_sqlite"})

    except WebSocketDisconnect:
        logger.info("WS_CLIENT_DISCONNECTED")
    except Exception as exc:
        logger.warning("WS_ERROR error=%s", exc)
    finally:
        connected_clients.discard(websocket)
        client_states.pop(websocket, None)


def choose_quote_regime(previous_regime: str | None = None):
    roll = random.random()
    if previous_regime in {"volume_up", "volume_down"}:
        roll += 0.24
    if roll < 0.54:
        return "sideways"
    if roll < 0.78:
        return "volatile"
    if roll < 0.86:
        return "trend_up"
    if roll < 0.94:
        return "trend_down"
    if roll < 0.97:
        return "volume_up"
    return "volume_down"


def next_quote_state(symbol: str, prev_price: float, base_volume: float):
    state = simulated_quote_states.get(symbol)
    if not state:
        state = {
            "anchor": prev_price,
            "baseVolume": max(0.01, min(base_volume, MAX_SIMULATED_STOCK_VOLUME_MILLIONS)),
            "regime": choose_quote_regime(),
            "ttl": random.randint(6, 18),
            "momentum": 0.0,
            "lastSign": 0,
            "streak": 0,
        }

    state["ttl"] = int(state.get("ttl", 0)) - 1
    if state["ttl"] <= 0:
        previous_regime = state.get("regime")
        regime = choose_quote_regime(previous_regime)
        state["regime"] = regime
        state["ttl"] = random.randint(3, 8) if regime.startswith("volume_") else random.randint(8, 26)
        if abs(prev_price - float(state.get("anchor") or prev_price)) / max(prev_price, 1) > 0.08:
            state["anchor"] = prev_price

    simulated_quote_states[symbol] = state
    return state


def regime_tick_profile(regime: str):
    if regime == "trend_up":
        return {"drift": random.uniform(0.00006, 0.0002), "noise": 0.00055, "reversion": 0.05, "volume": random.uniform(1.1, 1.6)}
    if regime == "trend_down":
        return {"drift": -random.uniform(0.00006, 0.00022), "noise": 0.0006, "reversion": 0.05, "volume": random.uniform(1.15, 1.7)}
    if regime == "volume_up":
        return {"drift": random.uniform(0.00018, 0.00055), "noise": 0.00075, "reversion": 0.04, "volume": random.uniform(2.0, 4.2)}
    if regime == "volume_down":
        return {"drift": -random.uniform(0.00018, 0.00058), "noise": 0.00078, "reversion": 0.04, "volume": random.uniform(2.1, 4.5)}
    if regime == "volatile":
        return {"drift": random.uniform(-0.00008, 0.00008), "noise": 0.00082, "reversion": 0.08, "volume": random.uniform(1.0, 1.9)}
    return {"drift": random.uniform(-0.00004, 0.00004), "noise": 0.00038, "reversion": 0.13, "volume": random.uniform(0.45, 0.85)}


def clamp_price_to_kline_anchor(prev_price: float, next_price: float, kline_anchor: float | None):
    if not kline_anchor or kline_anchor <= 0:
        return next_price

    anchor_lower = kline_anchor * (1 - MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO)
    anchor_upper = kline_anchor * (1 + MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO)
    step_base = kline_anchor if not anchor_lower <= prev_price <= anchor_upper else prev_price
    step_lower = step_base * (1 - MAX_SIMULATED_TICK_STEP_RATIO)
    step_upper = step_base * (1 + MAX_SIMULATED_TICK_STEP_RATIO)
    return max(1.0, min(anchor_upper, max(anchor_lower, min(step_upper, max(step_lower, next_price)))))


async def get_latest_kline_close_map(stocks, timeframe: str = "1h"):
    anchors = {}
    for stock in stocks:
        symbol = stock.get("symbol")
        if not symbol:
            continue
        try:
            klines = await db_manager.get_klines(symbol, timeframe, limit=1)
            if klines:
                anchors[symbol] = float(klines[-1]["close"])
        except Exception as exc:
            kline_logger.warning("KLINE_ANCHOR_LOOKUP_FAILED symbol=%s timeframe=%s error=%s", symbol, timeframe, exc)
    return anchors


def simulate_stock_prices(stocks, base_fallback, market_type="US", kline_anchors=None):
    kline_anchors = kline_anchors or {}
    updated = []
    market_drift = random.gauss(0, 0.00028 if market_type == "US" else 0.00036)
    for stock in stocks:
        prev_price = float(stock.get("price") or base_fallback)
        base_volume = max(0.01, min(float(stock.get("volume") or 1), MAX_SIMULATED_STOCK_VOLUME_MILLIONS))
        state = next_quote_state(stock["symbol"], prev_price, base_volume)
        profile = regime_tick_profile(state["regime"])
        kline_anchor = kline_anchors.get(stock["symbol"])
        if kline_anchor:
            state["anchor"] = float(kline_anchor)
        anchor = float(kline_anchor or state.get("anchor") or prev_price)
        reversion = (anchor - prev_price) / max(prev_price, 1) * profile["reversion"]
        momentum = float(state.get("momentum") or 0) * 0.22
        change_pct = profile["drift"] + random.gauss(0, profile["noise"]) + reversion + momentum + market_drift
        proposed_sign = 1 if change_pct > 0 else -1 if change_pct < 0 else 0
        last_sign = int(state.get("lastSign") or 0)
        streak = int(state.get("streak") or 0)
        if proposed_sign and proposed_sign == last_sign:
            if streak >= 5:
                change_pct = -proposed_sign * abs(random.gauss(0.00045, 0.00028))
            elif streak >= 3 and random.random() < 0.75:
                change_pct -= proposed_sign * random.uniform(0.00035, 0.0010)

        change_pct = max(-MAX_SIMULATED_TICK_STEP_RATIO, min(MAX_SIMULATED_TICK_STEP_RATIO, change_pct))
        proposed_price = prev_price * (1 + change_pct)
        next_price = round(clamp_price_to_kline_anchor(prev_price, proposed_price, kline_anchor), 2)
        raw_change = next_price - prev_price
        realized_sign = 1 if raw_change > 0 else -1 if raw_change < 0 else 0
        state["lastSign"] = realized_sign
        state["streak"] = (streak + 1) if realized_sign and realized_sign == last_sign else (1 if realized_sign else 0)
        state["momentum"] = (next_price - prev_price) / max(prev_price, 1)
        tick_volume = max(1, min(MAX_SIMULATED_TICK_VOLUME, round(base_volume * 1000 * profile["volume"] * random.lognormvariate(0, 0.18))))
        next_volume = round(max(0.01, tick_volume / 1000), 4)
        updated.append({
            **stock,
            "price": next_price,
            "change": round(raw_change, 2),
            "changePercent": round((raw_change / prev_price) * 100, 2) if prev_price else 0,
            "high24h": max(float(stock.get("high24h") or next_price), next_price),
            "low24h": min(float(stock.get("low24h") or next_price), next_price),
            "volume": next_volume,
            "tickVolume": tick_volume,
            "tickRegime": state["regime"],
            "priceSource": "simulated_sqlite",
        })
    return updated


async def persist_tick_updates(updated_us, updated_tw):
    await db_manager.update_all_prices_and_klines(updated_us, "US")
    await db_manager.update_all_prices_and_klines(updated_tw, "TW")


def update_due_market_stocks(stocks, base_fallback, market_type, now_monotonic, kline_anchors=None):
    due_stocks = []
    for stock in stocks:
        symbol = stock.get("symbol")
        if not symbol:
            continue
        key = f"{market_type}:{symbol}"
        if key not in next_symbol_tick_at:
            next_symbol_tick_at[key] = now_monotonic + get_next_simulated_tick_delay()
            continue
        if now_monotonic >= next_symbol_tick_at[key]:
            due_stocks.append(stock)

    if not due_stocks:
        return stocks, False

    due_anchors = {
        stock["symbol"]: (kline_anchors or {}).get(stock["symbol"])
        for stock in due_stocks
        if stock.get("symbol")
    }
    updated_due = simulate_stock_prices(due_stocks, base_fallback, market_type, due_anchors)
    updated_by_symbol = {stock["symbol"]: stock for stock in updated_due}

    for stock in updated_due:
        next_symbol_tick_at[f"{market_type}:{stock['symbol']}"] = now_monotonic + get_next_simulated_tick_delay()

    return [updated_by_symbol.get(stock.get("symbol"), stock) for stock in stocks], True


async def background_tick_loop():
    global indices_us, indices_tw, live_stocks_us, live_stocks_tw, tick_persist_task
    while True:
        await asyncio.sleep(SIMULATED_PRICE_UPDATE_POLL_INTERVAL_SECONDS)
        try:
            stocks_us = live_stocks_us
            stocks_tw = live_stocks_tw
            if stocks_us is None or stocks_tw is None:
                stocks_us = await get_us_dashboard_stocks()
                stocks_tw = await db_manager.get_stocks("TW")
                anchors_us = await get_latest_kline_close_map(stocks_us)
                anchors_tw = await get_latest_kline_close_map(stocks_tw)
            else:
                anchors_us = None
                anchors_tw = None

            now_monotonic = time.monotonic()
            indices_us, did_update_indices_us = update_due_indices(indices_us, "US", now_monotonic)
            indices_tw, did_update_indices_tw = update_due_indices(indices_tw, "TW", now_monotonic)
            updated_us, did_update_us = update_due_market_stocks(stocks_us, 180.0, "US", now_monotonic, anchors_us)
            updated_tw, did_update_tw = update_due_market_stocks(stocks_tw, 780.0, "TW", now_monotonic, anchors_tw)
            if not did_update_us and not did_update_tw and not did_update_indices_us and not did_update_indices_tw:
                continue

            live_stocks_us = updated_us
            live_stocks_tw = updated_tw

            indices_us, did_update_indices_us = update_due_indices(indices_us, "US", now_monotonic)
            indices_tw, did_update_indices_tw = update_due_indices(indices_tw, "TW", now_monotonic)

            if connected_clients:
                await broadcast_market_update("US", updated_us, indices_us)
                await broadcast_market_update("TW", updated_tw, indices_tw)
                for ws in list(connected_clients):
                    market = client_states.get(ws, {}).get("market", "US")
                    current_stocks = updated_us if market == "US" else updated_tw
                    if random.random() < 0.25:
                        signal = generate_random_signal(market, current_stocks)
                        if signal:
                            await ws.send_json({"type": "AI_SIGNAL", "signal": signal})

            if tick_persist_task and tick_persist_task.done():
                try:
                    tick_persist_task.result()
                except Exception as persist_exc:
                    logger.warning("BACKGROUND_TICK_PERSIST_FAILED error=%s", persist_exc)
                tick_persist_task = None

            if tick_persist_task is None:
                tick_persist_task = asyncio.create_task(persist_tick_updates(updated_us, updated_tw))
        except Exception as exc:
            logger.warning("BACKGROUND_TICK_FAILED error=%s", exc)


def update_indices(indices):
    updated = []
    for index in indices:
        change_pct = (random.random() - 0.5) * 0.001
        next_price = round(index["price"] * (1 + change_pct), 2)
        updated.append({**index, "price": next_price})
    return updated


def update_due_indices(indices, market_type: str, now_monotonic: float):
    if market_type not in next_index_tick_at:
        next_index_tick_at[market_type] = now_monotonic + get_next_index_tick_delay()
        return indices, False

    if now_monotonic < next_index_tick_at[market_type]:
        return indices, False

    next_index_tick_at[market_type] = now_monotonic + get_next_index_tick_delay()
    return update_indices(indices), True
