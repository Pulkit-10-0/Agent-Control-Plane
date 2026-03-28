import * as vscode from "vscode";
import {
    buildLangGraph,
    LangGraphResult,
    TraceData,
    GraphNodeData,
} from "../langgraph/LangGraphBuilder";

/**
 * LangGraph Panel Manager
 *
 * Uses @langchain/langgraph to model agent execution traces as a StateGraph.
 * Opens as a WebviewPanel in the editor area (right side).
 * The graph is compiled, and the drawable representation is extracted via
 * getGraph() and drawMermaid().
 */

export class LangGraphProvider {
    private _panel?: vscode.WebviewPanel;
    private _trace?: TraceData;
    private _graphResult?: LangGraphResult;
    /** Tracks the in-flight buildLangGraph promise to prevent duplicate builds */
    private _buildPromise?: Promise<LangGraphResult>;

    /** Callback for when user triggers branch-from-node in the graph UI */
    private _onBranchRequest?: (stepNumber: number, nodeId: string) => void;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    /** Register a callback for counterfactual branching from a graph node. */
    public onBranchRequest(handler: (stepNumber: number, nodeId: string) => void) {
        this._onBranchRequest = handler;
    }

    /** Get the current graph result (for export purposes). */
    public getGraphResult(): LangGraphResult | undefined {
        return this._graphResult;
    }

    public async setTrace(trace: TraceData) {
        this._trace = trace;
        this._graphResult = undefined;
        // One shared promise — if panel's requestGraph fires during build, it awaits this
        this._buildPromise = buildLangGraph(trace);
        try {
            this._graphResult = await this._buildPromise;
        } catch (e) {
            this._graphResult = undefined;
            console.error("LangGraph build failed:", e);
            if (this._panel) {
                this._panel.webview.postMessage({ type: "graphError", message: String(e) });
            }
            return;
        }
        if (this._panel) {
            this._panel.webview.postMessage({
                type: "loadGraph",
                graph: this._graphResult,
            });
        }
    }

    public highlightStep(stepNumber: number) {
        if (this._panel) {
            this._panel.webview.postMessage({
                type: "highlightStep",
                stepNumber,
            });
        }
    }

    /**
     * Show the LangGraph panel in the editor area.
     * Creates a new panel or reveals the existing one.
     */
    public show() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            // Re-push graph data — wait for any in-flight build first
            const sendGraph = async () => {
                if (!this._graphResult && this._buildPromise) {
                    try { this._graphResult = await this._buildPromise; } catch { /* ignore */ }
                }
                if (this._graphResult) {
                    this._panel?.webview.postMessage({ type: "loadGraph", graph: this._graphResult });
                }
            };
            setTimeout(sendGraph, 150);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            "acp.langGraph",
            "Execution Graph",
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [this._extensionUri],
                retainContextWhenHidden: true,
            }
        );

        this._panel.webview.html = this.getHtml();

        this._panel.webview.onDidReceiveMessage(async (data) => {
            if (data.type === "requestGraph") {
                // If a build is already in-flight, wait for it instead of starting another
                if (this._buildPromise && !this._graphResult) {
                    try { this._graphResult = await this._buildPromise; } catch { /* handled in setTrace */ }
                } else if (this._trace && !this._graphResult) {
                    // No build running yet — start one
                    this._buildPromise = buildLangGraph(this._trace);
                    try {
                        this._graphResult = await this._buildPromise;
                    } catch (e) {
                        console.error("LangGraph build failed on requestGraph:", e);
                        this._panel!.webview.postMessage({ type: "graphError", message: String(e) });
                        return;
                    }
                }
                if (this._graphResult) {
                    this._panel!.webview.postMessage({
                        type: "loadGraph",
                        graph: this._graphResult,
                    });
                } else if (!this._trace) {
                    this._panel!.webview.postMessage({ type: "noTrace" });
                }
            } else if (data.type === "branchFromNode") {
                if (this._onBranchRequest && data.stepNumber !== undefined) {
                    this._onBranchRequest(data.stepNumber, data.nodeId);
                }
            }
        });

        this._panel.onDidDispose(() => {
            this._panel = undefined;
        });

        // Delay the initial push so the webview frame has time to load its script
        // before we send. The webview also sends requestGraph as a safety net.
        if (this._graphResult) {
            const result = this._graphResult;
            setTimeout(() => {
                this._panel?.webview.postMessage({ type: "loadGraph", graph: result });
            }, 200);
        }
    }

    public dispose() {
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LangGraph</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
}

