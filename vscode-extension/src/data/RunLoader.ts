import * as fs from 'fs';
import * as path from 'path';
import { RunMeta, AgentStep, RunArtifacts, StateSnapshot, StateDiff, TRACE_SCHEMA_VERSION, KNOWN_SCHEMA_VERSIONS } from './DataTypes';

export class RunLoader {
    private runPath: string;
    private meta: RunMeta | undefined;
    private steps: AgentStep[] = [];
    private loaded: boolean = false;

    constructor(runPath: string) {
        this.runPath = runPath;
    }

    /**
     * Validate and normalize the schema version of a loaded run.
     * Warns on unknown or missing versions, and migrates if necessary.
     */
    private validateSchema(meta: RunMeta): void {
        if (!meta.schema_version) {
            console.warn(
                `[ACP] Run ${meta.run_id}: No schema_version field. Assuming v${TRACE_SCHEMA_VERSION}. ` +
                'Consider re-recording with the latest SDK.'
            );
            meta.schema_version = TRACE_SCHEMA_VERSION;
            return;
        }

        if (!KNOWN_SCHEMA_VERSIONS.includes(meta.schema_version)) {
            console.warn(
                `[ACP] Run ${meta.run_id}: Unknown schema version "${meta.schema_version}". ` +
                `Known versions: ${KNOWN_SCHEMA_VERSIONS.join(', ')}. ` +
                'Some features may not work correctly.'
            );
        }
    }

    public async load(): Promise<RunArtifacts> {
        if (this.loaded) {
            return {
                meta: this.meta!,
                steps: this.steps,
                path: this.runPath
            };
        }

        // Load meta.json
        const metaPath = path.join(this.runPath, 'meta.json');
        if (!fs.existsSync(metaPath)) {
            throw new Error(`meta.json not found in ${this.runPath}`);
        }
        this.meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        this.validateSchema(this.meta!);

        // Load steps.jsonl
        const stepsPath = path.join(this.runPath, 'steps.jsonl');
        if (!fs.existsSync(stepsPath)) {
            // Steps file might be missing if run just started or failed immediately
            this.steps = [];
        } else {
            const content = fs.readFileSync(stepsPath, 'utf-8');
            this.steps = content
                .split('\n')
                .filter(line => line.trim().length > 0)
                .map(line => {
                    try {
                        return JSON.parse(line) as AgentStep;
                    } catch (e) {
                        console.warn('Failed to parse step line:', line);
                        return null;
                    }
                })
                .filter((s): s is AgentStep => s !== null);
        }

        this.loaded = true;
        return {
            meta: this.meta!,
            steps: this.steps,
            path: this.runPath
        };
    }

    public getSnapshot(stepId: number): StateSnapshot | null {
        // Find step to get ref
        const step = this.steps.find(s => s.step_id === stepId);
        if (!step || !step.state_ref) return null;

        const snapshotPath = path.join(this.runPath, step.state_ref);
        if (!fs.existsSync(snapshotPath)) return null;

        return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as StateSnapshot;
    }

    public getDiff(stepId: number): StateDiff | null {
        const step = this.steps.find(s => s.step_id === stepId);
        if (!step || !step.diff_ref) return null;

        const diffPath = path.join(this.runPath, step.diff_ref);
        if (!fs.existsSync(diffPath)) return null;

        return JSON.parse(fs.readFileSync(diffPath, 'utf-8')) as StateDiff;
    }

    public getToolOutput(stepId: number, type: 'stdout' | 'stderr'): string | null {
        // This assumes a convention not explicitly detailed in the "tools/" section of the spec 
        // but implied by "tools/step_14.stdout".
        // The spec says: tools/step_14.stdout
        const filename = `step_${stepId}.${type}`;
        const toolOutputPath = path.join(this.runPath, 'tools', filename);

        if (!fs.existsSync(toolOutputPath)) return null;
        return fs.readFileSync(toolOutputPath, 'utf-8');
    }
}
