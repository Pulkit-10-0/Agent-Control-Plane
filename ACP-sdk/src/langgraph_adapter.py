"""
ACP SDK - LangGraph Native Tracing Adapter

Captures LangGraph StateGraph structure at recording time and writes
graph metadata (nodes, edges, conditional routing) alongside the
standard run artifacts (meta.json + steps.jsonl).

Usage:
    from acp_sdk.langgraph_adapter import ACPLangGraphTracer

    tracer = ACPLangGraphTracer(run_dir="traces/run_001")
    tracer.capture_graph(compiled_graph)
    tracer.record_step(step_id=1, phase="reason", input_data={...}, output_data={...})
    tracer.finalize()
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Sequence

# Current trace schema version
TRACE_SCHEMA_VERSION = "1.0.0"


@dataclass
class GraphNode:
    """Represents a node in the captured LangGraph."""
    id: str
    name: str
    node_type: str  # "runnable", "tool", "llm", "conditional", etc.
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class GraphEdge:
    """Represents an edge in the captured LangGraph."""
    source: str
    target: str
    conditional: bool = False
    condition_label: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CapturedGraph:
    """Full graph structure captured from a compiled LangGraph StateGraph."""
    nodes: List[GraphNode] = field(default_factory=list)
    edges: List[GraphEdge] = field(default_factory=list)
    entry_point: Optional[str] = None
    finish_points: List[str] = field(default_factory=list)
    mermaid: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "nodes": [asdict(n) for n in self.nodes],
            "edges": [asdict(e) for e in self.edges],
            "entry_point": self.entry_point,
            "finish_points": self.finish_points,
            "mermaid": self.mermaid,
        }


@dataclass
class StepRecord:
    """A single execution step record."""
    step_id: int
    timestamp: float
    phase: str  # reason, tool, observe, memory, retry, terminate
    input: Dict[str, Any] = field(default_factory=dict)
    output: Dict[str, Any] = field(default_factory=dict)
    state_ref: Optional[str] = None
    diff_ref: Optional[str] = None
    status: str = "ok"  # ok, error, retry
    duration: Optional[float] = None
    node_id: Optional[str] = None  # LangGraph node that produced this step
    semantic_labels: List[str] = field(default_factory=list)


class ACPLangGraphTracer:
    """
    LangGraph-native tracing adapter for the Agent Control Plane SDK.

    Captures:
    - Graph structure (nodes, edges, conditional routing) via capture_graph()
    - Individual execution steps via record_step()
    - State snapshots via save_snapshot()
    - State diffs via save_diff()

    Writes:
    - meta.json       - Run metadata with schema version
    - graph.json      - Captured graph structure
    - steps.jsonl     - Step-by-step execution log
    - snapshots/      - State snapshots per step
    - diffs/          - State diffs per step
    - tools/          - Tool outputs (stdout/stderr)
    """

    def __init__(
        self,
        run_dir: str,
        agent_version: str = "unknown",
        llm: str = "unknown",
        temperature: float = 0.0,
        tools: Optional[List[str]] = None,
        seed: int = 0,
        tags: Optional[List[str]] = None,
    ):
        self.run_dir = run_dir
        self.run_id = os.path.basename(run_dir)
        self._steps: List[StepRecord] = []
        self._graph: Optional[CapturedGraph] = None
        self._start_time = time.time()
        self._finalized = False

        # Ensure directory structure
        os.makedirs(run_dir, exist_ok=True)
        os.makedirs(os.path.join(run_dir, "snapshots"), exist_ok=True)
        os.makedirs(os.path.join(run_dir, "diffs"), exist_ok=True)
        os.makedirs(os.path.join(run_dir, "tools"), exist_ok=True)

        # Write initial meta.json
        self._meta = {
            "schema_version": TRACE_SCHEMA_VERSION,
            "run_id": self.run_id,
            "agent_version": agent_version,
            "llm": llm,
            "temperature": temperature,
            "tools": tools or [],
            "seed": seed,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tags": tags or [],
            "status": "running",
        }
        self._write_meta()

    def capture_graph(self, compiled_graph: Any) -> CapturedGraph:
        """
        Capture the graph structure from a compiled LangGraph.

        Args:
            compiled_graph: A compiled StateGraph (result of graph.compile())

        Returns:
            CapturedGraph with nodes, edges, and mermaid diagram
        """
        captured = CapturedGraph()

        try:
            drawable = compiled_graph.get_graph()

            # Extract nodes
            for node_id, node_data in drawable.nodes.items():
                graph_node = GraphNode(
                    id=node_id,
                    name=getattr(node_data, 'name', node_id),
                    node_type=self._infer_node_type(node_data),
                    metadata={"data": str(node_data)[:200]},
                )
                captured.nodes.append(graph_node)

            # Extract edges
            for edge in drawable.edges:
                source = edge.source if isinstance(edge.source, str) else str(edge.source)
                target = edge.target if isinstance(edge.target, str) else str(edge.target)
                conditional = getattr(edge, 'conditional', False)
                label = getattr(edge, 'data', None)

                graph_edge = GraphEdge(
                    source=source,
                    target=target,
                    conditional=conditional,
                    condition_label=str(label) if label else None,
                )
                captured.edges.append(graph_edge)

            # Get mermaid
            try:
                captured.mermaid = drawable.draw_mermaid()
            except Exception:
                captured.mermaid = None

            # Entry/finish points
            captured.entry_point = getattr(drawable, 'first_node', None)
            captured.finish_points = getattr(drawable, 'last_node', [])
            if isinstance(captured.finish_points, str):
                captured.finish_points = [captured.finish_points]

        except Exception as e:
            # If the graph API is different, store what we can
            captured.nodes.append(GraphNode(
                id="__error__",
                name="Graph capture failed",
                node_type="error",
                metadata={"error": str(e)},
            ))

        self._graph = captured

        # Write graph.json
        graph_path = os.path.join(self.run_dir, "graph.json")
        with open(graph_path, "w") as f:
            json.dump(captured.to_dict(), f, indent=2)

        return captured

    def record_step(
        self,
        step_id: int,
        phase: str,
        input_data: Dict[str, Any],
        output_data: Dict[str, Any],
        status: str = "ok",
        duration: Optional[float] = None,
        node_id: Optional[str] = None,
        semantic_labels: Optional[List[str]] = None,
    ) -> StepRecord:
        """
        Record a single execution step.

        Args:
            step_id: Unique step identifier (monotonically increasing)
            phase: Execution phase (reason, tool, observe, memory, retry, terminate)
            input_data: Step input payload
            output_data: Step output payload
            status: Step status (ok, error, retry)
            duration: Step duration in milliseconds
            node_id: LangGraph node ID that produced this step
            semantic_labels: Optional semantic labels for filtering

        Returns:
            The recorded StepRecord
        """
        if self._finalized:
            raise RuntimeError("Cannot record steps after finalize()")

        step = StepRecord(
            step_id=step_id,
            timestamp=time.time(),
            phase=phase,
            input=input_data,
            output=output_data,
            state_ref=f"snapshots/step_{step_id}.json",
            status=status,
            duration=duration,
            node_id=node_id,
            semantic_labels=semantic_labels or [],
        )
        self._steps.append(step)

        # Append to steps.jsonl
        steps_path = os.path.join(self.run_dir, "steps.jsonl")
        with open(steps_path, "a") as f:
            f.write(json.dumps(asdict(step)) + "\n")

        return step

    def save_snapshot(self, step_id: int, snapshot: Dict[str, Any]) -> str:
        """Save a state snapshot for a given step."""
        ref = f"snapshots/step_{step_id}.json"
        path = os.path.join(self.run_dir, ref)
        with open(path, "w") as f:
            json.dump(snapshot, f, indent=2)
        return ref

    def save_diff(self, step_id: int, diff: Dict[str, Any]) -> str:
        """Save a state diff for a given step."""
        ref = f"diffs/step_{step_id}.diff.json"
        path = os.path.join(self.run_dir, ref)
        with open(path, "w") as f:
            json.dump(diff, f, indent=2)

        # Update step's diff_ref
        for step in self._steps:
            if step.step_id == step_id:
                step.diff_ref = ref
                break

        return ref

    def save_tool_output(
        self, step_id: int, stdout: Optional[str] = None, stderr: Optional[str] = None
    ):
        """Save tool stdout/stderr for a given step."""
        if stdout is not None:
            path = os.path.join(self.run_dir, "tools", f"step_{step_id}.stdout")
            with open(path, "w") as f:
                f.write(stdout)
        if stderr is not None:
            path = os.path.join(self.run_dir, "tools", f"step_{step_id}.stderr")
            with open(path, "w") as f:
                f.write(stderr)

    def finalize(self, status: str = "completed"):
        """
        Finalize the run. Writes final meta.json with completion status.

        Args:
            status: Final run status (completed, error, aborted)
        """
        self._meta["status"] = status
        self._meta["completed_at"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
        )
        self._meta["total_steps"] = len(self._steps)
        self._meta["total_duration_ms"] = round(
            (time.time() - self._start_time) * 1000
        )
        self._meta["has_graph"] = self._graph is not None

        # Compute summary metrics
        phase_counts: Dict[str, int] = {}
        error_count = 0
        for step in self._steps:
            phase_counts[step.phase] = phase_counts.get(step.phase, 0) + 1
            if step.status == "error":
                error_count += 1

        self._meta["phase_counts"] = phase_counts
        self._meta["error_count"] = error_count

        self._write_meta()
        self._finalized = True

    def _write_meta(self):
        """Write meta.json to disk."""
        meta_path = os.path.join(self.run_dir, "meta.json")
        with open(meta_path, "w") as f:
            json.dump(self._meta, f, indent=2)

    @staticmethod
    def _infer_node_type(node_data: Any) -> str:
        """Infer the node type from LangGraph node data."""
        type_name = type(node_data).__name__.lower()
        if "tool" in type_name:
            return "tool"
        if "llm" in type_name or "chat" in type_name:
            return "llm"
        if "branch" in type_name or "conditional" in type_name:
            return "conditional"
        return "runnable"


class LangGraphCallbackTracer:
    """
    Automatic callback-based tracer that hooks into LangGraph execution.

    Usage:
        tracer = LangGraphCallbackTracer(run_dir="traces/run_002")
        config = {"callbacks": [tracer.get_callback()]}
        result = compiled_graph.invoke(input_data, config=config)
        tracer.finalize()
    """

    def __init__(self, run_dir: str, **kwargs: Any):
        self._tracer = ACPLangGraphTracer(run_dir, **kwargs)
        self._step_counter = 0

    def get_callback(self):
        """
        Returns a callback handler compatible with LangGraph/LangChain.
        Override or extend for custom callback integration.
        """
        tracer = self

        class ACPCallbackHandler:
            def on_chain_start(self, serialized: Dict, inputs: Dict, **kwargs: Any):
                tracer._step_counter += 1
                run_id = kwargs.get("run_id", "")
                node_name = serialized.get("name", str(run_id)[:8])
                tracer._tracer.record_step(
                    step_id=tracer._step_counter,
                    phase="reason",
                    input_data=inputs if isinstance(inputs, dict) else {"value": str(inputs)},
                    output_data={},
                    node_id=node_name,
                )

            def on_chain_end(self, outputs: Any, **kwargs: Any):
                # Update last step with output
                if tracer._tracer._steps:
                    last = tracer._tracer._steps[-1]
                    last.output = outputs if isinstance(outputs, dict) else {"value": str(outputs)}

            def on_tool_start(self, serialized: Dict, input_str: str, **kwargs: Any):
                tracer._step_counter += 1
                tool_name = serialized.get("name", "unknown_tool")
                tracer._tracer.record_step(
                    step_id=tracer._step_counter,
                    phase="tool",
                    input_data={"tool_name": tool_name, "input": input_str},
                    output_data={},
                    node_id=f"tool_{tool_name}",
                )

            def on_tool_end(self, output: str, **kwargs: Any):
                if tracer._tracer._steps:
                    last = tracer._tracer._steps[-1]
                    last.output = {"result": output}

            def on_tool_error(self, error: BaseException, **kwargs: Any):
                if tracer._tracer._steps:
                    last = tracer._tracer._steps[-1]
                    last.status = "error"
                    last.output = {"error": str(error)}

            def on_chain_error(self, error: BaseException, **kwargs: Any):
                if tracer._tracer._steps:
                    last = tracer._tracer._steps[-1]
                    last.status = "error"
                    last.output = {"error": str(error)}

        return ACPCallbackHandler()

    def capture_graph(self, compiled_graph: Any) -> CapturedGraph:
        """Delegate to underlying tracer."""
        return self._tracer.capture_graph(compiled_graph)

    def finalize(self, status: str = "completed"):
        """Delegate to underlying tracer."""
        self._tracer.finalize(status)
