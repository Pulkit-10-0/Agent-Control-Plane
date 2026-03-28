import { LangGraphResult, GraphNodeData, GraphEdgeData } from './LangGraphBuilder';

/**
 * LangGraph Exporter
 * 
 * Exports a compiled LangGraphResult as a standalone Python or TypeScript file
 * that recreates the graph structure, routing logic, and node definitions.
 */
export class LangGraphExporter {

    /**
     * Export graph as standalone Python file using langgraph library.
     */
    public exportPython(graph: LangGraphResult): string {
        const lines: string[] = [];

        lines.push('"""');
        lines.push(`Auto-generated LangGraph from trace: ${graph.traceId}`);
        lines.push(`Status: ${graph.status} | Steps: ${graph.totalSteps}`);
        lines.push(`Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`);
        lines.push('"""');
        lines.push('');
        lines.push('from langgraph.graph import StateGraph, START, END');
        lines.push('from typing import TypedDict, Annotated');
        lines.push('from operator import add');
        lines.push('');

        // State definition
        lines.push('');
        lines.push('class AgentState(TypedDict):');
        lines.push('    """Agent execution state."""');
        lines.push('    current_step: int');
        lines.push('    status: str');
        lines.push('    messages: Annotated[list, add]');
        lines.push('');
        lines.push('');

        // Node functions
        const internalNodes = graph.nodes.filter(n => !n.isStart && !n.isEnd);
        for (const node of internalNodes) {
            const funcName = this.pythonSafeName(node.id);
            const totalDuration = node.steps.reduce((s, st) => s + (st.duration || 0), 0);
            lines.push(`def ${funcName}(state: AgentState) -> dict:`);
            lines.push(`    """${node.name} node - ${node.type} type, ${node.steps.length} execution(s), ${totalDuration}ms total."""`);
            lines.push(`    return {`);
            lines.push(`        "current_step": state["current_step"] + 1,`);
            lines.push(`        "status": "running",`);
            lines.push(`        "messages": [{"node": "${node.name}", "type": "${node.type}"}],`);
            lines.push(`    }`);
            lines.push('');
            lines.push('');
        }

        // Conditional routing functions
        const conditionalSources = this.findConditionalSources(graph);
        for (const [source, targets] of conditionalSources) {
            const funcName = `route_from_${this.pythonSafeName(source)}`;
            lines.push(`def ${funcName}(state: AgentState) -> str:`);
            lines.push(`    """Conditional routing from ${source}."""`);
            lines.push(`    # TODO: Implement actual routing logic based on state`);
            const targetList = targets.map(t => `"${t}"`).join(', ');
            lines.push(`    # Possible targets: ${targetList}`);
            lines.push(`    return "${targets[0]}"  # Default to first target`);
            lines.push('');
            lines.push('');
        }

        // Build graph
        lines.push('def build_graph() -> StateGraph:');
        lines.push('    """Build the reconstructed LangGraph."""');
        lines.push('    graph = StateGraph(AgentState)');
        lines.push('');

        // Add nodes
        for (const node of internalNodes) {
            const funcName = this.pythonSafeName(node.id);
            lines.push(`    graph.add_node("${node.id}", ${funcName})`);
        }
        lines.push('');

        // Add edges
        const processedSources = new Set<string>();
        for (const edge of graph.edges) {
            const source = this.isStartNode(edge.source, graph) ? 'START' : `"${edge.source}"`;
            const target = this.isEndNode(edge.target, graph) ? 'END' : `"${edge.target}"`;

            if (edge.conditional && !processedSources.has(edge.source)) {
                const targets = this.getTargetsForSource(edge.source, graph);
                const routeFunc = `route_from_${this.pythonSafeName(edge.source)}`;
                const targetMap = targets.map(t => {
                    const tRef = this.isEndNode(t, graph) ? 'END' : `"${t}"`;
                    return `"${t}": ${tRef}`;
                }).join(', ');

                lines.push(`    graph.add_conditional_edges(${source}, ${routeFunc}, {${targetMap}})`);
                processedSources.add(edge.source);
            } else if (!processedSources.has(edge.source)) {
                lines.push(`    graph.add_edge(${source}, ${target})`);
                processedSources.add(edge.source);
            }
        }

        lines.push('');
        lines.push('    return graph');
        lines.push('');
        lines.push('');
        lines.push('if __name__ == "__main__":');
        lines.push('    graph = build_graph()');
        lines.push('    compiled = graph.compile()');
        lines.push('    print("Graph compiled successfully!")');
        lines.push('    print(compiled.get_graph().draw_mermaid())');
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Export graph as standalone TypeScript file using @langchain/langgraph.
     */
    public exportTypeScript(graph: LangGraphResult): string {
        const lines: string[] = [];

        lines.push('/**');
        lines.push(` * Auto-generated LangGraph from trace: ${graph.traceId}`);
        lines.push(` * Status: ${graph.status} | Steps: ${graph.totalSteps}`);
        lines.push(` * Nodes: ${graph.nodes.length} | Edges: ${graph.edges.length}`);
        lines.push(' */');
        lines.push('');
        lines.push('import { StateGraph, Annotation, START, END } from "@langchain/langgraph";');
        lines.push('');

        // State annotation
        lines.push('const AgentState = Annotation.Root({');
        lines.push('    currentStep: Annotation<number>({');
        lines.push('        reducer: (_prev: number, next: number) => next,');
        lines.push('        default: () => 0,');
        lines.push('    }),');
        lines.push('    status: Annotation<string>({');
        lines.push('        reducer: (_prev: string, next: string) => next,');
        lines.push('        default: () => "idle",');
        lines.push('    }),');
        lines.push('});');
        lines.push('');

        // Node functions
        const internalNodes = graph.nodes.filter(n => !n.isStart && !n.isEnd);
        for (const node of internalNodes) {
            const funcName = this.tsSafeName(node.id);
            const totalDuration = node.steps.reduce((s, st) => s + (st.duration || 0), 0);
            lines.push(`/** ${node.name} - ${node.type}, ${node.steps.length} exec(s), ${totalDuration}ms */`);
            lines.push(`async function ${funcName}(state: typeof AgentState.State) {`);
            lines.push(`    return { currentStep: state.currentStep + 1, status: "running" };`);
            lines.push('}');
            lines.push('');
        }

        // Routing functions
        const conditionalSources = this.findConditionalSources(graph);
        for (const [source, targets] of conditionalSources) {
            const funcName = `routeFrom${this.tsSafeName(source).charAt(0).toUpperCase() + this.tsSafeName(source).slice(1)}`;
            lines.push(`async function ${funcName}(state: typeof AgentState.State): Promise<string> {`);
            lines.push(`    // TODO: Implement routing logic. Targets: ${targets.join(', ')}`);
            lines.push(`    return "${targets[0]}";`);
            lines.push('}');
            lines.push('');
        }

        // Build graph
        lines.push('export async function buildGraph() {');
        lines.push('    const graph = new StateGraph(AgentState);');
        lines.push('');

        for (const node of internalNodes) {
            const funcName = this.tsSafeName(node.id);
            lines.push(`    graph.addNode("${node.id}", ${funcName});`);
        }
        lines.push('');

        const tsProcessedSources = new Set<string>();
        for (const edge of graph.edges) {
            const source = this.isStartNode(edge.source, graph) ? 'START' : `"${edge.source}"`;
            const target = this.isEndNode(edge.target, graph) ? 'END' : `"${edge.target}"`;

            if (edge.conditional && !tsProcessedSources.has(edge.source)) {
                const targets = this.getTargetsForSource(edge.source, graph);
                const routeFunc = `routeFrom${this.tsSafeName(edge.source).charAt(0).toUpperCase() + this.tsSafeName(edge.source).slice(1)}`;
                lines.push(`    graph.addConditionalEdges(${source} as any, ${routeFunc}, [${targets.map(t => `"${t}"`).join(', ')}] as any);`);
                tsProcessedSources.add(edge.source);
            } else if (!tsProcessedSources.has(edge.source)) {
                lines.push(`    graph.addEdge(${source} as any, ${target} as any);`);
                tsProcessedSources.add(edge.source);
            }
        }

        lines.push('');
        lines.push('    const compiled = graph.compile();');
        lines.push('    console.log("Graph compiled successfully!");');
        lines.push('    const drawable = compiled.getGraph();');
        lines.push('    console.log(drawable.drawMermaid());');
        lines.push('    return compiled;');
        lines.push('}');
        lines.push('');
        lines.push('buildGraph().catch(console.error);');
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Export Mermaid diagram source.
     */
    public exportMermaid(graph: LangGraphResult): string {
        return graph.mermaid;
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private pythonSafeName(id: string): string {
        return id.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    }

    private tsSafeName(id: string): string {
        return id.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
    }

    private isStartNode(id: string, graph: LangGraphResult): boolean {
        return graph.nodes.find(n => n.id === id)?.isStart || false;
    }

    private isEndNode(id: string, graph: LangGraphResult): boolean {
        return graph.nodes.find(n => n.id === id)?.isEnd || false;
    }

    private getTargetsForSource(source: string, graph: LangGraphResult): string[] {
        return graph.edges
            .filter(e => e.source === source)
            .map(e => e.target);
    }

    private findConditionalSources(graph: LangGraphResult): Map<string, string[]> {
        const result = new Map<string, string[]>();
        for (const edge of graph.edges) {
            if (edge.conditional) {
                if (!result.has(edge.source)) {
                    result.set(edge.source, []);
                }
                result.get(edge.source)!.push(edge.target);
            }
        }
        return result;
    }
}
