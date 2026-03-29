const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function safeWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function detectArchitecture(rawPrompt) {
    const text = (rawPrompt || '').toLowerCase();
    const frontend = text.includes('dashboard') ? 'React frontend' : 'Generic frontend';
    const backend = text.includes('api') ? 'Node.js API backend' : 'Optional backend';
    const deployment = text.includes('static site') ? 'Vercel-ready static deployment' : 'App deployment (Vercel or GCP)';

    return { frontend, backend, deployment };
}

function buildContext(rawPrompt, arch) {
    return [
        '# CONTEXT',
        '',
        `Idea: ${rawPrompt}`,
        `Created: ${new Date().toISOString()}`,
        '',
        '## Detected Architecture',
        `- Frontend: ${arch.frontend}`,
        `- Backend: ${arch.backend}`,
        `- Deployment: ${arch.deployment}`,
        '',
        '## Active Modules',
        '- inputProcessor.js',
        '- watcher.js',
        '- parser.js',
        '- geminiClient.js',
        '- deployer.js'
    ].join('\n');
}

function buildInstructions(rawPrompt, arch) {
    return [
        '# INSTRUCTIONS',
        '',
        `Goal: Build from idea -> "${rawPrompt}"`,
        '',
        '1. Generate project files from inputProcessor',
        '2. Implement architecture plan in codebase',
        '3. Capture runtime logs into traces/session_log/logs.txt',
        '4. Capture agent actions into traces/session_log/agent_trace.txt',
        '5. Run watcher to trigger parser + Gemini analysis',
        '6. Iterate until output.md has stable fixes',
        '',
        '## Architecture Targets',
        `- Frontend: ${arch.frontend}`,
        `- Backend: ${arch.backend}`,
        `- Deployment: ${arch.deployment}`,
        '',
        '## Commands',
        '- node backend/src/watcher.js',
        '- node backend/src/deployer.js vercel',
        '- node backend/src/deployer.js gcp'
    ].join('\n');
}

function buildArchitecture(rawPrompt, arch) {
    return [
        '# ARCHITECTURE',
        '',
        `Project Idea: ${rawPrompt}`,
        '',
        '## Components',
        `- Frontend Layer: ${arch.frontend}`,
        `- Backend Layer: ${arch.backend}`,
        '- Trace Layer: /traces (session, history, performance, summary)',
        '- Analysis Layer: parser.js + geminiClient.js',
        '- Deploy Layer: deployer.js',
        '',
        '## Data Flow',
        'inputProcessor -> root files -> watcher -> parser -> geminiClient -> GEMINI/src/output.md',
        '',
        '## Deployment',
        `- Preferred: ${arch.deployment}`,
        '- Optional alternatives: Vercel / GCP'
    ].join('\n');
}

function processInput(rawPrompt) {
    const idea = (rawPrompt || '').trim() || 'Build a project from this idea';
    const arch = detectArchitecture(idea);

    const context = buildContext(idea, arch);
    const instructions = buildInstructions(idea, arch);
    const architecture = buildArchitecture(idea, arch);

    safeWrite(path.join(ROOT, 'CONTEXT.md'), context);
    safeWrite(path.join(ROOT, 'instructions.md'), instructions);
    safeWrite(path.join(ROOT, 'architecture.md'), architecture);

    return {
        written: ['CONTEXT.md', 'instructions.md', 'architecture.md'],
        architecture: arch
    };
}

if (require.main === module) {
    const rawPrompt = process.argv.slice(2).join(' ') || 'Build a vendor management system';
    const result = processInput(rawPrompt);
    console.log(JSON.stringify(result, null, 2));
}

module.exports = { processInput, detectArchitecture };
