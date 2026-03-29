/**
 * TraceAdvisorParticipant - GitHub Copilot Chat Participant
 *
 * Commands:
 * - @ACP connect - Scan and connect frontend/backend
 * - @ACP trace/status - Show trace status
 * - @ACP skills - Show available skills
 * - @ACP docs - Show project documentation
 * - @ACP <anything> - Pass to Copilot
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let traceInjectionEnabled: boolean = true;
let statusBarItem: vscode.StatusBarItem;

// ========================================================================
// HELPERS
// ========================================================================

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return '';
    return folders[0].uri.fsPath;
}

function logAcpCommand(root: string, command: string, details: any): void {
    const sessionLogDir = path.join(root, 'traces', 'session_log');
    if (!fs.existsSync(sessionLogDir)) {
        fs.mkdirSync(sessionLogDir, { recursive: true });
    }

    const files = fs.readdirSync(sessionLogDir).filter(f => f.endsWith('.json')).sort();
    let stepCount = 0;
    if (files.length > 0) {
        const match = files[files.length - 1].match(/^(\d+)_/);
        if (match) stepCount = parseInt(match[1], 10);
    }
    stepCount++;

    const timestamp = new Date().toISOString();
    const entry = {
        step: stepCount,
        timestamp,
        source: 'acp-command',
        command,
        file: '@ACP chat',
        line: 0,
        added: JSON.stringify(details).substring(0, 300),
        removed: ''
    };

    const filename = `${stepCount}_${timestamp.replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(path.join(sessionLogDir, filename), JSON.stringify(entry, null, 2));
}

// ========================================================================
// SKILLS HANDLER
// ========================================================================

async function handleSkills(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const root = getWorkspaceRoot();
    if (root) logAcpCommand(root, 'skills', { action: 'listing skills' });

    stream.markdown("## 🎯 Available Skills\n\n");
    await delay(200);

    const skillsDir = path.join(root, 'skills');
    const geminiDir = path.join(root, 'GEMINI', 'src');

    // Check skills folder
    if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));

        if (skillFiles.length > 0) {
            stream.markdown("### 📚 Skill Files\n\n");

            for (const file of skillFiles) {
                const skillPath = path.join(skillsDir, file);
                const content = fs.readFileSync(skillPath, 'utf-8');
                const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
                const name = file.replace('.md', '');

                stream.markdown(`**${name}**\n`);
                stream.markdown(`> ${firstLine || 'No description'}\n\n`);

                // Show preview of skill
                const preview = content.substring(0, 200).replace(/\n/g, ' ').trim();
                stream.markdown(`\`\`\`\n${preview}...\n\`\`\`\n\n`);
                await delay(100);
            }
        }
    }

    // Check GEMINI prompts
    if (fs.existsSync(geminiDir)) {
        const geminiFiles = fs.readdirSync(geminiDir).filter(f => f.endsWith('.md'));

        if (geminiFiles.length > 0) {
            stream.markdown("### 🤖 GEMINI Prompts\n\n");

            for (const file of geminiFiles) {
                const promptPath = path.join(geminiDir, file);
                const content = fs.readFileSync(promptPath, 'utf-8');
                const name = file.replace('.md', '');

                stream.markdown(`- **${name}**: ${content.split('\n')[0].substring(0, 60)}...\n`);
            }
            stream.markdown('\n');
        }
    }

    // Show how to use
    stream.markdown("### 💡 Usage\n\n");
    stream.markdown("Skills are loaded automatically when relevant. You can also ask:\n\n");
    stream.markdown("- `@ACP use backend skill` - Apply backend best practices\n");
    stream.markdown("- `@ACP use debugging skill` - Debug current issue\n");
    stream.markdown("- `@ACP use performance skill` - Optimize performance\n");

    return { metadata: { command: 'skills' } };
}

// ========================================================================
// DOCS HANDLER
// ========================================================================

async function handleDocs(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const root = getWorkspaceRoot();
    if (root) logAcpCommand(root, 'docs', { action: 'showing docs' });

    stream.markdown("## 📄 Project Documentation\n\n");
    await delay(200);

    const docFiles = ['CONTEXT.md', 'instructions.md', 'architecture.md', 'CHANGELOG.md'];

    for (const docFile of docFiles) {
        const docPath = path.join(root, docFile);
        if (fs.existsSync(docPath)) {
            const content = fs.readFileSync(docPath, 'utf-8');
            const lines = content.split('\n');
            const title = lines[0].replace(/^#\s*/, '').trim() || docFile;

            stream.markdown(`### ${title}\n\n`);

            // Show first 10 lines or 500 chars
            const preview = lines.slice(0, 15).join('\n').substring(0, 500);
            stream.markdown(`\`\`\`markdown\n${preview}\n...\n\`\`\`\n\n`);
            await delay(100);
        }
    }

    // Show recent changes from CHANGELOG
    const changelogPath = path.join(root, 'CHANGELOG.md');
    if (fs.existsSync(changelogPath)) {
        const content = fs.readFileSync(changelogPath, 'utf-8');
        const steps = content.match(/### Step \d+/g) || [];

        stream.markdown(`### 📊 Session Activity\n\n`);
        stream.markdown(`- **Total steps logged:** ${steps.length}\n`);

        // Show last 3 steps
        const lastSteps = content.split('### Step').slice(-4).slice(1);
        if (lastSteps.length > 0) {
            stream.markdown("\n**Recent changes:**\n");
            for (const step of lastSteps) {
                const fileMatch = step.match(/File: (.+)/);
                const lineMatch = step.match(/Line: (\d+)/);
                if (fileMatch) {
                    stream.markdown(`- ${fileMatch[1]} (line ${lineMatch?.[1] || '?'})\n`);
                }
            }
        }
    }

    return { metadata: { command: 'docs' } };
}

