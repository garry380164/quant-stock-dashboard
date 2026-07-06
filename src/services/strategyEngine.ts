import { KLineData, Trade } from '../types';

export interface AIStrategy {
  id: string;
  name: string;
  description: string;
  concept: string;
  logic: string;
  indicators: string[]; // e.g. ["MA_10", "EMA_20", "RSI_14", "Bollinger_20_2"]
  parameters: {
    stopLoss: number;      // 止損百分比 e.g. 2.5
    takeProfit: number;    // 止盈百分比 e.g. 6.0
    positionSize: number;  // 倉位大小 e.g. 10
    riskControl: string;   // 風控說明
  };
}

// 1. 移動平均線 (MA)
export function calculateMA(data: KLineData[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(data[i].close); // 用收盤價當初始填充
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += data[i - j].close;
    }
    result.push(sum / period);
  }
  return result;
}

// 2. 指數移動平均線 (EMA)
export function calculateEMA(data: KLineData[], period: number): number[] {
  const result: number[] = [];
  if (data.length === 0) return result;
  
  let ema = data[0].close;
  result.push(ema);
  
  const k = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// 3. 相對強弱指標 (RSI)
export function calculateRSI(data: KLineData[], period: number): number[] {
  const rsi: number[] = [];
  if (data.length === 0) return rsi;

  const gains: number[] = [];
  const losses: number[] = [];

  // 計算價格變化
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // RSI 初始值填充 (前 period 個元素)
  for (let i = 0; i <= period; i++) {
    rsi.push(50); // 預設 50
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period + 1; i < data.length; i++) {
    const gain = gains[i - 1];
    const loss = losses[i - 1];

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi.push(100);
    } else {
      const rs = avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }

  return rsi;
}

// 4. 布林通道 (Bollinger Bands)
export interface BollingerBands {
  middle: number[];
  upper: number[];
  lower: number[];
}

export function calculateBollinger(data: KLineData[], period: number, stdDevMultiplier: number): BollingerBands {
  const middle = calculateMA(data, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      upper.push(data[i].close * 1.05);
      lower.push(data[i].close * 0.95);
      continue;
    }

    let sumOfSquares = 0;
    const mean = middle[i];
    for (let j = 0; j < period; j++) {
      sumOfSquares += Math.pow(data[i - j].close - mean, 2);
    }
    
    const stdDev = Math.sqrt(sumOfSquares / period);
    upper.push(mean + stdDevMultiplier * stdDev);
    lower.push(mean - stdDevMultiplier * stdDev);
  }

  return { middle, upper, lower };
}

// 5. 解析指標字串並計算
// 例如 "MA_10" -> 計算 MA 10
export function parseAndCalculateIndicator(data: KLineData[], indStr: string): any {
  if (indStr.startsWith('MA_')) {
    const period = parseInt(indStr.split('_')[1], 10) || 10;
    return {
      type: 'line',
      name: indStr,
      values: calculateMA(data, period),
      color: '#f59e0b', // 橙黃色
    };
  } else if (indStr.startsWith('EMA_')) {
    const period = parseInt(indStr.split('_')[1], 10) || 12;
    return {
      type: 'line',
      name: indStr,
      values: calculateEMA(data, period),
      color: '#06b6d4', // 霓虹藍
    };
  } else if (indStr.startsWith('RSI_')) {
    const period = parseInt(indStr.split('_')[1], 10) || 14;
    return {
      type: 'rsi',
      name: indStr,
      values: calculateRSI(data, period),
      color: '#ec4899', // 粉紅色
    };
  } else if (indStr.startsWith('Bollinger_')) {
    const parts = indStr.split('_');
    const period = parseInt(parts[1], 10) || 20;
    const stdDev = parseFloat(parts[2]) || 2.0;
    const bands = calculateBollinger(data, period, stdDev);
    return {
      type: 'bollinger',
      name: indStr,
      middle: bands.middle,
      upper: bands.upper,
      lower: bands.lower,
      colorMiddle: '#64748b',
      colorUpper: '#10b981', // 翡翠綠
      colorLower: '#ef4444', // 烈焰紅
    };
  }
  
  return null;
}

