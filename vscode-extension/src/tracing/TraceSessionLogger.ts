/**
 * TraceSessionLogger - Tracks all file edits and creates trace logs
 *
 * For every file edit in the workspace:
 * - Creates a new JSON file in traces/session_log/
 * - Never modifies existing files - append only
 * - Triggers Gemini verification every 5 new traces
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface TraceLogEntry {
    step_number: number;
    timestamp: string;
    file_path: string;
    before_snippet: string;
    after_snippet: string;
    what_changed: string;
}

export interface GeminiVerificationResult {
    coherent: boolean;
    conflicts: Array<{ step_a: number; step_b: number; reason: string }>;
    suggestions: string[];
    instructions_md_additions: string[];
}

/** Callback type for when Gemini verification is needed */
export type GeminiVerificationCallback = (logs: TraceLogEntry[]) => Promise<GeminiVerificationResult | null>;

export class TraceSessionLogger {
    private stepCount: number = 0;
    private sessionLogDir: string;
    private statusBarItem: vscode.StatusBarItem;
    private onGeminiVerification: GeminiVerificationCallback | null = null;
    private stepsUntilGeminiCheck: number = 5;
    private isBlocked: boolean = false;
    private disposables: vscode.Disposable[] = [];
    private previousDocumentContents: Map<string, string> = new Map();

