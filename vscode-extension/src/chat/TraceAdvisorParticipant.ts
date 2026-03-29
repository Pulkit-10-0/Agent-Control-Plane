/**
 * TraceAdvisorParticipant - GitHub Copilot Chat Participant
 *
 * Provides AI agent trace context to Copilot Chat. Reads the most recent
 * trace files and injects warnings, step counts, tool usage, and failure
 * classifications as context for better Copilot responses.
 *
 * Also includes session logs from the TraceSessionLogger for recent code changes.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { RunMeta, AgentStep, RunArtifacts } from '../data/DataTypes';
import { RunLoader } from '../data/RunLoader';
import { AnalysisEngine, AnalysisReport } from '../engines/AnalysisEngine';

/** State for A/B testing - whether trace injection is enabled */
let traceInjectionEnabled: boolean = true;

/** Status bar item for showing injection state */
let statusBarItem: vscode.StatusBarItem;

/** Interface for trace summary that's injected into Copilot context */
interface TraceSummary {
    runId: string;
    stepCount: number;
    toolUsage: Map<string, number>;
    warnings: string[];
    failures: FailureInfo[];
    retryRate: number;
}

interface FailureInfo {
    stepId: number;
    phase: string;
    description: string;
}

/** Interface for session log entry */
interface SessionLogEntry {
    step_number: number;
    timestamp: string;
    file_path: string;
    before_snippet: string;
    after_snippet: string;
    what_changed: string;
}

/**
 * Discover all available traces from workspace folders.
 * Returns paths to trace directories/files, sorted by modification time (newest first).
 */
function discoverTraces(): { path: string; mtime: number; type: 'sdk' | 'legacy' }[] {
    const traces: { path: string; mtime: number; type: 'sdk' | 'legacy' }[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
        return traces;
    }

    for (const folder of workspaceFolders) {
        const tracesDir = path.join(folder.uri.fsPath, 'traces');
        if (!fs.existsSync(tracesDir)) {
            continue;
        }

        const entries = fs.readdirSync(tracesDir, { withFileTypes: true });

        // SDK run folders (run_*)
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith('run_')) {
                const runDir = path.join(tracesDir, entry.name);
                const metaPath = path.join(runDir, 'meta.json');
                if (fs.existsSync(metaPath)) {
                    const stat = fs.statSync(metaPath);
                    traces.push({
                        path: runDir,
                        mtime: stat.mtimeMs,
                        type: 'sdk'
                    });
                }
            }
        }

        // Legacy JSON traces
        for (const entry of entries) {
            if (!entry.isDirectory() && entry.name.endsWith('.json') && !entry.name.startsWith('run_')) {
                const filePath = path.join(tracesDir, entry.name);
                const stat = fs.statSync(filePath);
                traces.push({
                    path: filePath,
                    mtime: stat.mtimeMs,
                    type: 'legacy'
                });
            }
        }
    }

    // Sort by modification time, newest first
    traces.sort((a, b) => b.mtime - a.mtime);
    return traces;
}

/**
 * Load an SDK run and extract summary information.
 */
async function loadSdkRunSummary(runPath: string): Promise<TraceSummary | null> {
    try {
        const loader = new RunLoader(runPath);
        const run = await loader.load();

        // Compute tool usage
        const toolUsage = new Map<string, number>();
        for (const step of run.steps) {
            if (step.phase === 'tool') {
                const toolName = step.input?.toolName || step.input?.tool || 'unknown';
                toolUsage.set(toolName, (toolUsage.get(toolName) || 0) + 1);
            }
        }

        // Collect warnings using AnalysisEngine
        const analysisEngine = new AnalysisEngine();
        const report = analysisEngine.analyze(run);

        const warnings: string[] = [];

        // Check for retry loops
        const retryCount = run.steps.filter(s => s.status === 'retry').length;
        const retryRate = run.steps.length > 0 ? retryCount / run.steps.length : 0;
        if (retryRate > 0.3) {
            warnings.push(`High retry rate: ${(retryRate * 100).toFixed(1)}% of steps are retries`);
        }

        // Check for repeated tool calls (loop detection)
        const toolSequence: string[] = [];
        for (const step of run.steps) {
            if (step.phase === 'tool') {
                const toolName = step.input?.toolName || step.input?.tool || 'unknown';
                toolSequence.push(toolName);
            }
        }
        const repeatedPattern = detectRepeatedPattern(toolSequence);
        if (repeatedPattern) {
            warnings.push(`Loop detected: ${repeatedPattern} called repeatedly`);
        }

        // Memory bloat detection (check context_tokens growth in last snapshot)
        // This is a simplified heuristic
        if (run.steps.length > 20) {
            const lastStep = run.steps[run.steps.length - 1];
            const snapshot = loader.getSnapshot(lastStep.step_id);
            if (snapshot && snapshot.context_tokens > 100000) {
                warnings.push(`Memory bloat warning: context_tokens at ${snapshot.context_tokens}`);
            }
        }

        // Add invariant failures as warnings
        for (const inv of report.invariants) {
            if (inv.status === 'fail') {
                warnings.push(`Invariant failure: ${inv.name} - ${inv.details}`);
            }
        }

        // Collect failure info
        const failures: FailureInfo[] = [];
        for (const step of run.steps) {
            if (step.status === 'error') {
                failures.push({
                    stepId: step.step_id,
                    phase: step.phase,
                    description: step.output?.error || step.output?.message || 'Error occurred'
                });
            }
        }

        // Add root cause analysis if available
        if (report.rootCause) {
            failures.push({
                stepId: report.rootCause.failureStepId,
                phase: 'analysis',
                description: report.rootCause.description
            });
        }

        return {
            runId: run.meta.run_id,
            stepCount: run.steps.length,
            toolUsage,
            warnings,
            failures,
            retryRate
        };
    } catch (err) {
        console.error(`Failed to load SDK run ${runPath}:`, err);
        return null;
    }
}

