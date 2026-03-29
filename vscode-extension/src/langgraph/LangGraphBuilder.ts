
/**
 * LangGraph Builder
 *
 * Converts agent execution traces into graph data (nodes + edges + Mermaid).
 * Pure TypeScript — no runtime dependency on @langchain/langgraph so the
 * extension host (CommonJS) can load it without ESM errors.
 *
 * Supports two trace formats:
 *   1. Legacy single-JSON: { traceId, steps: [{ stepNumber, stepType, ... }] }
 *   2. SDK run-folder:     { traceId, steps: [{ step_id, phase, ... }] }
 *
 * The builder normalizes both formats into TraceStep before graph construction.
 */

export interface TraceStep {
    stepNumber: number;
    stepType: string;
    timestamp: string;
    input: unknown;
    output: unknown;
    stateSnapshot: unknown;
    duration?: number;
}

export interface TraceData {
    traceId: string;
    agentId?: string;
    status: string;
    steps: TraceStep[];
    metadata?: {
        agentVersion?: string;
        toolsUsed?: string[];
        totalLLMCalls?: number;
        totalToolCalls?: number;
    };
}

/**
 * Phase-to-stepType mapping for SDK format normalization.
 */
const PHASE_TO_STEP_TYPE: Record<string, string> = {
    reason: "llm",
    tool: "tool",
    observe: "llm",
    memory: "state",
    retry: "error",
    terminate: "end",
};

/**
 * Normalize an SDK-format run into the TraceData shape the builder expects.
 * Accepts RunArtifacts-like objects with { meta, steps, path }.
 */
export function normalizeRunToTraceData(run: {
    meta: { run_id: string; agent_version?: string; tools?: string[] };
    steps: Array<{
        step_id: number;
        timestamp: number;
        phase: string;
        input: unknown;
        output: unknown;
        state_ref?: string;
        status?: string;
        duration?: number;
    }>;
}): TraceData {
    const hasErrors = run.steps.some(s => s.status === "error");
    return {
        traceId: run.meta.run_id,
        status: hasErrors ? "error" : "completed",
        steps: run.steps.map(s => ({
            stepNumber: s.step_id,
            stepType: PHASE_TO_STEP_TYPE[s.phase] || s.phase,
            timestamp: new Date(s.timestamp * 1000).toISOString(),
            input: s.input,
            output: s.output,
            stateSnapshot: null,
            duration: s.duration,
        })),
        metadata: {
            agentVersion: run.meta.agent_version || "",
            toolsUsed: run.meta.tools || [],
            totalLLMCalls: run.steps.filter(s => s.phase === "reason" || s.phase === "observe").length,
            totalToolCalls: run.steps.filter(s => s.phase === "tool").length,
        },
    };
}

export interface GraphNodeData {
    id: string;
    name: string;
    type: string;
    steps: TraceStep[];
    isStart: boolean;
    isEnd: boolean;
}

export interface GraphEdgeData {
    source: string;
    target: string;
    conditional: boolean;
    stepTransitions: Array<{ fromStep: number; toStep: number }>;
}

export interface LangGraphResult {
    nodes: GraphNodeData[];
    edges: GraphEdgeData[];
    mermaid: string;
    traceId: string;
    status: string;
    totalSteps: number;
}

/**
 * Analyzes a trace and identifies the unique node types and
 * the transitions (edges) between them, then generates Mermaid markup.
 * No external runtime dependencies.
 */
