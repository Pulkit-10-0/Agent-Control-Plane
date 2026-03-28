export interface RunMeta {
    run_id: string;
    agent_version: string;
    llm: string;
    temperature: number;
    tools: string[];
    seed: number;
    created_at: string;
    schema_version?: string;
}

/** Current schema version for new traces */
export const TRACE_SCHEMA_VERSION = '1.0.0';

/** All known schema versions for migration/validation */
export const KNOWN_SCHEMA_VERSIONS = ['1.0.0'];

export type StepPhase = 'reason' | 'tool' | 'observe' | 'memory';
export type StepStatus = 'ok' | 'error' | 'retry';

export interface AgentStep {
    step_id: number;
    timestamp: number;
    phase: StepPhase;
    input: Record<string, any>;
    output: Record<string, any>;
    state_ref: string; // e.g., "snapshots/step_17.json"
    diff_ref?: string; // e.g., "diffs/step_17.diff.json"
    status: StepStatus;

    // Computed/Runtime fields
    duration?: number;
    semanticLabels?: string[];
}

export interface StateSnapshot {
    step_id: number;
    memory: Record<string, any>[]; // List of memory entries
    context_tokens: number;
    tools_state: Record<string, any>;
}

export interface StateDiff {
    step_id: number;
    changes: {
        path: string[];
        old_value: any;
        new_value: any;
    }[];
}

export interface RunArtifacts {
    meta: RunMeta;
    steps: AgentStep[];
    path: string; // Root path of the run
}
