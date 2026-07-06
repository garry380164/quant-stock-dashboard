import { KLineData, Trade, StockInfo, MarketIndex, Signal, BacktestResult, PortfolioAsset, RiskStatus } from '../types';

const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min;

const getTimeframeIntervalMs = (timeframe: string) => {
  if (timeframe === '15m') return 15 * 60 * 1000;
  if (timeframe === '4h') return 4 * 60 * 60 * 1000;
  if (timeframe === '1d') return 24 * 60 * 60 * 1000;
  if (timeframe === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (timeframe === '1M') return 30 * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
};

const getBarStartTimestamp = (timestamp: number, timeframe: string) => {
  const intervalMs = getTimeframeIntervalMs(timeframe);
  return Math.floor(timestamp / intervalMs) * intervalMs;
};

export function generateHistoryKLines(
  symbol: string,
  basePrice: number,
  count: number = 200,
  timeframe: string = '1h'
): KLineData[] {
  const data: KLineData[] = [];
  let currentPrice = basePrice || 100;
  const interval = getTimeframeIntervalMs(timeframe);
  let timestamp = getBarStartTimestamp(Date.now(), timeframe) - (count - 1) * interval;

  for (let i = 0; i < count; i++) {
    const changePercent = randomInRange(-0.02, 0.021);
    const open = currentPrice;
    const close = currentPrice * (1 + changePercent);
    const high = Math.max(open, close) * randomInRange(1, 1.015);
    const low = Math.min(open, close) * randomInRange(0.985, 1);
    const volume = Math.round(randomInRange(50000, 500000));

    data.push({
      timestamp,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(close.toFixed(2)),
      volume,
    });

    currentPrice = close;
    timestamp += interval;
  }

  return data;
}

export function generateTradesForStrategy(klineData: KLineData[], strategy: string): Trade[] {
  const trades: Trade[] = [];
  if (klineData.length < 20) return [];

  let holding = false;
  let buyIndex = 0;

  for (let i = 15; i < klineData.length - 2; i++) {
    const curr = klineData[i];
    let shouldBuy = false;
    let shouldSell = false;

    if (strategy === 'LSTM') {
      const ma5 = klineData.slice(i - 5, i).reduce((sum, k) => sum + k.close, 0) / 5;
      shouldBuy = !holding && curr.close > ma5 && Math.random() < 0.15;
      shouldSell = holding && curr.close < ma5 && Math.random() < 0.2;
    } else if (strategy === 'MOMENTUM') {
      const avgVol = klineData.slice(i - 10, i).reduce((sum, k) => sum + k.volume, 0) / 10;
      shouldBuy = !holding && curr.volume > avgVol * 1.4 && curr.close > curr.open && Math.random() < 0.3;
      shouldSell = holding && curr.close < curr.open && Math.random() < 0.25;
    } else {
      const slice = klineData.slice(i - 15, i);
      const avg = slice.reduce((sum, k) => sum + k.close, 0) / 15;
      const variance = slice.reduce((sum, k) => sum + Math.pow(k.close - avg, 2), 0) / 15;
      const std = Math.sqrt(variance);
      shouldBuy = !holding && curr.close < avg - std * 1.4 && Math.random() < 0.35;
      shouldSell = holding && curr.close > avg + std * 1.2 && Math.random() < 0.35;
    }

    if (shouldBuy) {
      holding = true;
      buyIndex = i;
      trades.push({ time: curr.timestamp, type: 'BUY', price: curr.close, size: 1, note: `${strategy} entry` });
    } else if (shouldSell && holding && i - buyIndex > 2) {
      holding = false;
      trades.push({ time: curr.timestamp, type: 'SELL', price: curr.close, size: 1, note: `${strategy} exit` });
    }
  }

  if (holding && klineData.length > 0) {
    const last = klineData[klineData.length - 1];
    trades.push({ time: last.timestamp, type: 'SELL', price: last.close, size: 1, note: `${strategy} close` });
  }

  return trades.slice(-80);
}

export const mockBacktestResults: Record<string, Record<string, BacktestResult>> = {
  US: {
    LSTM: { winRate: 68, sharpeRatio: 1.84, maxDrawdown: 8.7, profitFactor: 1.92, totalTrades: 126 },
    MOMENTUM: { winRate: 61, sharpeRatio: 1.42, maxDrawdown: 12.4, profitFactor: 1.55, totalTrades: 188 },
    BOLLINGER: { winRate: 64, sharpeRatio: 1.67, maxDrawdown: 9.8, profitFactor: 1.73, totalTrades: 154 },
  },
  TW: {
    LSTM: { winRate: 65, sharpeRatio: 1.55, maxDrawdown: 10.2, profitFactor: 1.62, totalTrades: 98 },
    MOMENTUM: { winRate: 58, sharpeRatio: 1.22, maxDrawdown: 14.1, profitFactor: 1.36, totalTrades: 141 },
    BOLLINGER: { winRate: 62, sharpeRatio: 1.48, maxDrawdown: 11.5, profitFactor: 1.51, totalTrades: 120 },
  },
};

export const initialStocksUS: StockInfo[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: 182.52, change: 1.25, changePercent: 0.69, high24h: 184.20, low24h: 181.12, volume: 54.2, isFav: true },
  { symbol: 'MSFT', name: 'Microsoft Corp.', price: 415.50, change: -2.45, changePercent: -0.59, high24h: 420.12, low24h: 413.20, volume: 22.8, isFav: true },
  { symbol: 'TSLA', name: 'Tesla Inc.', price: 175.34, change: 8.42, changePercent: 5.04, high24h: 178.50, low24h: 166.30, volume: 88.5, isFav: true },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 875.12, change: 24.15, changePercent: 2.84, high24h: 884.80, low24h: 850.10, volume: 48.9, isFav: true },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 151.60, change: -0.85, changePercent: -0.56, high24h: 153.20, low24h: 150.50, volume: 28.3, isFav: false },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', price: 178.15, change: 1.98, changePercent: 1.12, high24h: 179.43, low24h: 176.02, volume: 31.4, isFav: false },
];

