'use client';

import React, { forwardRef, useEffect, useRef, useImperativeHandle, useState } from 'react';
import { format } from 'date-fns';
import { CoordinateSystem } from './CoordinateSystem';
import { RenderEngine, calculateLayout } from './RenderEngine';
import { InteractionHandler } from './InteractionHandler';

const buildDisplayData = (rawData) => (
    [...(rawData || [])]
        .filter((bar) => bar && Number.isFinite(Number(bar.timestamp)))
        .sort((a, b) => a.timestamp - b.timestamp)
);

const cloneDrawings = (drawings) => {
    if (!Array.isArray(drawings)) return [];
    return drawings.map((drawing) => JSON.parse(JSON.stringify(drawing)));
};

const CustomKLineChart = forwardRef(({
    data = [],
    symbol = '',
    timeframe = '1h',
    height = 600,
    pricePrecision = 2,
    trades = [],
    equityData = [],
    indicators = {},
    lifecycleEvents = [],
    showVolume = true,
    showEquity = false,
    showPosition = false,
    onVisibleRangeChanged = null,
    onCrosshairMoved = null,
    drawings = [],
    drawingsKey = symbol,
    onDrawingsChange = null,
    loading = false
}, ref) => {
    const containerHeight = typeof height === 'number' ? `${height}px` : height;
    const containerRef = useRef(null);
    const canvasDataRef = useRef(null);
    const canvasInterRef = useRef(null);

    const [activeTool, setActiveTool] = useState('cursor');
    const [hoveredTool, setHoveredTool] = useState(null);
    const [isTrashHovered, setIsTrashHovered] = useState(false);

    // Selected drawing state for floating settings toolbar
    const [focusedDrawingIndex, setFocusedDrawingIndex] = useState(null);
    const [focusedDrawingPos, setFocusedDrawingPos] = useState(null);
    const [showStylePicker, setShowStylePicker] = useState(false);
    const focusedDrawingIndexRef = useRef(null);
    focusedDrawingIndexRef.current = focusedDrawingIndex;

    // Imperative state stored in refs to bypass React rerender latency
    const dataListRef = useRef([...data]);
    const startIndexRef = useRef(0);
    const endIndexRef = useRef(0);
    const barWidthRef = useRef(6);
    const rightOffsetRef = useRef(80);
    
    // Sync React props into mutable refs to avoid stale closures in InteractionHandler callbacks
    const indicatorsRef = useRef(indicators);
    const tradesRef = useRef(trades);
    const lifecycleEventsRef = useRef(lifecycleEvents);
    const showVolumeRef = useRef(showVolume);
    const showEquityRef = useRef(showEquity);
    const showPositionRef = useRef(showPosition);
    const timeframeRef = useRef(timeframe);
    const onVisibleRangeChangedRef = useRef(onVisibleRangeChanged);
    const onDrawingsChangeRef = useRef(onDrawingsChange);
    const customHeightsRef = useRef({});
    const pricePrecisionRef = useRef(pricePrecision);
    
    // Drawing states
    const activeToolRef = useRef(activeTool);
    const drawingsRef = useRef([]);
    const activeDrawingRef = useRef(null);
    const lastNotifiedDrawingsRef = useRef('');
    const drawingsKeyRef = useRef(drawingsKey);
    const persistentCrosshairRef = useRef({ x: 0, y: 0, active: false });

    const notifyDrawingsChange = () => {
        if (onDrawingsChangeRef.current) {
            const nextDrawings = cloneDrawings(drawingsRef.current);
            lastNotifiedDrawingsRef.current = JSON.stringify(nextDrawings);
            onDrawingsChangeRef.current(nextDrawings);
        }
    };

    // Synchronize reactive props with refs on every render to prevent closure lag
    useEffect(() => {
        indicatorsRef.current = indicators;
        tradesRef.current = trades;
        lifecycleEventsRef.current = lifecycleEvents;
        showVolumeRef.current = showVolume;
        showEquityRef.current = showEquity;
        showPositionRef.current = showPosition;
        timeframeRef.current = timeframe;
        onVisibleRangeChangedRef.current = onVisibleRangeChanged;
        onDrawingsChangeRef.current = onDrawingsChange;
        pricePrecisionRef.current = pricePrecision;
        activeToolRef.current = activeTool;
    });
    
    // Engine and Handlers
    const coordRef = useRef(new CoordinateSystem());
    const engineRef = useRef(null);
    const interactionRef = useRef(null);
    const layoutInfoRef = useRef(null);
    const resizeRafRef = useRef(null);
    const lastResizeSizeRef = useRef({ width: 0, height: 0 });

    // UI State for Legend (so React can display it overlayed on top)
    const [legendInfo, setLegendInfo] = useState(null);
    const [isPinned, setIsPinned] = useState(true);
    const isPinnedRef = useRef(true);
    const hoveredCandleRef = useRef(null);
    const [isBtnHovered, setIsBtnHovered] = useState(false);
    const [, setIndicatorStyleOverrides] = useState({});
    const indicatorStyleOverridesRef = useRef({});
    const [openIndicatorMenu, setOpenIndicatorMenu] = useState(null);
    const [styleIndicatorName, setStyleIndicatorName] = useState(null);
    const openIndicatorMenuRef = useRef(null);

    const indicatorPresetColors = [
        '#00b2ff', '#06b6d4', '#089981', '#22c55e',
        '#f59e0b', '#f97316', '#ec4899', '#ef4444',
        '#a855f7', '#ffffff', '#94a3b8', '#64748b'
    ];
    const indicatorLineWidths = [1, 1.5, 2, 3, 4];

    const getStyledIndicators = (source = indicatorsRef.current) => {
        if (!source) return source;
        const overrides = indicatorStyleOverridesRef.current || {};
        return Object.fromEntries(
            Object.entries(source).map(([name, config]) => [
                name,
                {
                    ...config,
                    ...(overrides[name] || {})
                }
            ])
        );
    };

    const refreshLegendInfo = () => {
        if (hoveredCandleRef.current) {
            setLegendInfo(getLegendInfoForCandle(hoveredCandleRef.current));
            return;
        }

        if (isPinnedRef.current) {
            const dataList = dataListRef.current;
            const lastCandle = getLatestVisibleCandle(dataList);
            setLegendInfo(lastCandle ? getLegendInfoForCandle(lastCandle) : null);
        }
    };

    const updateIndicatorStyle = (name, patch) => {
        const nextOverrides = {
            ...indicatorStyleOverridesRef.current,
            [name]: {
                ...(indicatorStyleOverridesRef.current[name] || {}),
                ...patch
            }
        };
        indicatorStyleOverridesRef.current = nextOverrides;
        setIndicatorStyleOverrides(nextOverrides);
        requestRender();
        refreshLegendInfo();
    };

    useEffect(() => {
        if (!openIndicatorMenu) return undefined;

        const handlePointerDown = (event) => {
            const menuRoot = openIndicatorMenuRef.current;
            if (menuRoot && menuRoot.contains(event.target)) return;

            setOpenIndicatorMenu(null);
            setStyleIndicatorName(null);
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
        };
    }, [openIndicatorMenu]);

    // Format legend data for a specific candle
    const getLegendInfoForCandle = (candle) => {
        if (!candle) return null;
        if (candle.isHidden) {
            return {
                time: format(new Date(candle.timestamp), 'yyyy-MM-dd HH:mm'),
                isEmpty: true,
            };
        }
        const legend = {
            time: format(new Date(candle.timestamp), 'yyyy-MM-dd HH:mm'),
            open: candle.open.toFixed(pricePrecisionRef.current),
            high: candle.high.toFixed(pricePrecisionRef.current),
            low: candle.low.toFixed(pricePrecisionRef.current),
            close: candle.close.toFixed(pricePrecisionRef.current),
            volume: candle.volume?.toFixed(0) || '0',
            isUp: candle.close >= candle.open,
            change: (candle.close - candle.open).toFixed(pricePrecisionRef.current),
            changePercent: ((candle.close - candle.open) / candle.open * 100).toFixed(2)
        };

        const currentIndicators = getStyledIndicators();
        if (currentIndicators) {
            legend.inds = {};
            Object.entries(currentIndicators).forEach(([name, config]) => {
                if (config.showInLegend === false) return;

                const item = config.data?.find(it => {
                    const timeMs = typeof it.time === 'number' ? it.time : new Date(it.time).getTime();
                    return timeMs === candle.timestamp;
                });
                if (item && item.value !== undefined && item.value !== null) {
                    legend.inds[name] = {
                        value: typeof item.value === 'number' ? item.value.toFixed(pricePrecisionRef.current) : String(item.value),
                        color: config.color,
                        lineWidth: config.lineWidth || 1.5
                    };
                } else if (item) {
                    legend.inds[name] = {
                        value: 'N/A',
                        color: config.color,
                        lineWidth: config.lineWidth || 1.5
                    };
                }
            });
        }
        return legend;
    };

    const getLatestVisibleCandle = (dataList) => {
        for (let i = dataList.length - 1; i >= 0; i--) {
            if (!dataList[i]?.isHidden) return dataList[i];
        }
        return null;
    };

    const isLatestCandlePinned = (dataLength) => {
        if (!dataLength || !canvasDataRef.current) return false;

        const width = canvasDataRef.current.width / window.devicePixelRatio;
        const step = barWidthRef.current + Math.max(0.01, barWidthRef.current * 0.15);
        const latestIndex = dataLength - 1;
        const latestX = width
            - (rightOffsetRef.current || 80)
            - (endIndexRef.current - latestIndex) * step
            - (barWidthRef.current / 2);
        const pinnedX = width - (rightOffsetRef.current || 80) - (barWidthRef.current / 2);

        return Math.abs(latestX - pinnedX) <= step / 2;
    };

    // Update legend info when no hover is active under Pinned mode
    const updateDefaultLegend = () => {
        if (isPinnedRef.current && !hoveredCandleRef.current) {
            const dataList = dataListRef.current;
            if (dataList && dataList.length > 0) {
                const lastCandle = getLatestVisibleCandle(dataList);
                const nextLegend = getLegendInfoForCandle(lastCandle);
                
                // Deep comparison using JSON.stringify to avoid redundant state updates and potential infinite render loops
                if (JSON.stringify(nextLegend) !== JSON.stringify(legendInfo)) {
                    setLegendInfo(nextLegend);
                }
            } else {
                if (legendInfo !== null) {
                    setLegendInfo(null);
                }
            }
        }
    };

    // Helper to update dataset and preserve the visual focus range/zoom level
    const updateDataListAndMaintainView = (newData) => {
        const oldData = dataListRef.current;
        const oldLen = oldData.length;
        const sortedNewData = buildDisplayData(newData);
        const newLen = sortedNewData.length;

        let initialized = false;

        if (oldLen > 0 && newLen > 0 && endIndexRef.current !== 0) {
            const prevStartIdx = Math.max(0, Math.min(oldLen - 1, startIndexRef.current));
            const prevStartTs = oldData[prevStartIdx]?.timestamp;

            // Determine if the chart was previously scrolled to the rightmost boundary
            const step = barWidthRef.current + Math.max(0.01, barWidthRef.current * 0.15);
            const rightOffset = rightOffsetRef.current || 80;
            const isAtRightEdge = isLatestCandlePinned(oldLen);

            dataListRef.current = sortedNewData;

            if (isAtRightEdge) {
                // If it was at the rightmost edge, pin it to the new rightmost edge, preserving zoom level
                const width = canvasDataRef.current ? (canvasDataRef.current.width / window.devicePixelRatio) : 800;
                
                // Align the last candle to the right with offset
                endIndexRef.current = Math.max(newLen - 1, Math.round((width - rightOffset - barWidthRef.current / 2) / step));
                const visibleBarsCount = Math.ceil((width - rightOffset) / step);
                startIndexRef.current = Math.max(0, endIndexRef.current - visibleBarsCount);
            } else {
                // If the user scrolled back, keep the visual position matching the timestamp
                const matchIdx = sortedNewData.findIndex(d => d.timestamp === prevStartTs);
                if (matchIdx !== -1) {
                    const diff = matchIdx - prevStartIdx;
                    startIndexRef.current += diff;
                    endIndexRef.current += diff;
                    
                    if (interactionRef.current && diff !== 0) {
                        interactionRef.current.adjustDragStartIndices(diff);
                    }
                } else {
                    const approxIdx = sortedNewData.findIndex(d => d.timestamp >= prevStartTs);
                    if (approxIdx !== -1) {
                        const diff = approxIdx - prevStartIdx;
                        startIndexRef.current += diff;
                        endIndexRef.current += diff;
                        
                        if (interactionRef.current && diff !== 0) {
                            interactionRef.current.adjustDragStartIndices(diff);
                        }
                    } else {
                        // Reset to right edge if previous context is lost
                        const width = canvasDataRef.current ? (canvasDataRef.current.width / window.devicePixelRatio) : 800;
                        endIndexRef.current = Math.max(newLen - 1, Math.round((width - rightOffset - barWidthRef.current / 2) / step));
                        const visibleBarsCount = Math.ceil((width - rightOffset) / step);
                        startIndexRef.current = Math.max(0, endIndexRef.current - visibleBarsCount);
                    }
                }
            }
            initialized = true;
        }

        if (!initialized) {
            dataListRef.current = sortedNewData;
            if (newLen > 0) {
                barWidthRef.current = 6;
                const rightOffset = rightOffsetRef.current || 80;
                const width = canvasDataRef.current ? (canvasDataRef.current.width / window.devicePixelRatio) : 800;
                const step = barWidthRef.current + Math.max(0.01, barWidthRef.current * 0.15);
                const visibleBarsCount = Math.ceil((width - rightOffset) / step);
                
                endIndexRef.current = Math.max(newLen - 1, Math.round((width - rightOffset - barWidthRef.current / 2) / step));
                startIndexRef.current = Math.max(0, endIndexRef.current - visibleBarsCount);
            } else {
                startIndexRef.current = 0;
                endIndexRef.current = 0;
            }
        }

        if (interactionRef.current) {
            interactionRef.current.setDataLength(newLen);
        }
    };

    // 1. Core Render Trigger using requestAnimationFrame
    const requestRender = () => {
        if (!engineRef.current || !layoutInfoRef.current || !canvasDataRef.current) return;
        
        const dataList = dataListRef.current;
        const layouts = layoutInfoRef.current.layouts;
        const chartWidth = layoutInfoRef.current.chartWidth;
        const totalChartHeight = layoutInfoRef.current.totalChartHeight;
        const yAxisWidth = layoutInfoRef.current.yAxisWidth;
        const xAxisHeight = layoutInfoRef.current.xAxisHeight;

        requestAnimationFrame(() => {
            if (!engineRef.current) return;
            
            // Set X axis bounds
            coordRef.current.setXRange(
                canvasDataRef.current.width / window.devicePixelRatio,
                startIndexRef.current,
                endIndexRef.current,
                barWidthRef.current,
                rightOffsetRef.current || 80
            );

            engineRef.current.render({
                layouts,
                dataList,
                startIndex: startIndexRef.current,
                endIndex: endIndexRef.current,
                showVolume: showVolumeRef.current,
                showEquity: showEquityRef.current,
                showPosition: showPositionRef.current,
                indicators: getStyledIndicators(),
                trades: tradesRef.current,
                lifecycleEvents: lifecycleEventsRef.current,
                width: canvasDataRef.current.width / window.devicePixelRatio,
                height: canvasDataRef.current.height / window.devicePixelRatio,
                chartWidth,
                totalChartHeight,
                yAxisWidth,
                xAxisHeight,
                timeframe: timeframeRef.current,
                pricePrecision: pricePrecisionRef.current,
                drawings: drawingsRef.current,
                focusedDrawingIndex: focusedDrawingIndexRef.current
            });
        });
    };

    // 2. Draw Interactive elements (Crosshair)
    const renderInteractive = (mouseX, mouseY) => {
        const canvas = canvasInterRef.current;
        if (!canvas || !layoutInfoRef.current) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const { layouts, chartWidth, totalChartHeight, yAxisWidth, xAxisHeight } = layoutInfoRef.current;

        const isDrawingMode = activeToolRef.current && activeToolRef.current !== 'cursor';
        let targetX = mouseX;
        let targetY = mouseY;

        if (mouseX !== null && mouseY !== null) {
            persistentCrosshairRef.current = { x: mouseX, y: mouseY, active: true };
        } else if (isDrawingMode && persistentCrosshairRef.current.active) {
            targetX = persistentCrosshairRef.current.x;
            targetY = persistentCrosshairRef.current.y;
        }

        // If targetX / targetY are still null, handle exit state
        if (targetX === null || targetY === null) {
            hoveredCandleRef.current = null;
            if (isPinnedRef.current) {
                const dataList = dataListRef.current;
                if (dataList && dataList.length > 0) {
                    const lastCandle = getLatestVisibleCandle(dataList);
                    setLegendInfo(getLegendInfoForCandle(lastCandle));
                } else {
                    setLegendInfo(null);
                }
            } else {
                setLegendInfo(null);
            }

            if (onCrosshairMoved) {
                onCrosshairMoved(null);
            }
            return;
        }

        // Save context and apply DPR scale
        ctx.save();
        ctx.scale(dpr, dpr);

        // Find index matching targetX
        const currentIdx = coordRef.current.xToIndex(targetX);
        const dataList = dataListRef.current;

        if (currentIdx >= 0 && currentIdx < dataList.length) {
            const candle = dataList[currentIdx];
            hoveredCandleRef.current = candle;
            const x = coordRef.current.indexToX(currentIdx);

            // Draw Vertical crosshair line (dashed, full height)
            ctx.strokeStyle = '#555555';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height / dpr);
            ctx.stroke();

            // Draw Horizontal crosshair line (dashed, full width)
            ctx.beginPath();
            ctx.moveTo(0, targetY);
            ctx.lineTo(canvas.width / dpr, targetY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw center circle if in drawing mode (TradingView style)
            if (isDrawingMode) {
                ctx.fillStyle = '#00b2ff';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, targetY, 4.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            }

            // Draw X Axis floating Label
            ctx.fillStyle = '#2b2f3a';
            const labelXW = 100;
            const labelXH = 20;
            ctx.fillRect(x - labelXW / 2, totalChartHeight, labelXW, labelXH);
            
            ctx.strokeStyle = '#8f96a3';
            ctx.strokeRect(x - labelXW / 2, totalChartHeight, labelXW, labelXH);

            ctx.fillStyle = '#f0f3fa';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const date = new Date(candle.timestamp);
            let timeLabel = format(date, 'yyyy-MM-dd HH:mm');
            ctx.fillText(timeLabel, x, totalChartHeight + labelXH / 2);

            // Find which pane targetY is currently hovering
            let activePane = null;
            Object.entries(layouts).forEach(([paneName, layout]) => {
                if (targetY >= layout.yMin && targetY <= layout.yMax) {
                    activePane = paneName;
                }
            });

            // Draw Y Axis floating Label
            if (activePane) {
                const pane = coordRef.current.panes[activePane];
                if (pane) {
                    const value = coordRef.current.yToValue(activePane, targetY);
                    
                    ctx.fillStyle = '#2b2f3a';
                    const labelYW = yAxisWidth - 2;
                    const labelYH = 18;
                    ctx.fillRect(chartWidth, targetY - labelYH / 2, labelYW, labelYH);
                    
                    ctx.strokeStyle = '#8f96a3';
                    ctx.strokeRect(chartWidth, targetY - labelYH / 2, labelYW, labelYH);

                    ctx.fillStyle = '#f0f3fa';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.font = '10px Inter, sans-serif';

                    let priceLabel = '';
                    if (activePane === 'volume') {
                        priceLabel = value.toFixed(0);
                    } else if (activePane === 'position') {
                        priceLabel = value.toFixed(2);
                    } else {
                        priceLabel = value.toFixed(pricePrecisionRef.current);
                    }

                    ctx.fillText(priceLabel, chartWidth + 6, targetY);
                }
            }

            // Set UI Legend overlay info
            setLegendInfo(getLegendInfoForCandle(candle));

            if (onCrosshairMoved) {
                onCrosshairMoved({ candle, index: currentIdx, mouseX: targetX, mouseY: targetY });
            }
        }

        // Draw active drawing preview (if any)
        if (activeDrawingRef.current && mouseX !== null && mouseY !== null) {
            drawActiveDrawingPreview(ctx, mouseX, mouseY);
        }

        ctx.restore();
    };

    const drawActiveDrawingPreview = (ctx, mouseX, mouseY) => {
        const ad = activeDrawingRef.current;
        if (!ad) return;
        
        const dataList = dataListRef.current;
        const timeframe = timeframeRef.current;
        const pricePrecision = pricePrecisionRef.current;
        
        if (ad.type === 'trendline' || ad.type === 'ray' || ad.type === 'measurement') {
            const idx1 = engineRef.current.timestampToIndex(ad.p1.timestamp, dataList, timeframe);
            const x1 = coordRef.current.indexToX(idx1);
            const y1 = coordRef.current.valueToY('main', ad.p1.price);
            
            ctx.save();
            
            if (ad.type === 'trendline') {
                ctx.strokeStyle = '#00b2ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(mouseX, mouseY);
                ctx.stroke();
                
                // Endpoints
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#00b2ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x1, y1, 3.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
                
                ctx.beginPath();
                ctx.arc(mouseX, mouseY, 3.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            } else if (ad.type === 'ray') {
                // Infinite ray projection for preview
                let targetX = mouseX;
                let targetY = mouseY;
                if (mouseX !== x1) {
                    const slope = (mouseY - y1) / (mouseX - x1);
                    const chartWidth = layoutInfoRef.current.chartWidth;
                    if (mouseX > x1) {
                        targetX = chartWidth;
                        targetY = y1 + (chartWidth - x1) * slope;
                    } else {
                        targetX = 0;
                        targetY = y1 + (0 - x1) * slope;
                    }
                } else {
                    targetY = mouseY > y1 ? 2000 : -2000;
                }
                
                ctx.strokeStyle = '#00b2ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(targetX, targetY);
                ctx.stroke();
                
                // Endpoints
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#00b2ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x1, y1, 3.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
                
                ctx.beginPath();
                ctx.arc(mouseX, mouseY, 3.5, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            } else if (ad.type === 'measurement') {
                const currentPrice = coordRef.current.yToValue('main', mouseY);
                const currentIdx = coordRef.current.xToIndex(mouseX);
                
                const priceDiff = currentPrice - ad.p1.price;
                const percentDiff = (priceDiff / ad.p1.price) * 100;
                const barsDiff = Math.abs(currentIdx - idx1);
                
                const isUp = priceDiff >= 0;
                const color = isUp ? '#00EDA0' : '#FF4976';
                const fillColor = isUp ? 'rgba(0, 237, 160, 0.12)' : 'rgba(255, 73, 118, 0.12)';
                
                ctx.fillStyle = fillColor;
                ctx.fillRect(x1, Math.min(y1, mouseY), mouseX - x1, Math.abs(mouseY - y1));
                
                ctx.strokeStyle = color;
                ctx.lineWidth = 1.2;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(x1, Math.min(y1, mouseY), mouseX - x1, Math.abs(mouseY - y1));
                
                ctx.setLineDash([]);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(mouseX, mouseY);
                ctx.stroke();
                
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(x1, y1, 3, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
                
                ctx.beginPath();
                ctx.arc(mouseX, mouseY, 3, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
                
                // Info Label
                const labelX = x1 + (mouseX - x1) / 2;
                const labelY = mouseY - (isUp ? 22 : -18); 
                
                const txtPrice = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(pricePrecision)} (${priceDiff >= 0 ? '+' : ''}${percentDiff.toFixed(2)}%)`;
                const txtBars = `${barsDiff} bars`;
                
                ctx.font = 'bold 10px Inter, sans-serif';
                const textWidth = Math.max(ctx.measureText(txtPrice).width, ctx.measureText(txtBars).width) + 16;
                const boxW = textWidth;
                const boxH = 32;
                const boxX = labelX - boxW / 2;
                const boxY = labelY - boxH / 2;
                
                ctx.fillStyle = 'rgba(20, 23, 31, 0.9)';
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.fillRect(boxX, boxY, boxW, boxH);
                ctx.strokeRect(boxX, boxY, boxW, boxH);
                
                ctx.fillStyle = '#f0f3fa';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(txtPrice, labelX, boxY + 5);
                ctx.fillStyle = '#8f96a3';
                ctx.fillText(txtBars, labelX, boxY + 18);
            }
            
            ctx.restore();
        } else if (ad.type === 'polyline') {
            if (!ad.points || ad.points.length === 0) return;
            
            ctx.save();
            ctx.strokeStyle = '#ffae00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            ad.points.forEach((p, idx) => {
                const i = engineRef.current.timestampToIndex(p.timestamp, dataList, timeframe);
                const x = coordRef.current.indexToX(i);
                const y = coordRef.current.valueToY('main', p.price);
                
                if (idx === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            });
            
            ctx.lineTo(mouseX, mouseY);
            ctx.stroke();
            
            // Draw vertices
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#ffae00';
            ctx.lineWidth = 1.5;
            ad.points.forEach((p) => {
                const i = engineRef.current.timestampToIndex(p.timestamp, dataList, timeframe);
                const x = coordRef.current.indexToX(i);
                const y = coordRef.current.valueToY('main', p.price);
                
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, 2 * Math.PI);
                ctx.fill();
                ctx.stroke();
            });
            
            // Draw mouse position vertex
            ctx.beginPath();
            ctx.arc(mouseX, mouseY, 3, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
            
            ctx.restore();
        }
    };

    const rebuildDisplayData = (rawData) => buildDisplayData(rawData);

    // 3. Initialize/Resize Layout and Canvas Dimensions
    const initLayout = () => {
        if (!containerRef.current || !canvasDataRef.current || !canvasInterRef.current) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = containerRef.current.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // Apply DPR scaling for crisp graphics
        canvasDataRef.current.width = width * dpr;
        canvasDataRef.current.height = height * dpr;
        canvasDataRef.current.style.width = `${width}px`;
        canvasDataRef.current.style.height = `${height}px`;

        canvasInterRef.current.width = width * dpr;
        canvasInterRef.current.height = height * dpr;
        canvasInterRef.current.style.width = `${width}px`;
        canvasInterRef.current.style.height = `${height}px`;

        // Reset context transforms
        const ctxData = canvasDataRef.current.getContext('2d');
        ctxData.setTransform(1, 0, 0, 1, 0, 0);
        ctxData.scale(dpr, dpr);

        // Update layouts configuration
        layoutInfoRef.current = calculateLayout({
            width,
            height,
            showVolume,
            showEquity,
            showPosition,
            indicators: getStyledIndicators(),
            customHeights: customHeightsRef.current
        });

        if (interactionRef.current) {
            interactionRef.current.setChartWidth(layoutInfoRef.current.chartWidth);
        }

        requestRender();
    };

    const scheduleLayout = () => {
        if (!containerRef.current) return;

        const rect = containerRef.current.getBoundingClientRect();
        const nextSize = {
            width: Math.round(rect.width),
            height: Math.round(rect.height)
        };
        const prevSize = lastResizeSizeRef.current;

        if (
            Math.abs(nextSize.width - prevSize.width) < 1 &&
            Math.abs(nextSize.height - prevSize.height) < 1
        ) {
            return;
        }

        lastResizeSizeRef.current = nextSize;

        if (resizeRafRef.current !== null) {
            cancelAnimationFrame(resizeRafRef.current);
        }

        resizeRafRef.current = requestAnimationFrame(() => {
            resizeRafRef.current = null;
            initLayout();
        });
    };

    // 4. Imperative Interface Exposed to Parent
    useImperativeHandle(ref, () => ({
        clearDrawings: () => {
            drawingsRef.current = [];
            activeDrawingRef.current = null;
            setFocusedDrawingIndex(null);
            setFocusedDrawingPos(null);
            setShowStylePicker(false);
            notifyDrawingsChange();
            requestRender();
            renderInteractive(null, null);
        },
        setData: (newData) => {
            updateDataListAndMaintainView(newData);
            requestRender();
            updateDefaultLegend();

            if (onVisibleRangeChanged) {
                const len = dataListRef.current.length;
                const from = Math.max(0, startIndexRef.current);
                const to = Math.min(len - 1, endIndexRef.current);
                onVisibleRangeChanged({
                    fromIndex: from,
                    toIndex: to,
                    fromTimestamp: dataListRef.current[from]?.timestamp || 0,
                    toTimestamp: dataListRef.current[to]?.timestamp || 0
                });
            }
        },
        
        updateData: (candle) => {
            const dataList = dataListRef.current;
            if (dataList.length === 0) {
                dataListRef.current = rebuildDisplayData([candle]);
                startIndexRef.current = 0;
                endIndexRef.current = 0;
                requestRender();
                updateDefaultLegend();
                if (onVisibleRangeChanged) {
                    onVisibleRangeChanged({
                        fromIndex: 0,
                        toIndex: 0,
                        fromTimestamp: candle.timestamp,
                        toTimestamp: candle.timestamp
                    });
                }
                return;
            }

            const lastIndex = dataList.length - 1;
            const lastCandle = dataList[lastIndex];

            if (candle.timestamp === lastCandle.timestamp) {
                // Update current latest candle (Tick Update)
                dataList[lastIndex] = candle;
            } else if (candle.timestamp > lastCandle.timestamp) {
                // Append new candle
                const merged = rebuildDisplayData([...dataList.filter(d => !d.isHidden), candle]);
                dataListRef.current = merged;
                
                // Only scroll forward if the user was strictly locked to the rightmost boundary
                const isAtRightEdge = isLatestCandlePinned(dataList.length);

                if (isAtRightEdge) {
                    const addedCount = merged.length - dataList.length;
                    endIndexRef.current += addedCount;
                    startIndexRef.current += addedCount;
                }
            }

            if (interactionRef.current) {
                interactionRef.current.setDataLength(dataListRef.current.length);
            }
            requestRender();
            updateDefaultLegend();

            if (onVisibleRangeChanged) {
                const from = Math.max(0, startIndexRef.current);
                const to = Math.min(dataListRef.current.length - 1, endIndexRef.current);
                onVisibleRangeChanged({
                    fromIndex: from,
                    toIndex: to,
                    fromTimestamp: dataListRef.current[from]?.timestamp || 0,
                    toTimestamp: dataListRef.current[to]?.timestamp || 0
                });
            }
        },

        applyMoreData: (historicalData, hasMore) => {
            const currentData = dataListRef.current;
            if (historicalData.length === 0) return;

            // Merge historical data into head of array
            const sortedHistory = [...historicalData].sort((a, b) => a.timestamp - b.timestamp);
            
            // Avoid duplicates
            const firstCurrentTs = currentData.length > 0 ? currentData[0].timestamp : 0;
            const filteredHistory = sortedHistory.filter(d => d.timestamp < firstCurrentTs);

            if (filteredHistory.length > 0) {
                const lenBefore = currentData.length;
                dataListRef.current = rebuildDisplayData([...filteredHistory, ...currentData.filter(d => !d.isHidden)]);
                const lenAfter = dataListRef.current.length;

                // Adjust indices to maintain the same view context (visual position)
                const addedCount = lenAfter - lenBefore;
                startIndexRef.current += addedCount;
                endIndexRef.current += addedCount;

                if (interactionRef.current) {
                    interactionRef.current.setDataLength(lenAfter);
                }
                requestRender();
                updateDefaultLegend();

                if (onVisibleRangeChanged) {
                    const from = Math.max(0, startIndexRef.current);
                    const to = Math.min(lenAfter - 1, endIndexRef.current);
                    onVisibleRangeChanged({
                        fromIndex: from,
                        toIndex: to,
                        fromTimestamp: dataListRef.current[from]?.timestamp || 0,
                        toTimestamp: dataListRef.current[to]?.timestamp || 0
                    });
                }
            }
        },

        getVisibleRange: () => {
            const dataList = dataListRef.current;
            const from = Math.max(0, startIndexRef.current);
            const to = Math.min(dataList.length - 1, endIndexRef.current);
            return {
                fromIndex: from,
                toIndex: to,
                fromTimestamp: dataList[from]?.timestamp || 0,
                toTimestamp: dataList[to]?.timestamp || 0
            };
        },

        scrollToTimestamp: (ts, position = 'right') => {
            const dataList = dataListRef.current;
            const index = dataList.findIndex(d => d.timestamp === ts);
            if (index < 0) return;

            const visibleCount = endIndexRef.current - startIndexRef.current;
            const half = Math.round(visibleCount / 2);

            if (position === 'center') {
                startIndexRef.current = Math.max(0, index - half);
                endIndexRef.current = startIndexRef.current + visibleCount;
            } else if (position === 'left') {
                startIndexRef.current = index;
                endIndexRef.current = index + visibleCount;
            } else {
                // default right edge
                endIndexRef.current = index;
                startIndexRef.current = Math.max(0, index - visibleCount);
            }

            requestRender();
        }
    }));

    // 5. Setup Engine and Events on Mount
    useEffect(() => {
        // Initialize Coordinate System
        coordRef.current.startIndex = startIndexRef.current;
        coordRef.current.endIndex = endIndexRef.current;
        coordRef.current.barWidth = barWidthRef.current;
        coordRef.current.rightOffset = rightOffsetRef.current;

        // Initialize Render Engine
        engineRef.current = new RenderEngine(canvasDataRef.current, coordRef.current);

        // Initialize Interaction Handler
        interactionRef.current = new InteractionHandler(
            canvasInterRef.current,
            coordRef.current,
            // onUpdateRange callback
            (newStart, newEnd, newWidth) => {
                startIndexRef.current = newStart;
                endIndexRef.current = newEnd;
                barWidthRef.current = newWidth;
                
                requestRender();

                if (onVisibleRangeChangedRef.current) {
                    const dataList = dataListRef.current;
                    const from = Math.max(0, newStart);
                    const to = Math.min(dataList.length - 1, newEnd);
                    onVisibleRangeChangedRef.current({
                        fromIndex: from,
                        toIndex: to,
                        fromTimestamp: dataList[from]?.timestamp || 0,
                        toTimestamp: dataList[to]?.timestamp || 0
                    });
                }
            },
            // onCrosshairMove callback
            (mx, my) => {
                renderInteractive(mx, my);
            },
            // onCrosshairLeave callback
            () => {
                renderInteractive(null, null);
            },
            // onResizePane callback
            (upperName, upperH, lowerName, lowerH) => {
                if (upperName !== 'main') {
                    customHeightsRef.current[upperName] = upperH;
                }
                customHeightsRef.current[lowerName] = lowerH;
                initLayout();
            }
        );

        // Initial Layout computation
        initLayout();
        updateDefaultLegend();

        // Bind Resize Observer
        const resizeObserver = new ResizeObserver(() => {
            scheduleLayout();
        });
        resizeObserver.observe(containerRef.current);

        return () => {
            if (resizeRafRef.current !== null) {
                cancelAnimationFrame(resizeRafRef.current);
                resizeRafRef.current = null;
            }
            resizeObserver.disconnect();
            if (interactionRef.current) {
                interactionRef.current.unbindEvents();
            }
        };
    }, []);

    // 5.5 Handle activeTool change & bind drawing events to interaction handler
    useEffect(() => {
        if (activeTool === 'cursor') {
            persistentCrosshairRef.current.active = false;
        }
        if (interactionRef.current) {
            interactionRef.current.activeTool = activeTool;
            interactionRef.current.onDrawingsUpdated = () => {
                notifyDrawingsChange();
                requestRender();
            };
            
            interactionRef.current.onDrawingMouseDown = (mouseX, mouseY, e) => {
                const dataList = dataListRef.current;
                if (!dataList || dataList.length === 0) return;
                
                const idx = coordRef.current.xToIndex(mouseX);
                const safeIdx = Math.max(0, Math.min(dataList.length - 1, idx));
                const timestamp = dataList[safeIdx].timestamp;
                const price = coordRef.current.yToValue('main', mouseY);
                
                const currentTool = activeToolRef.current;
                
                if (currentTool === 'trendline' || currentTool === 'ray' || currentTool === 'measurement') {
                    if (!activeDrawingRef.current) {
                        // First point
                        activeDrawingRef.current = {
                            type: currentTool,
                            p1: { timestamp, price },
                            p2: null
                        };
                    } else {
                        // Second point, complete drawing
                        const p2 = { timestamp, price };
                        drawingsRef.current.push({
                            type: currentTool,
                            p1: activeDrawingRef.current.p1,
                            p2: p2
                        });
                        activeDrawingRef.current = null;
                        
                        setActiveTool('cursor');
                        notifyDrawingsChange();
                        requestRender();
                    }
                } else if (currentTool === 'horizontal') {
                    // Single point click completes horizontal line
                    drawingsRef.current.push({
                        type: 'horizontal',
                        price: price
                    });
                    
                    setActiveTool('cursor');
                    notifyDrawingsChange();
                    requestRender();
                } else if (currentTool === 'polyline') {
                    if (!activeDrawingRef.current) {
                        activeDrawingRef.current = {
                            type: 'polyline',
                            points: [{ timestamp, price }]
                        };
                    } else {
                        activeDrawingRef.current.points.push({ timestamp, price });
                    }
                    requestRender();
                }
            };

            interactionRef.current.onDrawingMouseMove = (mouseX, mouseY, e) => {
                if (activeDrawingRef.current) {
                    renderInteractive(mouseX, mouseY);
                }
            };

            interactionRef.current.onDrawingDblClick = (mouseX, mouseY, e) => {
                const currentTool = activeToolRef.current;
                if (currentTool === 'polyline' && activeDrawingRef.current) {
                    // Filter duplicate/near adjacent points if any
                    const pts = activeDrawingRef.current.points.filter((pt, idx, arr) => {
                        if (idx === 0) return true;
                        const prev = arr[idx - 1];
                        return pt.timestamp !== prev.timestamp || Math.abs(pt.price - prev.price) > 0.0000001;
                    });
                    
                    if (pts.length >= 2) {
                        drawingsRef.current.push({
                            type: 'polyline',
                            points: pts
                        });
                        notifyDrawingsChange();
                    }
                    activeDrawingRef.current = null;
                    setActiveTool('cursor');
                    requestRender();
                    renderInteractive(null, null);
                }
            };
        }
    }, [activeTool]);

    // Sync latest variables to interactionHandler on every render to ensure node dragging works correctly
    useEffect(() => {
        const nextDrawingsJson = JSON.stringify(Array.isArray(drawings) ? drawings : []);
        const isSameSymbolEcho = drawingsKeyRef.current === drawingsKey && nextDrawingsJson === lastNotifiedDrawingsRef.current;
        drawingsKeyRef.current = drawingsKey;

        drawingsRef.current = cloneDrawings(drawings);
        if (!isSameSymbolEcho) {
            activeDrawingRef.current = null;
            setFocusedDrawingIndex(null);
            setFocusedDrawingPos(null);
            setShowStylePicker(false);
        }

        if (interactionRef.current) {
            interactionRef.current.drawings = drawingsRef.current;
        }

        requestRender();
        renderInteractive(null, null);
    }, [drawings, drawingsKey]);

    useEffect(() => {
        if (interactionRef.current) {
            interactionRef.current.dataList = dataListRef.current;
            interactionRef.current.timeframe = timeframeRef.current;
            interactionRef.current.drawings = drawingsRef.current;
            interactionRef.current.focusedDrawingIndex = focusedDrawingIndex;
            interactionRef.current.onFocusDrawingChanged = (index, pos) => {
                setFocusedDrawingIndex(index);
                setFocusedDrawingPos(pos);
                if (index === null) {
                    setShowStylePicker(false);
                }
            };
        }
    });

    // Redraw whenever focus changes
    useEffect(() => {
        requestRender();
    }, [focusedDrawingIndex]);

    // 6. Handle props changes (like symbols, indicators, layouts)
    useEffect(() => {
        // Update local ref from prop
        updateDataListAndMaintainView(data);

        // Re-evaluate layout
        if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            layoutInfoRef.current = calculateLayout({
                width: rect.width,
                height: rect.height,
                showVolume,
                showEquity,
                showPosition,
                indicators: getStyledIndicators(indicators),
                customHeights: customHeightsRef.current
            });
            if (interactionRef.current) {
                interactionRef.current.setChartWidth(layoutInfoRef.current.chartWidth);
            }
        }

        requestRender();
        updateDefaultLegend();
    }, [data, showVolume, showEquity, showPosition, indicators, trades, lifecycleEvents, timeframe, symbol]);

    return (
        <div 
            ref={containerRef} 
            style={{ 
                position: 'relative', 
                width: '100%', 
                height: containerHeight, 
                userSelect: 'none',
                fontFamily: 'Inter, system-ui, sans-serif'
            }}
        >
            {/* Background & Data Canvas */}
            <canvas 
                ref={canvasDataRef} 
                style={{ 
                    position: 'absolute', 
                    left: 0, 
                    top: 0, 
                    zIndex: 1 
                }} 
            />

            {/* Interactive/Overlay Canvas (handles mouse events) */}
            <canvas 
                ref={canvasInterRef} 
                style={{ 
                    position: 'absolute', 
                    left: 0, 
                    top: 0, 
                    zIndex: 2, 
                    cursor: 'crosshair',
                    touchAction: 'none'
                }} 
            />

            {loading && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        zIndex: 20,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'linear-gradient(180deg, rgba(8, 13, 28, 0.82), rgba(8, 13, 28, 0.68))',
                        backdropFilter: 'blur(2px)',
                        pointerEvents: 'auto',
                        overflow: 'hidden'
                    }}
                >
                    <style>
                        {`
                            @keyframes qxScanLine {
                                0% { transform: translateY(-120%); opacity: 0; }
                                12% { opacity: 1; }
                                88% { opacity: 1; }
                                100% { transform: translateY(120%); opacity: 0; }
                            }
                            @keyframes qxPulseRing {
                                0% { transform: scale(0.86); opacity: 0.35; }
                                50% { transform: scale(1.08); opacity: 1; }
                                100% { transform: scale(0.86); opacity: 0.35; }
                            }
                            @keyframes qxBarPulse {
                                0%, 100% { height: 18px; opacity: 0.45; }
                                50% { height: 44px; opacity: 1; }
                            }
                        `}
                    </style>
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundImage: 'linear-gradient(rgba(34, 211, 238, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(34, 211, 238, 0.05) 1px, transparent 1px)',
                            backgroundSize: '42px 42px'
                        }}
                    />
                    <div
                        style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: '-20%',
                            height: '38%',
                            background: 'linear-gradient(180deg, transparent, rgba(34, 211, 238, 0.18), transparent)',
                            animation: 'qxScanLine 1.8s ease-in-out infinite'
                        }}
                    />
                    <div
                        style={{
                            position: 'relative',
                            width: '240px',
                            minHeight: '132px',
                            border: '1px solid rgba(34, 211, 238, 0.28)',
                            background: 'rgba(2, 6, 23, 0.78)',
                            borderRadius: '10px',
                            boxShadow: '0 0 30px rgba(6, 182, 212, 0.18)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '14px',
                            color: '#d7f9ff',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'end', gap: '8px', height: '50px' }}>
                            {[0, 1, 2, 3, 4].map((item) => (
                                <span
                                    key={item}
                                    style={{
                                        width: '9px',
                                        height: '28px',
                                        borderRadius: '999px',
                                        background: item % 2 === 0 ? '#22d3ee' : '#10b981',
                                        boxShadow: '0 0 12px rgba(34, 211, 238, 0.5)',
                                        animation: 'qxBarPulse 0.9s ease-in-out infinite',
                                        animationDelay: `${item * 0.09}s`
                                    }}
                                />
                            ))}
                        </div>
                        <div
                            style={{
                                position: 'absolute',
                                top: '20px',
                                width: '74px',
                                height: '74px',
                                border: '1px solid rgba(34, 211, 238, 0.34)',
                                borderRadius: '999px',
                                animation: 'qxPulseRing 1.2s ease-in-out infinite'
                            }}
                        />
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ fontSize: '12px', letterSpacing: '0.14em', fontWeight: 800 }}>
                                LOADING K-LINE DATA
                            </div>
                            <div style={{ marginTop: '6px', fontSize: '10px', color: '#7dd3fc' }}>
                                {symbol || 'SYMBOL'} / {timeframe}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* TradingView Legend Overlay */}
            {legendInfo && (
                <div 
                    style={{ 
                        position: 'absolute', 
                        left: '12px', 
                        top: '12px', 
                        zIndex: 3, 
                        background: 'rgba(30, 34, 45, 0.85)', 
                        padding: '8px 12px', 
                        borderRadius: '4px', 
                        border: '1px solid #2b2f3a',
                        fontSize: '11px',
                        lineHeight: '1.4',
                        pointerEvents: 'none',
                        color: '#d1d4dc',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '2px',
                        minWidth: '220px'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 'bold', color: '#f0f3fa', gap: '12px' }}>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                            <span>{symbol}</span>
                            <span>{timeframe}</span>
                            <span style={{ color: '#8f96a3', fontWeight: 'normal' }}>{legendInfo.time}</span>
                        </div>
                        <button
                            onClick={() => {
                                const nextPinned = !isPinned;
                                setIsPinned(nextPinned);
                                isPinnedRef.current = nextPinned;
                                if (nextPinned && !hoveredCandleRef.current) {
                                    const dataList = dataListRef.current;
                                    if (dataList && dataList.length > 0) {
                                        setLegendInfo(getLegendInfoForCandle(getLatestVisibleCandle(dataList)));
                                    }
                                } else if (!nextPinned && !hoveredCandleRef.current) {
                                    setLegendInfo(null);
                                }
                            }}
                            title={isPinned ? "取消固定資訊卡" : "固定資訊卡"}
                            style={{
                                background: isBtnHovered ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
                                border: 'none',
                                padding: '3px',
                                borderRadius: '4px',
                                color: isPinned ? '#26a69a' : (isBtnHovered ? '#f0f3fa' : '#8f96a3'),
                                cursor: 'pointer',
                                pointerEvents: 'auto',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s',
                                outline: 'none'
                            }}
                            onMouseEnter={() => setIsBtnHovered(true)}
                            onMouseLeave={() => setIsBtnHovered(false)}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 17v5" />
                                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.89A.5.5 0 0 0 6.36 14h11.28a.5.5 0 0 0 .45-.56l-.5-4.5a2 2 0 0 0-.44-1.15L15 5H9l-2.22 2.76A2 2 0 0 0 9 10.76Z" />
                                <path d="M8 5h8" />
                            </svg>
                        </button>
                    </div>
                    
                    <div style={{ display: legendInfo.isEmpty ? 'none' : 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span>開:<span style={{ color: legendInfo.isUp ? '#26a69a' : '#ef5350', marginLeft: '2px' }}>{legendInfo.open}</span></span>
                        <span>高:<span style={{ color: legendInfo.isUp ? '#26a69a' : '#ef5350', marginLeft: '2px' }}>{legendInfo.high}</span></span>
                        <span>低:<span style={{ color: legendInfo.isUp ? '#26a69a' : '#ef5350', marginLeft: '2px' }}>{legendInfo.low}</span></span>
                        <span>收:<span style={{ color: legendInfo.isUp ? '#26a69a' : '#ef5350', marginLeft: '2px' }}>{legendInfo.close}</span></span>
                        <span>量:<span style={{ color: '#d1d4dc', marginLeft: '2px' }}>{legendInfo.volume}</span></span>
                        <span>幅:<span style={{ color: legendInfo.isUp ? '#26a69a' : '#ef5350', marginLeft: '2px' }}>{legendInfo.change} ({legendInfo.changePercent}%)</span></span>
                    </div>

                    {legendInfo.isEmpty && (
                        <div style={{ color: '#8f96a3' }}>No data</div>
                    )}

                    {/* Indicators list */}
                    {!legendInfo.isEmpty && legendInfo.inds && Object.entries(legendInfo.inds).map(([name, ind]) => (
                        <div
                            key={name}
                            ref={openIndicatorMenu === name ? openIndicatorMenuRef : null}
                            style={{
                                position: 'relative',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                color: ind.color,
                                minHeight: '17px',
                                width: 'fit-content',
                                pointerEvents: 'auto'
                            }}
                        >
                            <span>{name}:</span>
                            <span>{ind.value}</span>
                            <button
                                type="button"
                                title={`${name} 指標選單`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenIndicatorMenu(openIndicatorMenu === name ? null : name);
                                    setStyleIndicatorName(null);
                                }}
                                style={{
                                    width: '18px',
                                    height: '18px',
                                    border: '1px solid transparent',
                                    borderRadius: '4px',
                                    background: openIndicatorMenu === name ? 'rgba(0, 178, 255, 0.18)' : 'transparent',
                                    color: openIndicatorMenu === name ? '#00b2ff' : '#8f96a3',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    padding: 0,
                                    outline: 'none',
                                    flex: '0 0 auto'
                                }}
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <circle cx="12" cy="12" r="1" />
                                    <circle cx="19" cy="12" r="1" />
                                    <circle cx="5" cy="12" r="1" />
                                </svg>
                            </button>

                            {openIndicatorMenu === name && (
                                <div
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                        position: 'absolute',
                                        left: 'calc(100% + 8px)',
                                        top: 0,
                                        zIndex: 30,
                                        width: styleIndicatorName === name ? '196px' : '132px',
                                        background: 'rgba(20, 24, 35, 0.97)',
                                        backdropFilter: 'blur(8px)',
                                        border: '1px solid #2b2f3a',
                                        borderRadius: '6px',
                                        boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
                                        color: '#d1d4dc',
                                        padding: '6px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '6px'
                                    }}
                                >
                                    {styleIndicatorName !== name ? (
                                        <button
                                            type="button"
                                            onClick={() => setStyleIndicatorName(name)}
                                            style={{
                                                width: '100%',
                                                background: 'transparent',
                                                border: '1px solid transparent',
                                                borderRadius: '4px',
                                                color: '#d1d4dc',
                                                cursor: 'pointer',
                                                fontSize: '11px',
                                                fontWeight: 700,
                                                textAlign: 'left',
                                                padding: '7px 8px',
                                                outline: 'none'
                                            }}
                                        >
                                            設定樣式
                                        </button>
                                    ) : (
                                        <>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                                <span style={{ fontSize: '10px', color: '#8f96a3', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>設定樣式</span>
                                                <button
                                                    type="button"
                                                    onClick={() => setStyleIndicatorName(null)}
                                                    style={{
                                                        background: 'transparent',
                                                        border: 'none',
                                                        color: '#8f96a3',
                                                        cursor: 'pointer',
                                                        fontSize: '12px',
                                                        padding: '2px 4px'
                                                    }}
                                                >
                                                    返回
                                                </button>
                                            </div>
                                            <div style={{ width: '100%', height: '1px', backgroundColor: '#2b2f3a' }} />

                                            <div style={{ fontSize: '10px', color: '#8f96a3', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>顏色</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px' }}>
                                                {indicatorPresetColors.map((color) => (
                                                    <button
                                                        key={color}
                                                        type="button"
                                                        onClick={() => updateIndicatorStyle(name, { color })}
                                                        title={color}
                                                        style={{
                                                            width: '22px',
                                                            height: '22px',
                                                            borderRadius: '4px',
                                                            background: color,
                                                            border: ind.color === color ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.14)',
                                                            cursor: 'pointer',
                                                            padding: 0,
                                                            boxSizing: 'border-box',
                                                            transform: ind.color === color ? 'scale(1.08)' : 'scale(1)',
                                                            transition: 'transform 0.12s'
                                                        }}
                                                    />
                                                ))}
                                            </div>

                                            <div style={{ width: '100%', height: '1px', backgroundColor: '#2b2f3a', margin: '2px 0' }} />

                                            <div style={{ fontSize: '10px', color: '#8f96a3', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px' }}>線條寬度</div>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '5px' }}>
                                                {indicatorLineWidths.map((width) => (
                                                    <button
                                                        key={width}
                                                        type="button"
                                                        onClick={() => updateIndicatorStyle(name, { lineWidth: width })}
                                                        title={`${width}px`}
                                                        style={{
                                                            height: '26px',
                                                            borderRadius: '4px',
                                                            border: ind.lineWidth === width ? '1px solid #00b2ff' : '1px solid #2b2f3a',
                                                            background: ind.lineWidth === width ? 'rgba(0, 178, 255, 0.16)' : 'rgba(15, 23, 42, 0.55)',
                                                            cursor: 'pointer',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                            padding: 0
                                                        }}
                                                    >
                                                        <span
                                                            style={{
                                                                width: '18px',
                                                                height: `${width}px`,
                                                                borderRadius: '99px',
                                                                background: ind.color,
                                                                display: 'block'
                                                            }}
                                                        />
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {/* Drawing Tools Floating Sidebar */}
            <div 
                style={{
                    position: 'absolute',
                    left: '12px',
                    top: '120px', // Below the Legend
                    zIndex: 10,
                    backgroundColor: 'rgba(30, 34, 45, 0.85)',
                    border: '1px solid #2b2f3a',
                    borderRadius: '6px',
                    padding: '6px 4px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    alignItems: 'center',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
                }}
            >
                {/* 1. Cursor */}
                <button
                    onClick={() => setActiveTool('cursor')}
                    onMouseEnter={() => setHoveredTool('cursor')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="游標 (Cursor)"
                    style={{
                        background: activeTool === 'cursor' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'cursor' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'cursor' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'cursor' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/>
                        <path d="m13 13 6 6"/>
                    </svg>
                </button>

                {/* Divider */}
                <div style={{ width: '20px', height: '1px', backgroundColor: '#2b2f3a', margin: '2px 0' }} />

                {/* 2. Trendline */}
                <button
                    onClick={() => setActiveTool('trendline')}
                    onMouseEnter={() => setHoveredTool('trendline')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="直線 (Trendline)"
                    style={{
                        background: activeTool === 'trendline' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'trendline' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'trendline' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'trendline' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="20" x2="20" y2="4" />
                        <circle cx="4" cy="20" r="2.5" fill="currentColor" />
                        <circle cx="20" cy="4" r="2.5" fill="currentColor" />
                    </svg>
                </button>

                {/* 3. Ray */}
                <button
                    onClick={() => setActiveTool('ray')}
                    onMouseEnter={() => setHoveredTool('ray')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="射線 (Ray)"
                    style={{
                        background: activeTool === 'ray' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'ray' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'ray' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'ray' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="4" y1="20" x2="18" y2="6" />
                        <circle cx="4" cy="20" r="2.5" fill="currentColor" />
                        <path d="M12 6h6v6" />
                    </svg>
                </button>

                {/* 4. Horizontal Line */}
                <button
                    onClick={() => setActiveTool('horizontal')}
                    onMouseEnter={() => setHoveredTool('horizontal')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="水平線 (Horizontal)"
                    style={{
                        background: activeTool === 'horizontal' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'horizontal' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'horizontal' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'horizontal' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <circle cx="12" cy="12" r="2.5" fill="currentColor" />
                    </svg>
                </button>

                {/* 5. Polyline */}
                <button
                    onClick={() => setActiveTool('polyline')}
                    onMouseEnter={() => setHoveredTool('polyline')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="折線 (Polyline)"
                    style={{
                        background: activeTool === 'polyline' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'polyline' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'polyline' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'polyline' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="4" cy="18" r="2" fill="currentColor"/>
                        <circle cx="12" cy="6" r="2" fill="currentColor"/>
                        <circle cx="20" cy="14" r="2" fill="currentColor"/>
                        <line x1="6" y1="17" x2="10" y2="7"/>
                        <line x1="14" y1="7" x2="18" y2="13"/>
                    </svg>
                </button>

                {/* 6. Measurement */}
                <button
                    onClick={() => setActiveTool('measurement')}
                    onMouseEnter={() => setHoveredTool('measurement')}
                    onMouseLeave={() => setHoveredTool(null)}
                    title="價格測量 (Measure)"
                    style={{
                        background: activeTool === 'measurement' ? 'rgba(0, 178, 255, 0.25)' : (hoveredTool === 'measurement' ? 'rgba(255, 255, 255, 0.08)' : 'transparent'),
                        border: activeTool === 'measurement' ? '1px solid #00b2ff' : '1px solid transparent',
                        color: activeTool === 'measurement' ? '#00b2ff' : '#d1d4dc',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 4v16"/>
                        <path d="M20 8h-6"/>
                        <path d="M20 16h-6"/>
                        <path d="M18 12h-4"/>
                        <path d="M10 8H8"/>
                        <path d="M10 16H8"/>
                        <path d="M10 12H6"/>
                        <path d="M4 4v16"/>
                    </svg>
                </button>

                {/* Divider */}
                <div style={{ width: '20px', height: '1px', backgroundColor: '#2b2f3a', margin: '2px 0' }} />

                {/* 7. Clear All */}
                <button
                    onClick={() => {
                        drawingsRef.current = [];
                        activeDrawingRef.current = null;
                        setFocusedDrawingIndex(null);
                        setFocusedDrawingPos(null);
                        setShowStylePicker(false);
                        notifyDrawingsChange();
                        requestRender();
                        renderInteractive(null, null);
                    }}
                    onMouseEnter={() => setIsTrashHovered(true)}
                    onMouseLeave={() => setIsTrashHovered(false)}
                    title="清除所有繪圖 (Clear All)"
                    style={{
                        background: isTrashHovered ? 'rgba(239, 83, 80, 0.2)' : 'transparent',
                        border: '1px solid transparent',
                        color: isTrashHovered ? '#ef5350' : '#8f96a3',
                        padding: '6px',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.2s',
                        outline: 'none'
                    }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18"/>
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                    </svg>
                </button>
            </div>

            {/* 8. Floating Object Settings Toolbar & Style Popover */}
            {focusedDrawingIndex !== null && focusedDrawingPos !== null && drawingsRef.current[focusedDrawingIndex] && (() => {
                const drawing = drawingsRef.current[focusedDrawingIndex];
                const chartWidth = layoutInfoRef.current ? layoutInfoRef.current.chartWidth : 800;
                const leftX = Math.max(90, Math.min(chartWidth - 90, focusedDrawingPos.x));
                
                let topY = focusedDrawingPos.y - 45;
                let isBelow = false;
                if (topY < 15) {
                    topY = focusedDrawingPos.y + 15;
                    isBelow = true;
                }

                const activeColor = drawing.color || (drawing.type === 'polyline' ? '#ffae00' : '#00b2ff');
                const activeLineStyle = drawing.lineStyle || 'solid';
                const presetColors = [
                    '#00b2ff', '#089981', '#f23645', '#ff9800',
                    '#e91e63', '#9c27b0', '#ffffff', '#787b86'
                ];

                return (
                    <div 
                        style={{
                            position: 'absolute',
                            left: `${leftX}px`,
                            top: `${topY}px`,
                            transform: 'translateX(-50%)',
                            zIndex: 15,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            pointerEvents: 'auto'
                        }}
                    >
                        {/* Style Panel Popover */}
                        {showStylePicker && (
                            <div 
                                style={{
                                    position: 'absolute',
                                    bottom: isBelow ? 'auto' : '48px',
                                    top: isBelow ? '48px' : 'auto',
                                    background: 'rgba(20, 24, 35, 0.96)',
                                    backdropFilter: 'blur(8px)',
                                    border: '1px solid #2b2f3a',
                                    borderRadius: '6px',
                                    padding: '10px',
                                    width: '180px',
                                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '8px'
                                }}
                            >
                                <div style={{ fontSize: '10px', color: '#8f96a3', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>顏色</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                                    {presetColors.map(c => (
                                        <button
                                            key={c}
                                            onClick={() => {
                                                drawing.color = c;
                                                notifyDrawingsChange();
                                                requestRender();
                                            }}
                                            style={{
                                                width: '24px',
                                                height: '24px',
                                                borderRadius: '4px',
                                                background: c,
                                                border: activeColor === c ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.1)',
                                                cursor: 'pointer',
                                                padding: 0,
                                                boxSizing: 'border-box',
                                                transition: 'transform 0.1s',
                                                transform: activeColor === c ? 'scale(1.1)' : 'scale(1)'
                                            }}
                                            title={c}
                                        />
                                    ))}
                                </div>

                                <div style={{ width: '100%', height: '1px', backgroundColor: '#2b2f3a', margin: '4px 0' }} />

                                <div style={{ fontSize: '10px', color: '#8f96a3', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>線條樣式</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                    {[
                                        { name: '實線', value: 'solid' },
                                        { name: '短虛線', value: 'dash-short' },
                                        { name: '中虛線', value: 'dash-medium' },
                                        { name: '長虛線', value: 'dash-long' }
                                    ].map(styleOpt => (
                                        <button
                                            key={styleOpt.value}
                                            onClick={() => {
                                                drawing.lineStyle = styleOpt.value;
                                                notifyDrawingsChange();
                                                requestRender();
                                            }}
                                            style={{
                                                background: activeLineStyle === styleOpt.value ? 'rgba(0, 178, 255, 0.15)' : 'transparent',
                                                border: '1px solid transparent',
                                                borderRadius: '4px',
                                                padding: '6px 8px',
                                                color: activeLineStyle === styleOpt.value ? '#00b2ff' : '#d1d4dc',
                                                cursor: 'pointer',
                                                fontSize: '11px',
                                                textAlign: 'left',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                transition: 'all 0.2s',
                                                outline: 'none'
                                            }}
                                        >
                                            <span>{styleOpt.name}</span>
                                            <div style={{ display: 'flex', width: '60px', height: '1px', overflow: 'hidden', alignItems: 'center' }}>
                                                <div 
                                                    style={{ 
                                                        width: '100%', 
                                                        height: 0, 
                                                        borderTop: `1.5px ${styleOpt.value === 'solid' ? 'solid' : 'dashed'} ${activeLineStyle === styleOpt.value ? '#00b2ff' : '#8f96a3'}`,
                                                        opacity: activeLineStyle === styleOpt.value ? 1 : 0.6
                                                    }} 
                                                />
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Floating Action Bar */}
                        <div 
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                background: 'rgba(20, 24, 35, 0.95)',
                                backdropFilter: 'blur(8px)',
                                border: '1px solid #2b2f3a',
                                borderRadius: '6px',
                                padding: '4px',
                                gap: '2px',
                                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)'
                            }}
                        >
                            <button
                                onClick={() => setShowStylePicker(!showStylePicker)}
                                title="變更樣式 (Style Settings)"
                                style={{
                                    background: showStylePicker ? 'rgba(0, 178, 255, 0.2)' : 'transparent',
                                    border: '1px solid transparent',
                                    borderRadius: '4px',
                                    padding: '5px',
                                    color: showStylePicker ? '#00b2ff' : '#d1d4dc',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s',
                                    outline: 'none'
                                }}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                                    <circle cx="7.5" cy="10.5" r="1.5" fill="currentColor"/>
                                    <circle cx="11.5" cy="7.5" r="1.5" fill="currentColor"/>
                                    <circle cx="16.5" cy="9.5" r="1.5" fill="currentColor"/>
                                    <circle cx="15.5" cy="14.5" r="1.5" fill="currentColor"/>
                                    <path d="M6 16c.5-1.5 2-2.5 4-2.5s3.5 1 4 2.5"/>
                                </svg>
                            </button>

                            <div style={{ width: '1px', height: '16px', backgroundColor: '#2b2f3a', margin: '0 4px' }} />

                            <button
                                onClick={() => {
                                    drawingsRef.current.splice(focusedDrawingIndex, 1);
                                    setFocusedDrawingIndex(null);
                                    setFocusedDrawingPos(null);
                                    setShowStylePicker(false);
                                    notifyDrawingsChange();
                                    requestRender();
                                }}
                                title="刪除此物件 (Delete Object)"
                                style={{
                                    background: 'transparent',
                                    border: '1px solid transparent',
                                    borderRadius: '4px',
                                    padding: '5px',
                                    color: '#ef5350',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    transition: 'all 0.2s',
                                    outline: 'none'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 83, 80, 0.15)'}
                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18"/>
                                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
});

CustomKLineChart.displayName = 'CustomKLineChart';

export default CustomKLineChart;
