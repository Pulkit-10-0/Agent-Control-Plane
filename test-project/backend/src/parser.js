const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LOG_LINES = 300;
const TRACE_LINES = 200;
const HISTORY_LINES = 200;

function readSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        return '';
    }
}

function tailLines(text, count) {
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

async function buildPrompt() {
    try {
        const files = {
            context: path.join(ROOT, 'CONTEXT.md'),
            prompt: path.join(ROOT, 'GEMINI', 'src', 'prompt.md'),
            rules: path.join(ROOT, 'GEMINI', 'src', 'ground_rules.md'),
            logs: path.join(ROOT, 'traces', 'session_log', 'logs.txt'),
            trace: path.join(ROOT, 'traces', 'session_log', 'agent_trace.txt'),
            history: path.join(ROOT, 'traces', 'history', 'history_log.txt'),
            memory: path.join(ROOT, 'traces', 'performance', 'memory.txt'),
            latency: path.join(ROOT, 'traces', 'performance', 'latency.txt'),
            summary: path.join(ROOT, 'traces', 'summary', 'summary.md')
        };

        const context = readSafe(files.context);
        const template = readSafe(files.prompt);
        const rules = readSafe(files.rules);
        const logs = tailLines(readSafe(files.logs), LOG_LINES);
        const trace = tailLines(readSafe(files.trace), TRACE_LINES);
        const history = tailLines(readSafe(files.history), HISTORY_LINES);
        const memory = readSafe(files.memory);
        const latency = readSafe(files.latency);
        const summary = readSafe(files.summary);

        const performance = [
            'Memory Metrics:',
            memory || '(no memory metrics)',
            '',
            'Latency Metrics:',
            latency || '(no latency metrics)'
        ].join('\n');

        const fallbackTemplate = [
            'You are analyzing a coding session.',
            '',
            '## CONTEXT',
            '{{CONTEXT}}',
            '',
            '## LOGS',
            '{{LOGS}}',
            '',
            '## AGENT TRACE',
            '{{TRACE}}',
            '',
            '## PERFORMANCE',
            '{{PERFORMANCE}}',
            '',
            '## HISTORY',
            '{{HISTORY}}',
            '',
            '## SUMMARY',
            '{{SUMMARY}}',
            '',
            '## RULES',
            '{{RULES}}'
        ].join('\n');

        let prompt = (template || fallbackTemplate)
            .replace(/{{\s*CONTEXT\s*}}/g, context)
            .replace(/{{\s*LOGS\s*}}/g, logs)
            .replace(/{{\s*TRACE\s*}}/g, trace)
            .replace(/{{\s*PERFORMANCE\s*}}/g, performance)
            .replace(/{{\s*HISTORY\s*}}/g, history)
            .replace(/{{\s*SUMMARY\s*}}/g, summary)
            .replace(/{{\s*RULES\s*}}/g, rules);

        if (!/## PERFORMANCE/.test(prompt)) {
            prompt += `\n\n## PERFORMANCE\n${performance}`;
        }
        if (!/## HISTORY/.test(prompt)) {
            prompt += `\n\n## HISTORY\n${history}`;
        }
        if (!/## SUMMARY/.test(prompt)) {
            prompt += `\n\n## SUMMARY\n${summary}`;
        }

        if (!prompt || prompt.length === 0) {
            throw new Error('Built prompt is empty; check CONTEXT.md and template files exist');
        }

        return prompt;
    } catch (error) {
        throw error;
    }
}

module.exports = { buildPrompt };
