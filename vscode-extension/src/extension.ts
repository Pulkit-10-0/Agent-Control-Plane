/**
 * Agent Control Plane - VS Code Extension
 *
 * A time-travel debugger for AI agents. Reconstructs agent cognition from
 * deterministic execution traces. Supports both legacy single-JSON traces
 * and SDK run-folder format (meta.json + steps.jsonl).
 *
 * Features:
 *   - Trace browser: discovers .json and run_* folders in workspace
 *   - Replay controller: play/pause/step through execution
 *   - LangGraph visualization: SVG graph, Mermaid, node inspector
 *   - Timeline sidebar: phase-colored step list with keyboard nav
 *   - State inspector: input/output/memory/tool logs with secret redaction
 *   - Diff viewer: VS Code native diff between consecutive steps
 *   - Hierarchy tree: group steps by phase, status, or flat
 *   - Comparison: side-by-side alignment of two runs
 *   - Analysis engine: semantic labels, invariant checks, root cause
 *   - Counterfactual engine: fork a run at any step with modified input
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

// LangGraph
import { LangGraphProvider } from "./ui/LangGraphProvider";
import { normalizeRunToTraceData } from "./langgraph/LangGraphBuilder";

// SDK data layer
import { RunContext } from "./data/RunContext";
import { RunArtifacts } from "./data/DataTypes";

// Sidebar providers
import { TimelineProvider } from "./ui/TimelineProvider";
import { StateInspectorProvider } from "./ui/StateInspectorProvider";
import { DiffViewProvider } from "./ui/DiffViewProvider";
import { HierarchyProvider } from "./ui/HierarchyProvider";
import { SearchProvider } from "./ui/SearchProvider";
import { StateMetricsProvider } from "./ui/StateMetricsProvider";

// Document providers
import { DiffContentProvider } from "./providers/DiffContentProvider";

// Engines
import { AnalysisEngine } from "./engines/AnalysisEngine";
import { CounterfactualEngine } from "./engines/CounterfactualEngine";

// Chat participant
import {
  handleChatRequest,
  initializeStatusBar,
  toggleTraceInjection
} from "./chat/TraceAdvisorParticipant";

// Tracing and Gemini integration
import { TraceSessionLogger, GeminiService } from "./tracing";

// Copilot output watcher
import { CopilotOutputWatcher } from "./watchers/CopilotOutputWatcher";

// Exporter
import { LangGraphExporter } from "./langgraph/LangGraphExporter";

// Command handlers (SDK format)
import {
  openRunCommand,
  openFailureCommand,
  generateReportCommand,
  compareRunCommand,
  counterfactualCommand,
} from "./commands/CommandHandlers";

// ---------------------------------------------------------------------------
// Legacy trace types (single-JSON format)
// ---------------------------------------------------------------------------
interface LegacyTrace {
  traceId: string;
  agentId: string;
  taskId: string;
  startTime: string;
  endTime?: string;
  status: string;
  steps: LegacyStep[];
  finalState?: unknown;
  metadata: {
    agentVersion: string;
    toolsUsed: string[];
    totalLLMCalls: number;
    totalToolCalls: number;
  };
}

interface LegacyStep {
  stepNumber: number;
  stepType: string;
  timestamp: string;
  input: unknown;
  output: unknown;
  stateSnapshot: unknown;
  duration?: number;
}

interface ReplayControllerState {
  state: "idle" | "playing" | "paused" | "stopped" | "completed";
  currentStepIndex: number;
  totalSteps: number;
  canPlayForward: boolean;
  canPlayBackward: boolean;
  progress: number;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let currentTrace: LegacyTrace | undefined;
let tracePanel: vscode.WebviewPanel | undefined;
let replayState: ReplayControllerState | undefined;
let autoPlayInterval: NodeJS.Timeout | undefined;
let langGraphProvider: LangGraphProvider;
let hierarchyProvider: HierarchyProvider;
let tracesProvider: TracesTreeProvider;
let traceSessionLogger: TraceSessionLogger | undefined;
let geminiService: GeminiService | undefined;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  console.log("Agent Control Plane extension activated");

  const runContext = RunContext.getInstance();

  // -----------------------------------------------------------------------
  // 1. Register DiffContentProvider (acp-diff: URI scheme)
  // -----------------------------------------------------------------------
  const diffContentProvider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      DiffContentProvider.scheme,
      diffContentProvider
    )
  );

  // -----------------------------------------------------------------------
  // 2. Initialize LangGraph panel manager
  // -----------------------------------------------------------------------
  langGraphProvider = new LangGraphProvider(context.extensionUri);

  // Wire graph branching: when user forks from a graph node, create counterfactual
  langGraphProvider.onBranchRequest(async (stepNumber, nodeId) => {
    const run = runContext.currentRun;
    if (!run) {
      vscode.window.showWarningMessage('No run loaded. Load a run first.');
      return;
    }
    const step = run.steps.find(s => s.step_id === stepNumber);
    if (!step) {
      vscode.window.showWarningMessage(`Step ${stepNumber} not found.`);
      return;
    }
    const newInput = await vscode.window.showInputBox({
      prompt: `Enter modified input JSON for step ${stepNumber} (node: ${nodeId}):`,
      value: JSON.stringify(step.input),
    });
    if (newInput === undefined) { return; }
    try {
      const parsedInput = JSON.parse(newInput);
      const engine = new CounterfactualEngine();
      const simPath = await engine.createSimulation(
        run,
        stepNumber,
        { input: parsedInput }
      );
      vscode.window.showInformationMessage(
        `Counterfactual branch created at: ${simPath}`
      );
      // Load the new simulation
      await runContext.loadRun(simPath);
    } catch (err) {
      vscode.window.showErrorMessage(`Branch failed: ${err}`);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Sidebar webview view providers
  // -----------------------------------------------------------------------
  const timelineProvider = new TimelineProvider(context.extensionUri);
  const stateInspectorProvider = new StateInspectorProvider(context.extensionUri);
  const diffViewProvider = new DiffViewProvider(context.extensionUri);
  const searchProvider = new SearchProvider(context.extensionUri);
  const stateMetricsProvider = new StateMetricsProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TimelineProvider.viewType,
      timelineProvider
    ),
    vscode.window.registerWebviewViewProvider(
      StateInspectorProvider.viewType,
      stateInspectorProvider
    ),
    vscode.window.registerWebviewViewProvider(
      DiffViewProvider.viewType,
      diffViewProvider
    ),
    vscode.window.registerWebviewViewProvider(
      SearchProvider.viewType,
      searchProvider
    ),
    vscode.window.registerWebviewViewProvider(
      StateMetricsProvider.viewType,
      stateMetricsProvider
    )
  );

  // -----------------------------------------------------------------------
  // 4. Hierarchy tree view
  // -----------------------------------------------------------------------
  hierarchyProvider = new HierarchyProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("acp.hierarchyView", hierarchyProvider)
  );

  // -----------------------------------------------------------------------
  // 5. Traces and Steps tree views
  // -----------------------------------------------------------------------
  tracesProvider = new TracesTreeProvider();
  const stepsProvider = new StepsTreeProvider();

  vscode.window.registerTreeDataProvider("acp.tracesView", tracesProvider);
  vscode.window.registerTreeDataProvider("acp.stepsView", stepsProvider);

  // -----------------------------------------------------------------------
  // 6. File watchers for trace discovery
  // -----------------------------------------------------------------------
  const jsonWatcher = vscode.workspace.createFileSystemWatcher("**/traces/*.json");
  jsonWatcher.onDidCreate(() => tracesProvider.refresh());
  jsonWatcher.onDidChange(() => tracesProvider.refresh());
  jsonWatcher.onDidDelete(() => tracesProvider.refresh());
  context.subscriptions.push(jsonWatcher);

  const metaWatcher = vscode.workspace.createFileSystemWatcher("**/traces/run_*/meta.json");
  metaWatcher.onDidCreate(() => tracesProvider.refresh());
  metaWatcher.onDidChange(() => tracesProvider.refresh());
  metaWatcher.onDidDelete(() => tracesProvider.refresh());
  context.subscriptions.push(metaWatcher);

  // Watch session_log and other session folders
  const sessionWatcher = vscode.workspace.createFileSystemWatcher("**/traces/*/*.json");
  sessionWatcher.onDidCreate(() => tracesProvider.refresh());
  sessionWatcher.onDidChange(() => tracesProvider.refresh());
  sessionWatcher.onDidDelete(() => tracesProvider.refresh());
  context.subscriptions.push(sessionWatcher);

  // Watch test-project traces folder
  const testProjectWatcher = vscode.workspace.createFileSystemWatcher("**/test-project/traces/**/*.json");
  testProjectWatcher.onDidCreate(() => tracesProvider.refresh());
  testProjectWatcher.onDidChange(() => tracesProvider.refresh());
  testProjectWatcher.onDidDelete(() => tracesProvider.refresh());
  context.subscriptions.push(testProjectWatcher);

  // -----------------------------------------------------------------------
  // 7. Bridge: when RunContext loads an SDK run, push to LangGraph + replay
  // -----------------------------------------------------------------------
  runContext.onDidRunChange(async (run) => {
    if (!run) { return; }

    // Convert SDK run to legacy trace format for the replay panel
    currentTrace = sdkRunToLegacyTrace(run);
    initializeReplayState();

    // Feed LangGraph
    const traceData = normalizeRunToTraceData(run);
    await langGraphProvider.setTrace(traceData);

    // Ensure graph panel is visible after loading
    langGraphProvider.show();

    // Refresh both trees so the loaded run appears in TRACES
    stepsProvider.refresh();
    tracesProvider.refresh();
  });

  runContext.onDidStepChange((step) => {
    if (!currentTrace) { return; }
    const index = currentTrace.steps.findIndex(s => s.stepNumber === step.step_id);
    if (index !== -1 && replayState) {
      replayState.currentStepIndex = index;
      updateReplayState();
      updateReplayUI();
    }
  });

  // -----------------------------------------------------------------------
  // 8. Register all commands
  // -----------------------------------------------------------------------
  context.subscriptions.push(
    // Legacy trace commands
    vscode.commands.registerCommand("acp.openTrace", openTraceCommand),
    vscode.commands.registerCommand("acp.showPanel", showPanelCommand),
    vscode.commands.registerCommand("acp.analyzeTrace", analyzeTraceCommand),
    vscode.commands.registerCommand("acp.showLangGraph", showLangGraphCommand),

    // SDK run commands
    vscode.commands.registerCommand("acp.openRun", openRunCommand),
    vscode.commands.registerCommand("acp.openFailure", openFailureCommand),
    vscode.commands.registerCommand("acp.generateReport", generateReportCommand),
    vscode.commands.registerCommand("acp.compareRun", () =>
      compareRunCommand(context.extensionUri)
    ),
    vscode.commands.registerCommand("acp.counterfactual", counterfactualCommand),

    // Step navigation
    vscode.commands.registerCommand("acp.jumpToStep", (stepId: number) => {
      const run = runContext.currentRun;
      if (run) {
        const index = run.steps.findIndex(s => s.step_id === stepId);
        if (index !== -1) {
          runContext.setStep(index);
        }
      }
    }),

    // Hierarchy grouping
    vscode.commands.registerCommand("acp.hierarchy.groupByPhase", () =>
      hierarchyProvider.setGrouping("phase")
    ),
    vscode.commands.registerCommand("acp.hierarchy.groupByStatus", () =>
      hierarchyProvider.setGrouping("retry")
    ),
    vscode.commands.registerCommand("acp.hierarchy.groupByNone", () =>
      hierarchyProvider.setGrouping("none")
    ),

    // Replay controller commands
    vscode.commands.registerCommand("acp.replay.play", replayPlayCommand),
    vscode.commands.registerCommand("acp.replay.pause", replayPauseCommand),
    vscode.commands.registerCommand("acp.replay.stop", replayStopCommand),
    vscode.commands.registerCommand("acp.replay.next", replayNextCommand),
    vscode.commands.registerCommand("acp.replay.prev", replayPrevCommand),
    vscode.commands.registerCommand("acp.replay.start", replayStartCommand),
    vscode.commands.registerCommand("acp.replay.end", replayEndCommand),
    vscode.commands.registerCommand("acp.replay.jump", replayJumpCommand),
    vscode.commands.registerCommand("acp.replay.search", replaySearchCommand),

    // Search steps (sidebar search provider)
    vscode.commands.registerCommand("acp.searchSteps", () => {
      vscode.commands.executeCommand('acp.searchView.focus');
    }),

    // Graph export
    vscode.commands.registerCommand("acp.exportGraph", async () => {
      const graphResult = langGraphProvider.getGraphResult();
      if (!graphResult) {
        vscode.window.showWarningMessage('No graph loaded. Open a trace first.');
        return;
      }
      const format = await vscode.window.showQuickPick(
        ['Python', 'TypeScript', 'Mermaid'],
        { placeHolder: 'Select export format' }
      );
      if (!format) { return; }

      const exporter = new LangGraphExporter();
      let content: string;
      let filename: string;

      switch (format) {
        case 'Python':
          content = exporter.exportPython(graphResult);
          filename = `graph_${graphResult.traceId}.py`;
          break;
        case 'TypeScript':
          content = exporter.exportTypeScript(graphResult);
          filename = `graph_${graphResult.traceId}.ts`;
          break;
        case 'Mermaid':
          content = exporter.exportMermaid(graphResult);
          filename = `graph_${graphResult.traceId}.md`;
          break;
        default:
          return;
      }

      const doc = await vscode.workspace.openTextDocument({
        content,
        language: format === 'Python' ? 'python' : format === 'TypeScript' ? 'typescript' : 'markdown',
      });
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Graph exported as ${format}`);
    }),

    // Branch from graph node
    vscode.commands.registerCommand("acp.graph.branch", async () => {
      if (!RunContext.getInstance().currentRun) {
        vscode.window.showWarningMessage('No run loaded. Load a run first.');
        return;
      }
      langGraphProvider.show();
      vscode.window.showInformationMessage(
        'Select a node in the graph and click "Fork from this node".'
      );
    })
  );

  // -----------------------------------------------------------------------
  // 9. GitHub Copilot Chat Participant
  // -----------------------------------------------------------------------
  const chatParticipant = vscode.chat.createChatParticipant(
    'agent-control-plane.trace-advisor',
    handleChatRequest
  );
  chatParticipant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
  context.subscriptions.push(chatParticipant);

  // -----------------------------------------------------------------------
  // 10. Status bar item for A/B testing (trace injection toggle)
  // -----------------------------------------------------------------------
  initializeStatusBar(context);

  // Register toggle command
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-control-plane.toggleTraceInjection', () => {
      const newState = toggleTraceInjection();
      vscode.window.showInformationMessage(
        `ACP Trace Injection: ${newState ? 'ON' : 'OFF'}`
      );
    })
  );

  // -----------------------------------------------------------------------
  // 11. Trace Session Logger and Gemini Integration
  // -----------------------------------------------------------------------
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Initialize Gemini service
    geminiService = new GeminiService(workspaceRoot);

    // Initialize trace session logger
    traceSessionLogger = new TraceSessionLogger(workspaceRoot, context);

    // Wire up Gemini verification callback
    traceSessionLogger.setGeminiVerificationCallback(async (logs) => {
      if (geminiService && geminiService.isConfigured()) {
        return await geminiService.verifyTraces(logs);
      }
      return null;
    });

    context.subscriptions.push({
      dispose: () => {
        if (traceSessionLogger) {
          traceSessionLogger.dispose();
        }
      }
    });

    console.log('[ACP] Trace session logger initialized');
  }

  // -----------------------------------------------------------------------
  // 12. Copilot Output Watcher
  // -----------------------------------------------------------------------
  const copilotWatcher = new CopilotOutputWatcher(context);
  copilotWatcher.start();
  context.subscriptions.push({
    dispose: () => copilotWatcher.dispose()
  });
  console.log('[ACP] Copilot output watcher initialized');
}

export function deactivate() {
  if (tracePanel) {
    tracePanel.dispose();
  }
  if (langGraphProvider) {
    langGraphProvider.dispose();
  }
}

// ---------------------------------------------------------------------------
// Format conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert SDK RunArtifacts to the legacy trace shape used by the replay panel.
 */
function sdkRunToLegacyTrace(run: RunArtifacts): LegacyTrace {
  const PHASE_MAP: Record<string, string> = {
    reason: "llm",
    tool: "tool",
    observe: "llm",
    memory: "state",
    retry: "error",
    terminate: "end",
  };

  return {
    traceId: run.meta.run_id,
    agentId: run.meta.agent_version || "unknown",
    taskId: "",
    startTime: run.meta.created_at,   
    status: run.steps.some(s => s.status === "error") ? "error" : "completed",
    steps: run.steps.map((s) => ({
      stepNumber: s.step_id,
      stepType: PHASE_MAP[s.phase] || s.phase,
      timestamp: new Date(s.timestamp * 1000).toISOString(),
      input: s.input,
      output: s.output,
      stateSnapshot: null,
      duration: s.duration,
    })),
    metadata: {
      agentVersion: run.meta.agent_version,
      toolsUsed: run.meta.tools || [],
      totalLLMCalls: run.steps.filter(s => s.phase === "reason" || s.phase === "observe").length,
      totalToolCalls: run.steps.filter(s => s.phase === "tool").length,
    },
  };
}

// ---------------------------------------------------------------------------
// Legacy trace commands
// ---------------------------------------------------------------------------

async function openTraceCommand(uri?: vscode.Uri) {
  let tracePath: string;

  if (uri) {
    tracePath = uri.fsPath;
  } else {
    // Prompt user to choose format
    const choice = await vscode.window.showQuickPick(
      ["Open JSON Trace File", "Open SDK Run Folder"],
      { placeHolder: "Select trace format" }
    );
    if (!choice) { return; }

    if (choice === "Open SDK Run Folder") {
      await openRunCommand();
      return;
    }

    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { "JSON files": ["json"] },
      title: "Select Trace File",
    });
    if (!files || files.length === 0) { return; }
    tracePath = files[0].fsPath;
  }

  // Detect format: if the path is a directory with meta.json, load as SDK run
  if (fs.existsSync(tracePath) && fs.statSync(tracePath).isDirectory()) {
    const metaPath = path.join(tracePath, "meta.json");
    if (fs.existsSync(metaPath)) {
      await RunContext.getInstance().loadRun(tracePath);
      langGraphProvider.show();
      if (currentTrace) {
        showTracePanel(currentTrace);
      }
      vscode.window.showInformationMessage(
        `Loaded SDK run: ${RunContext.getInstance().currentRun?.meta.run_id}`
      );
      return;
    }
  }

  try {
    const content = fs.readFileSync(tracePath, "utf-8");
    currentTrace = JSON.parse(content) as LegacyTrace;

    initializeReplayState();

    // Feed LangGraph with the legacy trace (it already accepts this shape)
    if (langGraphProvider) {
      await langGraphProvider.setTrace(currentTrace as any);
      langGraphProvider.show();
    }

    showTracePanel(currentTrace);

    vscode.window.showInformationMessage(
      `Loaded trace: ${currentTrace.traceId}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to load trace: ${error}`);
  }
}

async function showPanelCommand() {
  if (!currentTrace) {
    const result = await vscode.window.showWarningMessage(
      "No trace loaded. Would you like to open one?",
      "Open Trace"
    );
    if (result === "Open Trace") {
      await openTraceCommand();
    }
    return;
  }
  showTracePanel(currentTrace);
}

async function analyzeTraceCommand() {
  // Prefer SDK run analysis if available
  const run = RunContext.getInstance().currentRun;
  if (run) {
    const engine = new AnalysisEngine();
    const report = engine.analyze(run);

    const panel = vscode.window.createWebviewPanel(
      "acpAnalysisReport",
      "Diagnosis Report",
      vscode.ViewColumn.One,
      {}
    );

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .pass { color: #4caf50; }
    .fail { color: #f44336; font-weight: bold; }
    .section { margin-bottom: 20px; border: 1px solid var(--vscode-panel-border); padding: 15px; border-radius: 5px; }
    h1 { font-size: 18px; }
    h2 { font-size: 14px; margin-top: 0; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Run Diagnosis Report</h1>
  <p style="color: var(--vscode-descriptionForeground); font-size: 12px;">Run: ${run.meta.run_id} | Agent: ${run.meta.agent_version} | LLM: ${run.meta.llm}</p>
  <div class="section">
    <h2>Invariant Checks</h2>
    <ul>
      ${report.invariants.map(inv => `<li>${inv.name}: <span class="${inv.status}">${inv.status.toUpperCase()}</span> - ${inv.details}</li>`).join("")}
    </ul>
  </div>
  <div class="section">
    <h2>Root Cause Analysis</h2>
    ${report.rootCause
        ? `<p><strong>Failure Step:</strong> ${report.rootCause.failureStepId}</p>
         <p><strong>Confidence:</strong> ${Math.round(report.rootCause.confidence * 100)}%</p>
         <p>${report.rootCause.description}</p>
         <p><strong>Causal Chain:</strong> ${report.rootCause.causalChain.join(" -> ")}</p>`
        : "<p>No root cause identified (no failures detected).</p>"}
  </div>
</body>
</html>`;
    return;
  }

  // Fall back to basic analysis on legacy trace
  if (!currentTrace) {
    vscode.window.showWarningMessage("No trace loaded");
    return;
  }

  const warnings: string[] = [];
  if (currentTrace.steps.length > 10) {
    warnings.push(`High step count: ${currentTrace.steps.length}`);
  }
  const toolCalls = currentTrace.steps.filter(s => s.stepType === "tool");
  const toolCallsByName = new Map<string, number>();
  for (const step of toolCalls) {
    const input = step.input as { toolName: string };
    const count = toolCallsByName.get(input.toolName) || 0;
    toolCallsByName.set(input.toolName, count + 1);
  }
  for (const [tool, count] of toolCallsByName) {
    if (count >= 3) {
      warnings.push(`Repeated tool calls: ${tool} called ${count} times`);
    }
  }
  const errors = currentTrace.steps.filter(s => s.stepType === "error");
  if (errors.length > 0) {
    warnings.push(`Errors: ${errors.length} error(s) detected`);
  }
  const message = warnings.length > 0
    ? `Analysis found ${warnings.length} issue(s):\n${warnings.join("\n")}`
    : "No issues found.";
  vscode.window.showInformationMessage(message);
}

async function showLangGraphCommand() {
  if (!currentTrace && !RunContext.getInstance().currentRun) {
    const result = await vscode.window.showWarningMessage(
      "No trace loaded. Open a trace first.",
      "Open Trace"
    );
    if (result === "Open Trace") {
      await openTraceCommand();
    }
    return;
  }
  langGraphProvider.show();
}

// ---------------------------------------------------------------------------
// Replay Controller
// ---------------------------------------------------------------------------

function initializeReplayState() {
  if (!currentTrace) { return; }
  replayState = {
    state: "idle",
    currentStepIndex: 0,
    totalSteps: currentTrace.steps.length,
    canPlayForward: true,
    canPlayBackward: false,
    progress: 0,
  };
}

async function replayPlayCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState) { return; }

  replayState.state = "playing";
  updateReplayUI();

  autoPlayInterval = setInterval(() => {
    if (!replayState || !currentTrace) { return; }
    if (replayState.currentStepIndex < currentTrace.steps.length - 1) {
      replayState.currentStepIndex++;
      syncRunContext();
      updateReplayState();
      updateReplayUI();
    } else {
      stopAutoPlay();
      replayState.state = "completed";
      updateReplayUI();
    }
  }, 1000);
}