export async function buildLangGraph(trace: TraceData): Promise<LangGraphResult> {
    // Guard: ensure trace has steps
    if (!trace || !trace.steps || trace.steps.length === 0) {
        return {
            nodes: [],
            edges: [],
            mermaid: "%%{init: {'flowchart': {'curve': 'linear'}}}%%\ngraph TD;\n    empty([No steps in trace])",
            traceId: trace?.traceId ?? 'unknown',
            status: trace?.status ?? 'empty',
            totalSteps: 0,
        };
    }

    try {
        // 1. Identify unique logical nodes from steps
        const nodeMap = new Map<string, GraphNodeData>();
        const edgeSet = new Map<string, GraphEdgeData>();

        for (const step of trace.steps) {
            const nodeId = getNodeId(step);
            if (!nodeMap.has(nodeId)) {
                nodeMap.set(nodeId, {
                    id: nodeId,
                    name: getNodeLabel(step),
                    type: step.stepType,
                    steps: [],
                    isStart: step.stepType === "start",
                    isEnd: step.stepType === "end",
                });
            }
            nodeMap.get(nodeId)!.steps.push(step);
        }

        // 2. Identify edges from step transitions
        for (let i = 0; i < trace.steps.length - 1; i++) {
            const fromId = getNodeId(trace.steps[i]);
            const toId = getNodeId(trace.steps[i + 1]);
            const edgeKey = `${fromId}->${toId}`;

            if (!edgeSet.has(edgeKey)) {
                edgeSet.set(edgeKey, {
                    source: fromId,
                    target: toId,
                    conditional: false,
                    stepTransitions: [],
                });
            }
            edgeSet.get(edgeKey)!.stepTransitions.push({
                fromStep: trace.steps[i].stepNumber,
                toStep: trace.steps[i + 1].stepNumber,
            });
        }

        // Detect conditional edges: if a node has multiple outgoing edges
        const outgoingCount = new Map<string, number>();
        for (const edge of edgeSet.values()) {
            outgoingCount.set(edge.source, (outgoingCount.get(edge.source) || 0) + 1);
        }
        for (const edge of edgeSet.values()) {
            if ((outgoingCount.get(edge.source) || 0) > 1) {
                edge.conditional = true;
            }
        }

        // 3. Generate Mermaid diagram from nodes + edges
        const mermaid = generateFallbackMermaid(nodeMap, edgeSet);

        return {
            nodes: Array.from(nodeMap.values()),
            edges: Array.from(edgeSet.values()),
            mermaid,
            traceId: trace.traceId,
            status: trace.status,
            totalSteps: trace.steps.length,
        };
    } catch (outerErr) {
        // Absolute fallback — build a minimal result directly from steps
        const nodeMap2 = new Map<string, GraphNodeData>();
        const edgeSet2 = new Map<string, GraphEdgeData>();
        for (const step of trace.steps) {
            const nid = getNodeId(step);
            if (!nodeMap2.has(nid)) {
                nodeMap2.set(nid, { id: nid, name: getNodeLabel(step), type: step.stepType, steps: [], isStart: step.stepType === 'start', isEnd: step.stepType === 'end' });
            }
            nodeMap2.get(nid)!.steps.push(step);
        }
        for (let i = 0; i < trace.steps.length - 1; i++) {
            const src = getNodeId(trace.steps[i]);
            const tgt = getNodeId(trace.steps[i + 1]);
            const key = `${src}->${tgt}`;
            if (!edgeSet2.has(key)) {
                edgeSet2.set(key, { source: src, target: tgt, conditional: false, stepTransitions: [] });
            }
            edgeSet2.get(key)!.stepTransitions.push({ fromStep: trace.steps[i].stepNumber, toStep: trace.steps[i + 1].stepNumber });
        }
        return {
            nodes: Array.from(nodeMap2.values()),
            edges: Array.from(edgeSet2.values()),
            mermaid: generateFallbackMermaid(nodeMap2, edgeSet2),
            traceId: trace.traceId,
            status: trace.status,
            totalSteps: trace.steps.length,
        };
    }
}

function getNodeId(step: TraceStep): string {
    if (step.stepType === "start") return "__start__";
    if (step.stepType === "end") return "__end__";
    if (step.stepType === "tool") {
        const inp = step.input as { toolName?: string };
        return `tool_${inp.toolName || "unknown"}`;
    }
    return step.stepType;
}

function getNodeLabel(step: TraceStep): string {
    if (step.stepType === "start") return "START";
    if (step.stepType === "end") return "END";
    if (step.stepType === "tool") {
        const inp = step.input as { toolName?: string };
        return inp.toolName || "tool";
    }
    return step.stepType.toUpperCase();
}

function generateFallbackMermaid(
    nodeMap: Map<string, GraphNodeData>,
    edgeSet: Map<string, GraphEdgeData>
): string {
    let m = "%%{init: {'flowchart': {'curve': 'linear'}}}%%\ngraph TD;\n";
    for (const [id, node] of nodeMap) {
        if (node.isStart) {
            m += `    ${id}([${node.name}]):::first\n`;
        } else if (node.isEnd) {
            m += `    ${id}([${node.name}]):::last\n`;
        } else {
            m += `    ${id}(${node.name})\n`;
        }
    }
    for (const edge of edgeSet.values()) {
        if (edge.conditional) {
            m += `    ${edge.source} -.-> ${edge.target};\n`;
        } else {
            m += `    ${edge.source} --> ${edge.target};\n`;
        }
    }
    m += "    classDef default fill:#f2f0ff,line-height:1.2;\n";
    m += "    classDef first fill-opacity:0;\n";
    m += "    classDef last fill:#bfb6fc;\n";
    return m;
}