/**
 * Load a legacy trace and extract summary information.
 */
async function loadLegacyTraceSummary(filePath: string): Promise<TraceSummary | null> {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const trace = JSON.parse(content);

        const toolUsage = new Map<string, number>();
        const warnings: string[] = [];
        const failures: FailureInfo[] = [];

        if (trace.steps && Array.isArray(trace.steps)) {
            for (const step of trace.steps) {
                if (step.stepType === 'tool') {
                    const toolName = step.toolName || step.input?.toolName || 'unknown';
                    toolUsage.set(toolName, (toolUsage.get(toolName) || 0) + 1);
                }
                if (step.stepType === 'error' || step.error) {
                    failures.push({
                        stepId: step.stepNumber,
                        phase: step.stepType,
                        description: step.error || step.data?.error || 'Error occurred'
                    });
                }
            }

            // Check for high step count
            if (trace.steps.length > 100) {
                warnings.push(`High step count: ${trace.steps.length} steps`);
            }

            // Check for repeated tool calls
            const toolSequence = trace.steps
                .filter((s: any) => s.stepType === 'tool')
                .map((s: any) => s.toolName || s.input?.toolName || 'unknown');
            const repeatedPattern = detectRepeatedPattern(toolSequence);
            if (repeatedPattern) {
                warnings.push(`Loop detected: ${repeatedPattern} called repeatedly`);
            }
        }

        // Check trace status
        if (trace.status === 'failed') {
            warnings.push('Trace ended in failed status');
        }

        return {
            runId: trace.traceId || path.basename(filePath, '.json'),
            stepCount: trace.steps?.length || 0,
            toolUsage,
            warnings,
            failures,
            retryRate: 0
        };
    } catch (err) {
        console.error(`Failed to load legacy trace ${filePath}:`, err);
        return null;
    }
}

/**
 * Detect repeated patterns in tool call sequence.
 * Returns the repeated tool name if a loop is detected.
 */
function detectRepeatedPattern(sequence: string[]): string | null {
    if (sequence.length < 4) {
        return null;
    }

    // Check for same tool called 4+ times in a row
    for (let i = 0; i <= sequence.length - 4; i++) {
        if (sequence[i] === sequence[i + 1] &&
            sequence[i] === sequence[i + 2] &&
            sequence[i] === sequence[i + 3]) {
            return sequence[i];
        }
    }

    return null;
}

/**
 * Format trace summaries into a context string for Copilot.
 */
function formatTraceSummariesForContext(summaries: TraceSummary[]): string {
    if (summaries.length === 0) {
        return '';
    }

    const lines: string[] = [
        '=== ACP TRACE CONTEXT ===',
        `Traces analyzed: ${summaries.length}`,
        ''
    ];

    for (const summary of summaries) {
        lines.push(`--- Run: ${summary.runId} ---`);
        lines.push(`Step count: ${summary.stepCount}`);

        if (summary.toolUsage.size > 0) {
            const toolList = Array.from(summary.toolUsage.entries())
                .map(([tool, count]) => `${tool}(${count})`)
                .join(', ');
            lines.push(`Tool usage: ${toolList}`);
        }

        if (summary.retryRate > 0) {
            lines.push(`Retry rate: ${(summary.retryRate * 100).toFixed(1)}%`);
        }

        if (summary.warnings.length > 0) {
            lines.push('Warnings:');
            for (const warning of summary.warnings) {
                lines.push(`  - ${warning}`);
            }
        }

        if (summary.failures.length > 0) {
            lines.push('Failures:');
            for (const failure of summary.failures) {
                lines.push(`  - Step ${failure.stepId} (${failure.phase}): ${failure.description}`);
            }
        }

        lines.push('');
    }

    lines.push('=========================');
    return lines.join('\n');
}

/**
 * Read recent session logs from traces/session_log/
 */
