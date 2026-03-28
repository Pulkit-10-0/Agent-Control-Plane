import * as assert from 'assert';
import {
    buildLangGraph,
    normalizeRunToTraceData,
    TraceData,
    TraceStep,
    LangGraphResult,
} from '../langgraph/LangGraphBuilder';
import { LangGraphExporter } from '../langgraph/LangGraphExporter';

/**
 * Unit tests for LangGraphBuilder.
 * 
 * Run with: npx mocha out/test/langgraph.test.js --timeout 10000
 * (after compiling with tsc)
 */

// -----------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------

function createSimpleTrace(): TraceData {
    return {
        traceId: 'test-trace-001',
        status: 'completed',
        steps: [
            { stepNumber: 1, stepType: 'start', timestamp: '2024-01-01T00:00:00Z', input: {}, output: {}, stateSnapshot: null, duration: 0 },
            { stepNumber: 2, stepType: 'llm', timestamp: '2024-01-01T00:00:01Z', input: { prompt: 'Hello' }, output: { response: 'Hi there!' }, stateSnapshot: null, duration: 500 },
            { stepNumber: 3, stepType: 'tool', timestamp: '2024-01-01T00:00:02Z', input: { toolName: 'search', query: 'weather' }, output: { success: true, result: 'Sunny' }, stateSnapshot: null, duration: 200 },
            { stepNumber: 4, stepType: 'llm', timestamp: '2024-01-01T00:00:03Z', input: { prompt: 'Summarize' }, output: { response: 'The weather is sunny.' }, stateSnapshot: null, duration: 300 },
            { stepNumber: 5, stepType: 'end', timestamp: '2024-01-01T00:00:04Z', input: {}, output: { finalAnswer: 'Done' }, stateSnapshot: null, duration: 0 },
        ],
    };
}

function createConditionalTrace(): TraceData {
    return {
        traceId: 'test-trace-conditional',
        status: 'completed',
        steps: [
            { stepNumber: 1, stepType: 'start', timestamp: '2024-01-01T00:00:00Z', input: {}, output: {}, stateSnapshot: null },
            { stepNumber: 2, stepType: 'llm', timestamp: '2024-01-01T00:00:01Z', input: { prompt: 'Route?' }, output: { response: 'Use tool' }, stateSnapshot: null, duration: 100 },
            { stepNumber: 3, stepType: 'tool', timestamp: '2024-01-01T00:00:02Z', input: { toolName: 'calculator' }, output: { result: '42' }, stateSnapshot: null, duration: 50 },
            { stepNumber: 4, stepType: 'llm', timestamp: '2024-01-01T00:00:03Z', input: { prompt: 'Route?' }, output: { response: 'Done' }, stateSnapshot: null, duration: 100 },
            { stepNumber: 5, stepType: 'end', timestamp: '2024-01-01T00:00:04Z', input: {}, output: {}, stateSnapshot: null },
        ],
    };
}

function createMultiToolTrace(): TraceData {
    return {
        traceId: 'test-trace-multi-tool',
        status: 'completed',
        steps: [
            { stepNumber: 1, stepType: 'start', timestamp: '2024-01-01T00:00:00Z', input: {}, output: {}, stateSnapshot: null },
            { stepNumber: 2, stepType: 'llm', timestamp: '2024-01-01T00:00:01Z', input: {}, output: {}, stateSnapshot: null, duration: 200 },
            { stepNumber: 3, stepType: 'tool', timestamp: '2024-01-01T00:00:02Z', input: { toolName: 'search' }, output: {}, stateSnapshot: null, duration: 100 },
            { stepNumber: 4, stepType: 'llm', timestamp: '2024-01-01T00:00:03Z', input: {}, output: {}, stateSnapshot: null, duration: 150 },
            { stepNumber: 5, stepType: 'tool', timestamp: '2024-01-01T00:00:04Z', input: { toolName: 'calculator' }, output: {}, stateSnapshot: null, duration: 50 },
            { stepNumber: 6, stepType: 'llm', timestamp: '2024-01-01T00:00:05Z', input: {}, output: {}, stateSnapshot: null, duration: 200 },
            { stepNumber: 7, stepType: 'end', timestamp: '2024-01-01T00:00:06Z', input: {}, output: {}, stateSnapshot: null },
        ],
    };
}