async function replayPauseCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState) { return; }
  stopAutoPlay();
  replayState.state = "paused";
  updateReplayUI();
}

async function replayStopCommand() {
  stopAutoPlay();
  if (replayState) {
    replayState.state = "stopped";
    replayState.currentStepIndex = 0;
    syncRunContext();
    updateReplayState();
    updateReplayUI();
  }
}

async function replayNextCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState || !currentTrace) { return; }
  stopAutoPlay();
  if (replayState.currentStepIndex < currentTrace.steps.length - 1) {
    replayState.currentStepIndex++;
    syncRunContext();
    updateReplayState();
  }
  replayState.state = "paused";
  updateReplayUI();
}

async function replayPrevCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState) { return; }
  stopAutoPlay();
  if (replayState.currentStepIndex > 0) {
    replayState.currentStepIndex--;
    syncRunContext();
    updateReplayState();
  }
  replayState.state = "paused";
  updateReplayUI();
}

async function replayStartCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState) { return; }
  stopAutoPlay();
  replayState.currentStepIndex = 0;
  syncRunContext();
  updateReplayState();
  replayState.state = "paused";
  updateReplayUI();
}

async function replayEndCommand() {
  if (!replayState) { initializeReplayState(); }
  if (!replayState || !currentTrace) { return; }
  stopAutoPlay();
  replayState.currentStepIndex = currentTrace.steps.length - 1;
  syncRunContext();
  updateReplayState();
  replayState.state = "paused";
  updateReplayUI();
}

