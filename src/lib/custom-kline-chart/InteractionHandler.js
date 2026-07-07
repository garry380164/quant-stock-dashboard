export class InteractionHandler {
    constructor(canvas, coordSystem, onUpdateRange, onCrosshairMove, onCrosshairLeave, onResizePane) {
        this.canvas = canvas;
        this.coord = coordSystem;
        this.onUpdateRange = onUpdateRange;
        this.onCrosshairMove = onCrosshairMove;
        this.onCrosshairLeave = onCrosshairLeave;
        this.onResizePane = onResizePane;

        this.isDragging = false;
        this.startX = 0;
        this.startY = 0;
        this.startStartIndex = 0;
        this.startEndIndex = 0;
        this.hoveredNode = null;
        this.draggedNode = null;
        this.focusedDrawingIndex = null;
        this.hoveredDrawingIndex = -1;
        this.onFocusDrawingChanged = null;
        
        // Y scale dragging & Pane resize state
        this.dragMode = 'chart-scroll'; // 'chart-scroll', 'y-zoom', 'pane-resize', 'node-drag', or 'line-drag'
        this.startManualMin = 0;
        this.startManualMax = 0;
        
        this.resizeSplitterIndex = -1;
        this.resizeUpperPane = null;
        this.resizeLowerPane = null;
        this.startHeightUpper = 0;
        this.startHeightLower = 0;

        this.dataLength = 0;
        this.chartWidth = 0;

        // Mobile tap and double tap drawing states
        this.lastTapTime = 0;
        this.touchStartX = 0;
        this.touchStartY = 0;

        // Use arrow functions or bind to preserve 'this' context in event handlers
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);
        this.handleWheel = this.handleWheel.bind(this);
        this.handleDblClick = this.handleDblClick.bind(this);
        this.handleContextMenu = this.handleContextMenu.bind(this);
        
        // Touch events binds
        this.handleTouchStart = this.handleTouchStart.bind(this);
        this.handleTouchMove = this.handleTouchMove.bind(this);
        this.handleTouchEnd = this.handleTouchEnd.bind(this);
        this.handleTouchCancel = this.handleTouchCancel.bind(this);

        this.bindEvents();
    }

    setDataLength(len) {
        this.dataLength = len;
    }

    adjustDragStartIndices(diff) {
        if (this.isDragging) {
            this.startStartIndex += diff;
            this.startEndIndex += diff;
        }
    }

    setChartWidth(width) {
        this.chartWidth = width;
    }

    bindEvents() {
        this.canvas.addEventListener('mousedown', this.handleMouseDown);
        this.canvas.addEventListener('mousemove', this.handleMouseMove);
        this.canvas.addEventListener('mouseup', this.handleMouseUp);
        this.canvas.addEventListener('mouseleave', this.handleMouseLeave);
        this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
        this.canvas.addEventListener('dblclick', this.handleDblClick);
        this.canvas.addEventListener('contextmenu', this.handleContextMenu);

        // Touch event listeners
        this.canvas.addEventListener('touchstart', this.handleTouchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this.handleTouchMove, { passive: false });
        this.canvas.addEventListener('touchend', this.handleTouchEnd, { passive: false });
        this.canvas.addEventListener('touchcancel', this.handleTouchCancel, { passive: false });
    }

    unbindEvents() {
        this.canvas.removeEventListener('mousedown', this.handleMouseDown);
        this.canvas.removeEventListener('mousemove', this.handleMouseMove);
        this.canvas.removeEventListener('mouseup', this.handleMouseUp);
        this.canvas.removeEventListener('mouseleave', this.handleMouseLeave);
        this.canvas.removeEventListener('wheel', this.handleWheel);
        this.canvas.removeEventListener('dblclick', this.handleDblClick);
        this.canvas.removeEventListener('contextmenu', this.handleContextMenu);

        // Remove touch event listeners
        this.canvas.removeEventListener('touchstart', this.handleTouchStart);
        this.canvas.removeEventListener('touchmove', this.handleTouchMove);
        this.canvas.removeEventListener('touchend', this.handleTouchEnd);
        this.canvas.removeEventListener('touchcancel', this.handleTouchCancel);
    }

    getSplitterUnderMouse(mouseX, mouseY) {
        if (mouseX > this.chartWidth) return -1;

        // Sort active panes from top to bottom by yMin
        // Filter out 'volume' as it is no longer an independent pane
        const activePanes = Object.entries(this.coord.panes)
            .filter(([name]) => name !== 'volume')
            .map(([name, pane]) => ({ name, ...pane }))
            .sort((a, b) => a.yMin - b.yMin);

        for (let i = 0; i < activePanes.length - 1; i++) {
            const upper = activePanes[i];
            const lower = activePanes[i+1];
            // Since subPaneGap is 0, the splitter line is exactly lower.yMin
            const center = lower.yMin;
            
            // Allow a 10px target zone (5px above and below center)
            if (mouseY >= center - 5 && mouseY <= center + 5) {
                return i;
            }
        }
        return -1;
    }

    handleMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (this.activeTool && this.activeTool !== 'cursor') {
            if (this.onDrawingMouseDown) {
                this.onDrawingMouseDown(mouseX, mouseY, e);
            }
            e.preventDefault();
            return;
        }

        if ((!this.activeTool || this.activeTool === 'cursor') && this.hoveredNode) {
            this.dragMode = 'node-drag';
            this.draggedNode = { ...this.hoveredNode };
            this.isDragging = true;
            this.startX = e.clientX;
            this.startY = e.clientY;
            e.preventDefault();
            return;
        }

        if ((!this.activeTool || this.activeTool === 'cursor') && this.hoveredDrawingIndex !== -1) {
            this.dragMode = 'line-drag';
            this.focusedDrawingIndex = this.hoveredDrawingIndex;
            this.isDragging = true;
            this.startX = e.clientX;
            this.startY = e.clientY;
            
            this.startMouseXIndex = this.coord.xToIndex(mouseX);
            this.startMousePrice = this.coord.yToValue('main', mouseY);
            
            const d = this.drawings[this.focusedDrawingIndex];
            this.initialDrawingState = {};
            if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                this.initialDrawingState.p1 = {
                    index: this.timestampToIndex(d.p1.timestamp),
                    price: d.p1.price
                };
                this.initialDrawingState.p2 = {
                    index: this.timestampToIndex(d.p2.timestamp),
                    price: d.p2.price
                };
            } else if (d.type === 'horizontal') {
                this.initialDrawingState.price = d.price;
            } else if (d.type === 'polyline') {
                this.initialDrawingState.points = d.points.map(p => ({
                    index: this.timestampToIndex(p.timestamp),
                    price: p.price
                }));
            }
            
            if (this.onFocusDrawingChanged) {
                let avgX = mouseX;
                let minY = mouseY;
                if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                    const x1 = this.coord.indexToX(this.timestampToIndex(d.p1.timestamp));
                    const x2 = this.coord.indexToX(this.timestampToIndex(d.p2.timestamp));
                    const y1 = this.coord.valueToY('main', d.p1.price);
                    const y2 = this.coord.valueToY('main', d.p2.price);
                    avgX = (x1 + x2) / 2;
                    minY = Math.min(y1, y2);
                } else if (d.type === 'horizontal') {
                    const y = this.coord.valueToY('main', d.price);
                    avgX = mouseX;
                    minY = y;
                } else if (d.type === 'polyline') {
                    const xs = d.points.map(p => this.coord.indexToX(this.timestampToIndex(p.timestamp)));
                    const ys = d.points.map(p => this.coord.valueToY('main', p.price));
                    avgX = xs.reduce((sum, val) => sum + val, 0) / xs.length;
                    minY = Math.min(...ys);
                }
                this.onFocusDrawingChanged(this.focusedDrawingIndex, { x: avgX, y: minY });
            }
            e.preventDefault();
            return;
        }

        if (!this.activeTool || this.activeTool === 'cursor') {
            this.focusedDrawingIndex = null;
            if (this.onFocusDrawingChanged) {
                this.onFocusDrawingChanged(null, null);
            }
        }

        this.isDragging = true;
        this.startX = e.clientX;
        this.startY = e.clientY;
        this.startStartIndex = this.coord.startIndex;
        this.startEndIndex = this.coord.endIndex;

        const splitterIdx = this.getSplitterUnderMouse(mouseX, mouseY);

        if (splitterIdx >= 0) {
            // Drag on a pane splitter border
            const activePanes = Object.entries(this.coord.panes)
                .filter(([name]) => name !== 'volume')
                .map(([name, pane]) => ({ name, ...pane }))
                .sort((a, b) => a.yMin - b.yMin);

            this.dragMode = 'pane-resize';
            this.resizeSplitterIndex = splitterIdx;
            this.resizeUpperPane = activePanes[splitterIdx];
            this.resizeLowerPane = activePanes[splitterIdx + 1];
            this.startHeightUpper = this.resizeUpperPane.yMax - this.resizeUpperPane.yMin;
            this.startHeightLower = this.resizeLowerPane.yMax - this.resizeLowerPane.yMin;
            this.canvas.style.cursor = 'row-resize';
        } else if (mouseX > this.chartWidth) {
            // Drag on Y Axis: find which pane is under the mouse
            const activePanes = Object.entries(this.coord.panes)
                .map(([name, pane]) => ({ name, ...pane }));
            
            let targetPaneName = null;
            for (let pane of activePanes) {
                if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                    targetPaneName = pane.name;
                    break;
                }
            }

            if (targetPaneName) {
                this.dragMode = 'y-zoom';
                this.yZoomPaneName = targetPaneName;
                this.coord.yModes[targetPaneName] = 'manual';
                
                const range = this.coord.manualRanges[targetPaneName];
                this.startYZoomMin = range ? range.min : this.coord.panes[targetPaneName].valMin;
                this.startYZoomMax = range ? range.max : this.coord.panes[targetPaneName].valMax;
                this.canvas.style.cursor = 'ns-resize';
            } else {
                this.dragMode = 'chart-scroll';
                this.canvas.style.cursor = 'grabbing';
            }
        } else {
            // Check if clicking in X-axis (time labels) area below lowest pane
            const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
            if (mouseY > maxPaneY && maxPaneY > 0) {
                this.dragMode = 'x-zoom';
                this.startX = e.clientX;
                this.startY = e.clientY;
                this.startBarWidth = this.coord.barWidth;
                this.startXZoomMidX = mouseX;
                this.startXZoomMidIdx = this.coord.xToIndex(mouseX);
                this.canvas.style.cursor = 'ew-resize';
            } else {
                this.dragMode = 'chart-scroll';
                this.canvas.style.cursor = 'grabbing';

                // Find which pane was clicked for potential manual Y vertical scroll
                let activePane = null;
                Object.entries(this.coord.panes).forEach(([name, pane]) => {
                    if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                        activePane = name;
                    }
                });
                this.chartDragPaneName = activePane;
                if (activePane) {
                    const range = this.coord.manualRanges[activePane];
                    this.startManualMin = range ? range.min : this.coord.panes[activePane].valMin;
                    this.startManualMax = range ? range.max : this.coord.panes[activePane].valMax;
                }
            }
        }

        e.preventDefault();
    }

    handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (this.activeTool && this.activeTool !== 'cursor') {
            if (this.onDrawingMouseMove) {
                this.onDrawingMouseMove(mouseX, mouseY, e);
            }
            if (this.onCrosshairMove) {
                this.onCrosshairMove(mouseX, mouseY);
            }
            return;
        }

        if (this.isDragging) {
            if (this.dragMode === 'node-drag' && this.draggedNode) {
                const dataList = this.dataList;
                if (dataList && dataList.length > 0) {
                    const idx = this.coord.xToIndex(mouseX);
                    const safeIdx = Math.max(0, Math.min(dataList.length - 1, idx));
                    const timestamp = dataList[safeIdx].timestamp;
                    const price = this.coord.yToValue('main', mouseY);
                    
                    const dn = this.draggedNode;
                    const d = this.drawings[dn.drawingIndex];
                    
                    if (d) {
                        if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                            if (dn.nodeIndex === 1) {
                                d.p1.timestamp = timestamp;
                                d.p1.price = price;
                            } else if (dn.nodeIndex === 2) {
                                d.p2.timestamp = timestamp;
                                d.p2.price = price;
                            }
                        } else if (d.type === 'horizontal') {
                            d.price = price;
                        } else if (d.type === 'polyline') {
                            if (d.points && d.points[dn.nodeIndex]) {
                                d.points[dn.nodeIndex].timestamp = timestamp;
                                d.points[dn.nodeIndex].price = price;
                            }
                        }
                        
                        if (this.onDrawingsUpdated) {
                            this.onDrawingsUpdated();
                        }
                    }
                }
                
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(mouseX, mouseY);
                }
                
                e.preventDefault();
                return;
            }

            if (this.dragMode === 'line-drag' && this.focusedDrawingIndex !== null) {
                const dataList = this.dataList;
                if (dataList && dataList.length > 0) {
                    const currentIndex = this.coord.xToIndex(mouseX);
                    const currentPrice = this.coord.yToValue('main', mouseY);
                    
                    const deltaIndex = currentIndex - this.startMouseXIndex;
                    const deltaPrice = currentPrice - this.startMousePrice;
                    
                    const d = this.drawings[this.focusedDrawingIndex];
                    const state = this.initialDrawingState;
                    
                    if (d && state) {
                        if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                            const newIdx1 = Math.max(0, Math.min(dataList.length - 1, state.p1.index + deltaIndex));
                            const newIdx2 = Math.max(0, Math.min(dataList.length - 1, state.p2.index + deltaIndex));
                            
                            d.p1.timestamp = dataList[newIdx1].timestamp;
                            d.p1.price = state.p1.price + deltaPrice;
                            
                            d.p2.timestamp = dataList[newIdx2].timestamp;
                            d.p2.price = state.p2.price + deltaPrice;
                        } else if (d.type === 'horizontal') {
                            d.price = state.price + deltaPrice;
                        } else if (d.type === 'polyline') {
                            d.points.forEach((p, pIdx) => {
                                const origPoint = state.points[pIdx];
                                if (origPoint) {
                                    const newIdx = Math.max(0, Math.min(dataList.length - 1, origPoint.index + deltaIndex));
                                    p.timestamp = dataList[newIdx].timestamp;
                                    p.price = origPoint.price + deltaPrice;
                                }
                            });
                        }
                        
                        if (this.onDrawingsUpdated) {
                            this.onDrawingsUpdated();
                        }
                        
                        if (this.onFocusDrawingChanged) {
                            let avgX = mouseX;
                            let minY = mouseY;
                            if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                                const x1 = this.coord.indexToX(this.timestampToIndex(d.p1.timestamp));
                                const x2 = this.coord.indexToX(this.timestampToIndex(d.p2.timestamp));
                                const y1 = this.coord.valueToY('main', d.p1.price);
                                const y2 = this.coord.valueToY('main', d.p2.price);
                                avgX = (x1 + x2) / 2;
                                minY = Math.min(y1, y2);
                            } else if (d.type === 'horizontal') {
                                const y = this.coord.valueToY('main', d.price);
                                avgX = mouseX;
                                minY = y;
                            } else if (d.type === 'polyline') {
                                const xs = d.points.map(p => this.coord.indexToX(this.timestampToIndex(p.timestamp)));
                                const ys = d.points.map(p => this.coord.valueToY('main', p.price));
                                avgX = xs.reduce((sum, val) => sum + val, 0) / xs.length;
                                minY = Math.min(...ys);
                            }
                            this.onFocusDrawingChanged(this.focusedDrawingIndex, { x: avgX, y: minY });
                        }
                    }
                }
                
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(mouseX, mouseY);
                }
                e.preventDefault();
                return;
            }

            if (this.dragMode === 'pane-resize') {
                const deltaY = e.clientY - this.startY;
                let newHeightUpper = this.startHeightUpper + deltaY;
                let newHeightLower = this.startHeightLower - deltaY;
 
                // Pane height constraints (main >= 80px, sub >= 20px)
                const minUpper = this.resizeUpperPane.name === 'main' ? 80 : 20;
                const minLower = 20;
 
                if (newHeightUpper < minUpper) {
                    newHeightUpper = minUpper;
                    const adjDeltaY = newHeightUpper - this.startHeightUpper;
                    newHeightLower = this.startHeightLower - adjDeltaY;
                } else if (newHeightLower < minLower) {
                    newHeightLower = minLower;
                    const adjDeltaY = this.startHeightLower - newHeightLower;
                    newHeightUpper = this.startHeightUpper + adjDeltaY;
                }
 
                if (this.onResizePane) {
                    this.onResizePane(this.resizeUpperPane.name, newHeightUpper, this.resizeLowerPane.name, newHeightLower);
                }
            } else if (this.dragMode === 'y-zoom') {
                // Dragging Y Axis: scale the value range for that specific pane
                const deltaY = e.clientY - this.startY;
                const paneName = this.yZoomPaneName;
                const pane = this.coord.panes[paneName];
                if (pane && paneName) {
                    const height = pane.yMax - pane.yMin;
                    // Drag up -> compress value range (stretch vertically)
                    // Drag down -> expand value range (compress vertically)
                    const scaleFactor = 1 + (deltaY / height) * 1.5;
                    const clampedFactor = Math.max(0.02, Math.min(50, scaleFactor));
                    
                    const valDiff = this.startYZoomMax - this.startYZoomMin;
                    const newDiff = valDiff * clampedFactor;
                    const center = (this.startYZoomMax + this.startYZoomMin) / 2;
 
                    this.coord.manualRanges[paneName] = {
                        min: center - newDiff / 2,
                        max: center + newDiff / 2
                    };
 
                    // Trigger redraw
                    this.onUpdateRange(this.coord.startIndex, this.coord.endIndex, this.coord.barWidth);
                }
            } else if (this.dragMode === 'x-zoom') {
                const deltaX = e.clientX - this.startX;
                const scaleFactor = Math.pow(2, deltaX / 200);
                const newBarWidth = Math.max(0.02, Math.min(100, this.startBarWidth * scaleFactor));

                if (newBarWidth !== this.coord.barWidth && this.startXZoomMidIdx !== null && this.startXZoomMidIdx !== undefined) {
                    const newBarSpace = Math.max(0.01, newBarWidth * 0.15);
                    const stepNew = newBarWidth + newBarSpace;
                    const visibleCount = Math.round(this.chartWidth / stepNew);

                    if (visibleCount > 1000 && scaleFactor < 1.0) {
                        return;
                    }

                    const width = this.coord.width;
                    const rightOffset = this.coord.rightOffset;
                    
                    let endIndexNew = this.startXZoomMidIdx + (width - rightOffset - this.startXZoomMidX - newBarWidth / 2) / stepNew;
                    endIndexNew = Math.round(endIndexNew);

                    let startIndexNew = endIndexNew - visibleCount;

                    if (startIndexNew < 0) {
                        startIndexNew = 0;
                        endIndexNew = visibleCount;
                    }

                    this.onUpdateRange(startIndexNew, endIndexNew, newBarWidth);
                }
            } else {
                // Dragging on Chart: scroll horizontally and/or vertically
                const deltaX = e.clientX - this.startX;
                const deltaY = e.clientY - this.startY;
                
                let didChange = false;
                let newStartIndex = this.coord.startIndex;
                let newEndIndex = this.coord.endIndex;
 
                // 1. Horizontal Scroll (X Axis)
                const step = this.coord.barWidth + this.coord.barSpace;
                const diffBars = Math.round(deltaX / step);
 
                if (diffBars !== 0) {
                    newStartIndex = this.startStartIndex - diffBars;
                    newEndIndex = this.startEndIndex - diffBars;
 
                    // Restrict scrolling out of bounds
                    if (newStartIndex < 0) {
                        const offset = -newStartIndex;
                        newStartIndex += offset;
                        newEndIndex += offset;
                    }
 
                    didChange = true;
                }
 
                // 2. Vertical Scroll (Y Axis)
                // Only allow vertical scrolling on the pane that was clicked if it is in manual mode
                const paneName = this.chartDragPaneName;
                if (paneName && this.coord.yModes[paneName] === 'manual') {
                    const pane = this.coord.panes[paneName];
                    if (pane) {
                        const height = pane.yMax - pane.yMin;
                        const valDiff = this.startManualMax - this.startManualMin;
                        
                        // Translate vertical pixels to value difference
                        const deltaVal = (deltaY / height) * valDiff;
 
                        this.coord.manualRanges[paneName] = {
                            min: this.startManualMin + deltaVal,
                            max: this.startManualMax + deltaVal
                        };
                        didChange = true;
                    }
                }
 
                if (didChange) {
                    this.onUpdateRange(newStartIndex, newEndIndex, this.coord.barWidth);
                }
            }
        } else {
            // Update cursor style based on hover zone (Y-axis vs Splitter vs Chart)
            const splitterIdx = this.getSplitterUnderMouse(mouseX, mouseY);
            const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
            
            if (splitterIdx >= 0) {
                this.canvas.style.cursor = 'row-resize';
            } else if (mouseX > this.chartWidth) {
                this.canvas.style.cursor = 'ns-resize';
            } else if (mouseY > maxPaneY && maxPaneY > 0) {
                this.canvas.style.cursor = 'ew-resize';
            } else {
                // Check drawing nodes hover
                this.checkNodeHover(mouseX, mouseY);
            }
            // Update crosshair
            this.onCrosshairMove(mouseX, mouseY);
        }
    }
 
    handleMouseUp(e) {
        if (this.activeTool && this.activeTool !== 'cursor') {
            if (this.onDrawingMouseUp) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                this.onDrawingMouseUp(mouseX, mouseY, e);
            }
            e.preventDefault();
            return;
        }

        if (this.dragMode === 'node-drag') {
            this.dragMode = 'chart-scroll';
            this.draggedNode = null;
            this.isDragging = false;
            if (e) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                this.checkNodeHover(mouseX, mouseY);
            }
            e.preventDefault();
            return;
        }

        if (this.dragMode === 'line-drag') {
            this.dragMode = 'chart-scroll';
            this.isDragging = false;
            if (e) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                this.checkNodeHover(mouseX, mouseY);
            }
            e.preventDefault();
            return;
        }

        this.isDragging = false;
        if (e) {
            const rect = this.canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const splitterIdx = this.getSplitterUnderMouse(mouseX, mouseY);
            
            if (splitterIdx >= 0) {
                this.canvas.style.cursor = 'row-resize';
            } else if (mouseX > this.chartWidth) {
                this.canvas.style.cursor = 'ns-resize';
            } else {
                this.canvas.style.cursor = 'crosshair';
            }
        } else {
            this.canvas.style.cursor = 'crosshair';
        }
    }

    handleMouseLeave() {
        this.isDragging = false;
        this.canvas.style.cursor = 'crosshair';
        this.onCrosshairLeave();
    }

    handleDblClick(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        if (this.activeTool && this.activeTool !== 'cursor') {
            if (this.onDrawingDblClick) {
                this.onDrawingDblClick(mouseX, mouseY, e);
            }
            e.preventDefault();
            return;
        }

        if (mouseX > this.chartWidth) {
            // Double-clicked on Y Axis: Reset that specific pane back to auto Y scaling
            const activePanes = Object.entries(this.coord.panes)
                .map(([name, pane]) => ({ name, ...pane }));
            
            let targetPaneName = null;
            for (let pane of activePanes) {
                if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                    targetPaneName = pane.name;
                    break;
                }
            }

            if (targetPaneName) {
                this.coord.yModes[targetPaneName] = 'auto';
                this.onUpdateRange(this.coord.startIndex, this.coord.endIndex, this.coord.barWidth);
            }
        }
    }

    handleContextMenu(e) {
        if (this.activeTool && this.activeTool !== 'cursor') {
            if (this.onDrawingDblClick) {
                const rect = this.canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                this.onDrawingDblClick(mouseX, mouseY, e);
            }
            e.preventDefault();
        }
    }

    handleWheel(e) {
        e.preventDefault(); // Stop page scroll
        
        if (this.dataLength === 0 || this.chartWidth === 0) return;

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;

        // Only zoom if mouse is within the active chart area (left of Y axis border)
        if (mouseX > this.chartWidth) return;

        // Get index under the mouse pointer before zoom
        const mouseIdx = this.coord.xToIndex(mouseX);

        // Zoom In or Zoom Out multiplier
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const currentBarWidth = this.coord.barWidth;
        const newBarWidth = Math.max(0.02, Math.min(100, currentBarWidth * zoomFactor));

        if (newBarWidth !== currentBarWidth) {
            const newBarSpace = Math.max(0.01, newBarWidth * 0.15);
            const stepNew = newBarWidth + newBarSpace;
            const visibleCount = Math.round(this.chartWidth / stepNew);

            // Block zoom out if visible count exceeds 1000
            if (visibleCount > 1000 && zoomFactor < 1.0) {
                return;
            }

            // Align zoom center: mouseIdx's X position after zoom should equal its X position before zoom
            // mouseX = width - rightOffset - (endIndexNew - mouseIdx) * stepNew - (newBarWidth / 2)
            // => endIndexNew = mouseIdx + (width - rightOffset - mouseX - newBarWidth / 2) / stepNew
            const width = this.coord.width;
            const rightOffset = this.coord.rightOffset;
            
            let endIndexNew = mouseIdx + (width - rightOffset - mouseX - newBarWidth / 2) / stepNew;
            endIndexNew = Math.round(endIndexNew);

            let startIndexNew = endIndexNew - visibleCount;

            // Restrict bounds
            // 1. Prevent left-side gap
            if (startIndexNew < 0) {
                startIndexNew = 0;
                endIndexNew = visibleCount;
            }

            this.onUpdateRange(startIndexNew, endIndexNew, newBarWidth);
        }
    }

    timestampToIndex(ts) {
        if (!this.dataList || this.dataList.length === 0) return 0;
        const timeframe = this.timeframe || '1h';
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
        const firstTs = this.dataList[0].timestamp;
        const exactIdx = this.dataList.findIndex(d => d.timestamp === ts);
        if (exactIdx !== -1) return exactIdx;
        return Math.round((ts - firstTs) / interval);
    }

    checkLineHover(mouseX, mouseY) {
        if (!this.drawings || this.drawings.length === 0 || !this.dataList || this.dataList.length === 0) {
            this.hoveredDrawingIndex = -1;
            return;
        }

        const hitTolerance = 6; // 6 pixels distance tolerance

        const getDistanceToSegment = (mx, my, x1, y1, x2, y2) => {
            const dx = x2 - x1;
            const dy = y2 - y1;
            if (dx === 0 && dy === 0) {
                return Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2);
            }
            let t = ((mx - x1) * dx + (my - y1) * dy) / (dx * dx + dy * dy);
            t = Math.max(0, Math.min(1, t));
            const projX = x1 + t * dx;
            const projY = y1 + t * dy;
            return Math.sqrt((mx - projX) ** 2 + (my - projY) ** 2);
        };

        const getDistanceToRay = (mx, my, x1, y1, x2, y2) => {
            const dx = x2 - x1;
            const dy = y2 - y1;
            if (dx === 0 && dy === 0) {
                return Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2);
            }
            let t = ((mx - x1) * dx + (my - y1) * dy) / (dx * dx + dy * dy);
            t = Math.max(0, t); // infinite projection towards p2
            const projX = x1 + t * dx;
            const projY = y1 + t * dy;
            return Math.sqrt((mx - projX) ** 2 + (my - projY) ** 2);
        };

        for (let dIdx = this.drawings.length - 1; dIdx >= 0; dIdx--) {
            const d = this.drawings[dIdx];
            
            if (d.type === 'trendline') {
                const idx1 = this.timestampToIndex(d.p1.timestamp);
                const idx2 = this.timestampToIndex(d.p2.timestamp);
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                const dist = getDistanceToSegment(mouseX, mouseY, x1, y1, x2, y2);
                if (dist <= hitTolerance) {
                    this.hoveredDrawingIndex = dIdx;
                    return;
                }
            } else if (d.type === 'ray') {
                const idx1 = this.timestampToIndex(d.p1.timestamp);
                const idx2 = this.timestampToIndex(d.p2.timestamp);
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                const dist = getDistanceToRay(mouseX, mouseY, x1, y1, x2, y2);
                if (dist <= hitTolerance) {
                    this.hoveredDrawingIndex = dIdx;
                    return;
                }
            } else if (d.type === 'horizontal') {
                const y = this.coord.valueToY('main', d.price);
                if (Math.abs(mouseY - y) <= hitTolerance && mouseX <= this.chartWidth) {
                    this.hoveredDrawingIndex = dIdx;
                    return;
                }
            } else if (d.type === 'polyline') {
                if (!d.points || d.points.length < 2) continue;
                for (let i = 0; i < d.points.length - 1; i++) {
                    const idx1 = this.timestampToIndex(d.points[i].timestamp);
                    const idx2 = this.timestampToIndex(d.points[i+1].timestamp);
                    const x1 = this.coord.indexToX(idx1);
                    const y1 = this.coord.valueToY('main', d.points[i].price);
                    const x2 = this.coord.indexToX(idx2);
                    const y2 = this.coord.valueToY('main', d.points[i+1].price);
                    
                    const dist = getDistanceToSegment(mouseX, mouseY, x1, y1, x2, y2);
                    if (dist <= hitTolerance) {
                        this.hoveredDrawingIndex = dIdx;
                        return;
                    }
                }
            } else if (d.type === 'measurement') {
                const idx1 = this.timestampToIndex(d.p1.timestamp);
                const idx2 = this.timestampToIndex(d.p2.timestamp);
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                const minX = Math.min(x1, x2);
                const maxX = Math.max(x1, x2);
                const minY = Math.min(y1, y2);
                const maxY = Math.max(y1, y2);
                
                if (mouseX >= minX && mouseX <= maxX && mouseY >= minY && mouseY <= maxY) {
                    this.hoveredDrawingIndex = dIdx;
                    return;
                }
                
                const d1 = getDistanceToSegment(mouseX, mouseY, minX, minY, maxX, minY);
                const d2 = getDistanceToSegment(mouseX, mouseY, minX, maxY, maxX, maxY);
                const d3 = getDistanceToSegment(mouseX, mouseY, minX, minY, minX, maxY);
                const d4 = getDistanceToSegment(mouseX, mouseY, maxX, minY, maxX, maxY);
                if (Math.min(d1, d2, d3, d4) <= hitTolerance) {
                    this.hoveredDrawingIndex = dIdx;
                    return;
                }
            }
        }
        
        this.hoveredDrawingIndex = -1;
    }

    checkNodeHover(mouseX, mouseY) {
        if (!this.drawings || this.drawings.length === 0 || !this.dataList || this.dataList.length === 0) {
            this.hoveredNode = null;
            this.hoveredDrawingIndex = -1;
            return;
        }

        const hitRadius = 8; // 8 pixels tolerance
        
        for (let dIdx = 0; dIdx < this.drawings.length; dIdx++) {
            const d = this.drawings[dIdx];
            
            // Only allow node hover on focused drawings to keep it clean (or if no drawing is focused yet)
            const isSelectable = this.focusedDrawingIndex === null || this.focusedDrawingIndex === dIdx;
            if (!isSelectable) continue;

            if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                const idx1 = this.timestampToIndex(d.p1.timestamp);
                const idx2 = this.timestampToIndex(d.p2.timestamp);
                
                const x1 = this.coord.indexToX(idx1);
                const y1 = this.coord.valueToY('main', d.p1.price);
                const x2 = this.coord.indexToX(idx2);
                const y2 = this.coord.valueToY('main', d.p2.price);
                
                const dist1 = Math.sqrt((mouseX - x1) ** 2 + (mouseY - y1) ** 2);
                if (dist1 <= hitRadius) {
                    this.hoveredNode = { drawingIndex: dIdx, nodeIndex: 1, type: d.type };
                    this.canvas.style.cursor = 'pointer';
                    return;
                }
                
                const dist2 = Math.sqrt((mouseX - x2) ** 2 + (mouseY - y2) ** 2);
                if (dist2 <= hitRadius) {
                    this.hoveredNode = { drawingIndex: dIdx, nodeIndex: 2, type: d.type };
                    this.canvas.style.cursor = 'pointer';
                    return;
                }
            } else if (d.type === 'horizontal') {
                const y = this.coord.valueToY('main', d.price);
                if (Math.abs(mouseY - y) <= 6 && mouseX <= this.chartWidth) {
                    this.hoveredNode = { drawingIndex: dIdx, nodeIndex: 0, type: d.type };
                    this.canvas.style.cursor = 'row-resize';
                    return;
                }
            } else if (d.type === 'polyline') {
                if (!d.points) continue;
                for (let pIdx = 0; pIdx < d.points.length; pIdx++) {
                    const p = d.points[pIdx];
                    const i = this.timestampToIndex(p.timestamp);
                    const x = this.coord.indexToX(i);
                    const y = this.coord.valueToY('main', p.price);
                    
                    const dist = Math.sqrt((mouseX - x) ** 2 + (mouseY - y) ** 2);
                    if (dist <= hitRadius) {
                        this.hoveredNode = { drawingIndex: dIdx, nodeIndex: pIdx, type: d.type };
                        this.canvas.style.cursor = 'pointer';
                        return;
                    }
                }
            }
        }
        
        this.hoveredNode = null;
        
        // If not node hover, check if cursor is on any line
        if (!this.activeTool || this.activeTool === 'cursor') {
            this.checkLineHover(mouseX, mouseY);
        } else {
            this.hoveredDrawingIndex = -1;
        }

        if (this.hoveredDrawingIndex !== -1) {
            this.canvas.style.cursor = 'move';
        } else if (mouseX <= this.chartWidth) {
            this.canvas.style.cursor = 'crosshair';
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    getTouchCoords(touch) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top
        };
    }

    handleTouchStart(e) {
        if (e.touches.length === 1) {
            this.isPinching = false;
            const touch = e.touches[0];
            const coords = this.getTouchCoords(touch);
            const mouseX = coords.x;
            const mouseY = coords.y;

            this.touchStartX = touch.clientX;
            this.touchStartY = touch.clientY;

            // Check hover dynamically on touchstart since mobile has no mousemove before touch
            this.checkNodeHover(mouseX, mouseY);

            if (this.activeTool && this.activeTool !== 'cursor') {
                if (this.mobileCrosshairX === undefined || this.mobileCrosshairX === null) {
                    this.mobileCrosshairX = this.chartWidth / 2;
                    const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
                    this.mobileCrosshairY = maxPaneY / 2;
                }
                this.lastTouchX = touch.clientX;
                this.lastTouchY = touch.clientY;
                this.isDragging = true; // allow dragging to move crosshair
                
                // Keep crosshair updated at current persistent position
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(this.mobileCrosshairX, this.mobileCrosshairY);
                }
                e.preventDefault();
                return;
            }

            if ((!this.activeTool || this.activeTool === 'cursor') && this.hoveredNode) {
                this.dragMode = 'node-drag';
                this.draggedNode = { ...this.hoveredNode };
                this.isDragging = true;
                this.startX = touch.clientX;
                this.startY = touch.clientY;
                e.preventDefault();
                return;
            }

            if ((!this.activeTool || this.activeTool === 'cursor') && this.hoveredDrawingIndex !== -1) {
                this.dragMode = 'line-drag';
                this.focusedDrawingIndex = this.hoveredDrawingIndex;
                this.isDragging = true;
                this.startX = touch.clientX;
                this.startY = touch.clientY;
                
                this.startMouseXIndex = this.coord.xToIndex(mouseX);
                this.startMousePrice = this.coord.yToValue('main', mouseY);
                
                const d = this.drawings[this.focusedDrawingIndex];
                this.initialDrawingState = {};
                if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                    this.initialDrawingState.p1 = {
                        index: this.timestampToIndex(d.p1.timestamp),
                        price: d.p1.price
                    };
                    this.initialDrawingState.p2 = {
                        index: this.timestampToIndex(d.p2.timestamp),
                        price: d.p2.price
                    };
                } else if (d.type === 'horizontal') {
                    this.initialDrawingState.price = d.price;
                } else if (d.type === 'polyline') {
                    this.initialDrawingState.points = d.points.map(p => ({
                        index: this.timestampToIndex(p.timestamp),
                        price: p.price
                    }));
                }
                
                if (this.onFocusDrawingChanged) {
                    let avgX = mouseX;
                    let minY = mouseY;
                    if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                        const x1 = this.coord.indexToX(this.timestampToIndex(d.p1.timestamp));
                        const x2 = this.coord.indexToX(this.timestampToIndex(d.p2.timestamp));
                        const y1 = this.coord.valueToY('main', d.p1.price);
                        const y2 = this.coord.valueToY('main', d.p2.price);
                        avgX = (x1 + x2) / 2;
                        minY = Math.min(y1, y2);
                    } else if (d.type === 'horizontal') {
                        const y = this.coord.valueToY('main', d.price);
                        avgX = mouseX;
                        minY = y;
                    } else if (d.type === 'polyline') {
                        const xs = d.points.map(p => this.coord.indexToX(this.timestampToIndex(p.timestamp)));
                        const ys = d.points.map(p => this.coord.valueToY('main', p.price));
                        avgX = xs.reduce((sum, val) => sum + val, 0) / xs.length;
                        minY = Math.min(...ys);
                    }
                    this.onFocusDrawingChanged(this.focusedDrawingIndex, { x: avgX, y: minY });
                }
                e.preventDefault();
                return;
            }

            if (!this.activeTool || this.activeTool === 'cursor') {
                this.focusedDrawingIndex = null;
                if (this.onFocusDrawingChanged) {
                    this.onFocusDrawingChanged(null, null);
                }
            }

            this.isDragging = true;
            this.startX = touch.clientX;
            this.startY = touch.clientY;
            this.startStartIndex = this.coord.startIndex;
            this.startEndIndex = this.coord.endIndex;

            const splitterIdx = this.getSplitterUnderMouse(mouseX, mouseY);

            if (splitterIdx >= 0) {
                // Drag on a pane splitter border
                const activePanes = Object.entries(this.coord.panes)
                    .filter(([name]) => name !== 'volume')
                    .map(([name, pane]) => ({ name, ...pane }))
                    .sort((a, b) => a.yMin - b.yMin);

                this.dragMode = 'pane-resize';
                this.resizeSplitterIndex = splitterIdx;
                this.resizeUpperPane = activePanes[splitterIdx];
                this.resizeLowerPane = activePanes[splitterIdx + 1];
                this.startHeightUpper = this.resizeUpperPane.yMax - this.resizeUpperPane.yMin;
                this.startHeightLower = this.resizeLowerPane.yMax - this.resizeLowerPane.yMin;
            } else if (mouseX > this.chartWidth) {
                // Drag on Y Axis: find which pane is under the touch
                const activePanes = Object.entries(this.coord.panes)
                    .map(([name, pane]) => ({ name, ...pane }));
                
                let targetPaneName = null;
                for (let pane of activePanes) {
                    if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                        targetPaneName = pane.name;
                        break;
                    }
                }

                if (targetPaneName) {
                    this.dragMode = 'y-zoom';
                    this.yZoomPaneName = targetPaneName;
                    this.coord.yModes[targetPaneName] = 'manual';
                    
                    const range = this.coord.manualRanges[targetPaneName];
                    this.startYZoomMin = range ? range.min : this.coord.panes[targetPaneName].valMin;
                    this.startYZoomMax = range ? range.max : this.coord.panes[targetPaneName].valMax;
                } else {
                    this.dragMode = 'chart-scroll';
                }
            } else {
                // Check if dragging on X axis area below lowest pane
                const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
                if (mouseY > maxPaneY && maxPaneY > 0) {
                    this.dragMode = 'x-zoom';
                    this.startBarWidth = this.coord.barWidth;
                    this.startXZoomMidX = mouseX;
                    this.startXZoomMidIdx = this.coord.xToIndex(mouseX);
                } else {
                    this.dragMode = 'chart-scroll';

                    // Find which pane was clicked for potential manual Y vertical scroll
                    let activePane = null;
                    Object.entries(this.coord.panes).forEach(([name, pane]) => {
                        if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                            activePane = name;
                        }
                    });
                    this.chartDragPaneName = activePane;
                    if (activePane) {
                        const range = this.coord.manualRanges[activePane];
                        this.startManualMin = range ? range.min : this.coord.panes[activePane].valMin;
                        this.startManualMax = range ? range.max : this.coord.panes[activePane].valMax;
                    }
                }
            }

            if (this.onCrosshairMove) {
                this.onCrosshairMove(mouseX, mouseY);
            }
            e.preventDefault();
        } else if (e.touches.length === 2) {
            this.isPinching = true;
            this.isDragging = false; // pinch takes priority

            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const c1 = this.getTouchCoords(touch1);
            const c2 = this.getTouchCoords(touch2);

            this.startPinchDist = Math.sqrt((c1.x - c2.x) ** 2 + (c1.y - c2.y) ** 2);
            this.startPinchMidX = (c1.x + c2.x) / 2;
            this.startPinchMidY = (c1.y + c2.y) / 2;
            this.startBarWidth = this.coord.barWidth;

            // Capture the exact index under the pinch center
            if (this.startPinchMidX <= this.chartWidth) {
                this.startPinchMidIdx = this.coord.xToIndex(this.startPinchMidX);
            } else {
                this.startPinchMidIdx = null;
            }

            e.preventDefault();
        }
    }

    handleTouchMove(e) {
        if (e.touches.length === 1 && !this.isPinching && this.isDragging) {
            const touch = e.touches[0];
            const coords = this.getTouchCoords(touch);
            const mouseX = coords.x;
            const mouseY = coords.y;

            if (this.activeTool && this.activeTool !== 'cursor') {
                const deltaTouchX = touch.clientX - this.lastTouchX;
                const deltaTouchY = touch.clientY - this.lastTouchY;
                
                this.lastTouchX = touch.clientX;
                this.lastTouchY = touch.clientY;

                if (this.mobileCrosshairX === undefined || this.mobileCrosshairX === null) {
                    this.mobileCrosshairX = this.chartWidth / 2;
                    const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
                    this.mobileCrosshairY = maxPaneY / 2;
                }

                // Update crosshair by relative movement
                this.mobileCrosshairX += deltaTouchX;
                this.mobileCrosshairY += deltaTouchY;

                // Clamp values
                this.mobileCrosshairX = Math.max(0, Math.min(this.chartWidth, this.mobileCrosshairX));
                const maxPaneY = Math.max(...Object.values(this.coord.panes).map(pane => pane.yMax), 0);
                this.mobileCrosshairY = Math.max(0, Math.min(maxPaneY, this.mobileCrosshairY));

                if (this.onDrawingMouseMove) {
                    this.onDrawingMouseMove(this.mobileCrosshairX, this.mobileCrosshairY, e);
                }
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(this.mobileCrosshairX, this.mobileCrosshairY);
                }
                e.preventDefault();
                return;
            }

            if (this.dragMode === 'node-drag' && this.draggedNode) {
                const dataList = this.dataList;
                if (dataList && dataList.length > 0) {
                    const idx = this.coord.xToIndex(mouseX);
                    const safeIdx = Math.max(0, Math.min(dataList.length - 1, idx));
                    const timestamp = dataList[safeIdx].timestamp;
                    const price = this.coord.yToValue('main', mouseY);
                    
                    const dn = this.draggedNode;
                    const d = this.drawings[dn.drawingIndex];
                    
                    if (d) {
                        if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                            if (dn.nodeIndex === 1) {
                                d.p1.timestamp = timestamp;
                                d.p1.price = price;
                            } else if (dn.nodeIndex === 2) {
                                d.p2.timestamp = timestamp;
                                d.p2.price = price;
                            }
                        } else if (d.type === 'horizontal') {
                            d.price = price;
                        } else if (d.type === 'polyline') {
                            if (d.points && d.points[dn.nodeIndex]) {
                                d.points[dn.nodeIndex].timestamp = timestamp;
                                d.points[dn.nodeIndex].price = price;
                            }
                        }
                        
                        if (this.onDrawingsUpdated) {
                            this.onDrawingsUpdated();
                        }
                    }
                }
                
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(mouseX, mouseY);
                }
                
                e.preventDefault();
                return;
            }

            if (this.dragMode === 'line-drag' && this.focusedDrawingIndex !== null) {
                const dataList = this.dataList;
                if (dataList && dataList.length > 0) {
                    const currentIndex = this.coord.xToIndex(mouseX);
                    const currentPrice = this.coord.yToValue('main', mouseY);
                    
                    const deltaIndex = currentIndex - this.startMouseXIndex;
                    const deltaPrice = currentPrice - this.startMousePrice;
                    
                    const d = this.drawings[this.focusedDrawingIndex];
                    const state = this.initialDrawingState;
                    
                    if (d && state) {
                        if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                            const newIdx1 = Math.max(0, Math.min(dataList.length - 1, state.p1.index + deltaIndex));
                            const newIdx2 = Math.max(0, Math.min(dataList.length - 1, state.p2.index + deltaIndex));
                            
                            d.p1.timestamp = dataList[newIdx1].timestamp;
                            d.p1.price = state.p1.price + deltaPrice;
                            
                            d.p2.timestamp = dataList[newIdx2].timestamp;
                            d.p2.price = state.p2.price + deltaPrice;
                        } else if (d.type === 'horizontal') {
                            d.price = state.price + deltaPrice;
                        } else if (d.type === 'polyline') {
                            d.points.forEach((p, pIdx) => {
                                const origPoint = state.points[pIdx];
                                if (origPoint) {
                                    const newIdx = Math.max(0, Math.min(dataList.length - 1, origPoint.index + deltaIndex));
                                    p.timestamp = dataList[newIdx].timestamp;
                                    p.price = origPoint.price + deltaPrice;
                                }
                            });
                        }
                        
                        if (this.onDrawingsUpdated) {
                            this.onDrawingsUpdated();
                        }
                        
                        if (this.onFocusDrawingChanged) {
                            let avgX = mouseX;
                            let minY = mouseY;
                            if (d.type === 'trendline' || d.type === 'ray' || d.type === 'measurement') {
                                const x1 = this.coord.indexToX(this.timestampToIndex(d.p1.timestamp));
                                const x2 = this.coord.indexToX(this.timestampToIndex(d.p2.timestamp));
                                const y1 = this.coord.valueToY('main', d.p1.price);
                                const y2 = this.coord.valueToY('main', d.p2.price);
                                avgX = (x1 + x2) / 2;
                                minY = Math.min(y1, y2);
                            } else if (d.type === 'horizontal') {
                                const y = this.coord.valueToY('main', d.price);
                                avgX = mouseX;
                                minY = y;
                            } else if (d.type === 'polyline') {
                                const xs = d.points.map(p => this.coord.indexToX(this.timestampToIndex(p.timestamp)));
                                const ys = d.points.map(p => this.coord.valueToY('main', p.price));
                                avgX = xs.reduce((sum, val) => sum + val, 0) / xs.length;
                                minY = Math.min(...ys);
                            }
                            this.onFocusDrawingChanged(this.focusedDrawingIndex, { x: avgX, y: minY });
                        }
                    }
                }
                
                if (this.onCrosshairMove) {
                    this.onCrosshairMove(mouseX, mouseY);
                }
                e.preventDefault();
                return;
            }

            if (this.dragMode === 'pane-resize') {
                const deltaY = touch.clientY - this.startY;
                let newHeightUpper = this.startHeightUpper + deltaY;
                let newHeightLower = this.startHeightLower - deltaY;
 
                const minUpper = this.resizeUpperPane.name === 'main' ? 80 : 20;
                const minLower = 20;
 
                if (newHeightUpper < minUpper) {
                    newHeightUpper = minUpper;
                    const adjDeltaY = newHeightUpper - this.startHeightUpper;
                    newHeightLower = this.startHeightLower - adjDeltaY;
                } else if (newHeightLower < minLower) {
                    newHeightLower = minLower;
                    const adjDeltaY = this.startHeightLower - newHeightLower;
                    newHeightUpper = this.startHeightUpper + adjDeltaY;
                }
 
                if (this.onResizePane) {
                    this.onResizePane(this.resizeUpperPane.name, newHeightUpper, this.resizeLowerPane.name, newHeightLower);
                }
            } else if (this.dragMode === 'y-zoom') {
                const deltaY = touch.clientY - this.startY;
                const paneName = this.yZoomPaneName;
                const pane = this.coord.panes[paneName];
                if (pane && paneName) {
                    const height = pane.yMax - pane.yMin;
                    const scaleFactor = 1 + (deltaY / height) * 1.5;
                    const clampedFactor = Math.max(0.02, Math.min(50, scaleFactor));
                    
                    const valDiff = this.startYZoomMax - this.startYZoomMin;
                    const newDiff = valDiff * clampedFactor;
                    const center = (this.startYZoomMax + this.startYZoomMin) / 2;
 
                    this.coord.manualRanges[paneName] = {
                        min: center - newDiff / 2,
                        max: center + newDiff / 2
                    };
 
                    this.onUpdateRange(this.coord.startIndex, this.coord.endIndex, this.coord.barWidth);
                }
            } else if (this.dragMode === 'x-zoom') {
                const deltaX = touch.clientX - this.startX;
                const scaleFactor = Math.pow(2, deltaX / 200);
                const newBarWidth = Math.max(0.02, Math.min(100, this.startBarWidth * scaleFactor));

                if (newBarWidth !== this.coord.barWidth && this.startXZoomMidIdx !== null && this.startXZoomMidIdx !== undefined) {
                    const newBarSpace = Math.max(0.01, newBarWidth * 0.15);
                    const stepNew = newBarWidth + newBarSpace;
                    const visibleCount = Math.round(this.chartWidth / stepNew);

                    if (visibleCount > 1000 && scaleFactor < 1.0) {
                        e.preventDefault();
                        return;
                    }

                    const width = this.coord.width;
                    const rightOffset = this.coord.rightOffset;
                    
                    let endIndexNew = this.startXZoomMidIdx + (width - rightOffset - this.startXZoomMidX - newBarWidth / 2) / stepNew;
                    endIndexNew = Math.round(endIndexNew);

                    let startIndexNew = endIndexNew - visibleCount;

                    if (startIndexNew < 0) {
                        startIndexNew = 0;
                        endIndexNew = visibleCount;
                    }

                    this.onUpdateRange(startIndexNew, endIndexNew, newBarWidth);
                }
            } else {
                // Dragging on Chart
                const deltaX = touch.clientX - this.startX;
                const deltaY = touch.clientY - this.startY;
                
                let didChange = false;
                let newStartIndex = this.coord.startIndex;
                let newEndIndex = this.coord.endIndex;
 
                const step = this.coord.barWidth + this.coord.barSpace;
                const diffBars = Math.round(deltaX / step);
 
                if (diffBars !== 0) {
                    newStartIndex = this.startStartIndex - diffBars;
                    newEndIndex = this.startEndIndex - diffBars;
 
                    if (newStartIndex < 0) {
                        const offset = -newStartIndex;
                        newStartIndex += offset;
                        newEndIndex += offset;
                    }
 
                    didChange = true;
                }
 
                const paneName = this.chartDragPaneName;
                if (paneName && this.coord.yModes[paneName] === 'manual') {
                    const pane = this.coord.panes[paneName];
                    if (pane) {
                        const height = pane.yMax - pane.yMin;
                        const valDiff = this.startManualMax - this.startManualMin;
                        const deltaVal = (deltaY / height) * valDiff;
 
                        this.coord.manualRanges[paneName] = {
                            min: this.startManualMin + deltaVal,
                            max: this.startManualMax + deltaVal
                        };
                        didChange = true;
                    }
                }
 
                if (didChange) {
                    this.onUpdateRange(newStartIndex, newEndIndex, this.coord.barWidth);
                }
            }

            if (this.onCrosshairMove) {
                this.onCrosshairMove(mouseX, mouseY);
            }
            e.preventDefault();
        } else if (e.touches.length === 2 && this.isPinching) {
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const c1 = this.getTouchCoords(touch1);
            const c2 = this.getTouchCoords(touch2);

            const dist = Math.sqrt((c1.x - c2.x) ** 2 + (c1.y - c2.y) ** 2);
            if (this.startPinchDist > 0) {
                const zoomFactor = dist / this.startPinchDist;
                const currentBarWidth = this.startBarWidth;
                const newBarWidth = Math.max(0.02, Math.min(100, currentBarWidth * zoomFactor));

                if (newBarWidth !== this.coord.barWidth && this.startPinchMidIdx !== null && this.startPinchMidIdx !== undefined) {
                    const newBarSpace = Math.max(0.01, newBarWidth * 0.15);
                    const stepNew = newBarWidth + newBarSpace;
                    const visibleCount = Math.round(this.chartWidth / stepNew);

                    if (visibleCount > 1000 && zoomFactor < 1.0) {
                        e.preventDefault();
                        return;
                    }

                    const width = this.coord.width;
                    const rightOffset = this.coord.rightOffset;
                    
                    let endIndexNew = this.startPinchMidIdx + (width - rightOffset - this.startPinchMidX - newBarWidth / 2) / stepNew;
                    endIndexNew = Math.round(endIndexNew);

                    let startIndexNew = endIndexNew - visibleCount;

                    if (startIndexNew < 0) {
                        startIndexNew = 0;
                        endIndexNew = visibleCount;
                    }

                    this.onUpdateRange(startIndexNew, endIndexNew, newBarWidth);
                }
            }
            e.preventDefault();
        }
    }

    handleTouchEnd(e) {
        let mouseX = 0;
        let mouseY = 0;
        let clientX = 0;
        let clientY = 0;
        if (e.changedTouches && e.changedTouches.length > 0) {
            const coords = this.getTouchCoords(e.changedTouches[0]);
            mouseX = coords.x;
            mouseY = coords.y;
            clientX = e.changedTouches[0].clientX;
            clientY = e.changedTouches[0].clientY;
        }

        const dist = Math.sqrt((clientX - this.touchStartX) ** 2 + (clientY - this.touchStartY) ** 2);

        if (this.activeTool && this.activeTool !== 'cursor') {
            if (dist < 10) {
                const now = Date.now();
                const isDoubleTap = (now - this.lastTapTime) < 300;
                this.lastTapTime = now;

                if (isDoubleTap) {
                    if (this.onDrawingDblClick) {
                        this.onDrawingDblClick(this.mobileCrosshairX, this.mobileCrosshairY, e);
                    }
                } else {
                    if (this.onDrawingMouseDown) {
                        this.onDrawingMouseDown(this.mobileCrosshairX, this.mobileCrosshairY, e);
                    }
                }
            }

            this.isDragging = false;
            this.isPinching = false;
            e.preventDefault();
            return;
        }

        // Support double tap on Y axis to reset Y range to auto
        if (dist < 10) {
            const now = Date.now();
            const isDoubleTap = (now - this.lastTapTime) < 300;
            this.lastTapTime = now;

            if (isDoubleTap) {
                if (mouseX > this.chartWidth) {
                    const activePanes = Object.entries(this.coord.panes)
                        .map(([name, pane]) => ({ name, ...pane }));
                    
                    let targetPaneName = null;
                    for (let pane of activePanes) {
                        if (mouseY >= pane.yMin && mouseY <= pane.yMax) {
                            targetPaneName = pane.name;
                            break;
                        }
                    }

                    if (targetPaneName) {
                        this.coord.yModes[targetPaneName] = 'auto';
                        this.onUpdateRange(this.coord.startIndex, this.coord.endIndex, this.coord.barWidth);
                    }
                }
            }
        }

        if (this.dragMode === 'node-drag') {
            this.dragMode = 'chart-scroll';
            this.draggedNode = null;
            this.isDragging = false;
            this.checkNodeHover(mouseX, mouseY);
            e.preventDefault();
            return;
        }

        if (this.dragMode === 'line-drag') {
            this.dragMode = 'chart-scroll';
            this.isDragging = false;
            this.checkNodeHover(mouseX, mouseY);
            e.preventDefault();
            return;
        }

        this.isDragging = false;
        this.isPinching = false;
        if (this.onCrosshairLeave) {
            this.onCrosshairLeave();
        }
        e.preventDefault();
    }

    handleTouchCancel(e) {
        this.isDragging = false;
        this.isPinching = false;
        if (this.onCrosshairLeave) {
            this.onCrosshairLeave();
        }
        e.preventDefault();
    }
}

export default InteractionHandler;