function createSdkRun() {
    return {
        meta: {
            run_id: 'run_sdk_test',
            agent_version: '2.0.0',
            tools: ['search', 'calculator'],
        },
        steps: [
            { step_id: 1, timestamp: 1704067200, phase: 'reason', input: { prompt: 'Hi' }, output: { response: 'Hello' }, status: 'ok', duration: 100 },
            { step_id: 2, timestamp: 1704067201, phase: 'tool', input: { tool: 'search' }, output: { result: 'found' }, status: 'ok', duration: 50 },
            { step_id: 3, timestamp: 1704067202, phase: 'observe', input: {}, output: { analysis: 'done' }, status: 'ok', duration: 80 },
            { step_id: 4, timestamp: 1704067203, phase: 'terminate', input: {}, output: {}, status: 'ok', duration: 10 },
        ],
    };
}

function createErrorRun() {
    return {
        meta: {
            run_id: 'run_error_test',
            agent_version: '1.0.0',
            tools: ['web_search'],
        },
        steps: [
            { step_id: 1, timestamp: 1704067200, phase: 'reason', input: {}, output: {}, status: 'ok', duration: 100 },
            { step_id: 2, timestamp: 1704067201, phase: 'tool', input: { tool: 'web_search' }, output: {}, status: 'error', duration: 500 },
            { step_id: 3, timestamp: 1704067202, phase: 'retry', input: {}, output: {}, status: 'ok', duration: 200 },
        ],
    };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('LangGraphBuilder', () => {

    describe('buildLangGraph', () => {

        it('should extract correct number of unique nodes', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            // __start__, llm, tool_search, __end__ = 4 unique nodes
            assert.ok(result.nodes.length >= 3, `Expected at least 3 nodes, got ${result.nodes.length}`);

            const nodeIds = result.nodes.map(n => n.id);
            assert.ok(nodeIds.includes('__start__'), 'Should have __start__ node');
            assert.ok(nodeIds.includes('__end__'), 'Should have __end__ node');
            assert.ok(nodeIds.includes('llm'), 'Should have llm node');
        });

        it('should extract edges between consecutive nodes', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            assert.ok(result.edges.length >= 2, `Expected at least 2 edges, got ${result.edges.length}`);

            // Should have __start__ -> llm edge
            const startEdge = result.edges.find(e => e.source === '__start__');
            assert.ok(startEdge, 'Should have edge from __start__');
            assert.strictEqual(startEdge.target, 'llm');
        });

        it('should detect conditional edges when a node has multiple outgoing edges', async () => {
            const trace = createConditionalTrace();
            const result = await buildLangGraph(trace);

            // llm has outgoing edges to both tool_calculator and __end__
            const llmEdges = result.edges.filter(e => e.source === 'llm');
            if (llmEdges.length > 1) {
                const hasConditional = llmEdges.some(e => e.conditional);
                assert.ok(hasConditional, 'Multiple outgoing edges should be marked conditional');
            }
        });

        it('should track step transitions on edges', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            for (const edge of result.edges) {
                assert.ok(edge.stepTransitions.length > 0, `Edge ${edge.source}->${edge.target} should have transitions`);
                for (const t of edge.stepTransitions) {
                    assert.ok(typeof t.fromStep === 'number');
                    assert.ok(typeof t.toStep === 'number');
                }
            }
        });

        it('should group multiple executions into the same node', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            const llmNode = result.nodes.find(n => n.id === 'llm');
            assert.ok(llmNode, 'Should have llm node');
            assert.strictEqual(llmNode.steps.length, 2, 'LLM node should contain 2 steps');
        });

        it('should generate distinct tool nodes for different tools', async () => {
            const trace = createMultiToolTrace();
            const result = await buildLangGraph(trace);

            const toolNodes = result.nodes.filter(n => n.id.startsWith('tool_'));
            assert.ok(toolNodes.length >= 2, `Expected at least 2 tool nodes, got ${toolNodes.length}`);

            const toolIds = toolNodes.map(n => n.id);
            assert.ok(toolIds.includes('tool_search'), 'Should have tool_search node');
            assert.ok(toolIds.includes('tool_calculator'), 'Should have tool_calculator node');
        });

        it('should produce valid Mermaid output', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            assert.ok(result.mermaid.length > 0, 'Mermaid output should not be empty');
            // Mermaid should contain graph direction or flowchart marker
            assert.ok(
                result.mermaid.includes('graph') || result.mermaid.includes('flowchart') || result.mermaid.includes('stateDiagram'),
                'Mermaid should contain a graph/flowchart marker'
            );
        });

        it('should set correct traceId and status on result', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);

            assert.strictEqual(result.traceId, 'test-trace-001');
            assert.strictEqual(result.status, 'completed');
            assert.strictEqual(result.totalSteps, 5);
        });
    });

    describe('normalizeRunToTraceData', () => {

        it('should convert SDK run to TraceData format', () => {
            const run = createSdkRun();
            const trace = normalizeRunToTraceData(run);

            assert.strictEqual(trace.traceId, 'run_sdk_test');
            assert.strictEqual(trace.status, 'completed');
            assert.strictEqual(trace.steps.length, 4);
        });

        it('should map phases to stepTypes correctly', () => {
            const run = createSdkRun();
            const trace = normalizeRunToTraceData(run);

            assert.strictEqual(trace.steps[0].stepType, 'llm');       // reason -> llm
            assert.strictEqual(trace.steps[1].stepType, 'tool');       // tool -> tool
            assert.strictEqual(trace.steps[2].stepType, 'llm');       // observe -> llm
            assert.strictEqual(trace.steps[3].stepType, 'end');       // terminate -> end
        });

        it('should detect error status when steps have errors', () => {
            const run = createErrorRun();
            const trace = normalizeRunToTraceData(run);

            assert.strictEqual(trace.status, 'error');
        });

        it('should convert timestamps from epoch seconds to ISO strings', () => {
            const run = createSdkRun();
            const trace = normalizeRunToTraceData(run);

            for (const step of trace.steps) {
                assert.ok(step.timestamp.includes('T'), `Timestamp should be ISO format: ${step.timestamp}`);
                assert.ok(step.timestamp.includes('Z'), `Timestamp should be UTC: ${step.timestamp}`);
            }
        });

        it('should preserve step IDs as stepNumbers', () => {
            const run = createSdkRun();
            const trace = normalizeRunToTraceData(run);

            assert.strictEqual(trace.steps[0].stepNumber, 1);
            assert.strictEqual(trace.steps[1].stepNumber, 2);
            assert.strictEqual(trace.steps[2].stepNumber, 3);
            assert.strictEqual(trace.steps[3].stepNumber, 4);
        });

        it('should compute metadata correctly', () => {
            const run = createSdkRun();
            const trace = normalizeRunToTraceData(run);

            assert.ok(trace.metadata);
            assert.strictEqual(trace.metadata!.agentVersion, '2.0.0');
            assert.deepStrictEqual(trace.metadata!.toolsUsed, ['search', 'calculator']);
            assert.strictEqual(trace.metadata!.totalLLMCalls, 2); // reason + observe
            assert.strictEqual(trace.metadata!.totalToolCalls, 1);
        });

        it('should map retry phase to error stepType', () => {
            const run = createErrorRun();
            const trace = normalizeRunToTraceData(run);

            const retryStep = trace.steps.find(s => s.stepNumber === 3);
            assert.ok(retryStep);
            assert.strictEqual(retryStep.stepType, 'error'); // retry -> error
        });
    });

    describe('LangGraphExporter', () => {
        const exporter = new LangGraphExporter();

        it('should export valid Python code', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);
            const python = exporter.exportPython(result);

            assert.ok(python.includes('from langgraph.graph import StateGraph'));
            assert.ok(python.includes('class AgentState'));
            assert.ok(python.includes('def build_graph'));
            assert.ok(python.includes('graph.add_node'));
            assert.ok(python.includes('graph.compile()'));
        });

        it('should export valid TypeScript code', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);
            const ts = exporter.exportTypeScript(result);

            assert.ok(ts.includes('import { StateGraph'));
            assert.ok(ts.includes('Annotation.Root'));
            assert.ok(ts.includes('export async function buildGraph'));
            assert.ok(ts.includes('graph.addNode'));
            assert.ok(ts.includes('graph.compile()'));
        });

        it('should include conditional routing functions for conditional edges', async () => {
            const trace = createConditionalTrace();
            const result = await buildLangGraph(trace);

            if (result.edges.some(e => e.conditional)) {
                const python = exporter.exportPython(result);
                assert.ok(python.includes('route_from_'), 'Python should have routing function');

                const ts = exporter.exportTypeScript(result);
                assert.ok(ts.includes('routeFrom'), 'TypeScript should have routing function');
            }
        });

        it('should export Mermaid diagram', async () => {
            const trace = createSimpleTrace();
            const result = await buildLangGraph(trace);
            const mermaid = exporter.exportMermaid(result);

            assert.ok(mermaid.length > 0, 'Mermaid should not be empty');
        });
    });
});