export const initialStocksTW: StockInfo[] = [
  { symbol: '2330.TW', name: 'TSMC', price: 790.00, change: 12.00, changePercent: 1.54, high24h: 796.00, low24h: 782.00, volume: 32.4, isFav: true },
  { symbol: '2317.TW', name: 'Foxconn', price: 155.50, change: -1.50, changePercent: -0.96, high24h: 158.00, low24h: 154.00, volume: 45.2, isFav: true },
  { symbol: '2454.TW', name: 'MediaTek', price: 1120.00, change: 25.00, changePercent: 2.28, high24h: 1135.00, low24h: 1095.00, volume: 4.8, isFav: true },
  { symbol: '2308.TW', name: 'Delta', price: 342.00, change: 5.50, changePercent: 1.63, high24h: 345.00, low24h: 338.00, volume: 8.9, isFav: false },
  { symbol: '2881.TW', name: 'Fubon', price: 71.20, change: -0.30, changePercent: -0.42, high24h: 71.90, low24h: 70.80, volume: 15.6, isFav: false },
  { symbol: '2603.TW', name: 'Evergreen', price: 172.50, change: -4.50, changePercent: -2.54, high24h: 178.00, low24h: 171.00, volume: 22.1, isFav: false },
];

export const initialIndicesUS: MarketIndex[] = [
  { symbol: '.SPX', name: 'S&P 500', price: 5137.08, changePercent: 0.82, sparkline: [5095, 5102, 5098, 5110, 5108, 5122, 5118, 5125, 5130, 5127, 5137] },
  { symbol: '.IXIC', name: 'Nasdaq', price: 16274.94, changePercent: 1.14, sparkline: [16050, 16110, 16080, 16150, 16120, 16200, 16180, 16230, 16250, 16240, 16274] },
  { symbol: '.DJI', name: 'Dow Jones', price: 39087.38, changePercent: 0.23, sparkline: [38980, 39020, 39000, 39040, 39030, 39070, 39050, 39060, 39080, 39070, 39087] },
  { symbol: '.SOX', name: 'SOX', price: 4929.58, changePercent: 2.15, sparkline: [4810, 4850, 4830, 4880, 4860, 4910, 4890, 4920, 4940, 4915, 4929] },
];