function readRecentSessionLogs(maxEntries: number = 10): SessionLogEntry[] {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return [];
    }

    const logs: SessionLogEntry[] = [];

    for (const folder of workspaceFolders) {
        const sessionLogDir = path.join(folder.uri.fsPath, 'traces', 'session_log');
        if (!fs.existsSync(sessionLogDir)) {
            continue;
        }

        const files = fs.readdirSync(sessionLogDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .slice(-maxEntries); // Get the last N entries

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(sessionLogDir, file), 'utf-8');
                logs.push(JSON.parse(content));
            } catch (err) {
                console.warn(`Failed to read session log ${file}:`, err);
            }
        }
    }

    return logs;
}

/**
 * Format session logs for context injection.
 */
function formatSessionLogsForContext(logs: SessionLogEntry[]): string {
    if (logs.length === 0) {
        return '';
    }

    const lines: string[] = [
        '',
        '=== RECENT CODE CHANGES ===',
        `Changes logged: ${logs.length}`,
        ''
    ];

    for (const log of logs.slice(-5)) { // Only show last 5 changes
        lines.push(`Step ${log.step_number}: ${log.file_path}`);
        lines.push(`  Changed: ${log.what_changed}`);
        lines.push(`  Time: ${log.timestamp}`);
    }

    lines.push('===========================');
    return lines.join('\n');
}

/**
 * Get trace injection enabled state.
 */
export function isTraceInjectionEnabled(): boolean {
    return traceInjectionEnabled;
}

/**
 * Toggle trace injection state.
 */
export function toggleTraceInjection(): boolean {
    traceInjectionEnabled = !traceInjectionEnabled;
    updateStatusBarItem();
    return traceInjectionEnabled;
}

/**
 * Initialize status bar item.
 */
export function initializeStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'agent-control-plane.toggleTraceInjection';
    updateStatusBarItem();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

/**
 * Update status bar item text and tooltip.
 */
function updateStatusBarItem(): void {
    if (!statusBarItem) {
        return;
    }

    if (traceInjectionEnabled) {
        statusBarItem.text = '$(debug-start) ACP Traces: ON';
        statusBarItem.tooltip = 'Click to disable trace injection in @ACP chat';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(debug-pause) ACP Traces: OFF';
        statusBarItem.tooltip = 'Click to enable trace injection in @ACP chat';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

/**
 * The main chat participant request handler.
 */
export async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {

    // If trace injection is disabled, pass through to model directly
    if (!traceInjectionEnabled) {
        stream.markdown('*Traces Used: OFF*\n\n');

        // Get model and send request without trace context
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (models.length === 0) {
            stream.markdown('No Copilot model available. Please ensure GitHub Copilot is installed and active.');
            return { metadata: { tracesUsed: false } };
        }

        const model = models[0];
        const messages = [
            vscode.LanguageModelChatMessage.User(request.prompt)
        ];

        try {
            const response = await model.sendRequest(messages, {}, token);
            for await (const chunk of response.text) {
                stream.markdown(chunk);
            }
        } catch (err) {
            stream.markdown(`\n\nError communicating with Copilot: ${err}`);
        }

        return { metadata: { tracesUsed: false } };
    }

    // Discover and load recent traces
    const traceInfos = discoverTraces();

    if (traceInfos.length === 0) {
        stream.markdown('No traces recorded yet. Run your agent first.');
        return { metadata: { tracesUsed: false, noTraces: true } };
    }

    // Load summaries for up to 3 most recent traces
    const summaries: TraceSummary[] = [];
    for (const traceInfo of traceInfos.slice(0, 3)) {
        let summary: TraceSummary | null = null;

        if (traceInfo.type === 'sdk') {
            summary = await loadSdkRunSummary(traceInfo.path);
        } else {
            summary = await loadLegacyTraceSummary(traceInfo.path);
        }

        if (summary) {
            summaries.push(summary);
        }
    }

    if (summaries.length === 0) {
        stream.markdown('No traces recorded yet. Run your agent first.');
        return { metadata: { tracesUsed: false, noTraces: true } };
    }

    // Format trace context
    const traceContext = formatTraceSummariesForContext(summaries);

    // Also include recent session logs
    const sessionLogs = readRecentSessionLogs(10);
    const sessionLogContext = formatSessionLogsForContext(sessionLogs);

    stream.markdown('*Traces Used: ON*\n\n');

    // Get Copilot model
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
        stream.markdown('No Copilot model available. Please ensure GitHub Copilot is installed and active.');
        return { metadata: { tracesUsed: true, modelUnavailable: true } };
    }

    const model = models[0];

    // Build the augmented prompt with trace context and session logs
    const augmentedPrompt = `${traceContext}${sessionLogContext}

User Question: ${request.prompt}

Based on the trace context above (if relevant), please help answer the user's question. If the trace data shows any issues like loops, high retry rates, or failures, consider mentioning them if they're relevant to the question. Also consider recent code changes if they're relevant.`;

    const messages = [
        vscode.LanguageModelChatMessage.User(augmentedPrompt)
    ];

    try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }
    } catch (err) {
        stream.markdown(`\n\nError communicating with Copilot: ${err}`);
    }

    return {
        metadata: {
            tracesUsed: true,
            tracesAnalyzed: summaries.length,
            traceIds: summaries.map(s => s.runId)
        }
    };
}