async function replayJumpCommand() {
  if (!replayState || !currentTrace) {
    vscode.window.showWarningMessage("No trace loaded");
    return;
  }
  const input = await vscode.window.showInputBox({
    prompt: `Enter step number (0-${currentTrace.steps.length - 1}):`,
    value: replayState.currentStepIndex.toString(),
    validateInput: (value) => {
      const num = parseInt(value);
      if (isNaN(num) || num < 0 || num >= currentTrace!.steps.length) {
        return `Enter a number between 0 and ${currentTrace!.steps.length - 1}`;
      }
      return "";
    },
  });
  if (input !== undefined) {
    stopAutoPlay();
    replayState.currentStepIndex = parseInt(input);
    syncRunContext();
    updateReplayState();
    replayState.state = "paused";
    updateReplayUI();
  }
}

async function replaySearchCommand() {
  if (!currentTrace) {
    vscode.window.showWarningMessage("No trace loaded");
    return;
  }
  const query = await vscode.window.showInputBox({
    prompt: "Search for text in steps:",
  });
  if (!query) { return; }

  const results = currentTrace.steps.filter((step) => {
    const inputStr = JSON.stringify(step.input).toLowerCase();
    const outputStr = JSON.stringify(step.output).toLowerCase();
    return inputStr.includes(query.toLowerCase()) || outputStr.includes(query.toLowerCase());
  });

  if (results.length === 0) {
    vscode.window.showInformationMessage("No steps found matching your search.");
    return;
  }

  if (replayState) {
    replayState.currentStepIndex = results[0].stepNumber - 1;
    syncRunContext();
    updateReplayState();
    updateReplayUI();
  }
  vscode.window.showInformationMessage(
    `Found ${results.length} step(s). Jumped to first result.`
  );
}

