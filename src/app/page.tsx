'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { 
  generateHistoryKLines, 
  initialStocksUS,
  initialStocksTW,
  initialIndicesUS,
  initialIndicesTW,
  initialPortfolioUS,
  initialPortfolioTW,
  getRiskStatus,
  mockHeatmapUS,
  mockHeatmapTW
} from '../services/mockData';
import { StockInfo, MarketIndex, Signal, KLineData, Trade, BacktestResult } from '../types';
import { AIStrategy, runStrategyBacktest } from '../services/strategyEngine';

import MarketOverview from '../components/MarketOverview';
import AIStrategyConsole from '../components/AIStrategyConsole';
import MarketSentiment from '../components/MarketSentiment';
import WatchlistLeaderboard from '../components/WatchlistLeaderboard';
import PortfolioRisk from '../components/PortfolioRisk';

type KlineSyncedQuote = Pick<StockInfo, 'price' | 'change' | 'changePercent' | 'high24h' | 'low24h' | 'isKlineSynced' | 'priceSource'>;

const KLINE_TIMEFRAMES = ['15m', '1h', '4h', '1d', '1w', '1M'] as const;

const getTimeframeIntervalMs = (tf: string) => {
  if (tf === '15m') return 15 * 60 * 1000;
  if (tf === '4h') return 4 * 60 * 60 * 1000;
  if (tf === '1d') return 24 * 60 * 60 * 1000;
  if (tf === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (tf === '1M') return 30 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
};

const getBarStartTimestamp = (timestamp: number, tf: string) => {
  const intervalMs = getTimeframeIntervalMs(tf);
  return Math.floor(timestamp / intervalMs) * intervalMs;
};

const INITIAL_KLINE_LIMIT = 1000;
const OLDER_KLINE_BATCH_SIZE = 1000;
const OLDER_KLINE_TRIGGER_INDEX = 80;
const SIMULATED_PRICE_UPDATE_MIN_INTERVAL_MS = 600;
const SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS = 2400;
const SIMULATED_PRICE_UPDATE_MAX_INTERVAL_MS = 8000;
const SIMULATED_PRICE_UPDATE_FAST_PROBABILITY = 0.55;
const SIMULATED_PRICE_UPDATE_POLL_INTERVAL_MS = 400;
const SIMULATED_INDEX_UPDATE_MIN_INTERVAL_MS = 3000;
const SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_MS = 7000;
const SIMULATED_INDEX_UPDATE_MAX_INTERVAL_MS = 10000;
const SIMULATED_INDEX_UPDATE_FAST_PROBABILITY = 0.6;
const CHART_DRAWINGS_STORAGE_PREFIX = 'quantx:kline-drawings:';
const STRATEGIES_STORAGE_KEY = 'quantx:custom-strategies';
const KLINE_CACHE_STORAGE_PREFIX = 'quantx:kline-cache:';
const MAX_LIVE_PRICE_STEP_FROM_KLINE = 0.0025;
const MAX_LIVE_PRICE_DISTANCE_FROM_KLINE = 0.012;
const EMPTY_CHART_DRAWINGS: ChartDrawing[] = [];
const DEFAULT_STRATEGIES: Record<string, AIStrategy> = {
  LSTM: {
    id: 'LSTM',
    name: 'LSTM trend forecast',
    description: '',
    concept: '',
    logic: '',
    indicators: ['MA_5'],
    parameters: { stopLoss: 3, takeProfit: 8, positionSize: 15, riskControl: '' },
  },
  MOMENTUM: {
    id: 'MOMENTUM',
    name: 'Volume momentum breakout',
    description: '',
    concept: '',
    logic: '',
    indicators: ['MA_10'],
    parameters: { stopLoss: 4, takeProfit: 10, positionSize: 20, riskControl: '' },
  },
  BOLLINGER: {
    id: 'BOLLINGER',
    name: 'Bollinger channel',
    description: '',
    concept: '',
    logic: '',
    indicators: ['Bollinger_20_2'],
    parameters: { stopLoss: 2.5, takeProfit: 6, positionSize: 10, riskControl: '' },
  },
};

type VisibleRange = {
  fromIndex: number;
  toIndex: number;
  fromTimestamp: number;
  toTimestamp: number;
};

type ChartDrawingValue = string | number | boolean | null | ChartDrawingValue[] | { [key: string]: ChartDrawingValue };
type ChartDrawing = Record<string, ChartDrawingValue>;

const getChartDrawingsStorageKey = (symbol: string) => (
  `${CHART_DRAWINGS_STORAGE_PREFIX}${encodeURIComponent(symbol || 'unknown')}`
);

const readStoredChartDrawings = (symbol: string): ChartDrawing[] => {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(getChartDrawingsStorageKey(symbol));
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Failed to read chart drawings:', symbol, err);
    return [];
  }
};

const readStoredStrategies = (): AIStrategy[] => {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(STRATEGIES_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item: any) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        description: String(item.description || ''),
        concept: String(item.concept || ''),
        logic: String(item.logic || ''),
        indicators: Array.isArray(item.indicators) ? item.indicators.map((value: unknown) => String(value)) : [],
        parameters: {
          stopLoss: Number(item.parameters?.stopLoss ?? 0),
          takeProfit: Number(item.parameters?.takeProfit ?? 0),
          positionSize: Number(item.parameters?.positionSize ?? 0),
          riskControl: String(item.parameters?.riskControl || ''),
        },
      }))
      .filter((strategy) => strategy.id && strategy.name);
  } catch (err) {
    console.warn('Failed to read custom strategies:', err);
    return [];
  }
};

const writeStoredStrategies = (strategies: AIStrategy[]) => {
  if (typeof window === 'undefined') return;

  try {
    if (strategies.length === 0) {
      window.localStorage.removeItem(STRATEGIES_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(STRATEGIES_STORAGE_KEY, JSON.stringify(strategies));
  } catch (err) {
    console.warn('Failed to save custom strategies:', err);
  }
};

const writeStoredChartDrawings = (symbol: string, drawings: ChartDrawing[]) => {
  if (typeof window === 'undefined') return;

  try {
    const storageKey = getChartDrawingsStorageKey(symbol);
    if (drawings.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(drawings));
  } catch (err) {
    console.warn('Failed to save chart drawings:', symbol, err);
  }
};

const getCachedKlineStorageKey = (symbol: string, timeframe: string) => (
  `${KLINE_CACHE_STORAGE_PREFIX}${encodeURIComponent(symbol || 'unknown')}|${encodeURIComponent(timeframe || '1h')}`
);

const readStoredKlines = (symbol: string, timeframe: string): KLineData[] => {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(getCachedKlineStorageKey(symbol, timeframe));
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Failed to read cached klines:', symbol, timeframe, err);
    return [];
  }
};

const writeStoredKlines = (symbol: string, timeframe: string, klines: KLineData[]) => {
  if (typeof window === 'undefined') return;

  try {
    const storageKey = getCachedKlineStorageKey(symbol, timeframe);
    if (klines.length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }

    window.localStorage.setItem(storageKey, JSON.stringify(klines));
  } catch (err) {
    console.warn('Failed to save cached klines:', symbol, timeframe, err);
  }
};

const clampPriceNearKline = (price: number, anchorPrice?: number, previousPrice?: number) => {
  if (!anchorPrice || anchorPrice <= 0) return Math.max(1, price);

  const lowerBound = anchorPrice * (1 - MAX_LIVE_PRICE_DISTANCE_FROM_KLINE);
  const upperBound = anchorPrice * (1 + MAX_LIVE_PRICE_DISTANCE_FROM_KLINE);
  const stepBase = previousPrice && previousPrice >= lowerBound && previousPrice <= upperBound
    ? previousPrice
    : anchorPrice;
  const stepLower = stepBase * (1 - MAX_LIVE_PRICE_STEP_FROM_KLINE);
  const stepUpper = stepBase * (1 + MAX_LIVE_PRICE_STEP_FROM_KLINE);

  return Math.max(1, Math.min(upperBound, Math.max(lowerBound, Math.min(stepUpper, Math.max(stepLower, price)))));
};

const getRandomDelay = (minMs: number, maxMs: number) => (
  Math.round(minMs + Math.random() * (maxMs - minMs))
);

const getNextSimulatedTickDelay = () => {
  if (Math.random() < SIMULATED_PRICE_UPDATE_FAST_PROBABILITY) {
    return getRandomDelay(SIMULATED_PRICE_UPDATE_MIN_INTERVAL_MS, SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS);
  }

  return getRandomDelay(SIMULATED_PRICE_UPDATE_FAST_MAX_INTERVAL_MS, SIMULATED_PRICE_UPDATE_MAX_INTERVAL_MS);
};

const getNextIndexSimulatedTickDelay = () => {
  if (Math.random() < SIMULATED_INDEX_UPDATE_FAST_PROBABILITY) {
    return getRandomDelay(SIMULATED_INDEX_UPDATE_MIN_INTERVAL_MS, SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_MS);
  }

  return getRandomDelay(SIMULATED_INDEX_UPDATE_FAST_MAX_INTERVAL_MS, SIMULATED_INDEX_UPDATE_MAX_INTERVAL_MS);
};

const buildSignalsFromTrades = (trades: Trade[], symbol: string, strategyId: string): Signal[] => (
  trades.slice(-20).reverse().map((trade, index) => ({
    id: `${strategyId}-${symbol}-${trade.time}-${trade.type}-${index}`,
    time: new Date(trade.time).toLocaleTimeString('zh-TW', { hour12: false }),
    type: trade.type,
    symbol,
    price: trade.price,
    confidence: 100,
    strategy: strategyId,
  }))
);

const calculateBacktestResultFromTrades = (trades: Trade[]): BacktestResult => {
  const roundTrips: number[] = [];

  for (let i = 0; i + 1 < trades.length; i += 2) {
    const entry = trades[i];
    const exit = trades[i + 1];
    if (!entry || !exit || entry.type !== 'BUY' || exit.type !== 'SELL' || entry.price <= 0) {
      continue;
    }

    roundTrips.push((exit.price - entry.price) / entry.price);
  }

  if (roundTrips.length === 0) {
    return { winRate: 0, sharpeRatio: 0, maxDrawdown: 0, profitFactor: 0, totalTrades: trades.length };
  }

  const wins = roundTrips.filter((r) => r > 0).length;
  const losses = roundTrips.filter((r) => r < 0);
  const gains = roundTrips.filter((r) => r > 0);
  const winRate = (wins / roundTrips.length) * 100;
  const totalGain = gains.reduce((sum, r) => sum + r, 0);
  const totalLoss = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? totalGain : 0;

  const meanReturn = roundTrips.reduce((sum, r) => sum + r, 0) / roundTrips.length;
  const variance = roundTrips.reduce((sum, r) => sum + ((r - meanReturn) ** 2), 0) / Math.max(roundTrips.length - 1, 1);
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(roundTrips.length) : 0;

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of roundTrips) {
    equity *= (1 + r);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return {
    winRate: parseFloat(winRate.toFixed(2)),
    sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    totalTrades: trades.length,
  };
};

// 動態載入自訂 K 線圖庫以避免 SSR window is not defined 錯誤
const CustomKLineChart = dynamic(
  () => import('../lib/custom-kline-chart'),
  { 
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[450px] bg-slate-950/60 border border-slate-800 rounded-xl flex items-center justify-center font-mono text-xs text-slate-500">
        <svg className="animate-spin h-5 w-5 mr-3 text-cyan-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        載入 HTML5 Canvas 繪圖引擎...
      </div>
    )
  }
) as any;

