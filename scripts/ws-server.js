const { WebSocketServer } = require('ws');
const db = require('./db');

// 伺服器監聽埠口
const PORT = 8080;
const SIMULATED_PRICE_UPDATE_MIN_INTERVAL_MS = 300;
const SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS = 1500;
const SIMULATED_PRICE_UPDATE_MAX_INTERVAL_MS = 5000;
const SIMULATED_PRICE_UPDATE_FAST_PROBABILITY = 0.7;
const SIMULATED_PRICE_UPDATE_POLL_INTERVAL_MS = 250;
const MAX_SIMULATED_STOCK_VOLUME_MILLIONS = 250;
const MAX_SIMULATED_TICK_VOLUME = 2000000;
const MAX_SIMULATED_TICK_STEP_RATIO = 0.0018;
const MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO = 0.012;
const wss = new WebSocketServer({ port: PORT });

// 隨機數輔助函數
const randomInRange = (min, max) => Math.random() * (max - min) + min;
const getNextSimulatedTickDelay = () => {
  if (Math.random() < SIMULATED_PRICE_UPDATE_FAST_PROBABILITY) {
    return Math.round(randomInRange(SIMULATED_PRICE_UPDATE_MIN_INTERVAL_MS, SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS));
  }

  return Math.round(randomInRange(SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS, SIMULATED_PRICE_UPDATE_MAX_INTERVAL_MS));
};
const quoteStates = new Map();
let liveStocksUS = null;
let liveStocksTW = null;
let persistPromise = null;
const nextSymbolTickAt = new Map();

const updateDueMarketStocks = (stocks, marketType, marketDrift, anchors) => {
  const now = Date.now();
  const dueStocks = [];

  stocks.forEach((stock) => {
    const key = `${marketType}:${stock.symbol}`;
    if (!nextSymbolTickAt.has(key)) {
      nextSymbolTickAt.set(key, now + getNextSimulatedTickDelay());
      return;
    }

    if (now >= nextSymbolTickAt.get(key)) {
      dueStocks.push(stock);
    }
  });

  if (dueStocks.length === 0) {
    return { stocks, didUpdate: false };
  }

  const updatedBySymbol = new Map();
  dueStocks.forEach((stock) => {
    const updated = simulateStockTick(stock, marketDrift, anchors.get(stock.symbol));
    updatedBySymbol.set(updated.symbol, updated);
    nextSymbolTickAt.set(`${marketType}:${updated.symbol}`, now + getNextSimulatedTickDelay());
  });

  return {
    stocks: stocks.map((stock) => updatedBySymbol.get(stock.symbol) || stock),
    didUpdate: true,
  };
};

const chooseQuoteRegime = (previousRegime) => {
  let roll = Math.random();
  if (previousRegime === 'volume_up' || previousRegime === 'volume_down') roll += 0.24;
  if (roll < 0.54) return 'sideways';
  if (roll < 0.78) return 'volatile';
  if (roll < 0.86) return 'trend_up';
  if (roll < 0.94) return 'trend_down';
  if (roll < 0.97) return 'volume_up';
  return 'volume_down';
};

const getQuoteState = (symbol, prevPrice, baseVolume) => {
  let state = quoteStates.get(symbol);
  if (!state) {
    state = {
      anchor: prevPrice,
      baseVolume: Math.max(0.01, Math.min(baseVolume, MAX_SIMULATED_STOCK_VOLUME_MILLIONS)),
      regime: chooseQuoteRegime(),
      ttl: Math.floor(randomInRange(6, 18)),
      momentum: 0,
      lastSign: 0,
      streak: 0,
    };
  }

  state.ttl -= 1;
  if (state.ttl <= 0) {
    const nextRegime = chooseQuoteRegime(state.regime);
    state.regime = nextRegime;
    state.ttl = nextRegime.startsWith('volume_')
      ? Math.floor(randomInRange(3, 8))
      : Math.floor(randomInRange(8, 26));
    if (Math.abs(prevPrice - state.anchor) / Math.max(prevPrice, 1) > 0.08) {
      state.anchor = prevPrice;
    }
  }

  quoteStates.set(symbol, state);
  return state;
};