/**
 * Keep RunContext in sync when replay state changes, so sidebar providers
 * (timeline, state inspector, diff viewer) update accordingly.
 */
function syncRunContext() {
  if (!replayState) { return; }
  const runContext = RunContext.getInstance();
  if (runContext.currentRun) {
    runContext.setStep(replayState.currentStepIndex);
  }
}

function updateReplayState() {
  if (!replayState || !currentTrace) { return; }

  replayState.canPlayForward =
    replayState.currentStepIndex < currentTrace.steps.length - 1;
  replayState.canPlayBackward = replayState.currentStepIndex > 0;
  replayState.progress = Math.round(
    (replayState.currentStepIndex / currentTrace.steps.length) * 100
  );

  const step = currentTrace.steps[replayState.currentStepIndex];
  const inspection = {
    stepNumber: step.stepNumber,
    stepType: step.stepType,
    timestamp: step.timestamp,
    duration: step.duration || 0,
    input: { formatted: JSON.stringify(step.input, null, 2) },
    output: { formatted: JSON.stringify(step.output, null, 2) },
  };

  if (langGraphProvider) {
    langGraphProvider.highlightStep(step.stepNumber);
  }

  if (tracePanel) {
    tracePanel.webview.postMessage({
      type: "updateReplayState",
      state: replayState,
      inspection,
    });
  }
}