export default function DashboardPage() {
  // 全局市場狀態 ('US' | 'TW')，切換時會自動加載對應的股票、指數與配色
  const [market, setMarket] = useState<'US' | 'TW'>('US');
  const [isUSStyle, setIsUSStyle] = useState<boolean>(true); // true: 美股配色(綠漲紅跌)；false: 台股配色(紅漲綠跌)
  const [isWsConnected, setIsWsConnected] = useState<boolean>(false);

  // 基礎股票、指數、自選與資產狀態
  const [stocks, setStocks] = useState<StockInfo[]>([]);
  const [indices, setIndices] = useState<MarketIndex[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [portfolio, setPortfolio] = useState<any[]>([]);
  
  // 當前選定的股票、策略與 K 線週期
  const [selectedSymbol, setSelectedSymbol] = useState<string>('AAPL');
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>('');
  const [customStrategies, setCustomStrategies] = useState<AIStrategy[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [strategiesLoaded, setStrategiesLoaded] = useState<boolean>(false);
  const [chartIndicators, setChartIndicators] = useState<Record<string, any>>({});
  const [timeframe, setTimeframe] = useState<string>('1h');

  // 可拖曳網格狀態
  const [row1Height, setRow1Height] = useState<number>(63); // Row 1 佔百分比高度
  const [row1Widths, setRow1Widths] = useState<number[]>([23, 54, 23]); // Row 1 左、中、右佔百分比寬度
  const [row2Widths, setRow2Widths] = useState<number[]>([50, 50]); // Row 2 左、右佔百分比寬度
  const [activeDrag, setActiveDrag] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    type: string;
    startX: number;
    startY: number;
    startWidths?: number[];
    startHeight?: number;
  } | null>(null);

  // 檢查是否為行動裝置/平板 (RWD 回退機制)
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024); // 使用 1024px 作為分界點
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 拖曳處理事件
  const updateDrag = useCallback((clientX: number, clientY: number) => {
    if (!dragRef.current || !containerRef.current) return;
    const { type, startX, startWidths } = dragRef.current;
    const containerRect = containerRef.current.getBoundingClientRect();

    if (type === 'row-split') {
      const nextHeight = Math.max(25, Math.min(75, ((clientY - containerRect.top) / containerRect.height) * 100));
      setRow1Height(nextHeight);
    } else if (type === 'row1-col1') {
      const deltaX = clientX - startX;
      const deltaPct = (deltaX / containerRect.width) * 100;
      if (startWidths) {
        const rightWidth = startWidths[2];
        let newLeft = Math.max(15, Math.min(35, startWidths[0] + deltaPct));
        let newMid = 100 - newLeft - rightWidth;
        if (newMid < 40) {
          newMid = 40;
          newLeft = 100 - newMid - rightWidth;
        }
        setRow1Widths([newLeft, newMid, rightWidth]);
      }
    } else if (type === 'row1-col2') {
      const deltaX = clientX - startX;
      const deltaPct = (deltaX / containerRect.width) * 100;
      if (startWidths) {
        const leftWidth = startWidths[0];
        let newRight = Math.max(15, Math.min(35, startWidths[2] - deltaPct));
        let newMid = 100 - leftWidth - newRight;
        if (newMid < 40) {
          newMid = 40;
          newRight = 100 - leftWidth - newMid;
        }
        setRow1Widths([leftWidth, newMid, newRight]);
      }
    } else if (type === 'row2-col1') {
      const deltaX = clientX - startX;
      const deltaPct = (deltaX / containerRect.width) * 100;
      if (startWidths) {
        const newLeft = Math.max(20, Math.min(80, startWidths[0] + deltaPct));
        setRow2Widths([newLeft, 100 - newLeft]);
      }
    }
  }, []);

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    setActiveDrag(null);
    document.body.classList.remove('select-none');
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => updateDrag(e.clientX, e.clientY);

    if (activeDrag) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', stopDrag);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopDrag);
    };
  }, [activeDrag, stopDrag, updateDrag]);

  const startDrag = (type: string) => (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
    if ('pointerId' in e) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    dragRef.current = {
      type,
      startX: e.clientX,
      startY: e.clientY,
      startWidths: type.startsWith('row1-col') ? [...row1Widths] : type.startsWith('row2-col') ? [...row2Widths] : undefined,
      startHeight: type === 'row-split' ? row1Height : undefined,
    };
    setActiveDrag(type);
    document.body.classList.add('select-none');
  };

  const handleResizerPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.preventDefault();
    updateDrag(e.clientX, e.clientY);
  };

  const handleResizerPointerUp = (e: React.PointerEvent) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    stopDrag();
  };

  // 取得自訂 AI 策略清單
  useEffect(() => {
    setCustomStrategies(readStoredStrategies());
    setStrategiesLoaded(true);
  }, []);

  useEffect(() => {
    if (!strategiesLoaded) return;
    writeStoredStrategies(customStrategies);
  }, [customStrategies, strategiesLoaded]);

  const handleGenerateAIStrategy = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('http://localhost:8080/api/strategies/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: selectedSymbol, timeframe }),
      });
      const data = await res.json();

      if (data.status !== 'success' || !data.strategy) {
        throw new Error(data.message || 'Strategy generation failed');
      }

      const newStrategy: AIStrategy = {
        id: String(data.strategy.id || `LOCAL_${Date.now().toString(36).toUpperCase()}`),
        name: String(data.strategy.name || `${selectedSymbol} ${timeframe} Strategy`),
        description: String(data.strategy.description || ''),
        concept: String(data.strategy.concept || ''),
        logic: String(data.strategy.logic || ''),
        indicators: Array.isArray(data.strategy.indicators)
          ? data.strategy.indicators.map((value: unknown) => String(value))
          : [],
        parameters: {
          stopLoss: Number(data.strategy.parameters?.stopLoss ?? 0),
          takeProfit: Number(data.strategy.parameters?.takeProfit ?? 0),
          positionSize: Number(data.strategy.parameters?.positionSize ?? 0),
          riskControl: String(data.strategy.parameters?.riskControl || ''),
        },
      };
      setCustomStrategies((prev) => [newStrategy, ...prev]);
      setSelectedStrategyId(newStrategy.id);
    } catch (e) {
      console.error(e);
      alert('策略生成失敗');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeleteStrategy = async (id: string) => {
    try {
      setCustomStrategies((prev) => prev.filter((s) => s.id !== id));
      if (selectedStrategyId === id) {
        setSelectedStrategyId('');
      }
    } catch (e) {
      console.error(e);
      alert('Strategy operation failed');
    }
  };

  // K 線數據與交易點歷史
  const [klineData, setKlineData] = useState<KLineData[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [isKlineLoading, setIsKlineLoading] = useState<boolean>(false);
  const [isOlderKlineLoading, setIsOlderKlineLoading] = useState<boolean>(false);
  const [hasMoreOlderKlines, setHasMoreOlderKlines] = useState<boolean>(true);
  const [klineSource, setKlineSource] = useState<string>('initializing');

  const [quoteSource, setQuoteSource] = useState<string>('initializing');
  const [simulateClosedMarket, setSimulateClosedMarket] = useState<boolean>(false);
  const [chartDrawingsBySymbol, setChartDrawingsBySymbol] = useState<Record<string, ChartDrawing[]>>(() => ({
    AAPL: readStoredChartDrawings('AAPL'),
    '2330.TW': readStoredChartDrawings('2330.TW'),
  }));
  const [klineCacheBySymbol, setKlineCacheBySymbol] = useState<Record<string, Record<string, KLineData[]>>>(() => ({
    AAPL: {
      '1h': readStoredKlines('AAPL', '1h'),
    },
    '2330.TW': {
      '1h': readStoredKlines('2330.TW', '1h'),
    },
  }));

  // 用於 K 線圖 Ref 進行 imperative 更新
  const chartRef = useRef<any>(null);
  // 用於在非同步更新與 Effect 中追蹤最新 K 線數據，防止渲染生命週期衝突
  const klineDataRef = useRef<KLineData[]>([]);
  // 用於 WebSocket 引用
  const socketRef = useRef<WebSocket | null>(null);
  const stocksRef = useRef<StockInfo[]>([]);
  const acceptWsKlinesRef = useRef<boolean>(false);
  const quoteSourceRef = useRef<string>('initializing');
  const closedMarketSimPriceRef = useRef<Record<string, number>>({});
  const klineSyncedQuotesRef = useRef<Record<string, KlineSyncedQuote>>({});
  const klinePaginationRef = useRef<{
    hasMore: boolean;
    isLoadingOlder: boolean;
    oldestTimestamp: number | null;
    requestKey: string;
  }>({
    hasMore: true,
    isLoadingOlder: false,
    oldestTimestamp: null,
    requestKey: '',
  });

  // 用於在非同步 WebSocket 訊息接收中，追蹤最新的選取股票與週期，防止 Stale Closure 閉包陷阱
  const selectedSymbolRef = useRef<string>(selectedSymbol);
  const timeframeRef = useRef<string>(timeframe);

  useEffect(() => {
    stocksRef.current = stocks;
  }, [stocks]);

  useEffect(() => {
    quoteSourceRef.current = quoteSource;
  }, [quoteSource]);

  useEffect(() => {
    selectedSymbolRef.current = selectedSymbol;
  }, [selectedSymbol]);

  useEffect(() => {
    timeframeRef.current = timeframe;
  }, [timeframe]);

  const handleSelectSymbol = useCallback((symbol: string) => {
    setChartDrawingsBySymbol((prevDrawings) => {
      if (symbol in prevDrawings) return prevDrawings;

      return {
        ...prevDrawings,
        [symbol]: readStoredChartDrawings(symbol),
      };
    });
    setSelectedSymbol(symbol);
  }, []);

  const cacheKlinesForSymbol = useCallback((symbol: string, tf: string, klines: KLineData[]) => {
    const safeKlines = Array.isArray(klines) ? klines : [];
    setKlineCacheBySymbol((prevCache) => ({
      ...prevCache,
      [symbol]: {
        ...(prevCache[symbol] || {}),
        [tf]: safeKlines,
      },
    }));
    writeStoredKlines(symbol, tf, safeKlines);
  }, []);

  const handleChartDrawingsChange = useCallback((nextDrawings: ChartDrawing[]) => {
    const safeDrawings = Array.isArray(nextDrawings) ? nextDrawings : [];

    setChartDrawingsBySymbol((prevDrawings) => ({
      ...prevDrawings,
      [selectedSymbol]: safeDrawings,
    }));
    writeStoredChartDrawings(selectedSymbol, safeDrawings);
  }, [selectedSymbol]);

  const getKlineSyncedQuote = (klines: KLineData[]): KlineSyncedQuote | null => {
    if (klines.length === 0) return null;
    const latest = klines[klines.length - 1];
    const previous = klines.length > 1 ? klines[klines.length - 2] : latest;
    const latestPrice = parseFloat(latest.close.toFixed(2));
    const referencePrice = previous.close || latest.close || 1;
    const rawChange = latest.close - referencePrice;

    return {
      price: latestPrice,
      change: parseFloat(rawChange.toFixed(2)),
      changePercent: parseFloat(((rawChange / referencePrice) * 100).toFixed(2)),
      high24h: Math.max(latest.high, latestPrice),
      low24h: Math.min(latest.low, latestPrice),
      isKlineSynced: true,
    };
  };

  const markStocksKlinePending = (targetStocks: StockInfo[]) => (
    targetStocks.map((stock) => ({ ...stock, isKlineSynced: false }))
  );

  const mergeStocksWithKlineQuotes = (incomingStocks: StockInfo[], preferIncomingQuotes = false) => {
    const klineQuotes = klineSyncedQuotesRef.current;

    return incomingStocks.map((stock) => {
      const quote = klineQuotes[stock.symbol];
      if (preferIncomingQuotes) {
        return {
          ...stock,
          isKlineSynced: quote?.isKlineSynced ?? stock.isKlineSynced ?? true,
        };
      }

      if (!quote) return { ...stock, isKlineSynced: false };

      return {
        ...stock,
        ...quote,
        high24h: Math.max(stock.high24h, quote.high24h, quote.price),
        low24h: Math.min(stock.low24h, quote.low24h, quote.price),
      };
    });
  };

  const bindSelectedStockToLatestKline = (incomingStocks: StockInfo[]) => {
    const latestKline = klineDataRef.current[klineDataRef.current.length - 1];
    if (!latestKline) return incomingStocks;

    const selectedSymbol = selectedSymbolRef.current;
    const previousSelectedStock = stocksRef.current.find((stock) => stock.symbol === selectedSymbol);

    return incomingStocks.map((stock) => {
      if (stock.symbol !== selectedSymbol) return stock;

      const previousPrice = previousSelectedStock?.price ?? latestKline.close;
      const boundedPrice = parseFloat(clampPriceNearKline(
        stock.price,
        latestKline.close,
        previousPrice
      ).toFixed(stock.market === 'TW' || stock.symbol.endsWith('.TW') ? 1 : 2));
      const rawChange = boundedPrice - previousPrice;
      const boundedQuote: KlineSyncedQuote = {
        price: boundedPrice,
        change: parseFloat(rawChange.toFixed(2)),
        changePercent: parseFloat(((rawChange / Math.max(previousPrice, 1)) * 100).toFixed(2)),
        high24h: Math.max(stock.high24h, boundedPrice),
        low24h: Math.min(stock.low24h, boundedPrice),
        isKlineSynced: true,
        priceSource: stock.priceSource,
      };

      klineSyncedQuotesRef.current = {
        ...klineSyncedQuotesRef.current,
        [stock.symbol]: boundedQuote,
      };

      return {
        ...stock,
        ...boundedQuote,
        tickRegime: stock.tickRegime,
        volume: stock.volume,
      };
    });
  };

  const syncStockWithLatestKline = (symbol: string, klines: KLineData[]) => {
    const quote = getKlineSyncedQuote(klines);
    if (!quote) return;

    klineSyncedQuotesRef.current = {
      ...klineSyncedQuotesRef.current,
      [symbol]: quote,
    };

    setStocks((prevStocks) => prevStocks.map((stock) => {
      if (stock.symbol !== symbol) return stock;

      return {
        ...stock,
        ...quote,
        high24h: Math.max(stock.high24h, quote.high24h, quote.price),
        low24h: Math.min(stock.low24h, quote.low24h, quote.price),
      };
    }));
  };

  const markSelectedKlinePending = (symbol: string) => {
    const remainingQuotes = { ...klineSyncedQuotesRef.current };
    delete remainingQuotes[symbol];
    klineSyncedQuotesRef.current = remainingQuotes;
    setStocks((prevStocks) => prevStocks.map((stock) => (
      stock.symbol === symbol ? { ...stock, isKlineSynced: false } : stock
    )));
  };

  const fetchLatestKlineQuote = async (symbol: string, tf: string, signal: AbortSignal) => {
    const params = new URLSearchParams({
      symbol,
      timeframe: tf,
      limit: '2',
    });
    const response = await fetch(`http://localhost:8080/api/klines?${params.toString()}`, {
      signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`K-line API failed with ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.klines) || data.klines.length === 0) {
      return;
    }

    syncStockWithLatestKline(symbol, data.klines);
  };

  // 當市場切換時，初始化相關數據
  useEffect(() => {
    klineSyncedQuotesRef.current = {};
    if (market === 'US') {
      setStocks(markStocksKlinePending(initialStocksUS));
      setIndices(initialIndicesUS);
      setSelectedSymbol('AAPL');
      setPortfolio(initialPortfolioUS);
      setIsUSStyle(true); // 美股風格預設綠漲紅跌
    } else {
      setStocks(markStocksKlinePending(initialStocksTW));
      setIndices(initialIndicesTW);
      setSelectedSymbol('2330.TW');
      setPortfolio(initialPortfolioTW);
      setIsUSStyle(false); // 台股風格預設紅漲綠跌
    }
    // 清空歷史訊號流水燈，並加入幾個預設初始訊號
    setSignals([]);
  }, [market]);

  useEffect(() => {
    if (stocks.length === 0) return;

    const controller = new AbortController();
    let waitingForWsKlines = false;
    markSelectedKlinePending(selectedSymbol);
    const requestKey = `${selectedSymbol}|${timeframe}`;
    const cachedKlines = klineCacheBySymbol[selectedSymbol]?.[timeframe] || [];
    klinePaginationRef.current = {
      hasMore: true,
      isLoadingOlder: false,
      oldestTimestamp: null,
      requestKey,
    };
    setHasMoreOlderKlines(true);
    setIsOlderKlineLoading(false);

    if (cachedKlines.length > 0) {
      klineDataRef.current = cachedKlines;
      setKlineData(cachedKlines);
      setKlineSource('cache');
      klinePaginationRef.current = {
        hasMore: cachedKlines.length >= INITIAL_KLINE_LIMIT,
        isLoadingOlder: false,
        oldestTimestamp: cachedKlines[0]?.timestamp ?? null,
        requestKey,
      };
      setHasMoreOlderKlines(cachedKlines.length >= INITIAL_KLINE_LIMIT);
      syncStockWithLatestKline(selectedSymbol, cachedKlines);
      if (chartRef.current && chartRef.current.setData) {
        chartRef.current.setData(cachedKlines);
      }
    }

    const applyKlines = (klines: KLineData[], source: string) => {
      acceptWsKlinesRef.current = false;
      klineDataRef.current = klines;
      setKlineData(klines);
      setKlineSource(source);
      cacheKlinesForSymbol(selectedSymbol, timeframe, klines);
      klinePaginationRef.current = {
        hasMore: klines.length >= INITIAL_KLINE_LIMIT,
        isLoadingOlder: false,
        oldestTimestamp: klines[0]?.timestamp ?? null,
        requestKey,
      };
      setHasMoreOlderKlines(klines.length >= INITIAL_KLINE_LIMIT);
      setIsOlderKlineLoading(false);
      syncStockWithLatestKline(selectedSymbol, klines);

      if (chartRef.current && chartRef.current.setData) {
        chartRef.current.setData(klines);
      }
    };

    const requestWsKlines = () => {
      if (isWsConnected && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        console.log('Requesting K-lines via WS:', selectedSymbol, timeframe);
        socketRef.current.send(JSON.stringify({
          type: 'GET_KLINES',
          symbol: selectedSymbol,
          timeframe,
          limit: INITIAL_KLINE_LIMIT,
        }));
        acceptWsKlinesRef.current = true;
        setKlineSource('sqlite');
        return true;
      }
      return false;
    };

    const requestMassiveKlines = async () => {
      setIsKlineLoading(true);

      try {
        const params = new URLSearchParams({
          symbol: selectedSymbol,
          timeframe,
          limit: String(INITIAL_KLINE_LIMIT),
        });
        const response = await fetch(`http://localhost:8080/api/klines?${params.toString()}`, {
          signal: controller.signal,
          cache: 'no-store',
        });

        if (!response.ok) {
          throw new Error(`K-line API failed with ${response.status}`);
        }

        const data = await response.json();
        if (controller.signal.aborted) return;

        if (Array.isArray(data.klines) && data.klines.length > 0) {
          applyKlines(data.klines, data.source || 'massive');
          return;
        }

        throw new Error('K-line API returned no bars');
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Error fetching Massive K-lines:', err);

        if (requestWsKlines()) {
          waitingForWsKlines = true;
          return;
        }

        const currentStocks = stocksRef.current;
        const currentStock = currentStocks.find(s => s.symbol === selectedSymbol) || currentStocks[0];
        const history = generateHistoryKLines(selectedSymbol, currentStock.price, INITIAL_KLINE_LIMIT, timeframe);
        applyKlines(history, 'local');
      } finally {
        if (!controller.signal.aborted && !waitingForWsKlines) {
          setIsKlineLoading(false);
        }
      }
    };

    requestMassiveKlines();

    return () => controller.abort();
  }, [selectedSymbol, timeframe, isWsConnected, stocks.length]);

  const loadOlderKlines = useCallback(async () => {
    const pagination = klinePaginationRef.current;
    const requestKey = `${selectedSymbolRef.current}|${timeframeRef.current}`;
    const oldestTimestamp = pagination.oldestTimestamp ?? klineDataRef.current[0]?.timestamp;

    if (
      !oldestTimestamp ||
      pagination.requestKey !== requestKey ||
      pagination.isLoadingOlder ||
      !pagination.hasMore
    ) {
      return;
    }

    klinePaginationRef.current = {
      ...pagination,
      isLoadingOlder: true,
    };
    setIsOlderKlineLoading(true);

    try {
      const params = new URLSearchParams({
        symbol: selectedSymbolRef.current,
        timeframe: timeframeRef.current,
        limit: String(OLDER_KLINE_BATCH_SIZE),
        before: String(oldestTimestamp),
      });
      const response = await fetch(`http://localhost:8080/api/klines?${params.toString()}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(`K-line API failed with ${response.status}`);
      }

      const data = await response.json();
      const incomingKlines: KLineData[] = Array.isArray(data.klines) ? data.klines : [];

      if (`${selectedSymbolRef.current}|${timeframeRef.current}` !== requestKey) {
        return;
      }

      const currentData = klineDataRef.current;
      const firstCurrentTs = currentData[0]?.timestamp ?? Number.POSITIVE_INFINITY;
      const olderKlines = incomingKlines
        .filter((bar) => bar.timestamp < firstCurrentTs)
        .sort((a, b) => a.timestamp - b.timestamp);
      const hasMore = incomingKlines.length >= OLDER_KLINE_BATCH_SIZE && olderKlines.length > 0;

      if (olderKlines.length > 0) {
        const seen = new Set(currentData.map((bar) => bar.timestamp));
        const merged = [
          ...olderKlines.filter((bar) => !seen.has(bar.timestamp)),
          ...currentData,
        ];

        klineDataRef.current = merged;
        setKlineData(merged);
        setKlineSource(data.source || klineSource);

        if (chartRef.current && chartRef.current.applyMoreData) {
          chartRef.current.applyMoreData(olderKlines, hasMore);
        }

        klinePaginationRef.current = {
          hasMore,
          isLoadingOlder: false,
          oldestTimestamp: merged[0]?.timestamp ?? null,
          requestKey,
        };
      } else {
        klinePaginationRef.current = {
          ...klinePaginationRef.current,
          hasMore: false,
          isLoadingOlder: false,
        };
      }

      setHasMoreOlderKlines(klinePaginationRef.current.hasMore);
    } catch (err) {
      console.error('Error fetching older K-lines:', err);
      klinePaginationRef.current = {
        ...klinePaginationRef.current,
        isLoadingOlder: false,
      };
    } finally {
      setIsOlderKlineLoading(false);
    }
  }, [klineSource]);

  const handleVisibleRangeChanged = useCallback((range: VisibleRange) => {
    if (range.fromIndex <= OLDER_KLINE_TRIGGER_INDEX) {
      loadOlderKlines();
    }
  }, [loadOlderKlines]);

  const watchlistSymbolsKey = stocks
    .filter((stock) => stock.isFav)
    .map((stock) => stock.symbol)
    .sort()
    .join('|');

  useEffect(() => {
    if (!watchlistSymbolsKey) return;
    if (simulateClosedMarket && quoteSource === 'alpaca_iex_ws_waiting' && market === 'US') return;

    const symbols = watchlistSymbolsKey.split('|').filter(Boolean);
    const symbolSet = new Set(symbols);
    const controller = new AbortController();

    klineSyncedQuotesRef.current = {};
    setStocks((prevStocks) => prevStocks.map((stock) => (
      symbolSet.has(stock.symbol) ? { ...stock, isKlineSynced: false } : stock
    )));

    symbols.forEach((symbol) => {
      fetchLatestKlineQuote(symbol, timeframe, controller.signal).catch((err) => {
        if (!controller.signal.aborted) {
          console.error('Error fetching latest watchlist K-line quote:', symbol, err);
        }
      });
    });

    return () => controller.abort();
  }, [watchlistSymbolsKey, timeframe, simulateClosedMarket, quoteSource, market]);

  // 當 K 線數據或選定策略改變時，重新計算 AI 買賣點標記與指標折線
  useEffect(() => {
    if (klineData.length === 0) return;

    const defaultStrategy = DEFAULT_STRATEGIES[selectedStrategyId];

    if (defaultStrategy) {
      const result = runStrategyBacktest(klineData, defaultStrategy);
      setTrades(result.trades);
      setChartIndicators(result.chartIndicators);
      setSignals(buildSignalsFromTrades(result.trades, selectedSymbol, selectedStrategyId));
    } else {
      // 自訂 AI 策略
      const custom = customStrategies.find(s => s.id === selectedStrategyId);
      if (custom) {
        const result = runStrategyBacktest(klineData, custom);
        setTrades(result.trades);
        setChartIndicators(result.chartIndicators);
        setSignals(buildSignalsFromTrades(result.trades, selectedSymbol, selectedStrategyId));
      } else {
        // 如果還沒載入完或找不到，先清空
        setTrades([]);
        setChartIndicators({});
        setSignals([]);
      }
    }
  }, [klineData, selectedStrategyId, customStrategies, selectedSymbol]);


  // 即時資料的 WebSocket 接收管理器
  useEffect(() => {
    // 建立連接到本地 WebSocket 伺服器
    const socket = new WebSocket('ws://localhost:8080');
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('🔌 Connected to QUANT-X WS Server');
      setIsWsConnected(true);
      // 連線成功後，發送市場訂閱請求
      socket.send(JSON.stringify({
        type: 'SUBSCRIBE_ALL_PAIRS',
        market: market,
      }));
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'INITIAL_DATA') {
          console.log('📥 Received INITIAL_DATA via WS:', data.market);
          setStocks(mergeStocksWithKlineQuotes(data.stocks));
          setIndices(data.indices);
          setPortfolio(data.portfolio);
          setQuoteSource(data.priceSource || 'sqlite');
          
          // 初始化成功後，請求當前選定股票的 K 線數據
          socket.send(JSON.stringify({
            type: 'GET_KLINES',
            symbol: selectedSymbolRef.current,
            timeframe: timeframeRef.current,
            limit: INITIAL_KLINE_LIMIT,
          }));
        } else if (data.type === 'TICK_UPDATE') {
          // 被動接收即時報價跳動
          setStocks(mergeStocksWithKlineQuotes(bindSelectedStockToLatestKline(data.stocks), true));
          setIndices(data.indices);
          setQuoteSource(data.priceSource || 'unknown');
        } else if (data.type === 'AI_SIGNAL') {
          console.log('📥 Received AI_SIGNAL via WS:', data.signal.symbol);
          // Ignore random backend signals while strategy backtest signals are the source of truth.
        } else if (data.type === 'KLINES_DATA') {
          console.log('📥 Received KLINES_DATA via WS:', data.symbol, data.timeframe);
          // 確保返回的 K 線資料是當前選擇的股票與 timeframe，避免多個非同步請求回傳順序錯亂
          if (acceptWsKlinesRef.current && data.symbol === selectedSymbolRef.current && data.timeframe === timeframeRef.current) {
            acceptWsKlinesRef.current = false;
            const requestKey = `${data.symbol}|${data.timeframe}`;
            klineDataRef.current = data.klines;
            setKlineData(data.klines);
            setKlineSource('sqlite');
            cacheKlinesForSymbol(data.symbol, data.timeframe, data.klines);
            klinePaginationRef.current = {
              hasMore: data.klines.length >= INITIAL_KLINE_LIMIT,
              isLoadingOlder: false,
              oldestTimestamp: data.klines[0]?.timestamp ?? null,
              requestKey,
            };
            setHasMoreOlderKlines(data.klines.length >= INITIAL_KLINE_LIMIT);
            setIsOlderKlineLoading(false);
            syncStockWithLatestKline(data.symbol, data.klines);
            setIsKlineLoading(false);
            
            // 如果 K 線圖實例已經準備好，重新設定數據
            if (chartRef.current && chartRef.current.setData) {
              chartRef.current.setData(data.klines);
            }
          }
        }
      } catch (err) {
        console.error('Error parsing WS message:', err);
      }
    };

    socket.onclose = () => {
      console.log('🔌 Disconnected from QUANT-X WS Server');
      setIsWsConnected(false);
    };

    socket.onerror = (err) => {
      console.error('❌ WebSocket Error, falling back to local simulation:', err);
      setIsWsConnected(false);
    };

    return () => {
      socket.close();
    };
  }, [market]);

  // 【備用定時器】當 WebSocket 未連線時，自動啟用前端模擬資料跳動，確保展示不中斷
  useEffect(() => {
    if (isWsConnected) return; // 如果 WS 已連線，則不啟用本地模擬

    console.log('⚠️ WS Offline. Starting local simulation timer...');
    setQuoteSource('simulated_sqlite');
    const nextStockUpdateAt: Record<string, number> = {};
    const nextIndexUpdateAt: Record<string, number> = {};
    let timeoutId: ReturnType<typeof setTimeout>;
    const runLocalSimulation = () => {
      const now = Date.now();
      // 1. 隨機更新個股價格
      setStocks((prevStocks) => {
        return prevStocks.map((stock) => {
          if (!nextStockUpdateAt[stock.symbol]) {
            nextStockUpdateAt[stock.symbol] = now + getNextSimulatedTickDelay();
          }
          if (now < nextStockUpdateAt[stock.symbol]) return stock;

          nextStockUpdateAt[stock.symbol] = now + getNextSimulatedTickDelay();
          const changePct = (Math.random() - 0.5) * 0.0036; // 放慢成約 ±0.18%
          const selectedLastClose = stock.symbol === selectedSymbolRef.current && klineDataRef.current.length > 0
            ? klineDataRef.current[klineDataRef.current.length - 1].close
            : undefined;
          const proposedPrice = stock.price * (1 + changePct);
          const nextPrice = parseFloat(clampPriceNearKline(proposedPrice, selectedLastClose, stock.price).toFixed(2));
          const high24h = Math.max(stock.high24h, nextPrice);
          const low24h = Math.min(stock.low24h, nextPrice);
          const rawChange = nextPrice - (market === 'US' ? 180 : 780); // 簡化參考基準
          
          return {
            ...stock,
            price: nextPrice,
            change: parseFloat(rawChange.toFixed(2)),
            changePercent: parseFloat((rawChange / (market === 'US' ? 180 : 780) * 100).toFixed(2)),
            high24h,
            low24h,
            isKlineSynced: true,
            priceSource: 'simulated_sqlite',
          };
        });
      });

      // 2. 隨機更新大盤指數走勢
      setIndices((prevIndices) =>
        prevIndices.map((idx) => {
          if (!nextIndexUpdateAt[idx.symbol]) {
            nextIndexUpdateAt[idx.symbol] = now + getNextIndexSimulatedTickDelay();
          }
          if (now < nextIndexUpdateAt[idx.symbol]) return idx;

          nextIndexUpdateAt[idx.symbol] = now + getNextIndexSimulatedTickDelay();
          const changePct = (Math.random() - 0.5) * 0.0012; // 指數慢一點，避免跑太快
          const nextPrice = parseFloat((idx.price * (1 + changePct)).toFixed(2));
          return {
            ...idx,
            price: nextPrice,
          };
        })
      );

      timeoutId = setTimeout(runLocalSimulation, SIMULATED_PRICE_UPDATE_POLL_INTERVAL_MS);
    };

    timeoutId = setTimeout(runLocalSimulation, SIMULATED_PRICE_UPDATE_POLL_INTERVAL_MS);
    return () => clearTimeout(timeoutId);
  }, [isWsConnected, market]);

  useEffect(() => {
    if (!simulateClosedMarket || quoteSource !== 'alpaca_iex_ws_waiting' || market !== 'US') {
      closedMarketSimPriceRef.current = {};
      return;
    }

    klineSyncedQuotesRef.current = stocksRef.current.reduce<Record<string, KlineSyncedQuote>>((quotes, stock) => {
      quotes[stock.symbol] = {
        price: stock.price,
        change: stock.change,
        changePercent: stock.changePercent,
        high24h: stock.high24h,
        low24h: stock.low24h,
        isKlineSynced: true,
        priceSource: 'closed_market_simulated',
      };
      return quotes;
    }, {});

    let timeoutId: ReturnType<typeof setTimeout>;
    const runClosedMarketSimulation = () => {
      setStocks((prevStocks) => {
        const nextKlineQuotes = { ...klineSyncedQuotesRef.current };
        const nextStocks = prevStocks.map((stock) => {
          const selectedLastClose = klineDataRef.current.length > 0
            ? klineDataRef.current[klineDataRef.current.length - 1].close
            : undefined;
          const anchorPrice = stock.symbol === selectedSymbolRef.current && selectedLastClose
            ? selectedLastClose
            : stock.price;
          const previousSimPrice = closedMarketSimPriceRef.current[stock.symbol] ?? stock.price;
          const shouldReanchor = Math.abs(previousSimPrice - anchorPrice) / Math.max(anchorPrice, 1) > 0.02;
          const basePrice = shouldReanchor ? anchorPrice : previousSimPrice;
          const changePct = (Math.random() - 0.5) * 0.0012;
          const lowerBound = anchorPrice * 0.985;
          const upperBound = anchorPrice * 1.015;
          const simulatedPrice = basePrice * (1 + changePct);
          const nextPrice = Math.max(1, parseFloat(Math.min(upperBound, Math.max(lowerBound, simulatedPrice)).toFixed(2)));
          const rawChange = nextPrice - stock.price;

          closedMarketSimPriceRef.current[stock.symbol] = nextPrice;
          const nextChange = parseFloat(rawChange.toFixed(2));
          const nextChangePercent = parseFloat(((rawChange / Math.max(stock.price, 1)) * 100).toFixed(2));
          const high24h = Math.max(stock.high24h, nextPrice);
          const low24h = Math.min(stock.low24h, nextPrice);

          nextKlineQuotes[stock.symbol] = {
            price: nextPrice,
            change: nextChange,
            changePercent: nextChangePercent,
            high24h,
            low24h,
            isKlineSynced: true,
            priceSource: 'closed_market_simulated',
          };

          return {
            ...stock,
            price: nextPrice,
            change: nextChange,
            changePercent: nextChangePercent,
            high24h,
            low24h,
            isKlineSynced: true,
            priceSource: 'closed_market_simulated',
          };
        });

        klineSyncedQuotesRef.current = nextKlineQuotes;
        return nextStocks;
      });
      timeoutId = setTimeout(runClosedMarketSimulation, getNextSimulatedTickDelay());
    };

    timeoutId = setTimeout(runClosedMarketSimulation, getNextSimulatedTickDelay());
    return () => clearTimeout(timeoutId);
  }, [simulateClosedMarket, quoteSource, market]);

  // 當 stocks 變更且渲染完畢後，安全地觸發 K 線圖 Tick 增量更新 (並同步更新 K 線狀態)
  useEffect(() => {
    if (stocks.length === 0 || !chartRef.current || !chartRef.current.updateData || klineDataRef.current.length === 0) return;
    
    const activeStock = stocks.find(s => s.symbol === selectedSymbol);
    if (!activeStock) return;
    const liveQuoteSources = new Set(['alpaca_iex_ws', 'simulated_sqlite']);
    const isLiveQuote = liveQuoteSources.has(quoteSourceRef.current) || (activeStock.priceSource ? liveQuoteSources.has(activeStock.priceSource) : false);
    const isClosedMarketSimulation = simulateClosedMarket && quoteSourceRef.current === 'alpaca_iex_ws_waiting' && activeStock.priceSource === 'closed_market_simulated';
    if (!isLiveQuote && !isClosedMarketSimulation) return;

    const prevKline = klineDataRef.current;
    const lastIndex = prevKline.length - 1;
    const lastCandle = prevKline[lastIndex];
    const boundedActivePrice = parseFloat(clampPriceNearKline(
      activeStock.price,
      lastCandle.close,
      lastCandle.close
    ).toFixed(market === 'US' ? 2 : 1));
    const nowTs = Date.now();
    const currentBarStart = getBarStartTimestamp(nowTs, timeframe);
    const lastBarStart = getBarStartTimestamp(lastCandle.timestamp, timeframe);
    
    // 如果是一小時線，在同一個小時內只更新最後一根 K 線 of close/high/low
    const isNewBar = currentBarStart > lastBarStart;
    
    const updatedCandle: KLineData = {
      timestamp: isNewBar ? currentBarStart : lastCandle.timestamp,
      open: isNewBar ? lastCandle.close : lastCandle.open, // 無跳空：新開盤價等於上一根收盤價
      high: isNewBar ? Math.max(lastCandle.close, boundedActivePrice) : Math.max(lastCandle.high, boundedActivePrice),
      low: isNewBar ? Math.min(lastCandle.close, boundedActivePrice) : Math.min(lastCandle.low, boundedActivePrice),
      close: boundedActivePrice,
      volume: isNewBar ? Math.max(1, Math.round(activeStock.volume * 1000)) : lastCandle.volume + Math.max(1, Math.round(activeStock.volume * 100)),
    };

    // 1. 在 setKlineData 外部，安全地呼叫圖表 Ref 進行 Canvas 增量更新
    chartRef.current.updateData(updatedCandle);

    // 2. 同步更新 Ref 內的數據，以便下一次 Tick 依然基於最新的數據做計算
    if (isNewBar) {
      klineDataRef.current = [...prevKline, updatedCandle];
    } else {
      const nextKline = [...prevKline];
      nextKline[lastIndex] = updatedCandle;
      klineDataRef.current = nextKline;
    }

    // 3. 同步更新 React 狀態以觸發 Dashboard 重新渲染
    setKlineData(klineDataRef.current);
    cacheKlinesForSymbol(selectedSymbol, timeframe, klineDataRef.current);
  }, [stocks, selectedSymbol, timeframe, simulateClosedMarket, cacheKlinesForSymbol]);

  // 當自選股價格跳動時，同步更新模擬投資組合中的當前價格與總市值
  useEffect(() => {
    if (stocks.length === 0) return;
    
    setPortfolio((prevPortfolio) => {
      const updated = prevPortfolio.map((asset) => {
        const matchedStock = stocks.find(s => s.symbol === asset.symbol);
        if (!matchedStock) return asset;
        const currentPrice = matchedStock.price;
        const value = parseFloat((asset.shares * currentPrice).toFixed(2));
        return {
          ...asset,
          currentPrice,
          value,
        };
      });

      // 重新計算權重
      const totalValue = updated.reduce((sum, item) => sum + item.value, 0);
      return updated.map(item => ({
        ...item,
        weight: parseFloat(((item.value / totalValue) * 100).toFixed(1)),
      }));
    });
  }, [stocks]);

  // 切換自選狀態
  const handleToggleFav = (symbol: string, name?: string, market?: string) => {
    // 更新本地 stocks
    const exists = stocks.some(s => s.symbol === symbol);
    if (exists) {
      setStocks(prev => prev.map(s => s.symbol === symbol ? { ...s, isFav: !s.isFav } : s));
    } else {
      // 如果不在預設清單中 (如從全部美股中新加的自選)
      const newStock: StockInfo = {
        symbol: symbol,
        name: name || `${symbol} Inc.`,
        price: 100.0,
        change: 0.0,
        changePercent: 0.0,
        high24h: 100.0,
        low24h: 100.0,
        volume: 1.0,
        market: market || 'US',
        isKlineSynced: false,
        isFav: true
      };
      setStocks(prev => [...prev, newStock]);
    }
    
    // 更新 SQLite 後端
    if (isWsConnected && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'TOGGLE_FAV',
        symbol: symbol,
        name: name,
        market: market || 'US'
      }));
    }
  };

  // 觸發 AI 策略診斷與回測更新按鈕
  const handleTriggerDiagnosis = () => {
    // 立即產生 3 筆最新策略訊號
    // Re-run the selected strategy against the latest candles.
    if (klineData.length > 0) {
      const defaultStrategy = DEFAULT_STRATEGIES[selectedStrategyId];
      if (defaultStrategy) {
        const result = runStrategyBacktest(klineData, defaultStrategy);
        setTrades(result.trades);
        setChartIndicators(result.chartIndicators);
        setSignals(buildSignalsFromTrades(result.trades, selectedSymbol, selectedStrategyId));
      } else {
        const custom = customStrategies.find(s => s.id === selectedStrategyId);
        if (custom) {
          const result = runStrategyBacktest(klineData, custom);
          setTrades(result.trades);
          setChartIndicators(result.chartIndicators);
          setSignals(buildSignalsFromTrades(result.trades, selectedSymbol, selectedStrategyId));
        } else {
          setTrades([]);
          setChartIndicators({});
          setSignals([]);
        }
      }
    }
  };

  // 獲取當前市場的策略回測數據
  const backtestResult = calculateBacktestResultFromTrades(trades);

  const riskStatus = getRiskStatus(portfolio);

  // 獲取熱力圖區塊數據
  const heatmapSectors = market === 'US' ? mockHeatmapUS : mockHeatmapTW;
  const isMarketClosedWaiting = market === 'US' && quoteSource === 'alpaca_iex_ws_waiting';
  const selectedStock = stocks.find((stock) => stock.symbol === selectedSymbol);
  const selectedChartDrawings = chartDrawingsBySymbol[selectedSymbol] ?? EMPTY_CHART_DRAWINGS;
  const isChartLoading = isKlineLoading || !selectedStock?.isKlineSynced;

  return (
    <main className="min-h-screen bg-[#070b19] cyber-grid-bg relative text-slate-200 pb-5 flex flex-col">
      {/* 1. 頂部全局狀態欄 */}
      <MarketOverview indices={indices} isUSStyle={isUSStyle} />

      {/* 首頁導覽與控制列 */}
      <header className="px-4 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-slate-900 bg-slate-950/40 backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <div className="bg-gradient-to-tr from-cyan-500 to-emerald-400 p-1.5 rounded-lg shadow-[0_0_10px_rgba(6,182,212,0.3)]">
            <svg className="w-6 h-6 text-slate-950" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-extrabold tracking-wider bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent uppercase font-mono">
              QUANT-X B2B 智能股票回測儀表板
            </h1>
            <p className="text-[10px] text-slate-500 font-mono tracking-widest uppercase">
              Real-time Multi-Factor AI Strategy & Risk Management Station
            </p>
          </div>
        </div>

        {/* 頂部設定面板 (RWD) */}
        <div className="flex items-center flex-wrap gap-2.5">
          {/* 市場切換 (美股 / 台股) */}
          <div className="flex bg-slate-950/80 p-1 rounded-lg border border-slate-800/80 text-xs font-mono">
            <button
              onClick={() => setMarket('US')}
              className={`px-2.5 py-1 rounded-md font-bold transition-all ${
                market === 'US' 
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-inner'
                  : 'text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              美股指數交易
            </button>
            <button
              onClick={() => setMarket('TW')}
              className={`px-2.5 py-1 rounded-md font-bold transition-all ${
                market === 'TW' 
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-inner'
                  : 'text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              台股加權交易
            </button>
          </div>

          {/* 配色風格切換器 */}
          <button
            onClick={() => setIsUSStyle(!isUSStyle)}
            className="px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-mono text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1.5"
            title="點擊切換綠紅或紅綠配色"
          >
            🎨 配色風格: 
            <span className={isUSStyle ? 'text-emerald-400 font-bold' : 'text-rose-500 font-bold'}>
              {isUSStyle ? '美股模式 (🟢漲🔴跌)' : '台股模式 (🔴漲🟢跌)'}
            </span>
          </button>
        </div>
      </header>

      {/* 2. 儀表板 Bento Box 網格系統 (3-4欄式響應式 / 行動裝置自動堆疊) */}
      {isMobile ? (
        <div className="w-full px-4 mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-4 flex-1">
          {/* 左側欄: 自選與即時排行 (佔 3 欄) */}
          <div className="lg:col-span-3 flex flex-col gap-4 h-full min-h-[450px]">
            <WatchlistLeaderboard 
              stocks={stocks} 
              onToggleFav={handleToggleFav} 
              onSelectStock={handleSelectSymbol} 
              selectedSymbol={selectedSymbol} 
              isUSStyle={isUSStyle} 
            />
          </div>

          {/* 中央主區域: K 線圖 + 時間切換 (佔 6 欄) */}
          <div className="lg:col-span-6 flex flex-col gap-4">
            <div className="cyber-card rounded-none p-4 flex flex-col gap-3 min-h-[500px]">
              {/* K 線圖頂部狀態列 */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 flex-wrap gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="text-xl font-black text-white font-mono">{selectedSymbol}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                    {market === 'US' ? 'NASDAQ' : 'TWSE'}
                  </span>
                  <span className="text-xs text-slate-400">
                    AI 預測: 
                    <span className={`ml-1 font-bold ${backtestResult.winRate > 60 ? 'text-emerald-400' : 'text-cyan-400'}`}>
                      {selectedStrategyId ? `${selectedStrategyId} (勝率 ${backtestResult.winRate}%)` : '未套用策略'}
                    </span>
                  </span>
                </div>
                
                {/* K 線周期切換 (15m, 1h, 1d) */}
                <div className="flex items-center gap-2 flex-wrap justify-end">
                  {isMarketClosedWaiting && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-mono text-amber-200">
                      <span className="font-bold">休市中</span>
                      <label className="flex items-center gap-1.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={simulateClosedMarket}
                          onChange={(e) => setSimulateClosedMarket(e.target.checked)}
                          className="sr-only"
                        />
                        <span className={`relative h-4 w-7 rounded-full border transition-colors ${
                          simulateClosedMarket
                            ? 'border-cyan-400/60 bg-cyan-400/30'
                            : 'border-slate-700 bg-slate-950'
                        }`}>
                          <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-slate-100 transition-transform ${
                            simulateClosedMarket ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`} />
                        </span>
                        <span className={simulateClosedMarket ? 'text-cyan-200' : 'text-amber-200/70'}>
                          模擬即時價
                        </span>
                      </label>
                    </div>
                  )}

                  <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800/80 text-xs font-mono">
                    {KLINE_TIMEFRAMES.map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setTimeframe(tf)}
                        className={`px-2.5 py-1 rounded-md font-bold uppercase transition-all ${
                          timeframe === tf ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 客製化 K 線圖元件整合 */}
              <div className="flex-1 bg-slate-950/40 rounded-none overflow-hidden border border-slate-900 relative min-h-[400px]">
                <CustomKLineChart 
                  ref={chartRef}
                  data={klineData} 
                  symbol={selectedSymbol} 
                  timeframe={timeframe} 
                  height={400} 
                  pricePrecision={market === 'US' ? 2 : 1}
                  trades={trades} 
                  indicators={chartIndicators} 
                  showVolume={true}
                  showEquity={false}
                  loading={isChartLoading}
                  onVisibleRangeChanged={handleVisibleRangeChanged}
                  drawings={selectedChartDrawings}
                  drawingsKey={selectedSymbol}
                  onDrawingsChange={handleChartDrawingsChange}
                />
                {isOlderKlineLoading && (
                  <div className="absolute left-3 top-3 z-10 rounded border border-cyan-500/30 bg-slate-950/85 px-2 py-1 text-[10px] font-mono uppercase text-cyan-200 backdrop-blur">
                    loading older bars
                  </div>
                )}
                {!hasMoreOlderKlines && klineData.length > 0 && (
                  <div className="absolute left-3 bottom-3 z-10 rounded border border-slate-800/80 bg-slate-950/80 px-2 py-1 text-[10px] font-mono uppercase text-slate-500 backdrop-blur">
                    oldest loaded
                  </div>
                )}
              </div>

              {/* 圖表下方說明與聯動資訊 */}
              <div className="text-xs font-mono text-slate-500 flex justify-between border-t border-slate-900 pt-2 px-1">
                <div>* 滑鼠拖曳滾動，滾輪以游標為中心縮放 K 線圖。</div>
                <div className="text-right">
                  當前顯示 AI 交易點: <span className="text-cyan-400 font-bold">{trades.length} 個標記</span>
                </div>
              </div>
            </div>
          </div>

          {/* 右側欄: AI 策略控制台 (佔 3 欄) */}
          <div className="lg:col-span-3 flex flex-col gap-4">
            <AIStrategyConsole 
              selectedStrategyId={selectedStrategyId} 
              onSelectStrategyId={setSelectedStrategyId} 
              customStrategies={customStrategies}
              onGenerateAIStrategy={handleGenerateAIStrategy}
              onDeleteStrategy={handleDeleteStrategy}
              isGenerating={isGenerating}
              backtestResult={backtestResult} 
              signals={signals} 
              onTriggerDiagnosis={handleTriggerDiagnosis} 
              isUSStyle={isUSStyle} 
            />
          </div>

          {/* 下方擴展欄 1: 多空情緒與熱力圖 (佔 6 欄) */}
          <div className="md:col-span-1 lg:col-span-6 flex flex-col gap-4">
            <MarketSentiment 
              sentimentValue={market === 'US' ? 68 : 55} 
              sectors={heatmapSectors} 
              onSelectStock={handleSelectSymbol} 
              isUSStyle={isUSStyle} 
            />
          </div>

          {/* 下方擴展欄 2: 投資組合與風控 (佔 6 欄) */}
          <div className="md:col-span-1 lg:col-span-6 flex flex-col gap-4">
            <PortfolioRisk 
              portfolio={portfolio} 
              riskStatus={riskStatus} 
            />
          </div>
        </div>
      ) : (
        <div 
          ref={containerRef}
          className="w-full flex-1 grid min-h-[650px] h-[calc(100vh-130px)] gap-0 px-4 mt-2"
          style={{ gridTemplateRows: `minmax(0, min(calc(${row1Height}% - 2px), 800px)) 4px 1fr` }}
        >
          {/* Row 1 */}
          <div 
            className="w-full flex gap-0 overflow-hidden min-h-0 max-h-[800px]" 
          >
            {/* Left panel: Watchlist */}
            <div style={{ width: `${row1Widths[0]}%` }} className="flex flex-col overflow-hidden border border-slate-900 min-h-0">
              <WatchlistLeaderboard 
                stocks={stocks} 
                onToggleFav={handleToggleFav} 
                onSelectStock={handleSelectSymbol} 
                selectedSymbol={selectedSymbol} 
                isUSStyle={isUSStyle} 
              />
            </div>

            {/* Resizer 1 */}
            <div 
              className={`resizer-v flex-none ${activeDrag === 'row1-col1' ? 'dragging' : ''}`} 
              onPointerDown={startDrag('row1-col1')}
              onPointerMove={handleResizerPointerMove}
              onPointerUp={handleResizerPointerUp}
            />

            {/* Middle panel: Chart */}
            <div style={{ width: `${row1Widths[1]}%` }} className="flex flex-col overflow-hidden border-t border-b border-slate-900 min-h-0">
              <div className="cyber-card rounded-none p-4 flex flex-col gap-3 h-full min-h-0 border-none">
                {/* K 線圖頂部狀態列 */}
                <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 flex-wrap gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl font-black text-white font-mono">{selectedSymbol}</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-slate-400">
                      {market === 'US' ? 'NASDAQ' : 'TWSE'}
                    </span>
                    <span className="text-xs text-slate-400">
                      AI 預測: 
                      <span className={`ml-1 font-bold ${backtestResult.winRate > 60 ? 'text-emerald-400' : 'text-cyan-400'}`}>
                        {selectedStrategyId ? `${selectedStrategyId} (勝率 ${backtestResult.winRate}%)` : '未套用策略'}
                      </span>
                    </span>
                  </div>
                  
                  {/* K 線周期切換 */}
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {isMarketClosedWaiting && (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-mono text-amber-200">
                        <span className="font-bold">休市中</span>
                        <label className="flex items-center gap-1.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={simulateClosedMarket}
                            onChange={(e) => setSimulateClosedMarket(e.target.checked)}
                            className="sr-only"
                          />
                          <span className={`relative h-4 w-7 rounded-full border transition-colors ${
                            simulateClosedMarket
                              ? 'border-cyan-400/60 bg-cyan-400/30'
                              : 'border-slate-700 bg-slate-950'
                          }`}>
                            <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-slate-100 transition-transform ${
                              simulateClosedMarket ? 'translate-x-3.5' : 'translate-x-0.5'
                            }`} />
                          </span>
                          <span className={simulateClosedMarket ? 'text-cyan-200' : 'text-amber-200/70'}>
                            模擬即時價
                          </span>
                        </label>
                      </div>
                    )}

                    <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800/80 text-xs font-mono">
                      {KLINE_TIMEFRAMES.map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setTimeframe(tf)}
                          className={`px-2.5 py-1 rounded-md font-bold uppercase transition-all ${
                            timeframe === tf ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 客製化 K 線圖元件整合 */}
                <div className="flex-1 min-h-0 bg-slate-950/40 rounded-none overflow-hidden border border-slate-900 relative">
                  <CustomKLineChart 
                    ref={chartRef}
                    data={klineData} 
                    symbol={selectedSymbol} 
                    timeframe={timeframe} 
                    height="100%" 
                    pricePrecision={market === 'US' ? 2 : 1}
                    trades={trades} 
                    indicators={chartIndicators} 
                    showVolume={true}
                    showEquity={false}
                    loading={isChartLoading}
                    onVisibleRangeChanged={handleVisibleRangeChanged}
                    drawings={selectedChartDrawings}
                    drawingsKey={selectedSymbol}
                    onDrawingsChange={handleChartDrawingsChange}
                  />
                  {isOlderKlineLoading && (
                    <div className="absolute left-3 top-3 z-10 rounded border border-cyan-500/30 bg-slate-950/85 px-2 py-1 text-[10px] font-mono uppercase text-cyan-200 backdrop-blur">
                      loading older bars
                    </div>
                  )}
                  {!hasMoreOlderKlines && klineData.length > 0 && (
                    <div className="absolute left-3 bottom-3 z-10 rounded border border-slate-800/80 bg-slate-950/80 px-2 py-1 text-[10px] font-mono uppercase text-slate-500 backdrop-blur">
                      oldest loaded
                    </div>
                  )}
                </div>

                {/* 圖表下方說明與聯動資訊 */}
                <div className="text-xs font-mono text-slate-500 flex justify-between border-t border-slate-900 pt-2 px-1">
                  <div>* 滑鼠拖曳滾動，滾輪以游標為中心縮放 K 線圖。</div>
                  <div className="text-right">
                    當前顯示 AI 交易點: <span className="text-cyan-400 font-bold">{trades.length} 個標記</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Resizer 2 */}
            <div 
              className={`resizer-v flex-none ${activeDrag === 'row1-col2' ? 'dragging' : ''}`} 
              onPointerDown={startDrag('row1-col2')}
              onPointerMove={handleResizerPointerMove}
              onPointerUp={handleResizerPointerUp}
            />

            {/* Right panel: AI Strategy Console */}
            <div style={{ width: `${row1Widths[2]}%` }} className="flex flex-col overflow-hidden border border-slate-900 min-h-0">
              <AIStrategyConsole 
                selectedStrategyId={selectedStrategyId} 
                onSelectStrategyId={setSelectedStrategyId} 
                customStrategies={customStrategies}
                onGenerateAIStrategy={handleGenerateAIStrategy}
                onDeleteStrategy={handleDeleteStrategy}
                isGenerating={isGenerating}
                backtestResult={backtestResult} 
                signals={signals} 
                onTriggerDiagnosis={handleTriggerDiagnosis} 
                isUSStyle={isUSStyle} 
              />
            </div>
          </div>

          {/* Horizontal Resizer between Row 1 and Row 2 */}
          <div 
            className={`resizer-h flex-none ${activeDrag === 'row-split' ? 'dragging' : ''}`} 
            onPointerDown={startDrag('row-split')}
            onPointerMove={handleResizerPointerMove}
            onPointerUp={handleResizerPointerUp}
          />

          {/* Row 2 */}
          <div 
            className="w-full flex gap-0 overflow-hidden min-h-0"
          >
            {/* Bottom-Left panel: Sentiment */}
            <div style={{ width: `${row2Widths[0]}%` }} className="flex flex-col overflow-hidden border border-slate-900">
              <MarketSentiment 
                sentimentValue={market === 'US' ? 68 : 55} 
                sectors={heatmapSectors} 
                onSelectStock={handleSelectSymbol} 
                isUSStyle={isUSStyle} 
              />
            </div>

            {/* Resizer 3 */}
            <div 
              className={`resizer-v flex-none ${activeDrag === 'row2-col1' ? 'dragging' : ''}`} 
              onPointerDown={startDrag('row2-col1')}
              onPointerMove={handleResizerPointerMove}
              onPointerUp={handleResizerPointerUp}
            />

            {/* Bottom-Right panel: Risk */}
            <div style={{ width: `${row2Widths[1]}%` }} className="flex flex-col overflow-hidden border border-slate-900">
              <PortfolioRisk 
                portfolio={portfolio} 
                riskStatus={riskStatus} 
              />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
