export class CoordinateSystem {
    constructor() {
        this.width = 0;
        this.height = 0;
        this.barWidth = 6;
        this.barSpace = 2;
        this.rightOffset = 80;
        
        this.startIndex = 0;
        this.endIndex = 0;
        
        // Pane-specific Y scale options
        this.yModes = {}; // paneName -> 'auto' | 'manual'
        this.manualRanges = {}; // paneName -> { min, max }
        
        // Maps pane name to its value range and Y coordinates bounds
        // paneName -> { valMin, valMax, yMin, yMax, valRange }
        this.panes = {};
    }

    // Set X axis configuration
    setXRange(width, startIndex, endIndex, barWidth, rightOffset) {
        this.width = width;
        this.startIndex = startIndex;
        this.endIndex = endIndex;
        this.barWidth = barWidth;
        this.barSpace = Math.max(0.01, barWidth * 0.15);
        this.rightOffset = rightOffset;
    }

    // Register a Pane Y axis bounds
    setPaneYRange(paneName, valMin, valMax, yMin, yMax) {
        if (!this.yModes[paneName]) {
            this.yModes[paneName] = 'auto';
        }

        if (this.yModes[paneName] === 'manual') {
            const range = this.manualRanges[paneName];
            if (range) {
                valMin = range.min;
                valMax = range.max;
            }
        } else {
            this.manualRanges[paneName] = { min: valMin, max: valMax };
        }

        const diff = valMax - valMin;
        this.panes[paneName] = {
            valMin,
            valMax,
            yMin,
            yMax,
            valRange: diff === 0 ? 1 : diff
        };
    }

    // Convert data index to X pixel coordinate (returns center of the bar)
    indexToX(index) {
        const step = this.barWidth + this.barSpace;
        return this.width - this.rightOffset - (this.endIndex - index) * step - (this.barWidth / 2);
    }

    // Convert X pixel coordinate to data index (with nearest matching logic)
    xToIndex(x) {
        const step = this.barWidth + this.barSpace;
        const offset = this.width - this.rightOffset - x - (this.barWidth / 2);
        return Math.round(this.endIndex - offset / step);
    }

    // Convert value to Y pixel coordinate for a given pane
    valueToY(paneName, value) {
        const pane = this.panes[paneName];
        if (!pane) return 0;
        const ratio = (value - pane.valMin) / pane.valRange;
        // Remember Canvas Y=0 is top, so high value -> low Y
        return pane.yMax - ratio * (pane.yMax - pane.yMin);
    }

    // Convert Y pixel coordinate to value for a given pane
    yToValue(paneName, y) {
        const pane = this.panes[paneName];
        if (!pane) return 0;
        const height = pane.yMax - pane.yMin;
        const ratio = (pane.yMax - y) / height;
        return pane.valMin + ratio * pane.valRange;
    }
}

export default CoordinateSystem;
