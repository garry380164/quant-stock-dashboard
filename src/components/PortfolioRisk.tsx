'use client';

import React, { useState } from 'react';
import { PortfolioAsset, RiskStatus } from '../types';

interface PortfolioRiskProps {
  portfolio: PortfolioAsset[];
  riskStatus: RiskStatus;
}

export default function PortfolioRisk({ portfolio, riskStatus }: PortfolioRiskProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // 計算總資產價值
  const totalValue = portfolio.reduce((sum, item) => sum + item.value, 0);

  // SVG 甜甜圈圖數據與路徑計算
  const size = 150;
  const radius = 50;
  const strokeWidth = 14;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;

  // 累積權重以計算 DashOffset
  let accumulatedPercent = 0;

  // 獲取風險等級顏色
  const getRiskColor = (status: string) => {
    switch (status) {
      case 'HIGH':
        return {
          bg: 'bg-rose-950/20 border-rose-500/40 text-rose-400',
          indicator: 'bg-rose-500 shadow-[0_0_10px_#f43f5e] animate-pulse',
          badge: 'bg-rose-950 border-rose-800 text-rose-400'
        };
      case 'MEDIUM':
        return {
          bg: 'bg-amber-950/20 border-amber-500/40 text-amber-400',
          indicator: 'bg-amber-500 shadow-[0_0_10px_#f59e0b]',
          badge: 'bg-amber-950 border-amber-800 text-amber-400'
        };
      default:
        return {
          bg: 'bg-emerald-950/20 border-emerald-500/40 text-emerald-400',
          indicator: 'bg-emerald-500 shadow-[0_0_10px_#10b981]',
          badge: 'bg-emerald-950 border-emerald-800 text-emerald-400'
        };
    }
  };

  const rColor = getRiskColor(riskStatus.status);

  return (
    <div className="cyber-card rounded-none p-4 flex flex-col flex-1 gap-3">
      {/* 標題 */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-2 h-4 bg-amber-400 rounded-sm shadow-[0_0_8px_#f59e0b]"></div>
          <h2 className="text-base font-bold text-white tracking-wider font-mono">資產配置與風險監控</h2>
        </div>
        <span className="text-xs font-mono text-slate-400">模擬帳戶</span>
      </div>

      {/* RWD 佈局: 甜甜圈圖與圖例 */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-4 py-1.5">
        {/* SVG Donut Chart */}
        <div className="relative w-[150px] h-[150px] flex items-center justify-center">
          <svg width={size} height={size} className="transform -rotate-90 overflow-visible">
            {/* 底環 */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              fill="transparent"
              stroke="#1e293b"
              strokeWidth={strokeWidth}
            />
            {/* 數據環段 */}
            {portfolio.map((item, idx) => {
              const strokeDasharray = `${(item.weight / 100) * circumference} ${circumference}`;
              const strokeDashoffset = -((accumulatedPercent / 100) * circumference);
              accumulatedPercent += item.weight;
              
              const isHovered = hoveredIdx === idx;

              return (
                <circle
                  key={item.symbol}
                  cx={center}
                  cy={center}
                  r={radius}
                  fill="transparent"
                  stroke={item.color}
                  strokeWidth={isHovered ? strokeWidth + 4 : strokeWidth}
                  strokeDasharray={strokeDasharray}
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  className="transition-all duration-300 cursor-pointer"
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  style={{
                    filter: isHovered ? `drop-shadow(0px 0px 4px ${item.color})` : 'none',
                  }}
                />
              );
            })}
          </svg>
          
          {/* 中間顯示選定/懸停的資產資訊 */}
          <div className="absolute text-center flex flex-col justify-center items-center pointer-events-none">
            {hoveredIdx !== null ? (
              <>
                <span className="text-xs font-bold text-slate-400 font-mono">
                  {portfolio[hoveredIdx].symbol}
                </span>
                <span className="text-lg font-extrabold font-mono text-white leading-none mt-0.5">
                  {portfolio[hoveredIdx].weight}%
                </span>
              </>
            ) : (
              <>
                <span className="text-[10px] text-slate-500 font-bold tracking-wide uppercase">總市值</span>
                <span className="text-xs font-extrabold font-mono text-slate-200 mt-0.5">
                  ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
              </>
            )}
          </div>
        </div>

        {/* 圖例 */}
        <div className="flex-1 w-full flex flex-col gap-1.5 justify-center">
          {portfolio.map((item, idx) => (
            <div 
              key={item.symbol} 
              className={`flex items-center justify-between text-xs font-mono p-1 rounded transition-colors ${
                hoveredIdx === idx ? 'bg-slate-800/40' : ''
              }`}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                <span className="font-bold text-slate-300">{item.symbol}</span>
                <span className="text-[10px] text-slate-500">x{item.shares}</span>
              </div>
              <div className="text-right flex items-center gap-2">
                <span className="text-slate-400">${item.currentPrice}</span>
                <span className="text-white font-bold w-10 text-right">{item.weight}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 風險監控指標與風控警示燈 */}
      <div className="border-t border-slate-800/80 pt-3 flex flex-col gap-3">
        <div className="flex justify-between items-center text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${rColor.indicator}`} />
            <span className="text-slate-400 font-bold">風控狀態:</span>
            <span className="text-white font-bold">{riskStatus.status} RISK</span>
          </div>
          <div className="flex gap-4">
            <div>
              <span className="text-slate-500">組合 Beta:</span>{' '}
              <span className="text-cyan-400 font-bold">{riskStatus.portfolioBeta}</span>
            </div>
            <div>
              <span className="text-slate-500">曝險度:</span>{' '}
              <span className="text-amber-400 font-bold">{riskStatus.riskExposure}%</span>
            </div>
          </div>
        </div>

        {/* AI 風控分析提示框 */}
        <div className={`border rounded-lg p-2.5 text-xs leading-relaxed transition-all ${rColor.bg}`}>
          <div className="flex gap-2 items-start">
            <span className="text-sm">🛡️</span>
            <div>
              <span className="font-bold block mb-0.5">AI 風控助理即時提示：</span>
              <span>{riskStatus.alertMessage}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