.header-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}

.header-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
    flex: 1;
}

.header-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
}

.toggle-group {
    display: flex;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    overflow: hidden;
}

.toggle-btn {
    padding: 3px 10px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    background: transparent;
    color: var(--vscode-foreground);
    border: none;
    cursor: pointer;
    transition: background 0.15s;
}

.toggle-btn:not(:last-child) {
    border-right: 1px solid var(--vscode-panel-border);
}

.toggle-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

.toggle-btn:hover:not(.active) {
    background: var(--vscode-list-hoverBackground);
}

.tab-bar {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}

.tab-btn {
    flex: 1;
    padding: 6px 10px;
    font-size: 11px;
    font-family: var(--vscode-font-family);
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    text-align: center;
    transition: color 0.15s, border-color 0.15s;
}

.tab-btn.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
}

.tab-btn:hover:not(.active) {
    color: var(--vscode-foreground);
}

.tab-content {
    display: none;
    flex: 1;
    overflow: auto;
}

.tab-content.active {
    display: block;
}

/* Graph SVG panel */
.graph-container {
    padding: 10px;
}

svg { display: block; }

.graph-edge {
    stroke: var(--vscode-panel-border);
    stroke-width: 1.5;
    fill: none;
    marker-end: url(#arrowhead);
}

.graph-edge.conditional {
    stroke-dasharray: 6 3;
}

.graph-edge.active {
    stroke: var(--vscode-focusBorder);
    stroke-width: 2;
}

.node-group { cursor: pointer; }

.node-rect {
    rx: 6; ry: 6;
    stroke-width: 1.5;
    transition: stroke 0.15s, filter 0.15s;
}

.node-group:hover .node-rect { filter: brightness(1.15); }

.node-group.selected .node-rect {
    stroke: var(--vscode-focusBorder);
    stroke-width: 2.5;
}

.node-start .node-rect    { fill: #2d7d46; stroke: #3a9a58; }
.node-end .node-rect      { fill: #5a5a5a; stroke: #707070; }
.node-llm .node-rect      { fill: #1a6b3a; stroke: #228b4a; }
.node-tool .node-rect     { fill: #1565c0; stroke: #1e88e5; }
.node-decision .node-rect { fill: #e65100; stroke: #ff6d00; }
.node-error .node-rect    { fill: #b71c1c; stroke: #e53935; }

.node-label {
    fill: #fff;
    font-size: 12px;
    font-weight: 600;
    text-anchor: middle;
    dominant-baseline: central;
    pointer-events: none;
    font-family: var(--vscode-editor-font-family, monospace);
}

.node-badge {
    fill: rgba(255,255,255,0.3);
    font-size: 9px;
    text-anchor: end;
    dominant-baseline: central;
    pointer-events: none;
}

.node-step-count {
    fill: rgba(255,255,255,0.5);
    font-size: 9px;
    text-anchor: start;
    dominant-baseline: central;
    pointer-events: none;
}

/* Node list panel */
.node-list {
    padding: 0;
}

.node-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: background 0.12s;
}

.node-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.node-item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}

.node-type-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
    white-space: nowrap;
    min-width: 42px;
    text-align: center;
}

.badge-start    { background: #2d7d46; color: #fff; }
.badge-end      { background: #5a5a5a; color: #fff; }
.badge-llm      { background: #1a6b3a; color: #fff; }
.badge-tool     { background: #1565c0; color: #fff; }
.badge-decision { background: #e65100; color: #fff; }
.badge-error    { background: #b71c1c; color: #fff; }

.node-info {
    flex: 1;
    min-width: 0;
}

.node-name {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.node-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
}

/* Mermaid output panel */
.mermaid-container {
    padding: 10px;
    font-size: 11px;
}

.mermaid-container pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 10px;
    border-radius: 4px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow-x: auto;
    white-space: pre;
    color: var(--vscode-foreground);
}

.mermaid-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
}

/* Detail panel */
.detail-panel {
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
    max-height: 50%;
    overflow: auto;
    flex-shrink: 0;
    display: none;
}

.detail-panel.visible { display: block; }

.detail-header {
    padding: 8px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: sticky;
    top: 0;
    z-index: 2;
}

.detail-close {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 14px;
    padding: 0 4px;
    font-family: var(--vscode-font-family);
}

.detail-body { padding: 8px 10px; }

.detail-body pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 8px;
    border-radius: 3px;
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
    margin: 0;
    color: var(--vscode-foreground);
}

.detail-section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--vscode-descriptionForeground);
    margin: 8px 0 4px 0;
}

.detail-section-label:first-child { margin-top: 0; }

.detail-meta {
    display: flex;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
}

.detail-meta strong { color: var(--vscode-foreground); }

.empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
    padding: 20px;
    flex-direction: column;
    gap: 12px;
}
.retry-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 5px 14px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
}
.retry-btn:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>

<div class="header-bar">
    <span class="header-title">LangGraph</span>
    <span class="header-meta" id="headerMeta"></span>
    <div class="toggle-group">
        <button class="toggle-btn active" data-view="input" onclick="setView('input')">In</button>
        <button class="toggle-btn" data-view="output" onclick="setView('output')">Out</button>
        <button class="toggle-btn" data-view="both" onclick="setView('both')">Both</button>
    </div>
</div>

<div class="tab-bar">
    <button class="tab-btn active" data-tab="graph" onclick="switchTab('graph')">Graph</button>
    <button class="tab-btn" data-tab="nodes" onclick="switchTab('nodes')">Nodes</button>
    <button class="tab-btn" data-tab="mermaid" onclick="switchTab('mermaid')">Mermaid</button>
</div>

<div class="tab-content active" id="tab-graph">
    <div class="graph-container" id="graphContainer">
        <div class="empty-state" id="emptyState">
            <span id="emptyMsg">Loading execution graph…</span>
            <button class="retry-btn" id="retryBtn" style="display:none" onclick="retryLoad()">Retry</button>
        </div>
    </div>
</div>

<div class="tab-content" id="tab-nodes">
    <div class="node-list" id="nodeList">
        <div class="empty-state">No nodes.</div>
    </div>
</div>

<div class="tab-content" id="tab-mermaid">
    <div class="mermaid-container" id="mermaidContainer">
        <div class="empty-state">No graph data.</div>
    </div>
</div>

<div class="detail-panel" id="detailPanel">
    <div class="detail-header">
        <span id="detailTitle">Node Detail</span>
        <button class="detail-close" onclick="closeDetail()">x</button>
    </div>
    <div class="detail-body" id="detailBody"></div>
</div>

<script>
const vscode = acquireVsCodeApi();

let graphData = null;
let selectedNodeId = null;
let currentView = 'input';
let currentTab = 'graph';
let retryCount = 0;
let retryTimer = null;

function retryLoad() {
    document.getElementById('emptyMsg').textContent = 'Loading execution graph…';
    document.getElementById('retryBtn').style.display = 'none';
    vscode.postMessage({ type: 'requestGraph' });
}

function showEmptyState(msg) {
    document.getElementById('emptyMsg').textContent = msg || 'No trace loaded. Open a trace first.';
    document.getElementById('retryBtn').style.display = 'inline-block';
    document.getElementById('emptyState').style.display = 'flex';
}

// Schedule retry if no graph data arrives within timeout
function scheduleRetry(ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        if (!graphData && retryCount < 3) {
            retryCount++;
            vscode.postMessage({ type: 'requestGraph' });
            scheduleRetry(1500);
        } else if (!graphData) {
            showEmptyState('No trace loaded. Open a trace to view the execution graph.');
        }
    }, ms);
}

const NODE_WIDTH = 180;
const NODE_HEIGHT = 48;
const VERTICAL_GAP = 36;
const LEFT_MARGIN = 20;
const GROUP_THRESHOLD = 15; // Collapse nodes of same type if total > threshold
let collapsedGroups = {};

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('active', c.id === 'tab-' + tab);
    });
}

