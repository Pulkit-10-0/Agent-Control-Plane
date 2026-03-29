/**
 * CopilotOutputWatcher - Monitors all file changes in the workspace
 *
 * Tracks every file change and:
 * 1. Appends to traces/session_log/{step}_{timestamp}.json
 * 2. Appends to CHANGELOG.md
 * 3. Updates CONTEXT.md (Current Session section only)
 * 4. Every 5 changes triggers Gemini verification
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiService } from '../tracing/GeminiService';

interface ChangeLogEntry {
    step: number;
    timestamp: string;
    source: string;
    file: string;
    line: number;
    added: string;
    removed: string;
}

export class CopilotOutputWatcher {
    private stepCount: number = 0;
    private workspaceRoot: string;
    private sessionLogDir: string;
    private disposables: vscode.Disposable[] = [];
    private debounceTimer: NodeJS.Timeout | null = null;
    private pendingChanges: Map<string, vscode.TextDocumentChangeEvent> = new Map();
    private geminiService: GeminiService | null = null;
    private changesUntilGemini: number = 5;

    constructor(private context: vscode.ExtensionContext) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.workspaceRoot = '';
            this.sessionLogDir = '';
            return;
        }

        this.workspaceRoot = workspaceFolders[0].uri.fsPath;
        this.sessionLogDir = path.join(this.workspaceRoot, 'traces', 'session_log');

        // Initialize step count from existing logs
        this.initializeStepCount();

        // Initialize Gemini service
        this.geminiService = new GeminiService(this.workspaceRoot);
    }

    private initializeStepCount(): void {
        this.ensureDirectoryExists(this.sessionLogDir);

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

        // Set changes until next Gemini check
        this.changesUntilGemini = 5 - (this.stepCount % 5);
        if (this.changesUntilGemini === 0) {
            this.changesUntilGemini = 5;
        }
    }

    private ensureDirectoryExists(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    public start(): void {
        if (!this.workspaceRoot) {
            console.warn('[CopilotOutputWatcher] No workspace folder found');
            return;
        }

        // Listen to all document changes
        const watcher = vscode.workspace.onDidChangeTextDocument((event) => {
            this.handleDocumentChange(event);
        });

        this.disposables.push(watcher);
        this.context.subscriptions.push(watcher);

        console.log('[CopilotOutputWatcher] Started watching for file changes');
    }

    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        const doc = event.document;

        // Skip if no workspace
        if (!this.workspaceRoot) {
            return;
        }

        // Skip untitled documents
        if (doc.isUntitled) {
            return;
        }

        // Skip if outside workspace
        if (!doc.uri.fsPath.startsWith(this.workspaceRoot)) {
            return;
        }

        // Skip files inside traces/ folder
        const relativePath = path.relative(this.workspaceRoot, doc.uri.fsPath);
        if (relativePath.startsWith('traces') || relativePath.startsWith('traces/') || relativePath.startsWith('traces\\')) {
            return;
        }

        // Skip .md files
        if (doc.uri.fsPath.endsWith('.md')) {
            return;
        }

        // Skip if no actual content changes
        if (event.contentChanges.length === 0) {
            return;
        }

        // Skip empty changes
        const hasRealChange = event.contentChanges.some(c => c.text.length > 0 || c.rangeLength > 0);
        if (!hasRealChange) {
            return;
        }

        // Store the change and debounce
        this.pendingChanges.set(doc.uri.fsPath, event);

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.processPendingChanges();
        }, 500);
    }

    private async processPendingChanges(): Promise<void> {
        const changes = Array.from(this.pendingChanges.values());
        this.pendingChanges.clear();

        for (const event of changes) {
            await this.processChange(event);
        }
    }

    private async processChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const doc = event.document;
        const relativePath = path.relative(this.workspaceRoot, doc.uri.fsPath);

        // Process each content change
        for (const change of event.contentChanges) {
            // Increment step
            this.stepCount++;
            this.changesUntilGemini--;

            const timestamp = new Date().toISOString();
            const timestampForFile = timestamp.replace(/[:.]/g, '-');

            // Create the log entry
            const entry: ChangeLogEntry = {
                step: this.stepCount,
                timestamp: timestamp,
                source: 'copilot',
                file: relativePath,
                line: change.range.start.line + 1, // 1-indexed for readability
                added: change.text.substring(0, 300),
                removed: '' // We can't get the removed text after the fact
            };

            // 1. Append to traces/session_log/
            this.appendToSessionLog(entry, timestampForFile);

            // 2. Append to CHANGELOG.md
            this.appendToChangelog(entry);

            // 3. Update CONTEXT.md
            this.updateContextMd(entry);

            // 4. Check if Gemini verification needed
            if (this.changesUntilGemini <= 0) {
                await this.triggerGeminiCheck();
                this.changesUntilGemini = 5;
            }
        }
    }

    private appendToSessionLog(entry: ChangeLogEntry, timestampForFile: string): void {
        this.ensureDirectoryExists(this.sessionLogDir);

        const filename = `${entry.step}_${timestampForFile}.json`;
        const filepath = path.join(this.sessionLogDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
    }

    private appendToChangelog(entry: ChangeLogEntry): void {
        const changelogPath = path.join(this.workspaceRoot, 'CHANGELOG.md');

        // Create if doesn't exist
        if (!fs.existsSync(changelogPath)) {
            fs.writeFileSync(changelogPath, '# Changelog\n\nAuto-generated by ACP Copilot Output Watcher.\n\n');
        }

        const changeText = entry.added.substring(0, 100).replace(/\n/g, ' ').trim();
        const changelogEntry = `### Step ${entry.step} — ${entry.timestamp}\n- File: ${entry.file}\n- Line: ${entry.line}\n- Change: ${changeText || '(deletion)'}\n\n`;

        fs.appendFileSync(changelogPath, changelogEntry);
    }

    private updateContextMd(entry: ChangeLogEntry): void {
        const contextPath = path.join(this.workspaceRoot, 'CONTEXT.md');

        let content: string;

        if (!fs.existsSync(contextPath)) {
            content = `# Context\n\nAuto-generated by ACP Copilot Output Watcher.\n\n## Last Copilot Edit\n`;
        } else {
            content = fs.readFileSync(contextPath, 'utf-8');
        }

        // Find and replace the "Last Copilot Edit" section
        const sectionHeader = '## Last Copilot Edit';
        const nextSectionRegex = /\n## [^L]/;

        const sectionIndex = content.indexOf(sectionHeader);

        if (sectionIndex === -1) {
            // Add section at the end
            content += `\n${sectionHeader}\n`;
            content += `- File: ${entry.file}\n`;
            content += `- Line: ${entry.line}\n`;
            content += `- Time: ${entry.timestamp}\n`;
            content += `- Step: ${entry.step}\n`;
        } else {
            // Find where the section ends (next ## or end of file)
            const afterSection = content.substring(sectionIndex + sectionHeader.length);
            const nextSectionMatch = afterSection.match(nextSectionRegex);

            let endIndex: number;
            if (nextSectionMatch && nextSectionMatch.index !== undefined) {
                endIndex = sectionIndex + sectionHeader.length + nextSectionMatch.index;
            } else {
                endIndex = content.length;
            }

            // Replace the section content
            const newSectionContent = `${sectionHeader}\n- File: ${entry.file}\n- Line: ${entry.line}\n- Time: ${entry.timestamp}\n- Step: ${entry.step}\n`;

            content = content.substring(0, sectionIndex) + newSectionContent + content.substring(endIndex);
        }

        fs.writeFileSync(contextPath, content);
    }

    private async triggerGeminiCheck(): Promise<void> {
        if (!this.geminiService || !this.geminiService.isConfigured()) {
            console.log('[CopilotOutputWatcher] Gemini not configured, skipping check');
            return;
        }

        try {
            // Read all MD files
            const mdFiles = this.readAllMdFiles();

            // Read last 5 trace entries
            const traceEntries = this.readLastTraceEntries(5);

            // Build context for Gemini
            const context = {
                mdFiles: mdFiles,
                recentTraces: traceEntries
            };

            // Create prompt for Gemini
            const prompt = `Analyze these recent code changes and documentation files for coherence.

MD Files:
${JSON.stringify(mdFiles, null, 2)}

Recent Trace Entries (last 5 changes):
${JSON.stringify(traceEntries, null, 2)}

Check if the changes are coherent and do not contradict each other.
Check if any step breaks what a previous step built.

Return ONLY valid JSON:
{
  "coherent": true,
  "conflicts": [],
  "suggestions": [],
  "instructions_md_additions": []
}

If conflicts exist, set coherent to false and fill conflicts array with:
{ "step_a": number, "step_b": number, "reason": "description" }`;

            const response = await this.callGeminiDirect(prompt);

            if (response) {
                await this.handleGeminiResponse(response);
            }
        } catch (err) {
            console.error('[CopilotOutputWatcher] Gemini check failed:', err);
        }
    }

    private readAllMdFiles(): { path: string; content: string }[] {
        const mdFiles: { path: string; content: string }[] = [];

        const scanDir = (dir: string) => {
            if (!fs.existsSync(dir)) return;

            const entries = fs.readdirSync(dir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);

                // Skip node_modules, .git, traces
                if (entry.isDirectory()) {
                    if (!['node_modules', '.git', 'traces', 'out', 'dist'].includes(entry.name)) {
                        scanDir(fullPath);
                    }
                } else if (entry.name.endsWith('.md')) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        mdFiles.push({
                            path: path.relative(this.workspaceRoot, fullPath),
                            content: content.substring(0, 1000) // Limit size
                        });
                    } catch (err) {
                        // Skip unreadable files
                    }
                }
            }
        };

        scanDir(this.workspaceRoot);
        return mdFiles.slice(0, 10); // Limit to 10 MD files
    }

    private readLastTraceEntries(count: number): ChangeLogEntry[] {
        if (!fs.existsSync(this.sessionLogDir)) {
            return [];
        }

        const files = fs.readdirSync(this.sessionLogDir)
            .filter(f => f.endsWith('.json'))
            .sort()
            .slice(-count);

        const entries: ChangeLogEntry[] = [];

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(this.sessionLogDir, file), 'utf-8');
                entries.push(JSON.parse(content));
            } catch (err) {
                // Skip invalid files
            }
        }

        return entries;
    }

    private async callGeminiDirect(prompt: string): Promise<any> {
        // Load API key
        const envPath = path.join(this.workspaceRoot, 'vscode-extension', '.env.local');
        let apiKey = '';

        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            const match = content.match(/GEMINI_API_KEY=(.+)/);
            if (match) {
                apiKey = match[1].trim();
            }
        }

        if (!apiKey) {
            return null;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 2048
            }
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                console.error('[CopilotOutputWatcher] Gemini API error:', response.status);
                return null;
            }

            const data = await response.json() as any;

            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                const text = data.candidates[0].content.parts[0].text;

                // Parse JSON from response
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    return JSON.parse(jsonMatch[0]);
                }
            }
        } catch (err) {
            console.error('[CopilotOutputWatcher] Gemini call failed:', err);
        }

        return null;
    }

    private async handleGeminiResponse(result: any): Promise<void> {
        if (!result.coherent && result.conflicts?.length > 0) {
            // Show warning
            const conflictMsg = result.conflicts
                .map((c: any) => `Step ${c.step_a} vs ${c.step_b}: ${c.reason}`)
                .join('\n');

            vscode.window.showWarningMessage(
                `Gemini detected conflicts in your changes:\n${conflictMsg}`,
                'OK'
            );
        }

        // Append rules to instructions.md
        if (result.instructions_md_additions?.length > 0) {
            const instructionsPath = path.join(this.workspaceRoot, 'test-project', 'instructions.md');

            if (fs.existsSync(instructionsPath)) {
                const timestamp = new Date().toISOString();
                const additions = result.instructions_md_additions
                    .map((r: string) => `- ${r}`)
                    .join('\n');

                const appendContent = `\n### Auto-added ${timestamp}\n${additions}\n`;
                fs.appendFileSync(instructionsPath, appendContent);
            }
        }

        // Show suggestions
        if (result.suggestions?.length > 0) {
            vscode.window.showInformationMessage(
                `Gemini suggestion: ${result.suggestions[0]}`
            );
        }
    }

    public stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.disposables.forEach(d => d.dispose());
    }

    public dispose(): void {
        this.stop();
    }
}
