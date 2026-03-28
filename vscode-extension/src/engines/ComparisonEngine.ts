import { RunArtifacts, AgentStep } from '../data/DataTypes';
import { buildLangGraph, LangGraphResult, GraphNodeData, GraphEdgeData } from '../langgraph/LangGraphBuilder';
import { normalizeRunToTraceData } from '../langgraph/LangGraphBuilder';

export interface RunComparison {
    runId1: string;
    runId2: string;
    stepAlignment: { step1: number | null, step2: number | null, matchType: 'exact' | 'phase' | 'mismatch' }[];
    divergencePoint: number | null;
    metricsDiff: {
        duration: number;
        tokens: number;
        steps: number;
    };
    graphDiff?: GraphDiff;
}

/**
 * Graph-level diff between two runs.
 * Identifies nodes and edges that were added, removed, or changed.
 */
export interface GraphDiff {
    addedNodes: GraphNodeData[];
    removedNodes: GraphNodeData[];
    changedNodes: { node: GraphNodeData; changes: string[] }[];
    addedEdges: GraphEdgeData[];
    removedEdges: GraphEdgeData[];
    changedEdges: { edge: GraphEdgeData; changes: string[] }[];
    graph1Summary: { nodes: number; edges: number; conditionalEdges: number };
    graph2Summary: { nodes: number; edges: number; conditionalEdges: number };
}

export class ComparisonEngine {
    public compare(run1: RunArtifacts, run2: RunArtifacts): RunComparison {
        const alignment = this.alignSteps(run1.steps, run2.steps);
        const divergence = this.findDivergence(run1.steps, run2.steps);

        const metrics1 = this.computeMetrics(run1);
        const metrics2 = this.computeMetrics(run2);

        return {
            runId1: run1.meta.run_id,
            runId2: run2.meta.run_id,
            stepAlignment: alignment,
            divergencePoint: divergence,
            metricsDiff: {
                duration: metrics2.duration - metrics1.duration,
                tokens: metrics2.tokens - metrics1.tokens,
                steps: metrics2.steps - metrics1.steps
            }
        };
    }

    /**
     * Compare two runs with full graph diff analysis.
     * Builds LangGraph for both runs and computes structural differences.
     */
    public async compareWithGraphDiff(run1: RunArtifacts, run2: RunArtifacts): Promise<RunComparison> {
        const baseComparison = this.compare(run1, run2);

        try {
            const trace1 = normalizeRunToTraceData(run1);
            const trace2 = normalizeRunToTraceData(run2);

            const graph1 = await buildLangGraph(trace1);
            const graph2 = await buildLangGraph(trace2);

            baseComparison.graphDiff = this.computeGraphDiff(graph1, graph2);
        } catch {
            // Graph diff is optional; don't fail the whole comparison
        }

        return baseComparison;
    }