function setView(view) {
    currentView = view;
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    if (selectedNodeId && graphData) {
        const node = findNodeById(selectedNodeId);
        if (node) showDetail(node);
    }
}

function findNodeById(id) {
    if (!graphData) return null;
    return graphData.nodes.find(n => n.id === id);
}

function closeDetail() {
    document.getElementById('detailPanel').classList.remove('visible');
    selectedNodeId = null;
    document.querySelectorAll('.node-group').forEach(g => g.classList.remove('selected'));
    document.querySelectorAll('.node-item').forEach(i => i.classList.remove('selected'));
}

function showDetail(node) {
    const panel = document.getElementById('detailPanel');
    const title = document.getElementById('detailTitle');
    const body = document.getElementById('detailBody');

    title.textContent = node.name + ' [' + node.type + ']';

    let html = '<div class="detail-meta">';
    html += '<span>Type: <strong>' + node.type.toUpperCase() + '</strong></span>';
    html += '<span>Steps: <strong>' + node.steps.length + '</strong></span>';
    const totalDur = node.steps.reduce((s, st) => s + (st.duration || 0), 0);
    html += '<span>Total: <strong>' + totalDur + 'ms</strong></span>';
    html += '</div>';

    // Branch button
    const firstStep = node.steps[0];
    if (firstStep && !node.isStart) {
        html += '<div style="margin:8px 0">';
        html += '<button style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 12px;border-radius:3px;cursor:pointer;font-size:11px;font-family:var(--vscode-font-family)" ';
        html += 'onclick="branchFromNode(\'' + node.id + '\',' + firstStep.stepNumber + ')">Fork from this node</button>';
        html += '</div>';
    }

    for (let i = 0; i < node.steps.length; i++) {
        const step = node.steps[i];
        html += '<div class="detail-section-label">Step #' + step.stepNumber + ' (' + (step.duration || 0) + 'ms)</div>';

        if (currentView === 'input' || currentView === 'both') {
            html += '<div class="detail-section-label" style="margin-top:4px;font-size:9px">Input</div>';
            html += '<pre>' + escapeHtml(JSON.stringify(step.input, null, 2)) + '</pre>';
        }
        if (currentView === 'output' || currentView === 'both') {
            html += '<div class="detail-section-label" style="margin-top:4px;font-size:9px">Output</div>';
            html += '<pre>' + escapeHtml(JSON.stringify(step.output, null, 2)) + '</pre>';
        }
    }

    body.innerHTML = html;
    panel.classList.add('visible');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function renderGraph(data) {
    graphData = data;
    updateHeader(data);
    renderSvgGraph(data);
    renderNodeList(data);
    renderMermaid(data);
}

function updateHeader(data) {
    const meta = document.getElementById('headerMeta');
    if (data) {
        meta.textContent = data.nodes.length + ' nodes / ' + data.edges.length + ' edges';
    }
}

function renderSvgGraph(data) {
    const container = document.getElementById('graphContainer');
    const empty = document.getElementById('emptyState');

    if (!data || !data.nodes || data.nodes.length === 0) {
        showEmptyState('Trace loaded but graph has no nodes. The trace may have 0 steps.');
        return;
    }
    empty.style.display = 'none';

    // Layout: assign positions to unique nodes
    const nodePositions = {};
    let y = 16;
    for (const node of data.nodes) {
        nodePositions[node.id] = { x: LEFT_MARGIN, y };
        y += NODE_HEIGHT + VERTICAL_GAP;
    }

    const svgW = NODE_WIDTH + LEFT_MARGIN * 2 + 40;
    const svgH = y + 10;

    let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '">';
    svg += '<defs>';
    svg += '<marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">';
    svg += '<polygon points="0 0, 8 3, 0 6" fill="var(--vscode-panel-border)" />';
    svg += '</marker>';
    svg += '<marker id="arrowhead-active" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">';
    svg += '<polygon points="0 0, 8 3, 0 6" fill="var(--vscode-focusBorder)" />';
    svg += '</marker>';
    svg += '</defs>';

    // Edges
    for (const edge of data.edges) {
        const fromPos = nodePositions[edge.source];
        const toPos = nodePositions[edge.target];
        if (!fromPos || !toPos) continue;

        const x1 = fromPos.x + NODE_WIDTH / 2;
        const y1 = fromPos.y + NODE_HEIGHT;
        const x2 = toPos.x + NODE_WIDTH / 2;
        const y2 = toPos.y;

        const cls = 'graph-edge' + (edge.conditional ? ' conditional' : '');
        svg += '<line class="' + cls + '" data-from="' + edge.source + '" data-to="' + edge.target + '"';
        svg += ' x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" />';
    }

    // Nodes
    for (const node of data.nodes) {
        const pos = nodePositions[node.id];
        if (!pos) continue;

        const typeClass = node.isStart ? 'start' : node.isEnd ? 'end' : node.type;
        svg += '<g class="node-group node-' + typeClass + '" data-id="' + node.id + '" onclick="selectNode(\'' + node.id + '\')">';
        svg += '<rect class="node-rect" x="' + pos.x + '" y="' + pos.y + '" width="' + NODE_WIDTH + '" height="' + NODE_HEIGHT + '" />';

        const cx = pos.x + NODE_WIDTH / 2;
        const cy = pos.y + NODE_HEIGHT / 2;
        svg += '<text class="node-label" x="' + cx + '" y="' + cy + '">' + escapeHtml(node.name) + '</text>';

        // Step count
        svg += '<text class="node-step-count" x="' + (pos.x + 8) + '" y="' + (pos.y + 12) + '">' + node.steps.length + 'x</text>';

        // Total duration
        const dur = node.steps.reduce((s, st) => s + (st.duration || 0), 0);
        if (dur > 0) {
            svg += '<text class="node-badge" x="' + (pos.x + NODE_WIDTH - 8) + '" y="' + (pos.y + 12) + '">' + dur + 'ms</text>';
        }

        svg += '</g>';
    }

    svg += '</svg>';
    container.innerHTML = svg;
}

function renderNodeList(data) {
    const list = document.getElementById('nodeList');
    if (!data || !data.nodes || data.nodes.length === 0) {
        list.innerHTML = '<div class="empty-state">No nodes.</div>';
        return;
    }

    const useGroups = data.nodes.length > GROUP_THRESHOLD;
    let html = '';

    if (useGroups) {
        // Group by type
        const groups = {};
        for (const node of data.nodes) {
            const type = node.isStart ? 'start' : node.isEnd ? 'end' : node.type;
            if (!groups[type]) groups[type] = [];
            groups[type].push(node);
        }

        for (const [type, nodes] of Object.entries(groups)) {
            const isCollapsed = collapsedGroups[type] === true;
            const count = nodes.length;
            const totalDur = nodes.reduce((s, n) => s + n.steps.reduce((a, st) => a + (st.duration || 0), 0), 0);

            html += '<div class="node-group-header" onclick="toggleGroup(\'' + type + '\')" style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-panel-border);cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">';
            html += '<span style="font-size:10px">' + (isCollapsed ? '▶' : '▼') + '</span>';
            html += '<span class="node-type-badge badge-' + type + '">' + type + '</span>';
            html += '<span style="flex:1">' + count + ' node' + (count > 1 ? 's' : '') + '</span>';
            html += '<span style="font-size:10px;color:var(--vscode-descriptionForeground)">' + totalDur + 'ms</span>';
            html += '</div>';

            if (!isCollapsed) {
                for (const node of nodes) {
                    html += renderNodeItem(node);
                }
            }
        }
    } else {
        for (const node of data.nodes) {
            html += renderNodeItem(node);
        }
    }

    list.innerHTML = html;
}

function renderNodeItem(node) {
    const typeClass = node.isStart ? 'start' : node.isEnd ? 'end' : node.type;
    const dur = node.steps.reduce((s, st) => s + (st.duration || 0), 0);

    let html = '<div class="node-item" data-id="' + node.id + '" onclick="selectNode(\'' + node.id + '\')">';
    html += '<span class="node-type-badge badge-' + typeClass + '">' + node.type + '</span>';
    html += '<div class="node-info">';
    html += '<div class="node-name">' + escapeHtml(node.name) + '</div>';
    html += '<div class="node-meta">' + node.steps.length + ' execution(s) / ' + dur + 'ms</div>';
    html += '</div>';
    html += '</div>';
    return html;
}

function toggleGroup(type) {
    collapsedGroups[type] = !collapsedGroups[type];
    if (graphData) renderNodeList(graphData);
}

function renderMermaid(data) {
    const container = document.getElementById('mermaidContainer');
    if (!data || !data.mermaid) {
        container.innerHTML = '<div class="empty-state">No graph data.</div>';
        return;
    }

    let html = '<div class="mermaid-label">LangGraph Mermaid Output (from drawMermaid)</div>';
    html += '<pre>' + escapeHtml(data.mermaid) + '</pre>';
    html += '<div style="margin-top:10px">';
    html += '<div class="mermaid-label">Graph Stats</div>';
    html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">';
    html += 'Trace: ' + data.traceId + '<br>';
    html += 'Status: ' + data.status + '<br>';
    html += 'Total steps: ' + data.totalSteps + '<br>';
    html += 'Unique nodes: ' + data.nodes.length + '<br>';
    html += 'Edges: ' + data.edges.length + '<br>';

    const condEdges = data.edges.filter(e => e.conditional).length;
    if (condEdges > 0) {
        html += 'Conditional edges: ' + condEdges + '<br>';
    }
    html += '</div></div>';
    container.innerHTML = html;
}

function selectNode(nodeId) {
    selectedNodeId = nodeId;

    document.querySelectorAll('.node-group').forEach(g => {
        g.classList.toggle('selected', g.getAttribute('data-id') === nodeId);
    });
    document.querySelectorAll('.node-item').forEach(i => {
        i.classList.toggle('selected', i.getAttribute('data-id') === nodeId);
    });

    if (graphData) {
        const node = findNodeById(nodeId);
        if (node) {
            showDetail(node);

            document.querySelectorAll('.graph-edge').forEach(edge => {
                const from = edge.getAttribute('data-from');
                const to = edge.getAttribute('data-to');
                if (from === nodeId || to === nodeId) {
                    edge.classList.add('active');
                    edge.setAttribute('marker-end', 'url(#arrowhead-active)');
                } else {
                    edge.classList.remove('active');
                    edge.setAttribute('marker-end', 'url(#arrowhead)');
                }
            });
        }
    }
}

function branchFromNode(nodeId, stepNumber) {
    vscode.postMessage({ type: 'branchFromNode', nodeId: nodeId, stepNumber: stepNumber });
}

window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
        case 'loadGraph':
            clearTimeout(retryTimer);
            retryCount = 0;
            renderGraph(msg.graph);
            break;
        case 'graphError':
            showEmptyState('Graph build failed: ' + msg.message);
            break;
        case 'noTrace':
            showEmptyState('No trace loaded. Open a trace to view the execution graph.');
            break;
        case 'highlightStep': {
            if (!graphData) break;
            // Find the node containing this step
            const target = graphData.nodes.find(n =>
                n.steps.some(s => s.stepNumber === msg.stepNumber)
            );
            if (target) {
                selectNode(target.id);
                const el = document.querySelector('[data-id="' + target.id + '"]');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            break;
        }
    }
});

scheduleRetry(800);
vscode.postMessage({ type: 'requestGraph' });
</script>
</body>
</html>`;
    }
}
