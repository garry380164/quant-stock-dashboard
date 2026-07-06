'use client';

import React, { useState, useEffect, useRef } from 'react';
import { StockInfo } from '../types';

interface WatchlistLeaderboardProps {
  stocks: StockInfo[];
  onToggleFav: (symbol: string, name?: string, market?: string) => void;
  onSelectStock: (symbol: string) => void;
  selectedSymbol: string;
  isUSStyle: boolean;
}

export default function WatchlistLeaderboard({
  stocks,
  onToggleFav,
  onSelectStock,
  selectedSymbol,
  isUSStyle,
}: WatchlistLeaderboardProps) {
  const [activeTab, setActiveTab] = useState<'WATCHLIST' | 'SCANNER' | 'ALL'>('WATCHLIST');
  const [scannerType, setScannerType] = useState<'VOLUME' | 'BREAKOUT' | 'INSTITUTION'>('VOLUME');

  // Massive (全部美股) 的狀態
  const [massiveStocks, setMassiveStocks] = useState<StockInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMassive, setIsLoadingMassive] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // 依據配色獲得漲跌顏色 class
  const getChangeColorClass = (changePercent: number) => {
    const isPositive = changePercent >= 0;
    if (isUSStyle) {
      return isPositive ? 'text-emerald-400 font-semibold' : 'text-rose-500 font-semibold';
    } else {
      return isPositive ? 'text-rose-500 font-semibold' : 'text-emerald-400 font-semibold';
    }
  };

  const isWaitingForKline = (stock: StockInfo) => !stock.isKlineSynced;

  const formatStockPrice = (stock: StockInfo, requireKline = true) => (
    requireKline && isWaitingForKline(stock)
      ? '-'
      : `$${stock.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
  );

  const formatStockChangePercent = (stock: StockInfo, requireKline = true) => (
    requireKline && isWaitingForKline(stock)
      ? '-'
      : `${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%`
  );

  const getDisplayChangeColorClass = (stock: StockInfo, requireKline = true) => (
    requireKline && isWaitingForKline(stock) ? 'text-slate-500 font-semibold' : getChangeColorClass(stock.changePercent)
  );

  // 獲取自選股清單
  const watchlist = stocks.filter(s => s.isFav);

  // 根據篩選器類型，獲取排行股票
  const getScannerStocks = () => {
    const sorted = [...stocks];
    if (scannerType === 'VOLUME') {
      return sorted.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    } else if (scannerType === 'BREAKOUT') {
      return sorted.sort((a, b) => b.changePercent - a.changePercent);
    } else {
      return sorted.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    }
  };

  // 串接後端 API 拉取所有股票的清單
  const fetchMassiveStocks = async (cursorVal?: string | null, isNewSearch = false) => {
    if (isLoadingMassive) return;
    setIsLoadingMassive(true);
    
    try {
      let url = `http://localhost:8080/api/massive/stocks?limit=30&sort=market_cap`;
      if (cursorVal) {
        url += `&cursor=${encodeURIComponent(cursorVal)}`;
      }
      if (searchQuery.trim() !== '') {
        url += `&search=${encodeURIComponent(searchQuery.trim())}`;
      }
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const results: StockInfo[] = data.results.map((item: any) => ({
          symbol: item.symbol,
          name: item.name,
          price: item.price,
          change: item.change,
          changePercent: item.changePercent,
          high24h: item.high24h,
          low24h: item.low24h,
          volume: item.volume || 0,
          marketCap: item.marketCap,
          market: item.market || 'US',
          isFav: item.isFav
        }));
        
        if (isNewSearch) {
          setMassiveStocks(results);
        } else {
          setMassiveStocks(prev => {
            const existingSymbols = new Set(prev.map(s => s.symbol));
            const filteredResults = results.filter(r => !existingSymbols.has(r.symbol));
            return [...prev, ...filteredResults];
          });
        }
        setNextCursor(data.next_cursor);
      }
    } catch (err) {
      console.error('❌ Error fetching massive stocks:', err);
    } finally {
      setIsLoadingMassive(false);
    }
  };

  // 當切換到 ALL 且清單為空時，進行第一次載入
  useEffect(() => {
    if (activeTab === 'ALL' && massiveStocks.length === 0) {
      fetchMassiveStocks(null, true);
    }
  }, [activeTab]);

  // Debounce 搜尋輸入
  useEffect(() => {
    if (activeTab !== 'ALL') return;
    const timer = setTimeout(() => {
      fetchMassiveStocks(null, true);
    }, 450);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 當父層 stocks (自選/價格) 更新時，同步更新全部股票列表中對應股票的價格與 Fav 狀態
  useEffect(() => {
    if (massiveStocks.length === 0) return;
    setMassiveStocks(prev => prev.map(mStock => {
      const matched = stocks.find(s => s.symbol === mStock.symbol);
      if (matched) {
        return {
          ...mStock,
          price: matched.price,
          change: matched.change,
          changePercent: matched.changePercent,
          high24h: matched.high24h,
          low24h: matched.low24h,
          isFav: matched.isFav
        };
      }
      return mStock;
    }));
  }, [stocks]);

  // 處理滾動到底部時載入更多 (Infinite Scroll)
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (activeTab !== 'ALL') return;
    const target = e.currentTarget;
    // 剩餘可滾動距離小於 30px 時，載入下一頁
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 30) {
      if (!isLoadingMassive && nextCursor) {
        fetchMassiveStocks(nextCursor, false);
      }
    }
  };

  return (
    <div className="cyber-card rounded-none p-4 flex flex-col flex-1 min-h-0 gap-3">
      {/* 頂部切換 Tab */}
      <div className="flex border-b border-slate-800/80 pb-2 gap-1">
        <button
          onClick={() => setActiveTab('WATCHLIST')}
          className={`flex-1 text-center py-1.5 text-sm font-mono font-bold tracking-wider relative transition-colors ${
            activeTab === 'WATCHLIST' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          自選觀察
          {activeTab === 'WATCHLIST' && (
            <div className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_6px_#22d3ee]"></div>
          )}
        </button>
        <button
          onClick={() => setActiveTab('SCANNER')}
          className={`flex-1 text-center py-1.5 text-sm font-mono font-bold tracking-wider relative transition-colors ${
            activeTab === 'SCANNER' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          AI 篩選器
          {activeTab === 'SCANNER' && (
            <div className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_6px_#22d3ee]"></div>
          )}
        </button>
        <button
          onClick={() => setActiveTab('ALL')}
          className={`flex-1 text-center py-1.5 text-sm font-mono font-bold tracking-wider relative transition-colors ${
            activeTab === 'ALL' ? 'text-white' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          全部
          {activeTab === 'ALL' && (
            <div className="absolute bottom-[-9px] left-0 right-0 h-0.5 bg-cyan-400 shadow-[0_0_6px_#22d3ee]"></div>
          )}
        </button>
      </div>

      {/* Tab 1: 自選觀察清單 */}
      {activeTab === 'WATCHLIST' && (
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 pr-1">
          {watchlist.length === 0 ? (
            <div className="text-slate-500 text-center py-12 text-xs font-mono">
              清單空空如也，點擊排行或「全部」中的 ★ 將股票加入自選。
            </div>
          ) : (
            watchlist.map((stock) => {
              const isSelected = selectedSymbol === stock.symbol;
              
              return (
                <div
                  key={stock.symbol}
                  onClick={() => onSelectStock(stock.symbol)}
                  className={`flex items-center justify-between px-2.5 py-2 min-h-12 rounded-lg cursor-pointer transition-colors border ${
                    isSelected
                      ? 'bg-cyan-950/20 border-cyan-500/50'
                      : 'bg-slate-950/20 border-transparent hover:bg-slate-950/45 hover:border-slate-800/60'
                  }`}
                >
                  <div className="flex items-center justify-between min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFav(stock.symbol, stock.name, stock.market);
                        }}
                        className="text-amber-400 hover:scale-110 transition-transform cursor-pointer"
                      >
                        ★
                      </button>
                      <div className="min-w-0 flex items-baseline gap-2">
                        <span className="text-sm font-bold text-white font-mono shrink-0">{stock.symbol}</span>
                        <span className="text-xs text-slate-500 truncate" title={stock.name}>{stock.name}</span>
                      </div>
                    </div>

                    <div className="text-right flex items-baseline gap-2 shrink-0">
                      <span className="text-sm font-mono font-bold text-slate-100">
                        {formatStockPrice(stock)}
                      </span>
                      <span className={`text-xs font-mono min-w-14 ${getDisplayChangeColorClass(stock)}`}>
                        {formatStockChangePercent(stock)}
                      </span>
                    </div>
                  </div>

                </div>
              );
            })
          )}
        </div>
      )}

      {/* Tab 2: AI 智慧篩選器 (Smart Scanner) */}
      {activeTab === 'SCANNER' && (
        <div className="flex-1 min-h-0 flex flex-col gap-2.5">
          {/* 排行篩選切換標籤 */}
          <div className="flex bg-slate-950 p-0.5 rounded-lg border border-slate-800/80">
            <button
              onClick={() => setScannerType('VOLUME')}
              className={`flex-1 py-1.5 rounded-md text-sm font-mono font-bold transition-all ${
                scannerType === 'VOLUME' ? 'bg-slate-800 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              量能暴增
            </button>
            <button
              onClick={() => setScannerType('BREAKOUT')}
              className={`flex-1 py-1.5 rounded-md text-sm font-mono font-bold transition-all ${
                scannerType === 'BREAKOUT' ? 'bg-slate-800 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              強勢突破
            </button>
            <button
              onClick={() => setScannerType('INSTITUTION')}
              className={`flex-1 py-1.5 rounded-md text-sm font-mono font-bold transition-all ${
                scannerType === 'INSTITUTION' ? 'bg-slate-800 text-cyan-300' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              法人連買
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 pr-1">
            {getScannerStocks().map((stock, index) => {
              const isSelected = selectedSymbol === stock.symbol;
              return (
                <div
                  key={`scanner-${stock.symbol}`}
                  onClick={() => onSelectStock(stock.symbol)}
                  className={`flex items-center justify-between px-2.5 py-2 min-h-12 rounded-lg cursor-pointer transition-colors border ${
                    isSelected
                      ? 'bg-cyan-950/20 border-cyan-500/50'
                      : 'bg-slate-950/20 border-transparent hover:bg-slate-950/45 hover:border-slate-800/60'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="hidden text-sm font-mono text-slate-500 w-5 text-center">
                      {index + 1}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFav(stock.symbol, stock.name, stock.market);
                      }}
                      className="text-slate-500 hover:text-amber-400 hover:scale-110 transition-colors cursor-pointer"
                    >
                      {stock.isFav ? <span className="text-amber-400">★</span> : '☆'}
                    </button>
                    <div className="min-w-0 flex items-baseline gap-2">
                      <span className="text-sm font-bold text-white font-mono shrink-0">{stock.symbol}</span>
                      <span className="text-xs text-slate-500 truncate" title={stock.name}>{stock.name}</span>
                    </div>
                  </div>

                  <div className="text-right flex items-baseline gap-2 shrink-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-mono font-bold text-slate-100">{formatStockPrice(stock)}</span>
                      <span className={`text-xs font-mono min-w-14 ${getDisplayChangeColorClass(stock)}`}>
                        {formatStockChangePercent(stock)}
                      </span>
                    </div>
                    <div className="hidden w-16 text-center py-1.5 rounded bg-slate-900 border border-slate-800/40 text-sm font-mono text-cyan-400">
                      {scannerType === 'VOLUME' && `${stock.volume}M`}
                      {scannerType === 'BREAKOUT' && `突破`}
                      {scannerType === 'INSTITUTION' && `+${Math.round((stock.volume || 0) * 0.15)}K`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab 3: 全部美股 (Massive API + Infinite Scroll) */}
      {activeTab === 'ALL' && (
        <div className="flex-1 min-h-0 flex flex-col gap-2.5">
          {/* 搜尋輸入框 */}
          <div className="relative">
            <input
              type="text"
              placeholder="搜尋美股代號/名稱..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg py-1.5 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/80 transition-colors font-mono"
            />
            <svg className="w-4 h-4 absolute left-3 top-2 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1.5 text-slate-500 hover:text-white text-xs font-bold"
              >
                ✕
              </button>
            )}
          </div>

          {/* 列表內容 - 支援滾動偵測 */}
          <div
            onScroll={handleScroll}
            className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5 pr-1"
          >
            {massiveStocks.length === 0 && !isLoadingMassive ? (
              <div className="text-slate-500 text-center py-12 text-xs font-mono">
                未找到匹配的股票。
              </div>
            ) : (
              massiveStocks.map((stock) => {
                const isSelected = selectedSymbol === stock.symbol;
                return (
                  <div
                    key={`massive-${stock.symbol}`}
                    onClick={() => onSelectStock(stock.symbol)}
                    className={`flex items-center justify-between px-2.5 py-2 min-h-12 rounded-lg cursor-pointer transition-colors border ${
                      isSelected
                        ? 'bg-cyan-950/20 border-cyan-500/50'
                        : 'bg-slate-950/20 border-transparent hover:bg-slate-950/45 hover:border-slate-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFav(stock.symbol, stock.name, stock.market);
                        }}
                        className="text-slate-500 hover:text-amber-400 hover:scale-110 transition-colors cursor-pointer"
                      >
                        {stock.isFav ? <span className="text-amber-400">★</span> : '☆'}
                      </button>
                      <div className="min-w-0 flex items-baseline gap-2">
                        <span className="text-sm font-bold text-white font-mono shrink-0">{stock.symbol}</span>
                        <span className="text-xs text-slate-500 truncate" title={stock.name}>
                          {stock.name}
                        </span>
                      </div>
                    </div>

                    <div className="text-right flex items-baseline gap-2 shrink-0">
                      <span className="text-sm font-mono font-bold text-slate-100">{formatStockPrice(stock, false)}</span>
                      <span className={`text-xs font-mono min-w-14 ${getDisplayChangeColorClass(stock, false)}`}>
                        {formatStockChangePercent(stock, false)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}

            {/* 載入指示器 / 觸發加載下一頁的元素 */}
            {isLoadingMassive && (
              <div className="text-center py-3 text-xs font-mono text-cyan-400 flex items-center justify-center gap-2">
                <svg className="animate-spin h-3.5 w-3.5 text-cyan-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                獲取資料中...
              </div>
            )}

            {!isLoadingMassive && nextCursor && (
              <div className="text-slate-600 text-center py-2 text-[10px] font-mono">
                向下滾動載入更多美股
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