function updateReplayUI() {
  if (!replayState) { return; }
  if (tracePanel) {
    tracePanel.webview.postMessage({
      type: "updateReplayUI",
      state: replayState,
    });
  }
}

function stopAutoPlay() {
  if (autoPlayInterval) {
    clearInterval(autoPlayInterval);
    autoPlayInterval = undefined;
  }
}

// ---------------------------------------------------------------------------
// Trace webview panel
// ---------------------------------------------------------------------------

function showTracePanel(trace: LegacyTrace) {
  if (tracePanel) {
    tracePanel.reveal();
  } else {
    tracePanel = vscode.window.createWebviewPanel(
      "acpTrace",
      `Trace: ${trace.traceId}`,
      vscode.ViewColumn.Two,
      { enableScripts: true }
    );

    tracePanel.onDidDispose(() => {
      tracePanel = undefined;
    });

    tracePanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "replay.play": await replayPlayCommand(); break;
        case "replay.pause": await replayPauseCommand(); break;
        case "replay.stop": await replayStopCommand(); break;
        case "replay.next": await replayNextCommand(); break;
        case "replay.prev": await replayPrevCommand(); break;
        case "replay.start": await replayStartCommand(); break;
        case "replay.end": await replayEndCommand(); break;
        case "replay.jump": await replayJumpCommand(); break;
        case "replay.search": await replaySearchCommand(); break;
        case "jumpToStep":
          if (replayState) {
            replayState.currentStepIndex = message.step - 1;
            syncRunContext();
            updateReplayState();
            updateReplayUI();
          }
          break;
      }
    });
  }

  tracePanel.webview.html = getWebviewContent(trace);
}