// ========================================================================
// TRACE HANDLER
// ========================================================================

async function handleTraces(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const root = getWorkspaceRoot();
    if (root) logAcpCommand(root, 'trace-status', { action: 'viewing traces' });

    stream.markdown("## 📊 Trace Status\n\n");
    await delay(200);

    const sessionLogDir = path.join(root, 'traces', 'session_log');

    if (!fs.existsSync(sessionLogDir)) {
        stream.markdown("No traces found. Start editing files to generate traces.\n");
        return { metadata: { command: 'traces', count: 0 } };
    }

    const files = fs.readdirSync(sessionLogDir).filter(f => f.endsWith('.json')).sort();

    stream.markdown(`| Metric | Value |\n`);
    stream.markdown(`|--------|-------|\n`);
    stream.markdown(`| Total steps | ${files.length} |\n`);
    stream.markdown(`| Session log dir | traces/session_log/ |\n\n`);

    await delay(200);

    // Show recent entries
    if (files.length > 0) {
        stream.markdown("### Recent Changes\n\n");

        const recentFiles = files.slice(-5);
        for (const file of recentFiles) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(sessionLogDir, file), 'utf-8'));
                stream.markdown(`**Step ${content.step}** - \`${content.file}\`\n`);
                stream.markdown(`- Line: ${content.line}\n`);
                stream.markdown(`- Source: ${content.source}\n`);
                stream.markdown(`- Time: ${content.timestamp}\n\n`);
            } catch (e) {
                // Skip invalid files
            }
        }
    }

    // Check for ACP commands in traces
    const acpCommands = files.filter(f => {
        try {
            const content = JSON.parse(fs.readFileSync(path.join(sessionLogDir, f), 'utf-8'));
            return content.source === 'acp-command';
        } catch { return false; }
    });

    if (acpCommands.length > 0) {
        stream.markdown(`### ACP Commands Used: ${acpCommands.length}\n\n`);
    }

    return { metadata: { command: 'traces', count: files.length } };
}

// ========================================================================
// CONNECT HANDLER
// ========================================================================

