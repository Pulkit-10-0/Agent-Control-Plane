const fs = require('fs');
const path = require('path');
const geminiClient = require('./geminiClient');

const ROOT = path.join(__dirname, '..', '..');
const TRACE_PATH = path.join(ROOT, 'traces', 'session_log', 'agent_trace.txt');
const SKILLS_DIR = path.join(ROOT, 'skills');
const STEPS = [
    'Design architecture',
    'Create backend',
    'Create frontend',
    'Integrate',
    'Debug',
    'Optimize',
    'Deploy'
];

function readSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        return '';
    }
}

function appendTrace(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    const previous = readSafe(TRACE_PATH);
    fs.mkdirSync(path.dirname(TRACE_PATH), { recursive: true });
    const tmpPath = `${TRACE_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, previous + line + '\n', 'utf8');
    fs.renameSync(tmpPath, TRACE_PATH);
    console.log(line);
}

function safeWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function parseInstructions(text) {
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    return lines.filter(line => /^\d+\.|^-|^•/.test(line.trim()));
}

function getSkill(step) {
    const text = (step || '').toLowerCase();
    let skillFile = 'architecture.md';

    if (text.includes('backend')) skillFile = 'backend.md';
    else if (text.includes('frontend')) skillFile = 'frontend.md';
    else if (text.includes('deploy')) skillFile = 'deployment.md';
    else if (text.includes('debug')) skillFile = 'debugging.md';
    else if (text.includes('optimize')) skillFile = 'performance.md';

    return readSafe(path.join(SKILLS_DIR, skillFile));
}

function parseAIResponse(response) {
    const parsed = [];
    const invalid = [];
    const lines = (response || '').split(/\r?\n/);

    let i = 0;
    while (i < lines.length) {
        const raw = lines[i] || '';
        const line = raw.trim();

        if (!line.startsWith('FILE:')) {
            i += 1;
            continue;
        }

        const filePath = line.slice(5).trim();
        if (!filePath) {
            invalid.push('Missing file path after FILE:');
            i += 1;
            continue;
        }

        i += 1;
        if (i >= lines.length || !lines[i].trim().startsWith('CODE:')) {
            invalid.push(`Missing CODE block for ${filePath}`);
            continue;
        }

        const codeLine = lines[i];
        let code = codeLine.replace(/^\s*CODE:\s?/, '');
        i += 1;

        const extra = [];
        while (i < lines.length && !lines[i].trim().startsWith('FILE:')) {
            extra.push(lines[i]);
            i += 1;
        }

        if (extra.length > 0) {
            code = [code, ...extra].join('\n');
        }

        if (!code.trim()) {
            invalid.push(`Empty CODE block for ${filePath}`);
            continue;
        }

        parsed.push({ name: filePath, content: code });
    }

    return { files: parsed, invalid };
}

async function buildAgentPrompt(step) {
    const skill = getSkill(step);
    const context = readSafe(path.join(ROOT, 'CONTEXT.md'));
    const instructions = readSafe(path.join(ROOT, 'instructions.md'));

    return [
        'You are a code generation agent.',
        '',
        'SKILL:',
        skill || '(no skill loaded)',
        '',
        'CONTEXT:',
        context,
        '',
        'INSTRUCTIONS:',
        instructions,
        '',
        `CURRENT STEP: ${step}`,
        '',
        'TASK: Generate code files needed for the current step only.',
        '',
        'Return ONLY in this strict format:',
        'FILE: path/to/file.js',
        'CODE:',
        'function example() { /* code */ }',
        '',
        'FILE: path/to/other.js',
        'CODE:',
        'const value = 42;',
        '',
        'Rules:',
        '- Do not include markdown fences',
        '- Do not include commentary',
        '- Every FILE must be followed by CODE',
        '- Use relative paths inside this project',
        '',
        'Generate minimal working changes only. Be concise.'
    ].join('\n');
}

async function runAgent() {
    try {
        appendTrace('AGENT_START: Reading instructions');

        const instructions = readSafe(path.join(ROOT, 'instructions.md'));
        if (!instructions) {
            appendTrace('AGENT_ERROR: instructions.md not found');
            return;
        }

        const parsedSteps = parseInstructions(instructions);
        appendTrace(`AGENT_PARSE: Found ${parsedSteps.length} instruction lines`);

        for (let s = 0; s < STEPS.length; s++) {
            const step = STEPS[s];
            appendTrace(`[STEP] ${step}`);

            try {
                const prompt = await buildAgentPrompt(step);
                appendTrace(`AGENT_AI_CALL: Sending to Gemini for step: ${step}`);

                const response = await new Promise((resolve) => {
                    geminiClient.sendPrompt(prompt).then(() => {
                        const output = readSafe(path.join(ROOT, 'GEMINI', 'src', 'output.md'));
                        resolve(output);
                    }).catch((err) => {
                        appendTrace(`AGENT_AI_ERROR: ${step} - ${err.message}`);
                        resolve('');
                    });
                });

                if (!response) {
                    appendTrace(`AGENT_WARN: Empty AI response for step: ${step}`);
                    await new Promise((resolve) => setTimeout(resolve, 700));
                    continue;
                }

                const parsed = parseAIResponse(response);

                if (parsed.invalid.length > 0) {
                    for (let x = 0; x < parsed.invalid.length; x++) {
                        appendTrace(`AGENT_PARSE_SKIP: ${parsed.invalid[x]}`);
                    }
                }

                if (parsed.files.length === 0) {
                    appendTrace(`AGENT_WARN: No valid FILE/CODE blocks parsed for step: ${step}`);
                    await new Promise((resolve) => setTimeout(resolve, 700));
                    continue;
                }

                for (let i = 0; i < parsed.files.length; i++) {
                    const file = parsed.files[i];
                    const filePath = path.resolve(ROOT, file.name);

                    try {
                        if (!file.name || !file.content || !file.content.trim()) {
                            appendTrace(`AGENT_PARSE_SKIP: Invalid file block at index ${i} for step: ${step}`);
                            continue;
                        }

                        const relativePath = path.relative(ROOT, filePath);
                        if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                            appendTrace(`AGENT_PARSE_SKIP: Unsafe path ${file.name} for step: ${step}`);
                            continue;
                        }

                        safeWrite(filePath, file.content);
                        appendTrace(`[STEP] Created ${path.basename(file.name)}`);
                        appendTrace(`[REASON] Based on instruction: ${step}`);
                    } catch (error) {
                        appendTrace(`AGENT_WRITE_ERROR: ${file.name} - ${error.message}`);
                    }
                }
            } catch (error) {
                appendTrace(`AGENT_STEP_ERROR: ${step} - ${error.message}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 700));
        }

        appendTrace('AGENT_SUCCESS: Step-based generation complete');
        appendTrace('AGENT_TRIGGER: Watcher will pick up agent_trace.txt update');
    } catch (error) {
        appendTrace(`AGENT_FATAL: ${error.message}`);
    }
}

if (require.main === module) {
    runAgent().catch((err) => {
        console.error('Fatal agent error:', err);
        process.exit(1);
    });
}

module.exports = { runAgent, parseAIResponse, getSkill };