function getWebviewContent(trace: LegacyTrace): string {
  const progress = replayState ? replayState.progress : 0;

  const stepsHtml = trace.steps
    .map(
      (step) => `
    <div class="step ${step.stepType}" data-step="${step.stepNumber}" ${replayState?.currentStepIndex === step.stepNumber - 1 ? "selected" : ""}>
      <div class="step-header">
        <span class="step-num">${step.stepNumber}</span>
        <span class="step-type">${step.stepType.toUpperCase()}</span>
        <span class="step-time">${step.duration || 0}ms</span>
      </div>
      <div class="step-summary">${getStepSummary(step)}</div>
    </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .header { margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    .header h1 { margin: 0 0 10px 0; font-size: 18px; }
    .replay-controls { display: flex; gap: 8px; margin: 15px 0; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; align-items: center; }
    .replay-button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; font-family: var(--vscode-font-family); }
    .replay-button:hover { background: var(--vscode-button-hoverBackground); }
    .replay-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .progress-bar { flex: 1; height: 6px; background: var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--vscode-progressBar-background); width: ${progress}%; transition: width 0.2s; }
    .progress-text { font-size: 11px; color: var(--vscode-descriptionForeground); min-width: 80px; text-align: right; }
    .meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .meta-item { display: flex; flex-direction: column; }
    .meta-label { font-weight: bold; margin-bottom: 2px; }
    .steps-container { display: flex; gap: 20px; }
    .steps-list { flex: 1; max-width: 300px; }
    .step-detail { flex: 2; background: var(--vscode-editor-inactiveSelectionBackground); padding: 15px; border-radius: 4px; display: none; }
    .step-detail.active { display: block; }
    .step { padding: 10px; margin-bottom: 5px; border-radius: 4px; cursor: pointer; background: var(--vscode-list-hoverBackground); }
    .step:hover { background: var(--vscode-list-activeSelectionBackground); }
    .step.selected { background: var(--vscode-list-activeSelectionBackground); border-left: 3px solid var(--vscode-focusBorder); }
    .step-header { display: flex; gap: 10px; align-items: center; margin-bottom: 5px; }
    .step-num { font-weight: bold; color: var(--vscode-textLink-foreground); }
    .step-type { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 6px; border-radius: 3px; font-size: 10px; }
    .step.llm .step-type { background: #4CAF50; }
    .step.tool .step-type { background: #2196F3; }
    .step.error .step-type { background: #f44336; }
    .step.decision .step-type { background: #FF9800; }
    .step.state .step-type { background: #9C27B0; }
    .step-time { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .step-summary { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; max-height: 300px; }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${trace.traceId}</h1>
    <div class="meta">
      <div class="meta-item"><span class="meta-label">Status</span><span>${trace.status}</span></div>
      <div class="meta-item"><span class="meta-label">Steps</span><span>${trace.steps.length}</span></div>
      <div class="meta-item"><span class="meta-label">Duration</span><span>${trace.endTime ? Math.round((new Date(trace.endTime).getTime() - new Date(trace.startTime).getTime()) / 1000) : 0}s</span></div>
    </div>
  </div>

  <div class="replay-controls">
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.start'})">|&lt; Start</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.prev'})" ${replayState?.canPlayBackward ? "" : "disabled"}>Prev</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.play'})">Play</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.pause'})">Pause</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.next'})" ${replayState?.canPlayForward ? "" : "disabled"}>Next</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.end'})">End &gt;|</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.jump'})">Jump</button>
    <button class="replay-button" onclick="vscode.postMessage({command: 'replay.search'})">Search</button>
    <div class="progress-bar"><div class="progress-fill"></div></div>
    <div class="progress-text">${replayState?.progress || 0}%</div>
  </div>

  <div class="steps-container">
    <div class="steps-list">
      <h3>Steps</h3>
      <div id="stepsList">${stepsHtml}</div>
    </div>
    <div class="step-detail active" id="stepDetail">
      <h3>Current Step: <span id="stepNum">-</span> (<span id="stepType">-</span>)</h3>
      <h4>Input</h4>
      <pre><code id="stepInput">Select a step to inspect.</code></pre>
      <h4>Output</h4>
      <pre><code id="stepOutput">Select a step to inspect.</code></pre>
      <h4>Timestamp</h4>
      <p id="stepTime">-</p>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const trace = ${JSON.stringify(trace)};

    function attachStepListeners() {
      document.querySelectorAll('.step').forEach(el => {
        el.addEventListener('click', function() {
          const stepNum = parseInt(this.getAttribute('data-step'));
          vscode.postMessage({ command: 'jumpToStep', step: stepNum });
        });
      });
    }

    function updateStepDetailFromInspection(inspection) {
      document.querySelectorAll('.step').forEach(el => el.classList.remove('selected'));
      const selected = document.querySelector('[data-step="' + inspection.stepNumber + '"]');
      if (selected) {
        selected.classList.add('selected');
        selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      document.getElementById('stepNum').textContent = inspection.stepNumber;
      document.getElementById('stepType').textContent = inspection.stepType.toUpperCase();
      document.getElementById('stepInput').textContent = inspection.input.formatted;
      document.getElementById('stepOutput').textContent = inspection.output.formatted;
      document.getElementById('stepTime').textContent = inspection.timestamp;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'updateReplayState' && message.inspection) {
        updateStepDetailFromInspection(message.inspection);
      } else if (message.type === 'updateReplayUI' && message.state) {
        const progress = Math.round((message.state.currentStepIndex / trace.steps.length) * 100);
        const progressFill = document.querySelector('.progress-fill');
        if (progressFill) progressFill.style.width = progress + '%';
        const progressText = document.querySelector('.progress-text');
        if (progressText) progressText.textContent = progress + '%';
      }
    });

    attachStepListeners();
    if (trace.steps.length > 0) {
      vscode.postMessage({ command: 'jumpToStep', step: 1 });
    }
  </script>
</body>
</html>`;
}

function getStepSummary(step: LegacyStep): string {
  switch (step.stepType) {
    case "llm": {
      const llmOutput = step.output as { response?: string };
      return llmOutput.response?.substring(0, 50) + "..." || "LLM response";
    }
    case "tool": {
      const toolInput = step.input as { toolName?: string };
      const toolOutput = step.output as { success?: boolean };
      return `${toolInput.toolName || "tool"} ${toolOutput.success ? "[OK]" : "[FAIL]"}`;
    }
    case "error": {
      const errorOutput = step.output as { error?: string };
      return errorOutput.error?.substring(0, 40) + "..." || "Error";
    }
    case "start": return "Agent started";
    case "end": return "Agent ended";
    case "state": return "State update";
    default: return step.stepType;
  }
}

// ---------------------------------------------------------------------------
// Tree data providers
// ---------------------------------------------------------------------------

/**
 * Discovers traces in the workspace. Supports:
 *   - Legacy JSON files: traces/*.json
 *   - SDK run folders: traces/run_* (containing meta.json)
 *   - Session log folders: traces/session_log, test-project/traces/session_log
 *   - Subdirectory traces: test-project/traces/*
 */
class TracesTreeProvider implements vscode.TreeDataProvider<TraceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TraceItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TraceItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TraceItem): Promise<TraceItem[]> {
    // If element is provided, return children of that element (for expandable items)
    if (element) {
      return this.getChildrenOfItem(element);
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) { return []; }

