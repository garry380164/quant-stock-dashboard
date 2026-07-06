import { format } from 'date-fns';

export function calculateLayout({ width, height, showVolume, showEquity, showPosition, indicators, yAxisWidth = 65, xAxisHeight = 25, customHeights = {} }) {
    const chartWidth = width - yAxisWidth;
    const totalChartHeight = height - xAxisHeight;

    const subPanes = [];
    if (showEquity) subPanes.push('equity');
    if (showPosition) subPanes.push('position');

    const customPanes = new Set();
    if (indicators) {
        Object.entries(indicators).forEach(([name, config]) => {
            if (config.type === 'sub' && config.pane && config.pane !== 'volume' && config.pane !== 'equity' && config.pane !== 'position') {
                customPanes.add(config.pane);
            }
        });
    }
    customPanes.forEach(pane => subPanes.push(pane));

    const subPaneGap = 10;
    
    // Calculate total height of all sub-panes
    let totalSubPanesHeight = 0;
    subPanes.forEach(paneName => {
        const h = customHeights[paneName] !== undefined ? customHeights[paneName] : 65;
        totalSubPanesHeight += h + subPaneGap;
    });

    // Ensure main pane has a minimum height of 80px
    const mainHeight = Math.max(80, totalChartHeight - totalSubPanesHeight);

    const layouts = {};
    layouts['main'] = {
        yMin: 0,
        yMax: mainHeight,
        height: mainHeight,
        xMin: 0,
        xMax: chartWidth
    };

    let currentY = mainHeight;
    subPanes.forEach(paneName => {
        currentY += subPaneGap;
        const h = customHeights[paneName] !== undefined ? customHeights[paneName] : 65;
        layouts[paneName] = {
            yMin: currentY,
            yMax: currentY + h,
            height: h,
            xMin: 0,
            xMax: chartWidth
        };
        currentY += h;
    });

    return {
        layouts,
        chartWidth,
        totalChartHeight,
        yAxisWidth,
        xAxisHeight
    };
}

