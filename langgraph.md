# LangGraph Viewer — Quick Start

How to load a trace and view the execution graph in the right panel.

---

## Quick demo — load this trace right now

A ready-made trace is included at:

```
traces/run_langgraph_demo/
├── meta.json
└── steps.jsonl   ← 15 steps: reason → tool → observe → memory → … → terminate
```

It produces **6 distinct graph nodes**: `llm`, `tool_web_search`, `tool_read_file`, `tool_summarize`, `tool_write_file`, `state`, `end`.

### Open it now

1. Press `F5` in VS Code to launch the extension host
2. `Ctrl+Shift+P` → **ACP: Open Trace**
3. Choose **Open SDK Run Folder**
4. Navigate to `traces/run_langgraph_demo` and click **Select Folder**
5. The graph opens automatically in the right panel — if it doesn't, run **ACP: Show Execution Graph**

---

## Steps

### 1. Install dependencies

```bash
cd vscode-extension
npm install
npm run compile
```

### 2. Open the extension in VS Code

Open the `vscode-extension` folder in VS Code, then press `F5`.

This launches the **Extension Development Host** with `Agent-Control-Plane/` (the project root) as the workspace — so the `traces/` folder is visible to the extension.

> ⚠️ Make sure you press `F5` from inside the `vscode-extension` folder, not the parent. The `.vscode/launch.json` is already configured to open the parent as the workspace.

---

### 3. Put a trace somewhere VS Code can find it

Either a **legacy JSON trace** or an **SDK run folder** works.

**Option A — SDK run folder** (recommended):
```
your-workspace/
└── traces/
    └── run_1234/
        ├── meta.json
        └── steps.jsonl
```

**Option B — Legacy JSON trace:**
```
your-workspace/
└── traces/
    └── my_trace.json
```

---

### 4. Load the trace

Open the **Command Palette** (`Ctrl+Shift+P`) and run:

```
ACP: Open Trace
```

- Pick **"Open JSON Trace File"** for a `.json` file
- Pick **"Open SDK Run Folder"** for a `run_*` folder

Or click a trace in the **Agent Control Plane** sidebar (the robot icon in the Activity Bar).

---

### 5. View the graph on the right

After loading, the execution graph opens automatically in the **right editor panel**.

If it doesn't, run from the Command Palette:

```
ACP: Show Execution Graph
```

The panel has three tabs:

| Tab | What it shows |
|-----|--------------|
| **Graph** | SVG node-and-edge diagram of the execution flow |
| **Nodes** | List of all graph nodes (collapsible groups if >15 nodes) |
| **Mermaid** | Raw Mermaid diagram text + stats |

---

### 6. Navigate

- **Click a node** → see step inputs/outputs + a "Fork from this node" button
- Toggle **In / Out / Both** (top-right) to control what's shown in the detail panel
- Use **ACP: Replay - Next Step** (`Ctrl+Shift+P`) to step through — the graph highlights the active node as you go

---

### 7. Export the graph (optional)

```
Command Palette → ACP: Export Graph
```

Choose **Python**, **TypeScript**, or **Mermaid** — the file opens in a new editor tab ready to copy or save.

---

### 8. Branch / fork from the graph (optional)

1. Click any non-start node in the Graph tab
2. Click **"Fork from this node"** in the detail panel
3. Edit the input JSON in the prompt
4. A new counterfactual run folder is created and loaded automatically

---

## Trace format reference

### SDK run folder (`meta.json`)

```json
{
  "run_id": "run_abc123",
  "agent_version": "1.0.0",
  "llm": "gpt-4",
  "temperature": 0.7,
  "tools": ["search", "summarize"],
  "seed": 42,
  "created_at": "2026-03-01T10:00:00Z",
  "schema_version": "1.0.0"
}
```

### SDK run folder (`steps.jsonl` — one JSON object per line)

```jsonl
{"step_id":1,"timestamp":1740830400,"phase":"reason","input":{"prompt":"..."},"output":{"response":"..."},"state_ref":"snapshots/step_1.json","status":"ok","duration":142}
{"step_id":2,"timestamp":1740830401,"phase":"tool","input":{"toolName":"search","query":"..."},"output":{"results":[]},"state_ref":"snapshots/step_2.json","status":"ok","duration":310}
```

**Valid phases:** `reason` · `tool` · `observe` · `memory` · `retry` · `terminate`

---

## Python SDK (record traces automatically)

```python
from acp_sdk import ACPLangGraphTracer

tracer = ACPLangGraphTracer(output_dir="./traces")
tracer.capture_graph(compiled_graph)      # save graph topology
tracer.record_step(
    step_id=1,
    phase="reason",
    input_data={"prompt": "hello"},
    output_data={"response": "hi"},
)
tracer.finalize()
# → writes traces/run_<timestamp>/meta.json + steps.jsonl + graph.json
```