export const initialIndicesTW: MarketIndex[] = [
  { symbol: '.TWII', name: 'TAIEX', price: 20337.54, changePercent: 1.25, sparkline: [20050, 20120, 20080, 20180, 20150, 20240, 20210, 20280, 20310, 20290, 20337] },
  { symbol: '.TWOI', name: 'TPEx', price: 252.32, changePercent: 0.88, sparkline: [249.5, 250.2, 249.8, 250.8, 250.5, 251.4, 251.1, 251.9, 252.1, 252.0, 252.32] },
];

export const mockSignalTemplates = [
  { symbol: 'AAPL', strategy: 'LSTM', confidence: 88, type: 'BUY' as const, priceOffset: 1.002 },
  { symbol: 'TSLA', strategy: 'MOMENTUM', confidence: 79, type: 'BUY' as const, priceOffset: 1.015 },
  { symbol: 'NVDA', strategy: 'BOLLINGER', confidence: 91, type: 'SELL' as const, priceOffset: 0.992 },
  { symbol: '2330.TW', strategy: 'LSTM', confidence: 85, type: 'BUY' as const, priceOffset: 1.008 },
  { symbol: '2454.TW', strategy: 'BOLLINGER', confidence: 73, type: 'SELL' as const, priceOffset: 0.985 },
  { symbol: 'MSFT', strategy: 'MOMENTUM', confidence: 82, type: 'BUY' as const, priceOffset: 1.004 },
];

export function generateRandomSignal(marketType: 'US' | 'TW'): Signal {
  const templates = mockSignalTemplates.filter(t => marketType === 'TW' ? t.symbol.endsWith('.TW') : !t.symbol.endsWith('.TW'));
  const template = templates[Math.floor(Math.random() * templates.length)];
  const baseList = marketType === 'US' ? initialStocksUS : initialStocksTW;
  const stock = baseList.find(item => item.symbol === template.symbol) || baseList[0];
  return {
    id: `${template.symbol}-${Date.now()}`,
    time: new Date().toLocaleTimeString('en-US', { hour12: false }),
    type: template.type,
    symbol: template.symbol,
    price: parseFloat((stock.price * template.priceOffset).toFixed(2)),
    confidence: Math.max(50, Math.min(99, template.confidence + Math.round(randomInRange(-5, 5)))),
    strategy: template.strategy,
  };
}

