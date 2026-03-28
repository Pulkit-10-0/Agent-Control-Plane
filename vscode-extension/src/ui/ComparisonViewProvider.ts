import * as vscode from 'vscode';
import { RunComparison, GraphDiff } from '../engines/ComparisonEngine';

export class ComparisonViewProvider {
    public static readonly viewType = 'acp.comparisonView';
    private panel: vscode.WebviewPanel | undefined;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public show(comparison: RunComparison) {
        if (this.panel) {
            this.panel.reveal();
        } else {
            this.panel = vscode.window.createWebviewPanel(
                ComparisonViewProvider.viewType,
                `Compare: ${comparison.runId1} vs ${comparison.runId2}`,
                vscode.ViewColumn.One,
                { enableScripts: true }
            );
            this.panel.onDidDispose(() => this.panel = undefined);
        }

        this.panel.webview.html = this.getHtml(comparison);
    }

    private getHtml(comparison: RunComparison): string {
        const graphDiffHtml = comparison.graphDiff
            ? this.renderGraphDiff(comparison.graphDiff, comparison.runId1, comparison.runId2)
            : '<div class="section"><h3>Graph Diff</h3><p class="muted">Graph diff not available. Use "Compare with Graph Diff" for structural analysis.</p></div>';

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
                .header { display: flex; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
                .metrics { display: flex; gap: 20px; font-size: 12px; }
                .metric { font-weight: bold; }
                .row { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
                .cell { flex: 1; padding: 8px; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
                .cell.left { border-right: 1px solid var(--vscode-panel-border); }
                .match-exact { background-color: rgba(76, 175, 80, 0.1); }
                .match-phase { background-color: rgba(255, 152, 0, 0.1); }
                .match-mismatch { background-color: rgba(244, 67, 54, 0.1); }
                .divergence-marker { color: #f44336; font-weight: bold; margin-bottom: 10px; }
                .section { margin-bottom: 24px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 16px; }
                .section h3 { margin: 0 0 12px 0; font-size: 14px; }
                .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
                .tab-bar { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--vscode-panel-border); }
                .tab-btn { padding: 8px 16px; font-size: 12px; background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; margin-bottom: -2px; font-family: var(--vscode-font-family); }
                .tab-btn.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
                .tab-content { display: none; }
                .tab-content.active { display: block; }
                .graph-diff-container { display: flex; gap: 20px; }
                .graph-side { flex: 1; }
                .graph-side h4 { margin: 0 0 8px 0; font-size: 12px; font-weight: 600; }
                .diff-item { padding: 6px 10px; margin-bottom: 4px; border-radius: 3px; font-size: 11px; }
                .diff-added { background: rgba(76, 175, 80, 0.15); border-left: 3px solid #4caf50; }
                .diff-removed { background: rgba(244, 67, 54, 0.15); border-left: 3px solid #f44336; }
                .diff-changed { background: rgba(255, 152, 0, 0.15); border-left: 3px solid #ff9800; }
                .diff-label { font-weight: 600; margin-right: 6px; }
                .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 12px; }
                .stat-item { display: flex; justify-content: space-between; padding: 4px 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 3px; }
                .stat-label { color: var(--vscode-descriptionForeground); }
                .stat-value { font-weight: 600; }
            </style>
        </head>
        <body>
            <div class="header">
                <h2>Run Comparison</h2>
                <div class="metrics">
                    <span>\u0394 Duration: <span class="metric">${comparison.metricsDiff.duration}ms</span></span>
                    <span>\u0394 Steps: <span class="metric">${comparison.metricsDiff.steps}</span></span>
                </div>
            </div>
            
            ${comparison.divergencePoint ? `<div class="divergence-marker">Warning: Divergence detected at Step ${comparison.divergencePoint}</div>` : '<div style="color: #4caf50; margin-bottom: 10px;">Runs are identical</div>'}

            <div class="tab-bar">
                <button class="tab-btn active" onclick="switchTab('steps')">Step Alignment</button>
                <button class="tab-btn" onclick="switchTab('graph')">Graph Diff</button>
            </div>

            <div class="tab-content active" id="tab-steps">
                <div class="table">
                    <div class="row" style="font-weight: bold;">
                        <div class="cell left">${comparison.runId1}</div>
                        <div class="cell">${comparison.runId2}</div>
                    </div>
                    ${comparison.stepAlignment.map(row => `
                        <div class="row match-${row.matchType}">
                            <div class="cell left">
                                ${row.step1 !== null ? `Step ${row.step1}` : '-'}
                            </div>
                            <div class="cell">
                                ${row.step2 !== null ? `Step ${row.step2}` : '-'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="tab-content" id="tab-graph">
                ${graphDiffHtml}
            </div>

            <script>
                function switchTab(tab) {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    document.querySelector('[onclick*="' + tab + '"]').classList.add('active');
                    document.getElementById('tab-' + tab).classList.add('active');
                }
            </script>
        </body>
        </html>`;
    }

    private renderGraphDiff(diff: GraphDiff, runId1: string, runId2: string): string {
        let html = '<div class="section"><h3>Graph Structure Diff</h3>';

        // Summary stats
        html += '<div class="stats-grid">';
        html += `<div class="stat-item"><span class="stat-label">${runId1} Nodes</span><span class="stat-value">${diff.graph1Summary.nodes}</span></div>`;
        html += `<div class="stat-item"><span class="stat-label">${runId2} Nodes</span><span class="stat-value">${diff.graph2Summary.nodes}</span></div>`;
        html += `<div class="stat-item"><span class="stat-label">${runId1} Edges</span><span class="stat-value">${diff.graph1Summary.edges}</span></div>`;
        html += `<div class="stat-item"><span class="stat-label">${runId2} Edges</span><span class="stat-value">${diff.graph2Summary.edges}</span></div>`;
        html += '</div>';

        // Nodes diff
        html += '<h4 style="margin-top:16px;font-size:12px;">Node Changes</h4>';
        if (diff.addedNodes.length === 0 && diff.removedNodes.length === 0 && diff.changedNodes.length === 0) {
            html += '<p class="muted">No node changes detected.</p>';
        } else {
            for (const node of diff.addedNodes) {
                html += `<div class="diff-item diff-added"><span class="diff-label">+ Added:</span> ${node.name} [${node.type}]</div>`;
            }
            for (const node of diff.removedNodes) {
                html += `<div class="diff-item diff-removed"><span class="diff-label">- Removed:</span> ${node.name} [${node.type}]</div>`;
            }
            for (const { node, changes } of diff.changedNodes) {
                html += `<div class="diff-item diff-changed"><span class="diff-label">~ Changed:</span> ${node.name} - ${changes.join(', ')}</div>`;
            }
        }

        // Edges diff
        html += '<h4 style="margin-top:16px;font-size:12px;">Edge Changes</h4>';
        if (diff.addedEdges.length === 0 && diff.removedEdges.length === 0 && diff.changedEdges.length === 0) {
            html += '<p class="muted">No edge changes detected.</p>';
        } else {
            for (const edge of diff.addedEdges) {
                html += `<div class="diff-item diff-added"><span class="diff-label">+ Added:</span> ${edge.source} -> ${edge.target}${edge.conditional ? ' (conditional)' : ''}</div>`;
            }
            for (const edge of diff.removedEdges) {
                html += `<div class="diff-item diff-removed"><span class="diff-label">- Removed:</span> ${edge.source} -> ${edge.target}</div>`;
            }
            for (const { edge, changes } of diff.changedEdges) {
                html += `<div class="diff-item diff-changed"><span class="diff-label">~ Changed:</span> ${edge.source} -> ${edge.target} - ${changes.join(', ')}</div>`;
            }
        }

        html += '</div>';
        return html;
    }
}