async function handleConnect(
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    const root = getWorkspaceRoot();
    if (!root) {
        stream.markdown("No workspace open. Please open a folder first.");
        return { metadata: { command: 'connect' } };
    }

    logAcpCommand(root, 'connect', { action: 'scanning workspace' });

    stream.markdown("## 🔗 Connecting Frontend & Backend\n\n");
    await delay(300);

    stream.markdown("⏳ Scanning workspace...\n\n");
    await delay(400);

    // Find all source files
    const sourceFiles: string[] = [];
    const frontendCalls: { file: string; url: string; method: string }[] = [];
    const backendRoutes: { file: string; path: string; method: string }[] = [];

    function scan(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && !['node_modules', '.git', 'traces', 'out', 'dist'].includes(entry.name)) {
                scan(fullPath);
            } else if (entry.isFile() && /\.(js|ts|jsx|tsx)$/.test(entry.name)) {
                sourceFiles.push(fullPath);
            }
        }
    }
    scan(root);

    // Analyze files
    for (const file of sourceFiles) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            const relPath = path.relative(root, file);

            // Find fetch calls
            const fetchMatches = content.matchAll(/fetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g);
            for (const match of fetchMatches) {
                frontendCalls.push({ file: relPath, url: match[1], method: 'GET' });
            }

            // Find axios calls
            const axiosMatches = content.matchAll(/axios\.(get|post|put|delete)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi);
            for (const match of axiosMatches) {
                frontendCalls.push({ file: relPath, url: match[2], method: match[1].toUpperCase() });
            }

            // Find Express routes
            const routeMatches = content.matchAll(/(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi);
            for (const match of routeMatches) {
                backendRoutes.push({ file: relPath, path: match[2], method: match[1].toUpperCase() });
            }
        } catch (e) {
            // Skip unreadable files
        }
    }

    await delay(300);

    // Show results
    stream.markdown(`### 📊 Analysis Results\n\n`);
    stream.markdown(`| Category | Count |\n`);
    stream.markdown(`|----------|-------|\n`);
    stream.markdown(`| Source files | ${sourceFiles.length} |\n`);
    stream.markdown(`| Frontend API calls | ${frontendCalls.length} |\n`);
    stream.markdown(`| Backend routes | ${backendRoutes.length} |\n\n`);

    if (frontendCalls.length > 0) {
        stream.markdown("### 📤 Frontend Calls\n\n");
        for (const call of frontendCalls.slice(0, 5)) {
            stream.markdown(`- \`${call.method} ${call.url}\` in \`${call.file}\`\n`);
        }
        stream.markdown('\n');
    }

    if (backendRoutes.length > 0) {
        stream.markdown("### 📥 Backend Routes\n\n");
        for (const route of backendRoutes.slice(0, 5)) {
            stream.markdown(`- \`${route.method} ${route.path}\` in \`${route.file}\`\n`);
        }
        stream.markdown('\n');
    }

    // Find mismatches and generate fixes
    const missingRoutes = frontendCalls.filter(call => {
        const callPath = call.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{.*?\}/, '');
        return !backendRoutes.some(r => r.path === callPath && r.method === call.method);
    });

    if (missingRoutes.length > 0) {
        stream.markdown("### ⚠️ Missing Routes\n\n");
        await delay(300);

        for (const missing of missingRoutes.slice(0, 3)) {
            const routePath = missing.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{.*?\}/, '') || '/api/endpoint';
            const routeName = routePath.split('/').filter(Boolean).pop() || 'data';

            stream.markdown(`---\n\n**Missing:** \`${missing.method} ${routePath}\`\n\n`);

            // Generate working backend code
            let backendCode = '';
            if (routePath.includes('product')) {
                backendCode = `app.${missing.method.toLowerCase()}('${routePath}', (req, res) => {
    const products = [
        { id: 1, name: 'Product A', price: 29.99, stock: 100 },
        { id: 2, name: 'Product B', price: 49.99, stock: 50 }
    ];
    res.json({ success: true, data: products });
});`;
            } else if (routePath.includes('cart')) {
                backendCode = `app.${missing.method.toLowerCase()}('${routePath}', (req, res) => {
    const cart = { items: [], total: 0 };
    res.json({ success: true, data: cart });
});`;
            } else if (routePath.includes('order') || routePath.includes('checkout')) {
                backendCode = `app.${missing.method.toLowerCase()}('${routePath}', (req, res) => {
    const order = {
        id: Date.now(),
        items: req.body?.items || [],
        total: req.body?.total || 0,
        status: 'confirmed'
    };
    res.status(201).json({ success: true, data: order });
});`;
            } else {
                backendCode = `app.${missing.method.toLowerCase()}('${routePath}', (req, res) => {
    const ${routeName} = { id: 1, name: '${routeName}', timestamp: new Date().toISOString() };
    res.json({ success: true, data: ${routeName} });
});`;
            }

            stream.markdown("**Add to backend:**\n\n");
            stream.markdown("```javascript\n" + backendCode + "\n```\n\n");
            await delay(200);
        }
    } else if (frontendCalls.length > 0 && backendRoutes.length > 0) {
        stream.markdown("### ✅ All routes matched!\n\n");
    }

    return { metadata: { command: 'connect', mismatches: missingRoutes.length } };
}

// ========================================================================
// GENERAL HANDLER
// ========================================================================

async function handleGeneral(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {
    // Pass through directly to Copilot
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
        stream.markdown('No Copilot model available.');
        return { metadata: { tracesUsed: false } };
    }

    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User(request.prompt)];

    try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            stream.markdown(chunk);
        }
    } catch (err) {
        stream.markdown(`Error: ${err}`);
    }

    return { metadata: { tracesUsed: false } };
}

// ========================================================================
// EXPORTS
// ========================================================================

export function isTraceInjectionEnabled(): boolean {
    return traceInjectionEnabled;
}

export function toggleTraceInjection(): boolean {
    traceInjectionEnabled = !traceInjectionEnabled;
    updateStatusBarItem();
    return traceInjectionEnabled;
}

export function initializeStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'agent-control-plane.toggleTraceInjection';
    updateStatusBarItem();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    return statusBarItem;
}

function updateStatusBarItem(): void {
    if (!statusBarItem) return;

    if (traceInjectionEnabled) {
        statusBarItem.text = '$(debug-start) ACP Traces: ON';
        statusBarItem.tooltip = 'Click to disable';
    } else {
        statusBarItem.text = '$(debug-pause) ACP Traces: OFF';
        statusBarItem.tooltip = 'Click to enable';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

/**
 * Main chat request handler - routes to appropriate handler
 */
export async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> {

    if (!traceInjectionEnabled) {
        return handleGeneral(request, stream, token);
    }

    const msg = request.prompt.toLowerCase().trim();

    // Route based on keywords
    if (msg.includes('connect')) {
        return handleConnect(stream, token);
    }

    if (msg.includes('skill')) {
        return handleSkills(stream, token);
    }

    if (msg.includes('doc') || msg.includes('context') || msg.includes('instruction')) {
        return handleDocs(stream, token);
    }

    if (msg.includes('trace') || msg.includes('status') || msg.includes('log')) {
        return handleTraces(stream, token);
    }

    // Default - pass to Copilot
    return handleGeneral(request, stream, token);
}