    const items: TraceItem[] = [];

    for (const folder of workspaceFolders) {
      // Scan both root traces/ and test-project/traces/
      const traceDirs = [
        path.join(folder.uri.fsPath, "traces"),
        path.join(folder.uri.fsPath, "test-project", "traces")
      ];

      for (const tracesDir of traceDirs) {
        if (!fs.existsSync(tracesDir)) { continue; }

        const entries = fs.readdirSync(tracesDir, { withFileTypes: true });

        // Session log folders (session_log, history, etc.)
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const dirPath = path.join(tracesDir, entry.name);

            // SDK run folders (run_*)
            if (entry.name.startsWith("run_")) {
              const metaPath = path.join(dirPath, "meta.json");
              if (fs.existsSync(metaPath)) {
                try {
                  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                  items.push(
                    new TraceItem(
                      meta.run_id || entry.name,
                      "run",
                      dirPath,
                      vscode.TreeItemCollapsibleState.None,
                      "acp.openTrace"
                    )
                  );
                } catch {
                  items.push(
                    new TraceItem(
                      entry.name,
                      "error",
                      dirPath,
                      vscode.TreeItemCollapsibleState.None,
                      "acp.openTrace"
                    )
                  );
                }
              }
            } else if (entry.name !== ".git" && entry.name !== "replays") {
              // Session folders (session_log, history, performance, summary)
              const sessionFiles = this.getSessionFiles(dirPath);
              if (sessionFiles.length > 0) {
                const isTestProject = tracesDir.includes("test-project");
                const label = isTestProject ? `[test] ${entry.name}` : entry.name;
                items.push(
                  new TraceItem(
                    label,
                    "session",
                    dirPath,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    ""
                  )
                );
              }
            }
          }
        }