export const initialPortfolioUS: PortfolioAsset[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', shares: 150, avgPrice: 175.20, currentPrice: 182.52, value: 27378, weight: 24.5, color: '#06b6d4' },
  { symbol: 'MSFT', name: 'Microsoft Corp.', shares: 60, avgPrice: 395.40, currentPrice: 415.50, value: 24930, weight: 22.3, color: '#3b82f6' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', shares: 45, avgPrice: 720.00, currentPrice: 875.12, value: 39380.4, weight: 35.2, color: '#10b981' },
  { symbol: 'TSLA', name: 'Tesla Inc.', shares: 110, avgPrice: 185.00, currentPrice: 175.34, value: 19287.4, weight: 17.2, color: '#f59e0b' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', shares: 5, avgPrice: 148.00, currentPrice: 151.60, value: 758, weight: 0.8, color: '#ec4899' },
];

export const initialPortfolioTW: PortfolioAsset[] = [
  { symbol: '2330.TW', name: 'TSMC', shares: 5000, avgPrice: 710.00, currentPrice: 790.00, value: 3950000, weight: 58.2, color: '#10b981' },
  { symbol: '2317.TW', name: 'Foxconn', shares: 12000, avgPrice: 120.00, currentPrice: 155.50, value: 1866000, weight: 27.5, color: '#06b6d4' },
  { symbol: '2454.TW', name: 'MediaTek', shares: 800, avgPrice: 1050.00, currentPrice: 1120.00, value: 896000, weight: 13.2, color: '#3b82f6' },
  { symbol: '2881.TW', name: 'Fubon', shares: 1000, avgPrice: 70.00, currentPrice: 71.20, value: 71200, weight: 1.1, color: '#f59e0b' },
];

export function getRiskStatus(portfolio: PortfolioAsset[]): RiskStatus {
  const totalValue = portfolio.reduce((sum, item) => sum + item.value, 0) || 1;
  const concentration = Math.max(...portfolio.map(item => item.value / totalValue));
  const riskExposure = parseFloat((concentration * 100).toFixed(1));
  if (riskExposure > 45) return { portfolioBeta: 1.28, riskExposure, status: 'HIGH', alertMessage: 'Position concentration is elevated.' };
  if (riskExposure > 30) return { portfolioBeta: 1.08, riskExposure, status: 'MEDIUM', alertMessage: 'Portfolio risk is balanced but watch concentration.' };
  return { portfolioBeta: 0.86, riskExposure, status: 'LOW', alertMessage: 'Portfolio exposure is diversified.' };
}

export interface HeatmapItem {
  id: string;
  name: string;
  value: number;
  changePercent: number;
}

export interface HeatmapSector {
  sector: string;
  items: HeatmapItem[];
}

export const mockHeatmapUS: HeatmapSector[] = [
  { sector: 'Mega Cap Tech', items: [
    { id: 'AAPL', name: 'Apple', value: 182.52, changePercent: 0.69 },
    { id: 'MSFT', name: 'Microsoft', value: 415.50, changePercent: -0.59 },
    { id: 'NVDA', name: 'NVIDIA', value: 875.12, changePercent: 2.84 },
    { id: 'GOOGL', name: 'Alphabet', value: 151.60, changePercent: -0.56 },
  ]},
  { sector: 'Consumer', items: [
    { id: 'AMZN', name: 'Amazon', value: 178.15, changePercent: 1.12 },
    { id: 'TSLA', name: 'Tesla', value: 175.34, changePercent: 5.04 },
    { id: 'COST', name: 'Costco', value: 824.30, changePercent: 0.59 },
    { id: 'WMT', name: 'Walmart', value: 68.40, changePercent: 0.46 },
  ]},
  { sector: 'Finance', items: [
    { id: 'JPM', name: 'JPMorgan', value: 198.80, changePercent: 0.36 },
    { id: 'BAC', name: 'Bank of America', value: 39.20, changePercent: 0.31 },
    { id: 'V', name: 'Visa', value: 276.45, changePercent: 0.42 },
    { id: 'MA', name: 'Mastercard', value: 462.10, changePercent: 0.51 },
  ]},
];

export const mockHeatmapTW: HeatmapSector[] = [
  { sector: 'Semiconductor', items: [
    { id: '2330.TW', name: 'TSMC', value: 790, changePercent: 1.54 },
    { id: '2454.TW', name: 'MediaTek', value: 1120, changePercent: 2.28 },
    { id: '2308.TW', name: 'Delta', value: 342, changePercent: 1.63 },
  ]},
  { sector: 'Manufacturing', items: [
    { id: '2317.TW', name: 'Foxconn', value: 155.5, changePercent: -0.96 },
    { id: '2603.TW', name: 'Evergreen', value: 172.5, changePercent: -2.54 },
    { id: '2881.TW', name: 'Fubon', value: 71.2, changePercent: -0.42 },
  ]},
];
