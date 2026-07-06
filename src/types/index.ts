export interface KLineData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  time: number; // timestamp
  type: 'BUY' | 'SELL';
  price: number;
  size: number;
  note?: string;
}

export interface LifecycleEvent {
  time: number;
  color: string;
  text: string;
}

export interface StockInfo {
  symbol: string;
  name: string;
  price: number;
  change: number; // 漲跌額
  changePercent: number; // 漲跌幅
  high24h: number;
  low24h: number;
  volume: number; // 成交量 (百萬)
  tickVolume?: number;
  tickRegime?: 'sideways' | 'volatile' | 'trend_up' | 'trend_down' | 'volume_up' | 'volume_down';
  marketCap?: number;
  priceSource?: string;
  isKlineSynced?: boolean;
  isFav?: boolean;
  market?: string;
}

export interface MarketIndex {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  sparkline: number[]; // 24小時價格走勢 (微型圖)
}

export interface Signal {
  id: string;
  time: string; // 格式化時間, 如 '11:50:14'
  type: 'BUY' | 'SELL';
  symbol: string;
  price: number;
  confidence: number; // 信心度百分比 0-100
  strategy: string; // LSTM, Momentum, Bollinger
}

export interface BacktestResult {
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number; // MDD 百分比
  profitFactor: number;
  totalTrades: number;
}

export interface PortfolioAsset {
  symbol: string;
  name: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
  value: number;
  weight: number; // 權重百分比
  color: string; // 圓餅圖顏色
}

export interface RiskStatus {
  portfolioBeta: number;
  riskExposure: number; // 百分比
  status: 'LOW' | 'MEDIUM' | 'HIGH';
  alertMessage?: string;
}