// 6. 策略回測引擎 - 核心模擬買賣點位
export function runStrategyBacktest(klineData: KLineData[], strategy: AIStrategy): { trades: Trade[], chartIndicators: Record<string, any> } {
  const trades: Trade[] = [];
  const chartIndicators: Record<string, any> = {};
  
  if (klineData.length < 20) {
    return { trades, chartIndicators };
  }

  // 1. 計算所有指標
  const calculatedInds: any[] = [];
  strategy.indicators.forEach(indStr => {
    const calc = parseAndCalculateIndicator(klineData, indStr);
    if (calc) {
      calculatedInds.push(calc);
      
      // 轉換成 CustomKLineChart 所需的格式
      if (calc.type === 'line') {
        chartIndicators[calc.name] = {
          type: 'main',
          color: calc.color,
          data: klineData.map((k, idx) => ({
            time: k.timestamp,
            value: calc.values[idx]
          }))
        };
      } else if (calc.type === 'bollinger') {
        chartIndicators[`${calc.name}_Upper`] = {
          type: 'main',
          color: calc.colorUpper,
          data: klineData.map((k, idx) => ({
            time: k.timestamp,
            value: calc.upper[idx]
          }))
        };
        chartIndicators[`${calc.name}_Middle`] = {
          type: 'main',
          color: calc.colorMiddle,
          data: klineData.map((k, idx) => ({
            time: k.timestamp,
            value: calc.middle[idx]
          }))
        };
        chartIndicators[`${calc.name}_Lower`] = {
          type: 'main',
          color: calc.colorLower,
          data: klineData.map((k, idx) => ({
            time: k.timestamp,
            value: calc.lower[idx]
          }))
        };
      } else if (calc.type === 'rsi') {
        chartIndicators[calc.name] = {
          type: 'sub',
          pane: 'RSI',
          min: 0,
          max: 100,
          color: calc.color,
          data: klineData.map((k, idx) => ({
            time: k.timestamp,
            value: calc.values[idx]
          }))
        };
        chartIndicators[`${calc.name}_Overbought`] = {
          type: 'sub',
          pane: 'RSI',
          min: 0,
          max: 100,
          color: '#f97316',
          style: 'dashed',
          showInLegend: false,
          data: klineData.map((k) => ({
            time: k.timestamp,
            value: 70
          }))
        };
        chartIndicators[`${calc.name}_Oversold`] = {
          type: 'sub',
          pane: 'RSI',
          min: 0,
          max: 100,
          color: '#22c55e',
          style: 'dashed',
          showInLegend: false,
          data: klineData.map((k) => ({
            time: k.timestamp,
            value: 30
          }))
        };
      }
    }
  });

  // 2. 模擬交易信號
  let holding = false;
  let buyIndex = 0;
  let buyPrice = 0;
  const stopLoss = strategy.parameters.stopLoss || 2.0;
  const takeProfit = strategy.parameters.takeProfit || 5.0;

  // 尋找特定的指標以制定規則
  const maInd = calculatedInds.find(c => c.type === 'line' && c.name.startsWith('MA_'));
  const emaInd = calculatedInds.find(c => c.type === 'line' && c.name.startsWith('EMA_'));
  const rsiInd = calculatedInds.find(c => c.type === 'rsi');
  const bbInd = calculatedInds.find(c => c.type === 'bollinger');

  // 對於有多個 MA / EMA 或是布林的狀況，設定特別規則
  const maLines = calculatedInds.filter(c => c.type === 'line' && c.name.startsWith('MA_'));
  const emaLines = calculatedInds.filter(c => c.type === 'line' && c.name.startsWith('EMA_'));

  for (let i = 15; i < klineData.length; i++) {
    const curr = klineData[i];
    const prev = klineData[i - 1];
    
    if (!holding) {
      // 買入條件邏輯
      let shouldBuy = false;

      // 狀況 A: 雙 MA / EMA 黃金交叉
      if (maLines.length >= 2) {
        // 排序 MA 週期
        const sortedMAs = [...maLines].sort((a, b) => {
          const pA = parseInt(a.name.split('_')[1], 10);
          const pB = parseInt(b.name.split('_')[1], 10);
          return pA - pB;
        });
        const fastMA = sortedMAs[0];
        const slowMA = sortedMAs[1];
        
        // 黃金交叉: 快線向上穿過慢線
        const prevFast = fastMA.values[i - 1];
        const prevSlow = slowMA.values[i - 1];
        const currFast = fastMA.values[i];
        const currSlow = slowMA.values[i];
        
        shouldBuy = prevFast <= prevSlow && currFast > currSlow;
      } 
      // 狀況 B: 布林通道極值買入 (當價格低於布林下軌，且 RSI 低於 35)
      else if (bbInd) {
        const lowerBand = bbInd.lower[i];
        const rsiVal = rsiInd ? rsiInd.values[i] : 30; // 如果沒有 RSI 就只看布林
        
        const priceCrossUnderBB = prev.close >= bbInd.lower[i - 1] && curr.close < lowerBand;
        const rsiOversold = rsiVal < 35;
        
        shouldBuy = priceCrossUnderBB && rsiOversold;
      }
      // 狀況 C: 單均線價格向上突破
      else if (maInd || emaInd) {
        const targetInd = maInd || emaInd;
        const prevIndVal = targetInd.values[i - 1];
        const currIndVal = targetInd.values[i];
        
        shouldBuy = prev.close <= prevIndVal && curr.close > currIndVal;
      }
      // Fallback: deterministic mean-reversion entry.
      else {
        const rsiVal = rsiInd ? rsiInd.values[i] : 50;
        const recentLow = Math.min(...klineData.slice(Math.max(0, i - 5), i).map(k => k.close));
        shouldBuy = rsiVal < 35 && curr.close > prev.close && curr.close <= recentLow * 1.01;
      }

      if (shouldBuy && i < klineData.length - 2) {
        holding = true;
        buyIndex = i;
        buyPrice = curr.close;
        trades.push({
          time: curr.timestamp,
          type: 'BUY',
          price: curr.close,
          size: 1,
          note: `${strategy.name} 買入開單`
        });
      }
    } 
    else {
      // 賣出（平倉）條件邏輯：依據止盈止損
      const priceGainPct = ((curr.close - buyPrice) / buyPrice) * 100;
      
      let shouldSell = false;
      let sellNote = '';

      if (priceGainPct >= takeProfit) {
        shouldSell = true;
        sellNote = `止盈出場 (+${priceGainPct.toFixed(1)}%)`;
      } else if (priceGainPct <= -stopLoss) {
        shouldSell = true;
        sellNote = `止損出場 (${priceGainPct.toFixed(1)}%)`;
      } 
      // 輔助賣出規則：例如死亡交叉平倉
      else if (i - buyIndex > 3) {
        // 如果布林通道價格突破上軌，也可以觸發
        if (bbInd && curr.close > bbInd.upper[i]) {
          shouldSell = true;
          sellNote = '指標超買平倉';
        } 
        // 雙均線死亡交叉
        else if (maLines.length >= 2) {
          const sortedMAs = [...maLines].sort((a, b) => {
            const pA = parseInt(a.name.split('_')[1], 10);
            const pB = parseInt(b.name.split('_')[1], 10);
            return pA - pB;
          });
          const fastMA = sortedMAs[0];
          const slowMA = sortedMAs[1];
          shouldSell = fastMA.values[i - 1] >= slowMA.values[i - 1] && fastMA.values[i] < slowMA.values[i];
          if (shouldSell) sellNote = '均線死叉平倉';
        }
      }

      if (shouldSell && i - buyIndex > 2) {
        holding = false;
        trades.push({
          time: curr.timestamp,
          type: 'SELL',
          price: curr.close,
          size: 1,
          note: sellNote
        });
      }
    }
  }

  // 如果最後一天還持倉，強制平倉
  if (holding && klineData.length > 0) {
    const last = klineData[klineData.length - 1];
    const priceGainPct = ((last.close - buyPrice) / buyPrice) * 100;
    trades.push({
      time: last.timestamp,
      type: 'SELL',
      price: last.close,
      size: 1,
      note: `收盤強制平倉 (${priceGainPct >= 0 ? '+' : ''}${priceGainPct.toFixed(1)}%)`
    });
  }

  return {
    trades: trades.slice(-80),
    chartIndicators
  };
}
