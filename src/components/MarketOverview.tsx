'use client';

import React from 'react';
import { MarketIndex } from '../types';

interface MarketOverviewProps {
  indices: MarketIndex[];
  isUSStyle: boolean;
}

export default function MarketOverview({ indices, isUSStyle }: MarketOverviewProps) {
  // 依據美股/台股配色風格獲取顏色 class
  const getColorClass = (changePercent: number) => {
    const isPositive = changePercent >= 0;
    if (isUSStyle) {
      return isPositive ? 'text-emerald-400 font-semibold' : 'text-rose-500 font-semibold';
    } else {
      return isPositive ? 'text-rose-500 font-semibold' : 'text-emerald-400 font-semibold';
    }
  };

  const getColorHex = (changePercent: number) => {
    const isPositive = changePercent >= 0;
    if (isUSStyle) {
      return isPositive ? '#10b981' : '#f43f5e';
    } else {
      return isPositive ? '#f43f5e' : '#10b981';
    }
  };

  // 繪製 SVG Sparkline
  const renderSparkline = (points: number[], changePercent: number) => {
    if (!points || points.length === 0) return null;
    
    const width = 100;
    const height = 30;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min === 0 ? 1 : max - min;
    
    // 將數據點轉換為 SVG 座標
    const coords = points.map((p, index) => {
      const x = (index / (points.length - 1)) * width;
      const y = height - ((p - min) / range) * height * 0.8 - height * 0.1; // 上下留白 10%
      return `${x},${y}`;
    }).join(' ');

    const strokeColor = getColorHex(changePercent);

    return (
      <svg width={width} height={height} className="overflow-visible">
        <defs>
          <linearGradient id={`grad-${changePercent}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.3" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* 漸變填充區域 */}
        <polygon
          points={`0,${height} ${coords} ${width},${height}`}
          fill={`url(#grad-${changePercent})`}
        />
        {/* 走勢線 */}
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.5"
          points={coords}
          style={{ filter: `drop-shadow(0px 0px 2px ${strokeColor})` }}
        />
      </svg>
    );
  };

  return (
    <div className="w-full bg-slate-900/90 border-b border-slate-800/80 backdrop-blur-md overflow-hidden relative cyber-header-glow">
      <div className="scanline"></div>
      
      {/* 跑馬燈外層容器 */}
      <div className="flex select-none">
        {/* 跑馬燈內容複製品以達成無限滾動，這裡重複兩次 */}
        <div className="marquee-content py-1.5 px-3 flex gap-5 whitespace-nowrap min-w-full">
          {indices.map((idx, index) => (
            <div 
              key={`idx-1-${idx.symbol}-${index}`} 
              className="inline-flex items-center gap-3 bg-slate-950/40 border border-slate-800/50 rounded-lg px-3 py-1.5 hover:border-slate-700/60 transition-colors"
            >
              <div className="flex flex-col">
                <span className="text-xs text-slate-400 font-mono tracking-wider">{idx.symbol}</span>
                <span className="text-sm font-bold text-white tracking-tight">{idx.name}</span>
              </div>
              
              <div className="flex flex-col text-right">
                <span className="text-sm font-mono font-bold text-slate-100">
                  {idx.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className={`text-xs font-mono ${getColorClass(idx.changePercent)}`}>
                  {idx.changePercent >= 0 ? '+' : ''}{idx.changePercent.toFixed(2)}%
                </span>
              </div>
              
              <div className="pl-2 flex items-center justify-center">
                {renderSparkline(idx.sparkline, idx.changePercent)}
              </div>
            </div>
          ))}
        </div>

        {/* 跑馬燈內容複製品 2 */}
        <div className="marquee-content py-1.5 px-3 flex gap-5 whitespace-nowrap min-w-full" aria-hidden="true">
          {indices.map((idx, index) => (
            <div 
              key={`idx-2-${idx.symbol}-${index}`} 
              className="inline-flex items-center gap-3 bg-slate-950/40 border border-slate-800/50 rounded-lg px-3 py-1.5 hover:border-slate-700/60 transition-colors"
            >
              <div className="flex flex-col">
                <span className="text-xs text-slate-400 font-mono tracking-wider">{idx.symbol}</span>
                <span className="text-sm font-bold text-white tracking-tight">{idx.name}</span>
              </div>
              
              <div className="flex flex-col text-right">
                <span className="text-sm font-mono font-bold text-slate-100">
                  {idx.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className={`text-xs font-mono ${getColorClass(idx.changePercent)}`}>
                  {idx.changePercent >= 0 ? '+' : ''}{idx.changePercent.toFixed(2)}%
                </span>
              </div>
              
              <div className="pl-2 flex items-center justify-center">
                {renderSparkline(idx.sparkline, idx.changePercent)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
