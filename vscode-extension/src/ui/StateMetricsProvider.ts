import * as vscode from 'vscode';
import { RunContext } from '../data/RunContext';
import { AgentStep } from '../data/DataTypes';

/**
 * StateMetricsProvider - Sparkline / bar chart sidebar view.
 *
 * Shows state growth metrics over time:
 *   - Step durations as a bar chart
 *   - Cumulative execution time sparkline
 *   - Phase distribution pie
 *   - Memory/context token growth (if available)
 */
export class StateMetricsProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'acp.stateMetrics';

    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this.getHtml();

        // Listen to run changes
        const runContext = RunContext.getInstance();
        runContext.onDidRunChange((run) => {
            if (run) {
                this.updateMetrics(run.steps);
            }
        });

        runContext.onDidStepChange((step) => {
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'highlightStep',
                    stepId: step.step_id,
                });
            }
        });

        // If a run is already loaded, update immediately
        if (runContext.currentRun) {
            this.updateMetrics(runContext.currentRun.steps);
        }
    }

    public updateMetrics(steps: AgentStep[]) {
        if (!this._view) { return; }

        const metrics = this.computeMetrics(steps);
        this._view.webview.postMessage({
            type: 'updateMetrics',
            metrics,
        });
    }

    private computeMetrics(steps: AgentStep[]) {
        // Duration per step
        const durations = steps.map(s => ({
            stepId: s.step_id,
            duration: s.duration || 0,
            phase: s.phase,
            status: s.status,
        }));

        // Cumulative time
        let cumulative = 0;
        const cumulativeData = steps.map(s => {
            cumulative += s.duration || 0;
            return { stepId: s.step_id, cumulative };
        });

        // Phase distribution
        const phaseCount: Record<string, number> = {};
        for (const s of steps) {
            phaseCount[s.phase] = (phaseCount[s.phase] || 0) + 1;
        }

        // Status distribution
        const statusCount: Record<string, number> = {};
        for (const s of steps) {
            statusCount[s.status] = (statusCount[s.status] || 0) + 1;
        }

        // Total duration
        const totalDuration = steps.reduce((acc, s) => acc + (s.duration || 0), 0);

        // Avg duration
        const avgDuration = steps.length > 0 ? Math.round(totalDuration / steps.length) : 0;

        // Max duration step
        const maxStep = steps.reduce((max, s) => (s.duration || 0) > (max.duration || 0) ? s : max, steps[0]);

        return {
            totalSteps: steps.length,
            totalDuration,
            avgDuration,
            maxDuration: maxStep?.duration || 0,
            maxDurationStepId: maxStep?.step_id || 0,
            durations,
            cumulativeData,
            phaseCount,
            statusCount,
        };
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
    font-size: 11px;
}
.section {
    margin-bottom: 12px;
}
.section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    margin-bottom: 6px;
}
.stats-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-bottom: 8px;
}
.stat-card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 3px;
    padding: 6px 8px;
    text-align: center;
}
.stat-value {
    font-size: 16px;
    font-weight: 700;
    color: var(--vscode-foreground);
}
.stat-label {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.3px;
}
.chart-container {
    background: var(--vscode-editor-background);
    border-radius: 3px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border);
    margin-bottom: 8px;
}
.bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 60px;
    width: 100%;
}
.bar {
    flex: 1;
    min-width: 2px;
    max-width: 12px;
    border-radius: 1px 1px 0 0;
    cursor: pointer;
    transition: opacity 0.1s;
}
.bar:hover {
    opacity: 0.8;
}
.bar.highlighted {
    outline: 1px solid var(--vscode-focusBorder);
}
.bar.reason { background: #4caf50; }
.bar.tool { background: #2196f3; }
.bar.observe { background: #8bc34a; }
.bar.memory { background: #9c27b0; }
.bar.retry { background: #f44336; }
.bar.terminate { background: #607d8b; }
.bar.default { background: #78909c; }
.sparkline {
    width: 100%;
    height: 40px;
}
.sparkline polyline {
    fill: none;
    stroke: var(--vscode-charts-blue, #2196f3);
    stroke-width: 1.5;
}
.sparkline .fill {
    fill: rgba(33, 150, 243, 0.1);
    stroke: none;
}
.phase-dist {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
.phase-item {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
}
.phase-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.phase-dot.reason { background: #4caf50; }
.phase-dot.tool { background: #2196f3; }
.phase-dot.observe { background: #8bc34a; }
.phase-dot.memory { background: #9c27b0; }
.phase-dot.retry { background: #f44336; }
.phase-dot.terminate { background: #607d8b; }
.empty-state {
    text-align: center;
    color: var(--vscode-descriptionForeground);
    padding: 20px;
    font-size: 11px;
}
</style>
</head>
<body>
<div id="content">
    <div class="empty-state">No run loaded. Open a trace to see metrics.</div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentMetrics = null;

const PHASE_COLORS = {
    reason: '#4caf50',
    tool: '#2196f3',
    observe: '#8bc34a',
    memory: '#9c27b0',
    retry: '#f44336',
    terminate: '#607d8b',
};

function render(metrics) {
    currentMetrics = metrics;
    const el = document.getElementById('content');

    let html = '';

    // Summary stats
    html += '<div class="section">';
    html += '<div class="section-title">Summary</div>';
    html += '<div class="stats-row">';
    html += '<div class="stat-card"><div class="stat-value">' + metrics.totalSteps + '</div><div class="stat-label">Steps</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + metrics.totalDuration + 'ms</div><div class="stat-label">Total</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + metrics.avgDuration + 'ms</div><div class="stat-label">Avg</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + metrics.maxDuration + 'ms</div><div class="stat-label">Max (#' + metrics.maxDurationStepId + ')</div></div>';
    html += '</div></div>';

    // Duration bar chart
    html += '<div class="section">';
    html += '<div class="section-title">Step Durations</div>';
    html += '<div class="chart-container">';
    html += '<div class="bar-chart" id="barChart">';
    const maxDur = Math.max(...metrics.durations.map(d => d.duration), 1);
    for (const d of metrics.durations) {
        const h = Math.max(2, (d.duration / maxDur) * 56);
        const phaseClass = PHASE_COLORS[d.phase] ? d.phase : 'default';
        html += '<div class="bar ' + phaseClass + '" data-step="' + d.stepId + '" style="height:' + h + 'px" title="Step ' + d.stepId + ': ' + d.duration + 'ms (' + d.phase + ')"></div>';
    }
    html += '</div></div></div>';

    // Cumulative sparkline
    html += '<div class="section">';
    html += '<div class="section-title">Cumulative Time</div>';
    html += '<div class="chart-container">';
    html += renderSparkline(metrics.cumulativeData);
    html += '</div></div>';

    // Phase distribution
    html += '<div class="section">';
    html += '<div class="section-title">Phase Distribution</div>';
    html += '<div class="phase-dist">';
    for (const [phase, count] of Object.entries(metrics.phaseCount)) {
        const phaseClass = PHASE_COLORS[phase] ? phase : 'default';
        html += '<div class="phase-item"><span class="phase-dot ' + phaseClass + '"></span>' + phase + ': ' + count + '</div>';
    }
    html += '</div></div>';

    // Status distribution
    html += '<div class="section">';
    html += '<div class="section-title">Status</div>';
    html += '<div class="phase-dist">';
    for (const [status, count] of Object.entries(metrics.statusCount)) {
        const color = status === 'error' ? '#f44336' : status === 'retry' ? '#ff9800' : '#4caf50';
        html += '<div class="phase-item"><span class="phase-dot" style="background:' + color + '"></span>' + status + ': ' + count + '</div>';
    }
    html += '</div></div>';

    el.innerHTML = html;
}

function renderSparkline(data) {
    if (!data || data.length === 0) return '<div class="empty-state">No data</div>';

    const w = 200;
    const h = 40;
    const maxVal = Math.max(...data.map(d => d.cumulative), 1);
    
    const points = data.map((d, i) => {
        const x = (i / Math.max(data.length - 1, 1)) * w;
        const y = h - (d.cumulative / maxVal) * (h - 4);
        return x + ',' + y;
    }).join(' ');

    const fillPoints = '0,' + h + ' ' + points + ' ' + w + ',' + h;

    return '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
        '<polyline class="fill" points="' + fillPoints + '" />' +
        '<polyline points="' + points + '" />' +
        '</svg>';
}

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'updateMetrics') {
        render(msg.metrics);
    } else if (msg.type === 'highlightStep') {
        const bars = document.querySelectorAll('.bar');
        bars.forEach(b => {
            b.classList.toggle('highlighted', b.getAttribute('data-step') == msg.stepId);
        });
    }
});
</script>
</body>
</html>`;
    }
}