export class RenderEngine {
    constructor(canvas, coordSystem) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.coord = coordSystem;
        this.theme = {
            bg: '#1e222d',
            grid: '#2b2f3a',
            text: '#8f96a3',
            axisLine: '#2b2f3a',
            candleUp: '#26a69a',
            candleDown: '#ef5350',
            wickUp: '#26a69a',
            wickDown: '#ef5350',
            volumeUp: 'rgba(38, 166, 154, 0.5)',
            volumeDown: 'rgba(239, 83, 80, 0.5)',
            equity: '#1677ff',
            position: '#eab308'
        };
    }

    clear() {
        const { width, height } = this.canvas;
        this.ctx.fillStyle = this.theme.bg;
        this.ctx.fillRect(0, 0, width, height);
    }

    // Determine min/max values for each pane in the visible range
    computePaneRanges(dataList, startIndex, endIndex, indicators, showVolume, showEquity, showPosition) {
        if (!dataList || dataList.length === 0) return {};

        const visibleCount = Math.max(1, endIndex - startIndex);
        const rangeEnd = Math.min(dataList.length - 1, Math.max(0, endIndex));
        const rangeStart = Math.max(0, Math.min(rangeEnd, Math.max(0, startIndex)));
        const hasVisibleData = startIndex <= dataList.length - 1 && endIndex >= 0;
        const start = hasVisibleData ? rangeStart : Math.max(0, rangeEnd - visibleCount);
        const end = rangeEnd;
        
        let mainMin = Number.MAX_VALUE;
        let mainMax = -Number.MAX_VALUE;
        let volMax = 0;
        let equityMin = Number.MAX_VALUE;
        let equityMax = -Number.MAX_VALUE;
        let posMin = Number.MAX_VALUE;
        let posMax = -Number.MAX_VALUE;

        // Custom sub pane ranges
        const customRanges = {};

        // Build indicator fast maps
        const indicatorMaps = {};
        if (indicators) {
            Object.entries(indicators).forEach(([name, config]) => {
                if (config.data) {
                    const map = new Map();
                    config.data.forEach(item => {
                        if (item.time !== undefined && item.value !== undefined) {
                            const timeMs = typeof item.time === 'number' ? item.time : new Date(item.time).getTime();
                            if (!isNaN(timeMs)) {
                                map.set(timeMs, item.value);
                            }
                        }
                    });
                    indicatorMaps[name] = map;
                }
            });
        }

        for (let i = start; i <= end; i++) {
            const d = dataList[i];
            
            // Main chart (Candlesticks)
            if (d.high > mainMax) mainMax = d.high;
            if (d.low < mainMin) mainMin = d.low;

            // Main indicators overlay
            if (indicators) {
                Object.entries(indicators).forEach(([name, config]) => {
                    const valueMap = indicatorMaps[name];
                    if (!valueMap) return;

                    const val = valueMap.get(d.timestamp);
                    if (val !== undefined) {
                        if (config.type === 'main') {
                            if (val > mainMax) mainMax = val;
                            if (val < mainMin) mainMin = val;
                        } else if (config.type === 'sub' && config.pane) {
                            const pName = config.pane;
                            if (!customRanges[pName]) {
                                customRanges[pName] = { min: Number.MAX_VALUE, max: -Number.MAX_VALUE };
                            }
                            if (Number.isFinite(config.min)) {
                                customRanges[pName].min = Math.min(customRanges[pName].min, config.min);
                            }
                            if (Number.isFinite(config.max)) {
                                customRanges[pName].max = Math.max(customRanges[pName].max, config.max);
                            }
                            if (val > customRanges[pName].max) customRanges[pName].max = val;
                            if (val < customRanges[pName].min) customRanges[pName].min = val;
                        }
                    }
                });
            }

            // Volume
            if (showVolume && d.volume > volMax) volMax = d.volume;

            // Equity
            if (showEquity) {
                const eq = d.equity !== undefined ? d.equity : 0;
                if (eq > equityMax) equityMax = eq;
                if (eq < equityMin) equityMin = eq;
            }

            // Position
            if (showPosition) {
                const pos = d.position !== undefined ? d.position : 0;
                if (pos > posMax) posMax = pos;
                if (pos < posMin) posMin = pos;
            }
        }

        // Apply some padding/margins to ranges
        const mainDiff = mainMax - mainMin;
        const mainPad = mainDiff === 0 ? 1 : mainDiff * 0.05;
        mainMin = Math.max(0, mainMin - mainPad);
        mainMax = mainMax + mainPad;

        const eqDiff = equityMax - equityMin;
        const eqPad = eqDiff === 0 ? 100 : eqDiff * 0.05;
        equityMin = equityMin - eqPad;
        equityMax = equityMax + eqPad;

        // Position padding (if same, default -1 to 1)
        if (posMax === posMin) {
            posMin = posMin - 1;
            posMax = posMax + 1;
        } else {
            const posDiff = posMax - posMin;
            posMin = posMin - posDiff * 0.1;
            posMax = posMax + posDiff * 0.1;
        }

        const ranges = {
            main: { min: mainMin, max: mainMax },
            volume: { min: 0, max: volMax === 0 ? 1 : volMax },
            equity: { min: equityMin, max: equityMax },
            position: { min: posMin, max: posMax }
        };

        // Standardize custom sub pane ranges
        Object.entries(customRanges).forEach(([paneName, range]) => {
            const diff = range.max - range.min;
            const pad = diff === 0 ? 1 : diff * 0.05;
            ranges[paneName] = {
                min: range.min - pad,
                max: range.max + pad
            };
        });

        return ranges;
    }

    drawGrid(layouts, chartWidth) {
        const ctx = this.ctx;
        ctx.strokeStyle = this.theme.grid;
        ctx.lineWidth = 1;

        // Draw horizontal grid lines for each layout pane
        Object.entries(layouts).forEach(([paneName, layout]) => {
            const yRange = layout.yMax - layout.yMin;
            const steps = 4; // grid intervals
            for (let i = 1; i < steps; i++) {
                const y = layout.yMin + (yRange / steps) * i;
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(chartWidth, y);
                ctx.stroke();
            }
        });
    }

    drawXAxisGrid(dataList, startIndex, endIndex, chartWidth, totalChartHeight) {
        const ctx = this.ctx;
        ctx.strokeStyle = this.theme.grid;
        ctx.lineWidth = 1;

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        // Standard spacing between vertical grid lines (e.g., approx every 80px)
        const stepPx = 80;
        const barStep = Math.max(1, Math.round(stepPx / (this.coord.barWidth + this.coord.barSpace)));

        for (let i = start; i <= end; i++) {
            if ((i - start) % barStep === 0) {
                const x = this.coord.indexToX(i);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, totalChartHeight);
                ctx.stroke();
            }
        }
    }

    drawCandlesticks(dataList, startIndex, endIndex) {
        const ctx = this.ctx;
        const pane = this.coord.panes['main'];
        if (!pane) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
        ctx.clip();

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        const isNarrow = this.coord.barWidth < 1.5;

        if (isNarrow) {
            ctx.lineWidth = Math.max(0.5, this.coord.barWidth);
            
            // Batch draw Up candles (green)
            ctx.strokeStyle = this.theme.candleUp;
            ctx.beginPath();
            for (let i = start; i <= end; i++) {
                const d = dataList[i];
                if (d.isHidden) continue;
                if (d.close >= d.open) {
                    const x = this.coord.indexToX(i);
                    const highY = this.coord.valueToY('main', d.high);
                    const lowY = this.coord.valueToY('main', d.low);
                    ctx.moveTo(x, highY);
                    ctx.lineTo(x, lowY);
                }
            }
            ctx.stroke();

            // Batch draw Down candles (red)
            ctx.strokeStyle = this.theme.candleDown;
            ctx.beginPath();
            for (let i = start; i <= end; i++) {
                const d = dataList[i];
                if (d.isHidden) continue;
                if (d.close < d.open) {
                    const x = this.coord.indexToX(i);
                    const highY = this.coord.valueToY('main', d.high);
                    const lowY = this.coord.valueToY('main', d.low);
                    ctx.moveTo(x, highY);
                    ctx.lineTo(x, lowY);
                }
            }
            ctx.stroke();
        } else {
            ctx.lineWidth = 1.5;

            for (let i = start; i <= end; i++) {
                const d = dataList[i];
                if (d.isHidden) continue;
                const x = this.coord.indexToX(i);
                
                const openY = this.coord.valueToY('main', d.open);
                const closeY = this.coord.valueToY('main', d.close);
                const highY = this.coord.valueToY('main', d.high);
                const lowY = this.coord.valueToY('main', d.low);

                const isUp = d.close >= d.open;
                const color = isUp ? this.theme.candleUp : this.theme.candleDown;
                const wickColor = isUp ? this.theme.wickUp : this.theme.wickDown;

                // 1. Draw wick (shadow lines)
                ctx.strokeStyle = wickColor;
                ctx.beginPath();
                ctx.moveTo(x, highY);
                ctx.lineTo(x, Math.min(openY, closeY)); // top wick
                ctx.moveTo(x, lowY);
                ctx.lineTo(x, Math.max(openY, closeY)); // bottom wick
                ctx.stroke();

                // 2. Draw candle body (rectangle)
                ctx.fillStyle = color;
                const bodyH = Math.abs(closeY - openY);
                const bodyW = this.coord.barWidth;
                const bodyX = x - bodyW / 2;

                if (bodyH < 1) {
                    // If price didn't change, draw a tiny line
                    ctx.fillRect(bodyX, openY - 0.5, bodyW, 1);
                } else {
                    ctx.fillRect(bodyX, Math.min(openY, closeY), bodyW, bodyH);
                }
            }
        }

        ctx.restore();
    }

    drawIndicatorLines(dataList, startIndex, endIndex, indicators) {
        if (!indicators) return;

        const ctx = this.ctx;
        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        // Build indicator fast maps
        const indicatorMaps = {};
        Object.entries(indicators).forEach(([name, config]) => {
            if (config.data) {
                const map = new Map();
                config.data.forEach(item => {
                    if (item.time !== undefined && item.value !== undefined) {
                        const timeMs = typeof item.time === 'number' ? item.time : new Date(item.time).getTime();
                        if (!isNaN(timeMs)) {
                            map.set(timeMs, item.value);
                        }
                    }
                });
                indicatorMaps[name] = map;
            }
        });

        Object.entries(indicators).forEach(([name, config]) => {
            const valueMap = indicatorMaps[name];
            if (!valueMap || valueMap.size === 0) return;

            const isMain = config.type === 'main';
            const paneName = isMain ? 'main' : (config.pane || `PANE_${name}`);
            const pane = this.coord.panes[paneName];
            if (!pane) return;

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
            ctx.clip();

            ctx.strokeStyle = config.color || '#fff';
            ctx.lineWidth = config.lineWidth || 1.5;
            if (config.style === 'dashed') {
                ctx.setLineDash([4, 4]);
            } else {
                ctx.setLineDash([]);
            }

            ctx.beginPath();
            let first = true;

            for (let i = start; i <= end; i++) {
                const d = dataList[i];
                if (d.isHidden) {
                    first = true;
                    continue;
                }
                const x = this.coord.indexToX(i);

                // Find matching indicator value by time using O(1) Map lookup
                const val = valueMap.get(d.timestamp);
                if (val !== undefined) {
                    const y = this.coord.valueToY(paneName, val);
                    if (first) {
                        ctx.moveTo(x, y);
                        first = false;
                    } else {
                        ctx.lineTo(x, y);
                    }
                } else {
                    // Gap in data, break line
                    first = true;
                }
            }
            ctx.stroke();

            ctx.restore();
        });

        // Reset dash
        ctx.setLineDash([]);
    }

    drawVolume(dataList, startIndex, endIndex, layout) {
        const ctx = this.ctx;
        const pane = this.coord.panes['volume'];
        if (!pane) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
        ctx.clip();

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        for (let i = start; i <= end; i++) {
            const d = dataList[i];
            if (d.isHidden) continue;
            const x = this.coord.indexToX(i);
            const valY = this.coord.valueToY('volume', d.volume);
            const zeroY = this.coord.valueToY('volume', 0);

            const isUp = d.close >= d.open;
            ctx.fillStyle = isUp ? this.theme.volumeUp : this.theme.volumeDown;

            const w = this.coord.barWidth;
            const h = zeroY - valY;
            ctx.fillRect(x - w / 2, valY, w, Math.max(1, h));
        }

        ctx.restore();
    }

    drawEquity(dataList, startIndex, endIndex) {
        const ctx = this.ctx;
        const pane = this.coord.panes['equity'];
        if (!pane) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
        ctx.clip();

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        ctx.strokeStyle = this.theme.equity;
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        let first = true;
        for (let i = start; i <= end; i++) {
            const d = dataList[i];
            if (d.isHidden) {
                first = true;
                continue;
            }
            const x = this.coord.indexToX(i);
            const eq = d.equity !== undefined ? d.equity : 0;
            const y = this.coord.valueToY('equity', eq);

            if (first) {
                ctx.moveTo(x, y);
                first = false;
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        ctx.restore();
    }

    drawPosition(dataList, startIndex, endIndex) {
        const ctx = this.ctx;
        const pane = this.coord.panes['position'];
        if (!pane) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
        ctx.clip();

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        ctx.strokeStyle = this.theme.position;
        ctx.lineWidth = 2;
        ctx.beginPath();

        let prevX = null;
        let prevY = null;

        for (let i = start; i <= end; i++) {
            const d = dataList[i];
            if (d.isHidden) {
                prevX = null;
                continue;
            }
            const x = this.coord.indexToX(i);
            const pos = d.position !== undefined ? d.position : 0;
            const y = this.coord.valueToY('position', pos);

            if (prevX === null) {
                ctx.moveTo(x, y);
            } else {
                // Stepped line chart: draw horizontal line, then vertical line
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            }
            prevX = x;
            prevY = y;
        }
        ctx.stroke();

        ctx.restore();
    }

    drawTradeMarkers(trades, dataList) {
        if (!trades || trades.length === 0 || !dataList || dataList.length === 0) return;

        const ctx = this.ctx;
        const pane = this.coord.panes['main'];
        if (!pane) return;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, pane.yMin, this.canvas.width, pane.yMax - pane.yMin);
        ctx.clip();

        const buyOffsets = {};
        const sellOffsets = {};

        trades.forEach(t => {
            const tradeTime = new Date(t.time).getTime();
            
            // Find candle index matching trade time (or closest preceding candle)
            let matchIdx = -1;
            for (let i = 0; i < dataList.length; i++) {
                const nextTime = (i < dataList.length - 1) ? dataList[i+1].timestamp : Number.MAX_SAFE_INTEGER;
                if (tradeTime >= dataList[i].timestamp && tradeTime < nextTime) {
                    matchIdx = i;
                    break;
                }
            }

            if (matchIdx >= this.coord.startIndex && matchIdx <= this.coord.endIndex) {
                const x = this.coord.indexToX(matchIdx);
                const candle = dataList[matchIdx];
                
                const isBuy = t.type === 'BUY';
                const color = isBuy ? '#00EDA0' : '#FF4976';
                const borderColor = isBuy ? '#005e3eff' : '#63041cff';

                // Draw exact price dot and connector line
                if (t.price !== undefined && t.price !== null) {
                    const dotY = this.coord.valueToY('main', t.price);
                    const boundaryY = this.coord.valueToY('main', isBuy ? candle.low : candle.high);
                    
                    // 1. Draw dashed connector line
                    ctx.save();
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 0.8;
                    ctx.setLineDash([2, 2]);
                    ctx.beginPath();
                    ctx.moveTo(x, dotY);
                    ctx.lineTo(x, boundaryY);
                    ctx.stroke();
                    ctx.restore();

                    // 2. Draw exact price dot
                    ctx.beginPath();
                    ctx.arc(x, dotY, 4, 0, 2 * Math.PI);
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 1.2;
                    ctx.stroke();
                }

                if (isBuy) {
                    const offset = buyOffsets[matchIdx] || 0;
                    // Buy Arrow pointing AT low price (from below)
                    const y = this.coord.valueToY('main', candle.low) + offset;
                    
                    // Polygon Arrow pointing UP (from below low price)
                    ctx.fillStyle = color;
                    ctx.strokeStyle = borderColor;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, y + 2); // tip
                    ctx.lineTo(x - 5, y + 10);
                    ctx.lineTo(x + 5, y + 10);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();

                    // Text "開多" / "平空" etc. below the arrow
                    ctx.fillStyle = color;
                    ctx.font = 'bold 10px Inter, system-ui';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(t.note || '買', x, y + 12);

                    // Update offset for the next buy marker on the same candle
                    buyOffsets[matchIdx] = offset + 24;
                } else {
                    const offset = sellOffsets[matchIdx] || 0;
                    // Sell Arrow pointing AT high price (from above)
                    const y = this.coord.valueToY('main', candle.high) - offset;

                    // Polygon Arrow pointing DOWN (from above high price)
                    ctx.fillStyle = color;
                    ctx.strokeStyle = borderColor;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x, y - 2); // tip
                    ctx.lineTo(x - 5, y - 10);
                    ctx.lineTo(x + 5, y - 10);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();

                    // Text "開空" / "平多" etc. above the arrow
                    ctx.fillStyle = color;
                    ctx.font = 'bold 10px Inter, system-ui';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(t.note || '賣', x, y - 12);

                    // Update offset for the next sell marker on the same candle
                    sellOffsets[matchIdx] = offset + 24;
                }
            }
        });

        ctx.restore();
    }

    drawLifecycleMarkers(lifecycleEvents, dataList, totalChartHeight) {
        if (!lifecycleEvents || lifecycleEvents.length === 0 || !dataList || dataList.length === 0) return;

        const ctx = this.ctx;

        lifecycleEvents.forEach(e => {
            const eventTime = new Date(e.time).getTime();
            
            // Find matching candle index
            let matchIdx = -1;
            for (let i = 0; i < dataList.length; i++) {
                const nextTime = (i < dataList.length - 1) ? dataList[i+1].timestamp : Number.MAX_SAFE_INTEGER;
                if (eventTime >= dataList[i].timestamp && eventTime < nextTime) {
                    matchIdx = i;
                    break;
                }
            }

            if (matchIdx >= this.coord.startIndex && matchIdx <= this.coord.endIndex) {
                const x = this.coord.indexToX(matchIdx);
                const color = e.color || '#888888';
                
                // Draw Vertical Dashed Line
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, totalChartHeight);
                ctx.stroke();
                ctx.setLineDash([]);

                // Draw Text Label at top of chart
                ctx.fillStyle = color;
                ctx.font = '9px Inter, sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(e.text || '', x + 4, 10);
            }
        });
    }

    drawAxes(layouts, dataList, startIndex, endIndex, width, height, chartWidth, totalChartHeight, yAxisWidth, xAxisHeight, timeframe, pricePrecision) {
        const ctx = this.ctx;
        
        // Axis Styles
        ctx.strokeStyle = this.theme.axisLine;
        ctx.fillStyle = this.theme.text;
        ctx.font = '10px Inter, system-ui';
        ctx.lineWidth = 1;

        // Draw Vertical Border line between chart area and Y Axis
        ctx.beginPath();
        ctx.moveTo(chartWidth, 0);
        ctx.lineTo(chartWidth, totalChartHeight);
        ctx.stroke();

        // Draw Horizontal Border line between chart area and X Axis
        ctx.beginPath();
        ctx.moveTo(0, totalChartHeight);
        ctx.lineTo(width, totalChartHeight);
        ctx.stroke();

        // 1. Draw Y Axis values for each Pane
        Object.entries(layouts).forEach(([paneName, layout]) => {
            const pane = this.coord.panes[paneName];
            if (!pane) return;

            const yRange = layout.yMax - layout.yMin;
            const steps = 4;

            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';

            for (let i = 0; i <= steps; i++) {
                const ratio = i / steps;
                const y = layout.yMax - ratio * yRange;
                const value = pane.valMin + ratio * pane.valRange;
                
                // Draw tiny tick mark
                ctx.beginPath();
                ctx.moveTo(chartWidth, y);
                ctx.lineTo(chartWidth + 4, y);
                ctx.stroke();

                // Format number based on value size
                let formattedValue = '';
                if (paneName === 'volume') {
                    formattedValue = value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` :
                                     value >= 1000 ? `${(value / 1000).toFixed(1)}K` :
                                     value.toFixed(0);
                } else if (paneName === 'position') {
                    formattedValue = value.toFixed(1);
                } else {
                    formattedValue = (pricePrecision !== undefined && pricePrecision !== null)
                        ? value.toFixed(pricePrecision)
                        : (value >= 100 ? value.toFixed(2) : value.toFixed(4));
                }

                ctx.fillText(formattedValue, chartWidth + 8, y);
            }
        });

        // 2. Draw X Axis values (Time stamps)
        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        const stepPx = 80;
        const barStep = Math.max(1, Math.round(stepPx / (this.coord.barWidth + this.coord.barSpace)));

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (let i = start; i <= end; i++) {
            if ((i - start) % barStep === 0) {
                const x = this.coord.indexToX(i);
                const d = dataList[i];
                
                // Draw tiny tick mark
                ctx.beginPath();
                ctx.moveTo(x, totalChartHeight);
                ctx.lineTo(x, totalChartHeight + 4);
                ctx.stroke();

                // Format date string based on timeframe
                const date = new Date(d.timestamp);
                let label = '';
                if (timeframe.endsWith('d') || timeframe.endsWith('w') || timeframe.endsWith('M')) {
                    label = format(date, 'yyyy-MM-dd');
                } else if (timeframe.includes('h')) {
                    label = format(date, 'MM-dd HH:mm');
                } else {
                    label = format(date, 'HH:mm');
                }

                ctx.fillText(label, x, totalChartHeight + 8);
            }
        }

        // 3. Draw latest price label on the Y Axis
        if (dataList && dataList.length > 0) {
            const lastCandle = dataList[dataList.length - 1];
            if (lastCandle) {
                const lastClose = lastCandle.close;
                const lastOpen = lastCandle.open;
                const isUp = lastClose >= lastOpen;
                
                const lastPriceY = this.coord.valueToY('main', lastClose);
                const mainLayout = layouts['main'];
                
                // Ensure the price coordinate is within main layout boundaries
                if (mainLayout && lastPriceY >= mainLayout.yMin && lastPriceY <= mainLayout.yMax) {
                    const precision = (pricePrecision !== undefined && pricePrecision !== null) ? pricePrecision : 2;
                    const formattedPrice = lastClose.toFixed(precision);
                    
                    const labelH = 18;
                    const labelW = yAxisWidth - 2;
                    const labelX = chartWidth;
                    const labelY = lastPriceY - labelH / 2;
                    
                    ctx.save();
                    
                    // Background color based on candle direction
                    ctx.fillStyle = isUp ? '#26a69a' : '#ef5350';
                    ctx.fillRect(labelX, labelY, labelW, labelH);
                    
                    // Draw a subtle white border
                    ctx.strokeStyle = '#ffffff';
                    ctx.lineWidth = 0.5;
                    ctx.strokeRect(labelX, labelY, labelW, labelH);
                    
                    // Draw white price text
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 10px Inter, system-ui';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(formattedPrice, labelX + 6, lastPriceY);
                    
                    ctx.restore();
                }
            }
        }
    }

    drawPaneBorders(layouts, width) {
        const ctx = this.ctx;
        ctx.strokeStyle = '#2b2f3a'; // Border line color
        ctx.lineWidth = 1;

        Object.entries(layouts).forEach(([paneName, layout]) => {
            // Draw bottom border line of the pane
            ctx.beginPath();
            ctx.moveTo(0, layout.yMax);
            ctx.lineTo(width, layout.yMax);
            ctx.stroke();

            // Draw top border line if it's not the main pane
            // Since subPaneGap is 0, layout.yMin of a pane is yMax of the upper pane,
            // so we draw this to ensure sub-panes have a clear top border.
            if (paneName !== 'main') {
                ctx.beginPath();
                ctx.moveTo(0, layout.yMin);
                ctx.lineTo(width, layout.yMin);
                ctx.stroke();
            }
        });
    }

    drawMinMaxLabels(dataList, startIndex, endIndex, chartWidth, pricePrecision) {
        if (!dataList || dataList.length === 0) return;

        const start = Math.max(0, startIndex);
        const end = Math.min(dataList.length - 1, endIndex);

        let maxVal = -Number.MAX_VALUE;
        let minVal = Number.MAX_VALUE;
        let maxIdx = -1;
        let minIdx = -1;

        for (let i = start; i <= end; i++) {
            const d = dataList[i];
            if (!d || d.isHidden) continue;

            if (d.high > maxVal) {
                maxVal = d.high;
                maxIdx = i;
            }
            if (d.low < minVal) {
                minVal = d.low;
                minIdx = i;
            }
        }

        if (maxIdx === -1 || minIdx === -1) return;

        const ctx = this.ctx;
        const pane = this.coord.panes['main'];
        if (!pane) return;

        const precision = (pricePrecision !== undefined && pricePrecision !== null) ? pricePrecision : 2;

        // Calculate Y/X coordinates
        const maxX = this.coord.indexToX(maxIdx);
        const maxY = this.coord.valueToY('main', maxVal);
        const minX = this.coord.indexToX(minIdx);
        const minY = this.coord.valueToY('main', minVal);

        // 1. Draw highest price marker & dotted horizontal line
        ctx.save();
        ctx.strokeStyle = 'rgba(38, 166, 154, 0.45)'; // Muted candleUp green
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(maxX, maxY);
        ctx.lineTo(chartWidth, maxY);
        ctx.stroke();
        ctx.setLineDash([]); // Restore solid



        // Draw highest price text
        ctx.fillStyle = '#26a69a';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${maxVal.toFixed(precision)} (Max)`, chartWidth - 5, maxY - 2);
        ctx.restore();

        // 2. Draw lowest price marker & dotted horizontal line
        ctx.save();
        ctx.strokeStyle = 'rgba(239, 83, 80, 0.45)'; // Muted candleDown red
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(minX, minY);
        ctx.lineTo(chartWidth, minY);
        ctx.stroke();
        ctx.setLineDash([]); // Restore solid



        // Draw lowest price text
        ctx.fillStyle = '#ef5350';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(`${minVal.toFixed(precision)} (Min)`, chartWidth - 5, minY + 2);
        ctx.restore();
    }
    drawLastPriceLine(dataList, chartWidth) {
        if (!dataList || dataList.length === 0) return;
        
        const lastCandle = dataList[dataList.length - 1];
        if (!lastCandle) return;
        
        const lastClose = lastCandle.close;
        const lastOpen = lastCandle.open;
        const isUp = lastClose >= lastOpen;
        
        const lastPriceY = this.coord.valueToY('main', lastClose);
        const pane = this.coord.panes['main'];
        if (!pane) return;
        
        // Ensure within main pane boundaries
        if (lastPriceY >= pane.yMin && lastPriceY <= pane.yMax) {
            const ctx = this.ctx;
            ctx.save();
            // Up is light green, Down is light red
            ctx.strokeStyle = isUp ? 'rgba(38, 166, 154, 0.45)' : 'rgba(239, 83, 80, 0.45)';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, lastPriceY);
            ctx.lineTo(chartWidth, lastPriceY);
            ctx.stroke();
            ctx.restore();
        }
    }

    render({ layouts, dataList, startIndex, endIndex, showVolume, showEquity, showPosition, indicators, trades, lifecycleEvents, width, height, chartWidth, totalChartHeight, yAxisWidth, xAxisHeight, timeframe, pricePrecision, drawings, focusedDrawingIndex }) {
        this.clear();

        if (!dataList || dataList.length === 0) {
            // Draw empty state
            this.ctx.fillStyle = this.theme.text;
            this.ctx.font = '14px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('No data available', width / 2, height / 2);
            return;
        }

        // 1. Calculate Pane ranges and register in coordinate system
        const ranges = this.computePaneRanges(dataList, startIndex, endIndex, indicators, showVolume, showEquity, showPosition);
        Object.entries(layouts).forEach(([paneName, layout]) => {
            const range = ranges[paneName];
            if (range) {
                this.coord.setPaneYRange(paneName, range.min, range.max, layout.yMin, layout.yMax);
            }
        });

        // Register volume coordinates manually as main chart overlay (bottom 20% of main layout)
        if (showVolume) {
            const volRange = ranges['volume'];
            const mainLayout = layouts['main'];
            if (volRange && mainLayout) {
                const mainHeight = mainLayout.yMax - mainLayout.yMin;
                const volYMin = mainLayout.yMax - mainHeight * 0.2;
                const volYMax = mainLayout.yMax - 2;
                this.coord.setPaneYRange('volume', volRange.min, volRange.max, volYMin, volYMax);
            }
        }

        // 2. Draw Grids
        this.drawGrid(layouts, chartWidth);
        this.drawXAxisGrid(dataList, startIndex, endIndex, chartWidth, totalChartHeight);

        // 3. Draw Data elements (Use clip path so drawings don't overlap onto axes)
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, 0, chartWidth, totalChartHeight);
        this.ctx.clip();

        // Render main candlesticks
        this.drawCandlesticks(dataList, startIndex, endIndex);

        // Render main indicators overlay (MA, etc.)
        this.drawIndicatorLines(dataList, startIndex, endIndex, indicators);

        // Render volume overlay on main pane bottom
        if (showVolume) {
            this.drawVolume(dataList, startIndex, endIndex);
        }

        // Render equity sub-pane
        if (showEquity && layouts['equity']) {
            this.drawEquity(dataList, startIndex, endIndex);
        }

        // Render position sub-pane
        if (showPosition && layouts['position']) {
            this.drawPosition(dataList, startIndex, endIndex);
        }

        // Render trade markers (buy/sell arrows)
        this.drawTradeMarkers(trades, dataList);

        // Render lifecycle events
        this.drawLifecycleMarkers(lifecycleEvents, dataList, totalChartHeight);

        // Render visible range highest & lowest price labels
        this.drawMinMaxLabels(dataList, startIndex, endIndex, chartWidth, pricePrecision);

        // Render current latest price line
        this.drawLastPriceLine(dataList, chartWidth);

        // Render custom user drawings
        if (drawings && drawings.length > 0) {
            this.drawCustomDrawings(drawings, dataList, timeframe, pricePrecision, chartWidth, focusedDrawingIndex);
        }

        this.ctx.restore();

        // 4. Draw border lines, Y/X Axes ticks & texts
        this.drawAxes(layouts, dataList, startIndex, endIndex, width, height, chartWidth, totalChartHeight, yAxisWidth, xAxisHeight, timeframe, pricePrecision);

        // 5. Draw Pane border lines
        this.drawPaneBorders(layouts, width);
    }

    timestampToIndex(ts, dataList, timeframe) {
        if (!dataList || dataList.length === 0) return 0;
        
        // 1. Exact match
        const exactIdx = dataList.findIndex(d => d.timestamp === ts);
        if (exactIdx !== -1) return exactIdx;
        
        // 2. Interpolate/estimate index based on timeframe interval if out of range
        const getIntervalMs = (tf) => {
            const unit = tf.slice(-1);
            const num = parseInt(tf.slice(0, -1)) || 1;
            if (unit === 'm') return num * 60 * 1000;
            if (unit === 'h') return num * 60 * 60 * 1000;
            if (unit === 'd') return num * 24 * 60 * 60 * 1000;
            if (unit === 'w') return num * 7 * 24 * 60 * 60 * 1000;
            if (unit === 'M') return num * 30 * 24 * 60 * 60 * 1000;
            return 60 * 1000;
        };
        const interval = getIntervalMs(timeframe);
        const firstTs = dataList[0].timestamp;
        
        return Math.round((ts - firstTs) / interval);
    }

    drawCustomDrawings(drawings, dataList, timeframe, pricePrecision, chartWidth, focusedDrawingIndex) {
        const ctx = this.ctx;
        
        drawings.forEach((d, idx) => {
            const isFocused = idx === focusedDrawingIndex;
            const defaultColor = d.type === 'polyline' ? '#ffae00' : '#00b2ff';
            const color = d.color || defaultColor;
            
            // Helper to apply dash styles
            const applyDashStyle = (context, style) => {
                if (style === 'dash-short') {
                    context.setLineDash([2, 2]);
                } else if (style === 'dash-medium') {
                    context.setLineDash([6, 6]);
                } else if (style === 'dash-long') {
                    context.setLineDash([12, 6]);
                } else {
                    context.setLineDash([]);
                }
            };
            
            if (d.type === 'trendline') {
                const idx1 = this.timestampToIndex(d.p1.timestamp, dataList, timeframe);
                const idx2 = this.timestampToIndex(d.p2.timestamp, dataList, timeframe);
                
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                ctx.save();
                if (isFocused) {
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 6;
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = isFocused ? 3 : 2;
                applyDashStyle(ctx, d.lineStyle);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                ctx.restore();
                
                // Endpoints (Only when focused or hovering)
                if (isFocused) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    
                    ctx.beginPath();
                    ctx.arc(x1, y1, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    
                    ctx.beginPath();
                    ctx.arc(x2, y2, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
            } else if (d.type === 'ray') {
                const idx1 = this.timestampToIndex(d.p1.timestamp, dataList, timeframe);
                const idx2 = this.timestampToIndex(d.p2.timestamp, dataList, timeframe);
                
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                // Infinite ray projection
                let targetX = x2;
                let targetY = y2;
                if (x2 !== x1) {
                    const slope = (y2 - y1) / (x2 - x1);
                    if (x2 > x1) {
                        targetX = chartWidth;
                        targetY = y1 + (chartWidth - x1) * slope;
                    } else {
                        targetX = 0;
                        targetY = y1 + (0 - x1) * slope;
                    }
                } else {
                    targetY = y2 > y1 ? 2000 : -2000;
                }
                
                ctx.save();
                if (isFocused) {
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 6;
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = isFocused ? 3 : 2;
                applyDashStyle(ctx, d.lineStyle);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(targetX, targetY);
                ctx.stroke();
                ctx.restore();
                
                // Endpoints (Only when focused)
                if (isFocused) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    
                    ctx.beginPath();
                    ctx.arc(x1, y1, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    
                    ctx.beginPath();
                    ctx.arc(x2, y2, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
            } else if (d.type === 'horizontal') {
                const y = this.coord.valueToY('main', d.price);
                
                ctx.save();
                if (isFocused) {
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 6;
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = isFocused ? 2.5 : 1.5;
                applyDashStyle(ctx, d.lineStyle);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(chartWidth, y);
                ctx.stroke();
                ctx.restore();
                
                // Draw a center control point when focused
                if (isFocused) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(chartWidth / 2, y, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
            } else if (d.type === 'polyline') {
                if (!d.points || d.points.length < 2) return;
                
                ctx.save();
                if (isFocused) {
                    ctx.shadowColor = color;
                    ctx.shadowBlur = 6;
                }
                ctx.strokeStyle = color;
                ctx.lineWidth = isFocused ? 3 : 2;
                applyDashStyle(ctx, d.lineStyle);
                ctx.beginPath();
                
                d.points.forEach((p, pIdx) => {
                    const i = this.timestampToIndex(p.timestamp, dataList, timeframe);
                    const x = this.coord.indexToX(i);
                    const y = this.coord.valueToY('main', p.price);
                    
                    if (pIdx === 0) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                });
                
                ctx.stroke();
                ctx.restore();
                
                // Draw vertices (Only when focused)
                if (isFocused) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 2;
                    d.points.forEach((p) => {
                        const i = this.timestampToIndex(p.timestamp, dataList, timeframe);
                        const x = this.coord.indexToX(i);
                        const y = this.coord.valueToY('main', p.price);
                        
                        ctx.beginPath();
                        ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
                        ctx.fill();
                        ctx.stroke();
                    });
                    ctx.restore();
                }
            } else if (d.type === 'measurement') {
                const idx1 = this.timestampToIndex(d.p1.timestamp, dataList, timeframe);
                const idx2 = this.timestampToIndex(d.p2.timestamp, dataList, timeframe);
                
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                const priceDiff = d.p2.price - d.p1.price;
                const percentDiff = (priceDiff / d.p1.price) * 100;
                const barsDiff = Math.abs(idx2 - idx1);
                
                const isUp = priceDiff >= 0;
                const borderCol = d.color || (isUp ? '#00EDA0' : '#FF4976');
                const fillColor = d.color ? `${d.color}1e` : (isUp ? 'rgba(0, 237, 160, 0.12)' : 'rgba(255, 73, 118, 0.12)');
                
                ctx.save();
                
                // Measurement Area Fill
                ctx.fillStyle = fillColor;
                ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
                
                // Border
                ctx.strokeStyle = borderCol;
                ctx.lineWidth = isFocused ? 2.2 : 1.2;
                if (isFocused) {
                    ctx.shadowColor = borderCol;
                    ctx.shadowBlur = 6;
                }
                applyDashStyle(ctx, d.lineStyle || 'dash-short');
                ctx.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
                
                // Diagonal Connection Line
                ctx.setLineDash([]);
                ctx.strokeStyle = borderCol;
                ctx.lineWidth = isFocused ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
                ctx.restore();
                
                // Dots (Only when focused)
                if (isFocused) {
                    ctx.save();
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = borderCol;
                    ctx.lineWidth = 2;
                    
                    ctx.beginPath();
                    ctx.arc(x1, y1, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    
                    ctx.beginPath();
                    ctx.arc(x2, y2, 4.5, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.stroke();
                    ctx.restore();
                }
                
                // Label box
                ctx.save();
                const labelX = x1 + (x2 - x1) / 2;
                const labelY = y2 - (isUp ? 22 : -18); 
                
                const txtPrice = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(pricePrecision)} (${priceDiff >= 0 ? '+' : ''}${percentDiff.toFixed(2)}%)`;
                const txtBars = `${barsDiff} bars`;
                
                ctx.font = 'bold 10px Inter, sans-serif';
                const textWidth = Math.max(ctx.measureText(txtPrice).width, ctx.measureText(txtBars).width) + 16;
                const boxW = textWidth;
                const boxH = 32;
                const boxX = labelX - boxW / 2;
                const boxY = labelY - boxH / 2;
                
                ctx.fillStyle = 'rgba(20, 23, 31, 0.9)';
                ctx.strokeStyle = borderCol;
                ctx.lineWidth = 1;
                ctx.fillRect(boxX, boxY, boxW, boxH);
                ctx.strokeRect(boxX, boxY, boxW, boxH);
                
                ctx.fillStyle = '#f0f3fa';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(txtPrice, labelX, boxY + 5);
                ctx.fillStyle = '#8f96a3';
                ctx.fillText(txtBars, labelX, boxY + 18);
                
                ctx.restore();
            }
        });
    }
}