    constructor(
        private workspaceRoot: string,
        private context: vscode.ExtensionContext
    ) {
        this.sessionLogDir = path.join(workspaceRoot, 'traces', 'session_log');
        this.ensureDirectoryExists(this.sessionLogDir);

        // Initialize step count from existing logs
        this.initializeStepCount();

        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99 // Just below the ACP Traces status bar
        );
        this.updateStatusBar();
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);

        // Set up file watchers
        this.setupFileWatchers();
    }

    private ensureDirectoryExists(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private initializeStepCount(): void {
        if (!fs.existsSync(this.sessionLogDir)) {
            this.stepCount = 0;
            return;
        }

        const files = fs.readdirSync(this.sessionLogDir)
            .filter(f => f.endsWith('.json'))
            .sort();

        if (files.length === 0) {
            this.stepCount = 0;
            return;
        }

        // Get the highest step number from existing files
        const lastFile = files[files.length - 1];
        const match = lastFile.match(/^(\d+)_/);
        if (match) {
            this.stepCount = parseInt(match[1], 10);
        }

        // Update steps until next Gemini check
        this.stepsUntilGeminiCheck = 5 - (this.stepCount % 5);
        if (this.stepsUntilGeminiCheck === 0) {
            this.stepsUntilGeminiCheck = 5;
        }
    }

    private setupFileWatchers(): void {
        // Track document content before changes
        const onDidOpenDocument = vscode.workspace.onDidOpenTextDocument((doc) => {
            if (this.shouldTrackDocument(doc)) {
                this.previousDocumentContents.set(doc.uri.fsPath, doc.getText());
            }
        });

        // Update content cache on save
        const onWillSaveDocument = vscode.workspace.onWillSaveTextDocument((event) => {
            const doc = event.document;
            if (this.shouldTrackDocument(doc)) {
                // Store current content as "before" state
                const currentContent = this.previousDocumentContents.get(doc.uri.fsPath);
                if (currentContent !== doc.getText()) {
                    // Content has changed since last save
                    this.previousDocumentContents.set(doc.uri.fsPath + '_before', currentContent || '');
                }
            }
        });

        // Log changes on document save
        const onDidSaveDocument = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (this.shouldTrackDocument(doc)) {
                this.logFileChange(doc);
            }
        });

        // Track newly opened documents
        vscode.workspace.textDocuments.forEach((doc) => {
            if (this.shouldTrackDocument(doc)) {
                this.previousDocumentContents.set(doc.uri.fsPath, doc.getText());
            }
        });

        this.disposables.push(onDidOpenDocument, onWillSaveDocument, onDidSaveDocument);
    }

    private shouldTrackDocument(doc: vscode.TextDocument): boolean {
        const fsPath = doc.uri.fsPath;

        // Don't track if blocked
        if (this.isBlocked) {
            return false;
        }

        // Don't track trace logs themselves
        if (fsPath.includes('traces/session_log') || fsPath.includes('traces\\session_log')) {
            return false;
        }

        // Don't track .git files
        if (fsPath.includes('.git')) {
            return false;
        }

        // Don't track node_modules
        if (fsPath.includes('node_modules')) {
            return false;
        }

        // Only track files in workspace
        if (!fsPath.startsWith(this.workspaceRoot)) {
            return false;
        }

        return true;
    }

    private async logFileChange(doc: vscode.TextDocument): Promise<void> {
        const fsPath = doc.uri.fsPath;
        const beforeContent = this.previousDocumentContents.get(fsPath + '_before') || '';
        const afterContent = doc.getText();

        // Skip if no actual change
        if (beforeContent === afterContent) {
            // Update cache for next comparison
            this.previousDocumentContents.set(fsPath, afterContent);
            return;
        }

        // Increment step count
        this.stepCount++;
        this.stepsUntilGeminiCheck--;

        // Create timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-');

        // Create trace log entry
        const entry: TraceLogEntry = {
            step_number: this.stepCount,
            timestamp: now.toISOString(),
            file_path: path.relative(this.workspaceRoot, fsPath),
            before_snippet: this.getSnippet(beforeContent),
            after_snippet: this.getSnippet(afterContent),
            what_changed: this.describeChange(beforeContent, afterContent)
        };

        // Write to file
        const filename = `${this.stepCount}_${timestamp}.json`;
        const filepath = path.join(this.sessionLogDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));

        // Update cache
        this.previousDocumentContents.set(fsPath, afterContent);
        this.previousDocumentContents.delete(fsPath + '_before');

        // Update status bar
        this.updateStatusBar();

        // Check if Gemini verification is needed
        if (this.stepsUntilGeminiCheck <= 0) {
            await this.triggerGeminiVerification();
            this.stepsUntilGeminiCheck = 5;
        }
    }

    private getSnippet(content: string, maxLength: number = 500): string {
        if (content.length <= maxLength) {
            return content;
        }
        return content.substring(0, maxLength) + '... (truncated)';
    }

    private describeChange(before: string, after: string): string {
        const beforeLines = before.split('\n').length;
        const afterLines = after.split('\n').length;
        const lineDiff = afterLines - beforeLines;

        if (lineDiff > 0) {
            return `Added ${lineDiff} line(s)`;
        } else if (lineDiff < 0) {
            return `Removed ${Math.abs(lineDiff)} line(s)`;
        } else {
            return 'Modified content (same line count)';
        }
    }

    private updateStatusBar(): void {
        this.statusBarItem.text = `$(list-ordered) ACP: ${this.stepCount} steps logged | Gemini check in ${this.stepsUntilGeminiCheck}`;
        this.statusBarItem.tooltip = 'Trace session logger - tracking code changes';

        if (this.isBlocked) {
            this.statusBarItem.text = `$(warning) ACP: BLOCKED - Resolve conflicts`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    public setGeminiVerificationCallback(callback: GeminiVerificationCallback): void {
        this.onGeminiVerification = callback;
    }

    private async triggerGeminiVerification(): Promise<void> {
        if (!this.onGeminiVerification) {
            console.log('[TraceSessionLogger] No Gemini verification callback set');
            return;
        }

        // Read all trace logs
        const logs = this.readAllTraceLogs();

        if (logs.length === 0) {
            return;
        }

        try {
            const result = await this.onGeminiVerification(logs);

            if (result) {
                await this.handleGeminiResult(result);
            }
        } catch (err) {
            console.error('[TraceSessionLogger] Gemini verification failed:', err);
            vscode.window.showErrorMessage(`Gemini verification failed: ${err}`);
        }
    }

    public readAllTraceLogs(): TraceLogEntry[] {
        if (!fs.existsSync(this.sessionLogDir)) {
            return [];
        }

        const files = fs.readdirSync(this.sessionLogDir)
            .filter(f => f.endsWith('.json'))
            .sort();

        const logs: TraceLogEntry[] = [];

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(this.sessionLogDir, file), 'utf-8');
                logs.push(JSON.parse(content));
            } catch (err) {
                console.warn(`[TraceSessionLogger] Failed to read ${file}:`, err);
            }
        }

        return logs;
    }

    private async handleGeminiResult(result: GeminiVerificationResult): Promise<void> {
        if (!result.coherent) {
            // Block further edits
            this.isBlocked = true;
            this.updateStatusBar();

            // Show warning with conflicts
            const conflictMessages = result.conflicts
                .map(c => `Step ${c.step_a} vs Step ${c.step_b}: ${c.reason}`)
                .join('\n');

            const action = await vscode.window.showWarningMessage(
                `Gemini detected incoherent changes!\n\nConflicts:\n${conflictMessages}`,
                'Acknowledge & Continue',
                'View Details'
            );

            if (action === 'Acknowledge & Continue') {
                this.isBlocked = false;
                this.updateStatusBar();
            } else if (action === 'View Details') {
                // Show full details in a new document
                const doc = await vscode.workspace.openTextDocument({
                    content: JSON.stringify(result, null, 2),
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc);

                // Still allow acknowledge
                const ack = await vscode.window.showWarningMessage(
                    'Review complete. Acknowledge to continue editing.',
                    'Acknowledge & Continue'
                );
                if (ack) {
                    this.isBlocked = false;
                    this.updateStatusBar();
                }
            }
        }

        // Append auto-generated rules to instructions.md
        if (result.instructions_md_additions && result.instructions_md_additions.length > 0) {
            await this.appendToInstructions(result.instructions_md_additions);
        }

        // Show suggestions as info
        if (result.suggestions && result.suggestions.length > 0) {
            vscode.window.showInformationMessage(
                `Gemini suggestions: ${result.suggestions[0]}${result.suggestions.length > 1 ? ' (and more)' : ''}`
            );
        }
    }

    private async appendToInstructions(additions: string[]): Promise<void> {
        const instructionsPath = path.join(this.workspaceRoot, 'instructions.md');

        if (!fs.existsSync(instructionsPath)) {
            return;
        }

        let content = fs.readFileSync(instructionsPath, 'utf-8');

        // Append each addition
        const timestamp = new Date().toISOString();
        const newRules = additions.map(a => `- ${a}`).join('\n');
        const appendContent = `\n### Added ${timestamp}\n${newRules}\n`;

        content += appendContent;

        fs.writeFileSync(instructionsPath, content);
    }

    public getStepCount(): number {
        return this.stepCount;
    }

    public getStepsUntilGeminiCheck(): number {
        return this.stepsUntilGeminiCheck;
    }

    public isEditingBlocked(): boolean {
        return this.isBlocked;
    }

    public unblock(): void {
        this.isBlocked = false;
        this.updateStatusBar();
    }

    public dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.statusBarItem.dispose();
    }
}
