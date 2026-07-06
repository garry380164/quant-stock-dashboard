'use client';

import React, { useState, useEffect } from 'react';
import { BacktestResult, Signal } from '../types';
import { AIStrategy } from '../services/strategyEngine';

const PlusIcon = ({ className = '' }: { className?: string }) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

const LoaderCircleIcon = ({ className = '' }: { className?: string }) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

interface AIStrategyConsoleProps {
  selectedStrategyId: string;
  onSelectStrategyId: (id: string) => void;
  customStrategies: AIStrategy[];
  onGenerateAIStrategy: () => Promise<void>;
  onDeleteStrategy: (id: string) => Promise<void>;
  isGenerating: boolean;
  backtestResult: BacktestResult;
  signals: Signal[];
  onTriggerDiagnosis: () => void;
  isUSStyle: boolean;
}

export default function AIStrategyConsole({
  selectedStrategyId,
  onSelectStrategyId,
  customStrategies,
  onGenerateAIStrategy,
  onDeleteStrategy,
  isGenerating,
  backtestResult,
  signals,
  onTriggerDiagnosis,
  isUSStyle,
}: AIStrategyConsoleProps) {
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);

  const loadingTexts = [
    '🤖 AI 智慧大腦正在啟動...',
    '📊 正在抓取最新市場行情與成交量...',
    '📈 評估最佳技術指標 (MA/EMA/RSI/Bollinger)...',
    '🛡️ 制定止盈/止損與風控點位中...',
    '⚖️ 進行倉位管理與資金曝險評估...',
    '💾 策略生成完畢，正在儲存至智慧策略庫...'
  ];

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isGenerating) {
      interval = setInterval(() => {
        setLoadingTextIndex((prev) => (prev + 1) % loadingTexts.length);
      }, 3000);
    } else {
      setLoadingTextIndex(0);
    }
    return () => clearInterval(interval);
  }, [isGenerating]);

  // 決定策略的中文名稱與描述
  const getStrategyMeta = (strategyId: string) => {
    // 檢查是否是預設策略
    if (strategyId === 'LSTM') {
      return {
        name: 'LSTM 趨勢預測模型',
        desc: '利用長短期記憶神經網路 (Long Short-Term Memory) 分析歷史價格序列，預測未來 24H 價格波段趨勢。',
        modelDetails: '深度學習·迴歸預測·非線性時間序列',
        concept: 'LSTM 是循環神經網路 (RNN) 的一種變體，專門用來處理時間序列數據中的長短期依賴關係。本模型藉由過去多根 K 棒的收盤價、成交量等特徵進行學習，預測未來的趨勢方向。',
        logic: '當預測未來價格大於 MA5 且置信度達標時，觸發買入開單。若價格跌破 MA5 或滿足反向條件，則觸發平倉。',
        indicators: ['MA_5'],
        parameters: { stopLoss: 3, takeProfit: 8, positionSize: 15, riskControl: '單筆交易最大虧損限制在 3%' }
      };
    }
    if (strategyId === 'MOMENTUM') {
      return {
        name: '量價動能突破策略',
        desc: '監控成交量異動與大K線實體，偵測主力資金湧入或竭盡的動量轉折點，適合順勢交易。',
        modelDetails: '量價多因子·統計動能·成交量加權均線',
        concept: '動能突破策略是基於「強者恆強」的趨勢跟隨原理。當成交量異常放大且價格收紅時，代表有大額資金流入推進，此時順勢做多；當多頭動能竭盡或反向突破時，立即平倉。',
        logic: '當前 K 棒收紅，且成交量高於 10 日平均成交量的 1.4 倍時，代表動能爆發，觸發買入開單。當 K 棒收黑或價格跌破開單點時平倉。',
        indicators: ['MA_10'],
        parameters: { stopLoss: 4, takeProfit: 10, positionSize: 20, riskControl: '成交量未達標時不予開單，防止假突破' }
      };
    }
    if (strategyId === 'BOLLINGER') {
      return {
        name: '布林通道極值突破',
        desc: '計算 20 日移動平均線與 2 倍標準差，當價格突破通道上下軌且指標超買/超賣時觸發逆勢或突破交易。',
        modelDetails: '統計學標準差·均值回歸·波動率通道',
        concept: '布林通道利用統計學的標準差，在均線上下繪製出波動區間。根據正態分佈，約 95.4% 的價格會在上下軌之間波動。當價格觸及上下軌時，往往面臨極值逆轉或強勢突破。',
        logic: '當價格向下突破布林下軌（超賣），且隨機指標處於低位時，觸發均值回歸買入開單。當價格向上突破布林上軌（超買）或達到止盈目標時平倉。',
        indicators: ['Bollinger_20_2'],
        parameters: { stopLoss: 2.5, takeProfit: 6, positionSize: 10, riskControl: '布林帶寬度過窄（擠壓期）時避免逆勢操作' }
      };
    }

    // 尋找自訂策略
    const custom = customStrategies.find((s) => s.id === strategyId);
    if (custom) {
      return {
        name: custom.name,
        desc: custom.description,
        modelDetails: `AI 生成策略 · ID: ${custom.id}`,
        concept: custom.concept,
        logic: custom.logic,
        indicators: custom.indicators,
        parameters: custom.parameters,
      };
    }

    return { 
      name: '未選取策略', 
      desc: '', 
      modelDetails: '', 
      concept: '', 
      logic: '', 
      indicators: [], 
      parameters: { stopLoss: 0, takeProfit: 0, positionSize: 0, riskControl: '' } 
    };
  };

  const meta = getStrategyMeta(selectedStrategyId);

  const getSignalColor = (type: 'BUY' | 'SELL') => {
    if (isUSStyle) {
      return type === 'BUY' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20' : 'text-rose-500 border-rose-500/30 bg-rose-950/20';
    } else {
      return type === 'BUY' ? 'text-rose-500 border-rose-500/30 bg-rose-950/20' : 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20';
    }
  };

  const getSignalIcon = (type: 'BUY' | 'SELL') => {
    if (isUSStyle) {
      return type === 'BUY' ? '🟢 [AI 買入訊號]' : '🔴 [AI 賣出訊號]';
    } else {
      return type === 'BUY' ? '🔴 [AI 買入訊號]' : '🟢 [AI 賣出訊號]';
    }
  };

  return (
    <div className="cyber-card rounded-none p-4 flex flex-col flex-1 gap-3 overflow-y-auto min-h-0">
      {/* 頂部標題 */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-4 bg-cyan-400 rounded-sm shadow-[0_0_8px_#22d3ee]"></div>
          <h2 className="text-base font-bold text-white tracking-wider font-mono">智慧核心: AI 策略庫控制台</h2>
        </div>
        <span className="text-xs font-mono text-cyan-400 bg-cyan-950/30 border border-cyan-800/30 px-2 py-0.5 rounded-full">
          GEMINI CORES
        </span>
      </div>

      {/* AI 生成策略按鈕 */}
      <button
        onClick={onGenerateAIStrategy}
        disabled={isGenerating}
        className={`w-full text-white font-semibold py-2 px-3 rounded-lg text-xs font-mono tracking-wider transition-all duration-300 shadow-[0_0_12px_rgba(6,182,212,0.15)] hover:shadow-[0_0_20px_rgba(6,182,212,0.35)] flex items-center justify-center gap-2 ${
          isGenerating
            ? 'bg-slate-800 border border-slate-700 cursor-not-allowed text-slate-400'
            : 'bg-gradient-to-r from-purple-600 via-cyan-600 to-blue-600 hover:from-purple-500 hover:to-blue-500'
        }`}
      >
        {isGenerating ? (
          <>
            <LoaderCircleIcon className="h-4 w-4 animate-spin text-cyan-400" />
            <span className="animate-pulse">{loadingTexts[loadingTextIndex]}</span>
          </>
        ) : (
          <>
            <PlusIcon className="h-4 w-4 text-cyan-200" />
            AI 生成智慧策略 (Gemini 驅動)
          </>
        )}
      </button>

      {/* AI 生成自訂策略庫 */}
      <div className="flex flex-col gap-2">
        <div className="text-xs font-bold text-slate-400 font-mono flex items-center justify-between">
          <span>AI 自訂策略庫:</span>
          <span className="text-xs text-slate-500 font-normal">({customStrategies.length} 個已儲存)</span>
        </div>
        
        {customStrategies.length === 0 ? (
          <div className="text-slate-600 text-xs font-mono py-2 text-center border border-dashed border-slate-800/60 rounded-lg bg-slate-950/20">
            尚無自訂策略。請點擊上方按鈕生成！
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[150px] overflow-y-auto border border-slate-900 rounded-lg p-1.5 bg-slate-950/40">
            {customStrategies.map((strat) => (
              <div
                key={strat.id}
                className={`flex items-center justify-between p-2 rounded-lg transition-all border ${
                  selectedStrategyId === strat.id
                    ? 'bg-cyan-950/20 border-cyan-500/50 text-cyan-200'
                    : 'bg-slate-900/40 border-slate-900 text-slate-400 hover:border-slate-800 hover:text-slate-300'
                }`}
              >
                <button
                  onClick={() => onSelectStrategyId(strat.id)}
                  className="flex-1 text-left text-xs font-semibold truncate mr-2"
                >
                  ✨ {strat.name}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteStrategy(strat.id);
                  }}
                  className="text-xs bg-rose-950/20 hover:bg-rose-900/40 text-rose-400 border border-rose-900/30 hover:border-rose-500/40 px-1.5 py-0.5 rounded transition-all font-mono"
                >
                  刪除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 策略概念與邏輯細節 */}
      {selectedStrategyId && (
          <div className="bg-slate-950/60 border border-slate-900 rounded-lg p-3 flex flex-col gap-2.5">
          <div className="border-b border-slate-800 pb-2">
            <div className="text-sm font-bold text-cyan-300 font-mono mb-0.5">{meta.name}</div>
            <div className="text-xs text-slate-500 font-mono">{meta.modelDetails}</div>
          </div>

          <div className="text-slate-300 text-xs leading-relaxed">
            <span className="font-bold text-slate-400 block mb-1">💡 策略概念說明:</span>
            {meta.concept}
          </div>

          <div className="text-slate-300 text-xs leading-relaxed border-t border-slate-900 pt-2">
            <span className="font-bold text-slate-400 block mb-1">⚙️ 交易運作邏輯:</span>
            {meta.logic}
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs border-t border-slate-900 pt-2.5">
            <div>
              <span className="font-bold text-slate-400 block mb-1">🎯 止盈/止損設定:</span>
              <span className="text-emerald-400">止盈 {meta.parameters.takeProfit}%</span>
              <span className="text-slate-500 mx-1">/</span>
              <span className="text-rose-400">止損 {meta.parameters.stopLoss}%</span>
            </div>
            <div>
              <span className="font-bold text-slate-400 block mb-1">💼 倉位管理:</span>
              <span className="text-cyan-400">倉位比重: {meta.parameters.positionSize}%</span>
            </div>
          </div>

          <div className="text-slate-300 text-xs leading-relaxed border-t border-slate-900 pt-2">
            <span className="font-bold text-slate-400 block mb-1">🛡️ 風險控制機制:</span>
            <span className="text-slate-400 font-mono text-[11px] bg-slate-900/60 px-2 py-1 rounded block border border-slate-800/40">
              {meta.parameters.riskControl}
            </span>
          </div>

          <div className="text-slate-300 text-xs leading-relaxed border-t border-slate-900 pt-2">
            <span className="font-bold text-slate-400 block mb-1">📊 使用技術指標:</span>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {meta.indicators && meta.indicators.length > 0 ? (
                meta.indicators.map((ind) => (
                  <span
                    key={ind}
                    className="text-xs font-mono text-cyan-300 bg-cyan-950/40 border border-cyan-900/60 px-2 py-0.5 rounded"
                  >
                    {ind}
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-600 font-mono">無額外指標</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 互動診斷按鈕 */}
      <button
        onClick={onTriggerDiagnosis}
        className="w-full bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 font-semibold py-1.5 px-3 rounded-lg text-xs font-mono tracking-wider transition-all flex items-center justify-center gap-2"
      >
        <svg className="w-3.5 h-3.5 animate-pulse text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        觸發即時策略訊號診斷回測
      </button>

      {/* 回測績效卡片 */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-slate-950/40 border border-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400 font-mono">歷史勝率</div>
          <div className="text-sm font-bold text-emerald-400 font-mono mt-0.5">{backtestResult.winRate}%</div>
        </div>
        <div className="bg-slate-950/40 border border-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400 font-mono">Sharpe Ratio</div>
          <div className="text-sm font-bold text-cyan-400 font-mono mt-0.5">{backtestResult.sharpeRatio}</div>
        </div>
        <div className="bg-slate-950/40 border border-slate-800/40 rounded-lg p-2 text-center">
          <div className="text-xs text-slate-400 font-mono">最大回撤</div>
          <div className="text-sm font-bold text-rose-400 font-mono mt-0.5">-{backtestResult.maxDrawdown}%</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-slate-400 font-mono border-t border-slate-900 pt-2 px-1">
        <div>總交易次數: <span className="text-slate-200 font-bold">{backtestResult.totalTrades} 次</span></div>
        <div className="text-right">獲利因子: <span className="text-slate-200 font-bold">{backtestResult.profitFactor}</span></div>
      </div>

      {/* 即時訊號流水燈 (Feed) */}
      <div className="flex flex-col gap-2 border-t border-slate-900 pt-3">
        <div className="text-xs font-bold text-slate-400 font-mono flex items-center justify-between">
          <span>即時策略流水燈 (SIGNAL FEED)</span>
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
          </span>
        </div>
        
        <div className="overflow-y-auto max-h-[130px] border border-slate-900 bg-slate-950/45 rounded-lg p-2 flex flex-col gap-1.5">
          {signals.length === 0 ? (
            <div className="text-slate-600 text-center py-6 text-xs font-mono">
              等待 AI 策略觸發診斷訊號...
            </div>
          ) : (
            signals.map((sig) => (
              <div
                key={sig.id}
                className={`signal-enter border rounded-lg px-2 py-1 flex items-center justify-between text-xs font-mono transition-colors ${getSignalColor(sig.type)}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-bold">{getSignalIcon(sig.type)}</span>
                  <span className="text-white font-bold text-xs">{sig.symbol}</span>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <span className="text-slate-500 text-[9px]">{sig.time}</span>
                  <span className="text-slate-200">${sig.price}</span>
                  <span className="font-bold bg-slate-900/50 px-1 py-0.5 rounded border border-slate-800">
                    信 {sig.confidence}%
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
