'use client';

import React, { useState } from 'react';
import { HeatmapSector } from '../services/mockData';

interface MarketSentimentProps {
  sentimentValue: number; // 0-100
  sectors: HeatmapSector[];
  onSelectStock: (symbol: string) => void;
  isUSStyle: boolean;
}

export default function MarketSentiment({
  sentimentValue,
  sectors,
  onSelectStock,
  isUSStyle,
}: MarketSentimentProps) {
  const [activeTab, setActiveTab] = useState<'SENTIMENT' | 'HEATMAP'>('SENTIMENT');

  // 情緒狀態判定
  const getSentimentLabel = (val: number) => {
    if (val < 25) return { text: '極度恐懼 (Extreme Fear)', color: 'text-rose-500 shadow-rose-500/20' };
    if (val < 45) return { text: '恐懼 (Fear)', color: 'text-amber-500 shadow-amber-500/20' };
    if (val < 55) return { text: '中立 (Neutral)', color: 'text-slate-400 shadow-slate-400/20' };
    if (val < 75) return { text: '貪婪 (Greed)', color: 'text-cyan-400 shadow-cyan-400/20' };
    return { text: '極度貪婪 (Extreme Greed)', color: 'text-emerald-400 shadow-emerald-400/20' };
  };

  const sentiment = getSentimentLabel(sentimentValue);

  // 取得熱力圖方塊背景色與字體顏色
  const getItemStyle = (change: number) => {
    const isPositive = change >= 0;
    const absChange = Math.abs(change);
    
    // 依漲跌幅決定透明度/深淺
    let intensity = 0.15;
    if (absChange > 3) intensity = 0.85;
    else if (absChange > 1.5) intensity = 0.6;
    else if (absChange > 0.5) intensity = 0.35;

    // 依台美股配色決定紅綠
    let colorName: 'emerald' | 'rose' = 'emerald';
    if (isUSStyle) {
      colorName = isPositive ? 'emerald' : 'rose';
    } else {
      colorName = isPositive ? 'rose' : 'emerald';
    }

    if (colorName === 'emerald') {
      return {
        bg: `rgba(16, 185, 129, ${intensity})`,
        border: `rgba(16, 185, 129, ${intensity + 0.15})`,
        text: intensity > 0.5 ? 'text-slate-900 font-bold' : 'text-emerald-400'
      };
    } else {
      return {
        bg: `rgba(244, 63, 94, ${intensity})`,
        border: `rgba(244, 63, 94, ${intensity + 0.15})`,
        text: intensity > 0.5 ? 'text-slate-900 font-bold' : 'text-rose-400'
      };
    }
  };

  // 情緒 Gauge 的弧度計算 (SVG)
  const radius = 55;
  const circumference = 2 * Math.PI * radius;
  const halfCircumference = circumference / 2;
  // 將 0-100 對應至半圓的 strokeDashoffset (從滿弧到空弧)
  const strokeDashoffset = halfCircumference - (sentimentValue / 100) * halfCircumference;

  return (
    <div className="cyber-card rounded-none p-4 flex flex-col flex-1 gap-3">
      {/* 標題與分頁切換 */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-4 bg-emerald-400 rounded-sm shadow-[0_0_8px_#34d399]"></div>
          <h2 className="text-base font-bold text-white tracking-wider font-mono">市場監控中心</h2>
        </div>
        <div className="flex bg-slate-950/60 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('SENTIMENT')}
            className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold transition-all ${
              activeTab === 'SENTIMENT'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            情緒指數
          </button>
          <button
            onClick={() => setActiveTab('HEATMAP')}
            className={`px-2.5 py-1 rounded-md text-xs font-mono font-bold transition-all ${
              activeTab === 'HEATMAP'
                ? 'bg-slate-800 text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            板塊熱力
          </button>
        </div>
      </div>

      {/* 1. 多空情緒儀表板 */}
      {activeTab === 'SENTIMENT' && (
        <div className="flex-1 flex flex-col justify-center items-center py-3">
          <div className="relative w-44 h-28 flex items-center justify-center">
            {/* SVG 半圓形 Gauge */}
            <svg width="180" height="110" className="overflow-visible rotate-180">
              <defs>
                <linearGradient id="gauge-grad" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#f43f5e" />   {/* Rose */}
                  <stop offset="50%" stopColor="#eab308" />  {/* Yellow */}
                  <stop offset="100%" stopColor="#10b981" /> {/* Emerald */}
                </linearGradient>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
                  <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                  </feMerge>
                </filter>
              </defs>
              {/* 底色圓弧 */}
              <path
                d="M 25 100 A 65 65 0 0 1 155 100"
                fill="none"
                stroke="#1e293b"
                strokeWidth="10"
                strokeLinecap="round"
              />
              {/* 進度條圓弧 */}
              <circle
                cx="90"
                cy="100"
                r={radius}
                fill="none"
                stroke="url(#gauge-grad)"
                strokeWidth="10"
                strokeDasharray={`${halfCircumference} ${halfCircumference}`}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                transform="rotate(180 90 100)"
                style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1)' }}
                filter="url(#glow)"
              />
            </svg>
            
            {/* 情緒指標文字 (置中偏下) */}
            <div className="absolute bottom-1 text-center flex flex-col items-center">
              <span className="text-3xl font-extrabold font-mono text-white tracking-tighter">
                {sentimentValue}
              </span>
              <span className={`text-xs font-mono font-bold uppercase tracking-wider ${sentiment.color}`}>
                {sentiment.text}
              </span>
            </div>
          </div>

          <div className="w-full bg-slate-950/50 border border-slate-900 rounded-lg p-2.5 mt-2 text-xs font-mono text-slate-400">
            <div className="flex justify-between mb-1.5 text-xs text-slate-500">
              <span>0 (極度恐懼)</span>
              <span>50 (中立)</span>
              <span>100 (極度貪婪)</span>
            </div>
            <div className="h-1 bg-slate-800 rounded overflow-hidden flex">
              <div 
                className="h-full bg-gradient-to-r from-rose-500 via-amber-500 to-emerald-400"
                style={{ width: `${sentimentValue}%`, transition: 'width 1s ease-in-out' }}
              ></div>
            </div>
            <div className="mt-2.5 text-center leading-normal">
              🤖 <span className="text-slate-300 font-bold">AI 綜合解析：</span>
              {sentimentValue > 60 
                ? '市場資金湧入，情緒偏向貪婪。技術面呈強勢順勢做多格局，但須防高位震盪。' 
                : sentimentValue < 40 
                  ? '市場避險情緒升溫，賣壓沉重。AI 建議適度增加現金比例，等待底部信號。'
                  : '市場處於橫盤整理，缺乏明確方向。多空拉鋸，適合進行區間布林策略。'}
            </div>
          </div>
        </div>
      )}

      {/* 2. 產業板塊熱力圖 (Finviz Treemap) */}
      {activeTab === 'HEATMAP' && (
        <div className="flex-1 flex flex-col gap-2 overflow-y-auto max-h-[300px] pr-1">
          {sectors.map((sec, sIdx) => (
            <div key={sec.sector} className="flex flex-col gap-1 border-b border-slate-800/40 pb-2 mb-2 last:border-0 last:mb-0 last:pb-0">
              <div className="text-xs text-slate-500 font-mono font-bold tracking-wider uppercase mb-1">
                {sec.sector}
              </div>
              
              {/* 板塊網格 (RWD Flex/Grid) */}
              <div className="flex flex-wrap gap-1">
                {sec.items.map((item) => {
                  const style = getItemStyle(item.changePercent);
                  // 計算方塊的相對大小 (以 value 做寬度比重)
                  const baseWidth = Math.max(12, Math.min(30, item.value * 8));
                  
                  return (
                    <button
                      key={item.id}
                      onClick={() => onSelectStock(item.id)}
                      style={{ 
                        backgroundColor: style.bg,
                        borderColor: style.border,
                        flexGrow: item.value,
                        minWidth: `${baseWidth}%`
                      }}
                      className={`h-11 border rounded p-1.5 flex flex-col justify-between items-center text-center cursor-pointer transition-all hover:scale-[1.03] hover:shadow-[0_0_8px_rgba(255,255,255,0.1)] group`}
                    >
                      <span className={`text-xs font-mono font-bold tracking-tight ${style.text} group-hover:text-white transition-colors`}>
                        {item.name}
                      </span>
                      <span className={`text-[9px] font-mono leading-none ${style.text} group-hover:text-white/90`}>
                        {item.changePercent >= 0 ? '+' : ''}{item.changePercent.toFixed(2)}%
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="text-xs text-slate-600 font-mono text-center mt-1">
            * 點擊股票代碼可直接切換中央主 K 線圖
          </div>
        </div>
      )}
    </div>
  );
}