    /**
     * Compute structural differences between two LangGraph results.
     */
    public computeGraphDiff(graph1: LangGraphResult, graph2: LangGraphResult): GraphDiff {
        const nodeIds1 = new Set(graph1.nodes.map(n => n.id));
        const nodeIds2 = new Set(graph2.nodes.map(n => n.id));

        const addedNodes = graph2.nodes.filter(n => !nodeIds1.has(n.id));
        const removedNodes = graph1.nodes.filter(n => !nodeIds2.has(n.id));

        const changedNodes: { node: GraphNodeData; changes: string[] }[] = [];
        for (const node2 of graph2.nodes) {
            if (!nodeIds1.has(node2.id)) { continue; }
            const node1 = graph1.nodes.find(n => n.id === node2.id)!;
            const changes: string[] = [];

            if (node1.type !== node2.type) {
                changes.push(`type: ${node1.type} -> ${node2.type}`);
            }
            if (node1.steps.length !== node2.steps.length) {
                changes.push(`executions: ${node1.steps.length} -> ${node2.steps.length}`);
            }
            const dur1 = node1.steps.reduce((s, st) => s + (st.duration || 0), 0);
            const dur2 = node2.steps.reduce((s, st) => s + (st.duration || 0), 0);
            if (Math.abs(dur1 - dur2) > 10) {
                changes.push(`duration: ${dur1}ms -> ${dur2}ms`);
            }

            if (changes.length > 0) {
                changedNodes.push({ node: node2, changes });
            }
        }

        const edgeKey = (e: GraphEdgeData) => `${e.source}->${e.target}`;
        const edgeKeys1 = new Set(graph1.edges.map(edgeKey));
        const edgeKeys2 = new Set(graph2.edges.map(edgeKey));

        const addedEdges = graph2.edges.filter(e => !edgeKeys1.has(edgeKey(e)));
        const removedEdges = graph1.edges.filter(e => !edgeKeys2.has(edgeKey(e)));

        const changedEdges: { edge: GraphEdgeData; changes: string[] }[] = [];
        for (const edge2 of graph2.edges) {
            const key = edgeKey(edge2);
            if (!edgeKeys1.has(key)) { continue; }
            const edge1 = graph1.edges.find(e => edgeKey(e) === key)!;
            const changes: string[] = [];

            if (edge1.conditional !== edge2.conditional) {
                changes.push(`conditional: ${edge1.conditional} -> ${edge2.conditional}`);
            }
            if (edge1.stepTransitions.length !== edge2.stepTransitions.length) {
                changes.push(`transitions: ${edge1.stepTransitions.length} -> ${edge2.stepTransitions.length}`);
            }

            if (changes.length > 0) {
                changedEdges.push({ edge: edge2, changes });
            }
        }

        return {
            addedNodes,
            removedNodes,
            changedNodes,
            addedEdges,
            removedEdges,
            changedEdges,
            graph1Summary: {
                nodes: graph1.nodes.length,
                edges: graph1.edges.length,
                conditionalEdges: graph1.edges.filter(e => e.conditional).length,
            },
            graph2Summary: {
                nodes: graph2.nodes.length,
                edges: graph2.edges.length,
                conditionalEdges: graph2.edges.filter(e => e.conditional).length,
            },
        };
    }

    private computeMetrics(run: RunArtifacts) {
        return {
            duration: (run.steps[run.steps.length - 1]?.timestamp || 0) - (run.steps[0]?.timestamp || 0),
            tokens: 0,
            steps: run.steps.length
        };
    }

    private alignSteps(steps1: AgentStep[], steps2: AgentStep[]) {
        const alignment: { step1: number | null, step2: number | null, matchType: 'exact' | 'phase' | 'mismatch' }[] = [];
        const maxLen = Math.max(steps1.length, steps2.length);

        for (let i = 0; i < maxLen; i++) {
            const s1 = steps1[i];
            const s2 = steps2[i];

            if (s1 && s2) {
                if (s1.phase === s2.phase && JSON.stringify(s1.input) === JSON.stringify(s2.input)) {
                    alignment.push({ step1: s1.step_id, step2: s2.step_id, matchType: 'exact' });
                } else if (s1.phase === s2.phase) {
                    alignment.push({ step1: s1.step_id, step2: s2.step_id, matchType: 'phase' });
                } else {
                    alignment.push({ step1: s1.step_id, step2: s2.step_id, matchType: 'mismatch' });
                }
            } else if (s1) {
                alignment.push({ step1: s1.step_id, step2: null, matchType: 'mismatch' });
            } else {
                alignment.push({ step1: null, step2: s2!.step_id, matchType: 'mismatch' });
            }
        }
        return alignment;
    }

    private findDivergence(steps1: AgentStep[], steps2: AgentStep[]): number | null {
        const minLen = Math.min(steps1.length, steps2.length);
        for (let i = 0; i < minLen; i++) {
            const s1 = steps1[i];
            const s2 = steps2[i];

            if (JSON.stringify(s1.input) !== JSON.stringify(s2.input)) {
                return s1.step_id;
            }
            if (JSON.stringify(s1.output) !== JSON.stringify(s2.output)) {
                return s1.step_id;
            }
        }

        if (steps1.length !== steps2.length) {
            return steps1[Math.min(steps1.length, steps2.length) - 1]?.step_id || 0;
        }

        return null;
    }
}