        // Legacy JSON traces (directly in traces folder)
        const jsonFiles = entries
          .filter(e => !e.isDirectory() && e.name.endsWith(".json"))
          .slice(-10);

        for (const file of jsonFiles) {
          const filePath = path.join(tracesDir, file.name);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const trace = JSON.parse(content) as LegacyTrace;
            items.push(
              new TraceItem(
                trace.traceId || file.name,
                trace.status || "trace",
                filePath,
                vscode.TreeItemCollapsibleState.None,
                "acp.openTrace"
              )
            );
          } catch {
            items.push(
              new TraceItem(
                file.name,
                "error",
                filePath,
                vscode.TreeItemCollapsibleState.None,
                "acp.openTrace"
              )
            );
          }
        }
      }
    }

    return items;
  }

  private getSessionFiles(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath)
        .filter(f => f.endsWith(".json"))
        .sort((a, b) => {
          // Sort by step number if present
          const numA = parseInt(a.split("_")[0]) || 0;
          const numB = parseInt(b.split("_")[0]) || 0;
          return numA - numB;
        });
    } catch {
      return [];
    }
  }

  private getChildrenOfItem(element: TraceItem): TraceItem[] {
    if (element.itemType !== "session") { return []; }

    const files = this.getSessionFiles(element.filePath);
    return files.slice(-50).map(file => {
      const filePath = path.join(element.filePath, file);
      const stepNum = file.split("_")[0];
      return new TraceItem(
        `Step ${stepNum}`,
        "step",
        filePath,
        vscode.TreeItemCollapsibleState.None,
        "acp.openTrace"
      );
    });
  }
}

class TraceItem extends vscode.TreeItem {
  constructor(
    public readonly traceId: string,
    public readonly itemType: string,
    public readonly filePath: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    commandId: string
  ) {
    super(traceId.length > 40 ? traceId.substring(0, 40) + "..." : traceId, collapsibleState);
    this.tooltip = `${traceId}\nType: ${itemType}\n${filePath}`;
    this.description = itemType;

    // Set icon based on item type
    switch (itemType) {
      case "run":
        this.iconPath = new vscode.ThemeIcon("folder");
        break;
      case "session":
        this.iconPath = new vscode.ThemeIcon("list-tree");
        break;
      case "step":
        this.iconPath = new vscode.ThemeIcon("debug-stackframe");
        break;
      case "completed":
        this.iconPath = new vscode.ThemeIcon("pass");
        break;
      case "trace":
        this.iconPath = new vscode.ThemeIcon("file-code");
        break;
      case "error":
        this.iconPath = new vscode.ThemeIcon("error");
        break;
      default:
        this.iconPath = new vscode.ThemeIcon("file");
    }

    // Set command if provided
    if (commandId) {
      this.command = {
        command: commandId,
        title: itemType === "run" ? "Open Run" : "Open Trace",
        arguments: [vscode.Uri.file(filePath)],
      };
    }
  }
}

class StepsTreeProvider implements vscode.TreeDataProvider<StepItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StepItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: StepItem): vscode.TreeItem {
    return element;
  }

  getChildren(): StepItem[] {
    if (!currentTrace) { return []; }
    return currentTrace.steps.map(step => new StepItem(step));
  }
}

class StepItem extends vscode.TreeItem {
  constructor(public readonly step: LegacyStep) {
    super(`Step ${step.stepNumber}`, vscode.TreeItemCollapsibleState.None);
    this.description = step.stepType.toUpperCase();
    this.tooltip = `${step.stepType}\n${step.timestamp}`;

    const icons: Record<string, string> = {
      llm: "comment",
      tool: "tools",
      error: "error",
      start: "debug-start",
      end: "debug-stop",
      decision: "git-compare",
      state: "database",
    };

    this.iconPath = new vscode.ThemeIcon(icons[step.stepType] || "circle-outline");
  }
}