const gaussian = (mean = 0, std = 1) => {
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const regimeTickProfile = (regime) => {
  if (regime === 'trend_up') return { drift: randomInRange(0.00008, 0.00032), noise: 0.00072, reversion: 0.045, volume: randomInRange(1.15, 1.85) };
  if (regime === 'trend_down') return { drift: -randomInRange(0.00008, 0.00034), noise: 0.00078, reversion: 0.045, volume: randomInRange(1.25, 2.0) };
  if (regime === 'volume_up') return { drift: randomInRange(0.00035, 0.0010), noise: 0.00115, reversion: 0.035, volume: randomInRange(2.6, 5.8) };
  if (regime === 'volume_down') return { drift: -randomInRange(0.00035, 0.00105), noise: 0.0012, reversion: 0.035, volume: randomInRange(2.8, 6.4) };
  if (regime === 'volatile') return { drift: randomInRange(-0.00012, 0.00012), noise: 0.00115, reversion: 0.07, volume: randomInRange(1.05, 2.15) };
  return { drift: randomInRange(-0.00006, 0.00006), noise: 0.00048, reversion: 0.12, volume: randomInRange(0.45, 0.9) };
};

const clampPriceToKlineAnchor = (prevPrice, nextPrice, klineAnchor) => {
  if (!klineAnchor || klineAnchor <= 0) return nextPrice;

  const anchorLower = klineAnchor * (1 - MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO);
  const anchorUpper = klineAnchor * (1 + MAX_SIMULATED_DISTANCE_FROM_KLINE_RATIO);
  const stepBase = prevPrice >= anchorLower && prevPrice <= anchorUpper ? prevPrice : klineAnchor;
  const stepLower = stepBase * (1 - MAX_SIMULATED_TICK_STEP_RATIO);
  const stepUpper = stepBase * (1 + MAX_SIMULATED_TICK_STEP_RATIO);

  return Math.max(1, Math.min(anchorUpper, Math.max(anchorLower, Math.min(stepUpper, Math.max(stepLower, nextPrice)))));
};

const getLatestKlineAnchors = async (stocks, timeframe = '1h') => {
  const entries = await Promise.all(stocks.map(async (stock) => {
    try {
      const klines = await db.getKLines(stock.symbol, timeframe, 1);
      const latest = klines[klines.length - 1];
      return latest ? [stock.symbol, Number(latest.close)] : null;
    } catch (err) {
      console.warn('KLINE_ANCHOR_LOOKUP_FAILED', stock.symbol, err.message);
      return null;
    }
  }));

  return new Map(entries.filter(Boolean));
};

const simulateStockTick = (stock, marketDrift, klineAnchor) => {
  const prevPrice = Number(stock.price) || 100;
  const baseVolume = Math.max(0.01, Math.min(Number(stock.volume) || 1, MAX_SIMULATED_STOCK_VOLUME_MILLIONS));
  const state = getQuoteState(stock.symbol, prevPrice, baseVolume);
  if (klineAnchor) state.anchor = klineAnchor;
  const profile = regimeTickProfile(state.regime);
  const reversion = ((state.anchor - prevPrice) / Math.max(prevPrice, 1)) * profile.reversion;
  const momentum = (state.momentum || 0) * 0.22;
  let changePct = profile.drift + gaussian(0, profile.noise) + reversion + momentum + marketDrift;
  const proposedSign = changePct > 0 ? 1 : changePct < 0 ? -1 : 0;
  const lastSign = Number(state.lastSign) || 0;
  const streak = Number(state.streak) || 0;

  if (proposedSign && proposedSign === lastSign) {
    if (streak >= 5) {
      changePct = -proposedSign * Math.abs(gaussian(0.00045, 0.00028));
    } else if (streak >= 3 && Math.random() < 0.75) {
      changePct -= proposedSign * randomInRange(0.00035, 0.0010);
    }
  }

  changePct = Math.max(-MAX_SIMULATED_TICK_STEP_RATIO, Math.min(MAX_SIMULATED_TICK_STEP_RATIO, changePct));
  const proposedPrice = prevPrice * (1 + changePct);
  const nextPrice = Math.max(1, parseFloat(clampPriceToKlineAnchor(prevPrice, proposedPrice, klineAnchor).toFixed(2)));
  const rawChange = nextPrice - prevPrice;
  const tickVolume = Math.max(1, Math.min(MAX_SIMULATED_TICK_VOLUME, Math.round(baseVolume * 1000 * profile.volume * Math.exp(gaussian(0, 0.18)))));
  const realizedSign = rawChange > 0 ? 1 : rawChange < 0 ? -1 : 0;
  state.lastSign = realizedSign;
  state.streak = realizedSign && realizedSign === lastSign ? streak + 1 : (realizedSign ? 1 : 0);
  state.momentum = rawChange / Math.max(prevPrice, 1);

  return {
    ...stock,
    price: nextPrice,
    change: parseFloat(rawChange.toFixed(2)),
    changePercent: parseFloat(((rawChange / prevPrice) * 100).toFixed(2)),
    high24h: Math.max(stock.high24h, nextPrice),
    low24h: Math.min(stock.low24h, nextPrice),
    volume: parseFloat((tickVolume / 1000).toFixed(4)),
    tickVolume,
    tickRegime: state.regime,
    priceSource: 'simulated_sqlite',
  };
};

// 大盤指數初始資料 (保留於記憶體中)
let indicesUS = [
  { symbol: '.SPX', name: 'S&P 500', price: 5137.08, changePercent: 0.82, sparkline: [5095, 5102, 5098, 5110, 5108, 5122, 5118, 5125, 5130, 5127, 5137] },
  { symbol: '.IXIC', name: 'Nasdaq', price: 16274.94, changePercent: 1.14, sparkline: [16050, 16110, 16080, 16150, 16120, 16200, 16180, 16230, 16250, 16240, 16274] },
  { symbol: '.DJI', name: 'Dow Jones', price: 39087.38, changePercent: 0.23, sparkline: [38980, 39020, 39000, 39040, 39030, 39070, 39050, 39060, 39080, 39070, 39087] },
  { symbol: '.SOX', name: 'SOX (費半)', price: 4929.58, changePercent: 2.15, sparkline: [4810, 4850, 4830, 4880, 4860, 4910, 4890, 4920, 4940, 4915, 4929] },
];

let indicesTW = [
  { symbol: '.TWII', name: '台股加權指數', price: 20337.54, changePercent: 1.25, sparkline: [20050, 20120, 20080, 20180, 20150, 20240, 20210, 20280, 20310, 20290, 20337] },
  { symbol: '.TWOI', name: '櫃買指數 (OTC)', price: 252.32, changePercent: 0.88, sparkline: [249.5, 250.2, 249.8, 250.8, 250.5, 251.4, 251.1, 251.9, 252.1, 252.0, 252.32] },
];

// AI 訊號範本
const mockSignalTemplates = [
  { symbol: 'AAPL', strategy: 'LSTM', confidence: 88, type: 'BUY', priceOffset: 1.002 },
  { symbol: 'TSLA', strategy: 'MOMENTUM', confidence: 79, type: 'BUY', priceOffset: 1.015 },
  { symbol: 'NVDA', strategy: 'BOLLINGER', confidence: 91, type: 'SELL', priceOffset: 0.992 },
  { symbol: '2330.TW', strategy: 'LSTM', confidence: 85, type: 'BUY', priceOffset: 1.008 },
  { symbol: '2454.TW', strategy: 'BOLLINGER', confidence: 73, type: 'SELL', priceOffset: 0.985 },
  { symbol: 'MSFT', strategy: 'MOMENTUM', confidence: 82, type: 'BUY', priceOffset: 1.004 },
];

// 產生隨機即時訊號
function generateRandomSignal(marketType, currentStocks) {
  const templates = mockSignalTemplates.filter(t => 
    marketType === 'TW' ? t.symbol.endsWith('.TW') : !t.symbol.endsWith('.TW')
  );
  const template = templates[Math.floor(Math.random() * templates.length)];
  
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  
  const baseStock = currentStocks.find(s => s.symbol === template.symbol) || currentStocks[0];
  const finalPrice = parseFloat((baseStock.price * template.priceOffset).toFixed(2));

  return {
    id: `${template.symbol}-${Date.now()}`,
    time: timeStr,
    type: template.type,
    symbol: template.symbol,
    price: finalPrice,
    confidence: template.confidence + Math.round(randomInRange(-5, 5)),
    strategy: template.strategy,
  };
}

// 模擬資產配置
const getPortfolio = (stocksList, marketType) => {
  if (marketType === 'US') {
    const defaultPortfolio = [
      { symbol: 'AAPL', name: 'Apple Inc.', shares: 150, avgPrice: 175.20, color: '#06b6d4' },
      { symbol: 'MSFT', name: 'Microsoft Corp.', shares: 60, avgPrice: 395.40, color: '#3b82f6' },
      { symbol: 'NVDA', name: 'NVIDIA Corp.', shares: 45, avgPrice: 720.00, color: '#10b981' },
      { symbol: 'TSLA', name: 'Tesla Inc.', shares: 110, avgPrice: 185.00, color: '#f59e0b' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', shares: 5, avgPrice: 148.00, color: '#ec4899' },
    ];
    return calculateWeights(defaultPortfolio, stocksList);
  } else {
    const defaultPortfolio = [
      { symbol: '2330.TW', name: '台積電', shares: 5000, avgPrice: 710.00, color: '#10b981' },
      { symbol: '2317.TW', name: '鴻海', shares: 12000, avgPrice: 120.00, color: '#06b6d4' },
      { symbol: '2454.TW', name: '聯發科', shares: 800, avgPrice: 1050.00, color: '#3b82f6' },
      { symbol: '2881.TW', name: '富邦金', shares: 1000, avgPrice: 70.00, color: '#f59e0b' },
    ];
    return calculateWeights(defaultPortfolio, stocksList);
  }
};

const calculateWeights = (portfolio, stocksList) => {
  const updated = portfolio.map(asset => {
    const matchedStock = stocksList.find(s => s.symbol === asset.symbol);
    const currentPrice = matchedStock ? matchedStock.price : asset.avgPrice;
    return {
      ...asset,
      currentPrice,
      value: parseFloat((asset.shares * currentPrice).toFixed(2)),
    };
  });

  const totalValue = updated.reduce((sum, item) => sum + item.value, 0);
  return updated.map(item => ({
    ...item,
    weight: parseFloat(((item.value / totalValue) * 100).toFixed(1)),
  }));
};

// 儲存每個 Client 連線的狀態
const clients = new Map();

// 初始化資料庫並啟動服務
db.initDb().then(() => {
  console.log('✅ Database schema and data verified.');
  
  wss.on('connection', (ws) => {
    console.log('🔌 Client connected');
    
    // 建立連線預設狀態
    const clientState = {
      market: 'US',
    };
    clients.set(ws, clientState);

    // 監聽訊息
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log('📥 Received:', data);

        if (data.type === 'SUBSCRIBE_MARKET' || data.type === 'SUBSCRIBE_ALL_PAIRS') {
          const targetMarket = data.market;
          clientState.market = targetMarket;
          clientState.subscription = 'all_pairs';
          
          // 從 SQLite 讀取該市場股票
          const stocks = await db.getStocks(targetMarket);
          const indices = targetMarket === 'US' ? indicesUS : indicesTW;
          const portfolio = getPortfolio(stocks, targetMarket);

          // 發送初始包給 Client
          ws.send(JSON.stringify({
            type: 'INITIAL_DATA',
            market: targetMarket,
            stocks: stocks,
            indices: indices,
            portfolio: portfolio,
          }));
        } else if (data.type === 'GET_KLINES') {
          const { symbol, timeframe, limit, before } = data;
          // 從 SQLite 讀取 K 線並返回
          const klines = await db.getKLines(symbol, timeframe, limit || 1000, before);
          ws.send(JSON.stringify({
            type: 'KLINES_DATA',
            symbol,
            timeframe,
            klines,
          }));
        } else if (data.type === 'TOGGLE_FAV') {
          const { symbol } = data;
          const isFav = await db.toggleFav(symbol);
          
          // 重新廣播最新的 stocks
          const stocks = await db.getStocks(clientState.market);
          ws.send(JSON.stringify({
            type: 'TICK_UPDATE',
            stocks: stocks,
            indices: clientState.market === 'US' ? indicesUS : indicesTW,
          }));
        }
      } catch (err) {
        console.error('❌ Parse error:', err);
      }
    });

    ws.on('close', () => {
      console.log('🔌 Client disconnected');
      clients.delete(ws);
    });
  });

  // 全域單一的 Tick 更新定時器
  const scheduleNextTick = () => {
    setTimeout(runTickLoop, SIMULATED_PRICE_UPDATE_POLL_INTERVAL_MS);
  };

  const runTickLoop = async () => {
    try {
      // 1. 取得最新資料庫 stocks
      const stocksUS = liveStocksUS || await db.getStocks('US');
      const stocksTW = liveStocksTW || await db.getStocks('TW');

      // 2. 模擬價格跳動
      const marketDriftUS = gaussian(0, 0.00028);
      const marketDriftTW = gaussian(0, 0.00036);
      const anchorsUS = liveStocksUS ? new Map() : await getLatestKlineAnchors(stocksUS);
      const anchorsTW = liveStocksTW ? new Map() : await getLatestKlineAnchors(stocksTW);
      const nextUS = updateDueMarketStocks(stocksUS, 'US', marketDriftUS, anchorsUS);
      const nextTW = updateDueMarketStocks(stocksTW, 'TW', marketDriftTW, anchorsTW);
      if (!nextUS.didUpdate && !nextTW.didUpdate) {
        return;
      }

      const updatedUS = nextUS.stocks;
      const updatedTW = nextTW.stocks;
      liveStocksUS = updatedUS;
      liveStocksTW = updatedTW;

      // 3. 在 SQLite Transaction 中同步寫入個股價格及所有 timeframe K 線的最新 Bar

      // 4. 模擬大盤指數跳動
      if (nextUS.didUpdate) indicesUS = indicesUS.map((idx) => {
        const changePct = (Math.random() - 0.5) * 0.002;
        const nextPrice = parseFloat((idx.price * (1 + changePct)).toFixed(2));
        const newSpark = [...idx.sparkline.slice(1), nextPrice];
        return { ...idx, price: nextPrice, sparkline: newSpark };
      });

      if (nextTW.didUpdate) indicesTW = indicesTW.map((idx) => {
        const changePct = (Math.random() - 0.5) * 0.002;
        const nextPrice = parseFloat((idx.price * (1 + changePct)).toFixed(2));
        const newSpark = [...idx.sparkline.slice(1), nextPrice];
        return { ...idx, price: nextPrice, sparkline: newSpark };
      });

      // 5. 對每個連線的 Client 發送最新狀態
      for (const [ws, state] of clients.entries()) {
        if (ws.readyState !== ws.OPEN) continue;

        const currentStocks = state.market === 'US' ? updatedUS : updatedTW;
        const currentIndices = state.market === 'US' ? indicesUS : indicesTW;

        ws.send(JSON.stringify({
          type: 'TICK_UPDATE',
          stocks: currentStocks,
          indices: currentIndices,
        }));

        // 25% 概率產生即時 AI 交易訊號，廣播發送
        if (Math.random() < 0.25) {
          const signal = generateRandomSignal(state.market, currentStocks);
          ws.send(JSON.stringify({
            type: 'AI_SIGNAL',
            signal,
          }));
        }
      }

      if (!persistPromise) {
        persistPromise = Promise.all([
          db.updateAllPricesAndKLines(updatedUS, 'US'),
          db.updateAllPricesAndKLines(updatedTW, 'TW'),
        ]).catch((persistErr) => {
          console.error('❌ Error persisting tick update:', persistErr);
        }).finally(() => {
          persistPromise = null;
        });
      }
    } catch (tickErr) {
      console.error('❌ Error in TICK_UPDATE interval:', tickErr);
    } finally {
      scheduleNextTick();
    }
  };

  scheduleNextTick();

  console.log(`🚀 QUANT-X WebSocket Server with SQLite is running on ws://localhost:${PORT}`);
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
});
