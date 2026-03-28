import * as vscode from 'vscode';

/**
 * SearchProvider - Full-text search across all trace steps.
 * 
 * Provides a webview panel with a search bar that filters through
 * step inputs/outputs and highlights matching graph nodes.
 */
export class SearchProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'acp.searchView';

    private _view?: vscode.WebviewView;
    private _searchResults: SearchResult[] = [];

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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'search':
                    this._onSearchRequested(data.query);
                    break;
                case 'jumpToStep':
                    vscode.commands.executeCommand('acp.jumpToStep', data.stepId);
                    break;
            }
        });
    }

    /**
     * Set search results from external search logic (called from extension.ts).
     */
    public setResults(results: SearchResult[]) {
        this._searchResults = results;
        if (this._view) {
            this._view.webview.postMessage({
                type: 'searchResults',
                results,
            });
        }
    }

    private _onSearchCallback?: (query: string) => void;

    /**
     * Register a callback for when search is triggered from the webview.
     */
    public onSearch(callback: (query: string) => void) {
        this._onSearchCallback = callback;
    }

    private _onSearchRequested(query: string) {
        if (this._onSearchCallback) {
            this._onSearchCallback(query);
        }
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
}
.search-box {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
}
.search-input {
    flex: 1;
    padding: 5px 8px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: 12px;
    border-radius: 3px;
    outline: none;
}
.search-input:focus {
    border-color: var(--vscode-focusBorder);
}
.search-btn {
    padding: 5px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family);
}
.search-btn:hover {
    background: var(--vscode-button-hoverBackground);
}
.filter-row {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
    flex-wrap: wrap;
}
.filter-chip {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    cursor: pointer;
    border: 1px solid var(--vscode-panel-border);
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
}
.filter-chip.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
}
.results-count {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 6px;
}
.result-item {
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    font-size: 11px;
}
.result-item:hover {
    background: var(--vscode-list-hoverBackground);
}
.result-header {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-bottom: 2px;
}
.result-step {
    font-weight: 600;
    color: var(--vscode-textLink-foreground);
}
.result-type {
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
}
.result-match {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.result-match mark {
    background: rgba(255, 213, 0, 0.3);
    color: var(--vscode-foreground);
    padding: 0 2px;
    border-radius: 2px;
}
.empty {
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    padding: 20px;
}
</style>
</head>
<body>
<div class="search-box">
    <input class="search-input" id="searchInput" placeholder="Search steps..." type="text" />
    <button class="search-btn" onclick="doSearch()">Search</button>
</div>
<div class="filter-row">
    <button class="filter-chip active" data-filter="all" onclick="toggleFilter('all')">All</button>
    <button class="filter-chip" data-filter="llm" onclick="toggleFilter('llm')">LLM</button>
    <button class="filter-chip" data-filter="tool" onclick="toggleFilter('tool')">Tool</button>
    <button class="filter-chip" data-filter="error" onclick="toggleFilter('error')">Error</button>
    <button class="filter-chip" data-filter="state" onclick="toggleFilter('state')">State</button>
</div>
<div class="results-count" id="resultsCount"></div>
<div id="resultsList">
    <div class="empty">Enter a search query to find matching steps.</div>
</div>

<script>
const vscode = acquireVsCodeApi();
let allResults = [];
let activeFilter = 'all';

document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
});

function doSearch() {
    const query = document.getElementById('searchInput').value.trim();
    if (!query) return;
    vscode.postMessage({ type: 'search', query });
}

function toggleFilter(filter) {
    activeFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => {
        c.classList.toggle('active', c.getAttribute('data-filter') === filter);
    });
    renderResults();
}

function renderResults() {
    const list = document.getElementById('resultsList');
    const count = document.getElementById('resultsCount');
    
    const filtered = activeFilter === 'all' 
        ? allResults 
        : allResults.filter(r => r.stepType === activeFilter);

    count.textContent = filtered.length + ' result(s)' + (activeFilter !== 'all' ? ' [' + activeFilter + ']' : '');

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty">No results found.</div>';
        return;
    }

    let html = '';
    for (const r of filtered) {
        html += '<div class="result-item" onclick="jumpTo(' + r.stepId + ')">';
        html += '<div class="result-header">';
        html += '<span class="result-step">Step ' + r.stepId + '</span>';
        html += '<span class="result-type">' + r.stepType + '</span>';
        html += '</div>';
        html += '<div class="result-match">' + r.matchContext + '</div>';
        html += '</div>';
    }
    list.innerHTML = html;
}

function jumpTo(stepId) {
    vscode.postMessage({ type: 'jumpToStep', stepId });
}

window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'searchResults') {
        allResults = msg.results;
        renderResults();
    }
});
</script>
</body>
</html>`;
    }
}

export interface SearchResult {
    stepId: number;
    stepType: string;
    matchField: 'input' | 'output';
    matchContext: string;
    nodeId?: string;
}
