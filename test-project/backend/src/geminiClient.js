const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env.local') });

const ROOT = path.join(__dirname, '..', '..');

if (!global.fetch) {
    try {
        global.fetch = require('node-fetch');
    } catch (e) {
        console.error('node-fetch not available; fetch calls will fail on Node < 18');
    }
}
const OUTPUT_PATH = path.join(ROOT, 'GEMINI', 'src', 'output.md');
const MAX_PROMPT_CHARS = 200000;

function safeWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function buildGeminiUrl() {
    if (process.env.GEMINI_API_URL) return process.env.GEMINI_API_URL;
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function extractText(responseJson) {
    if (responseJson && responseJson.candidates && responseJson.candidates[0] && responseJson.candidates[0].content && responseJson.candidates[0].content.parts && responseJson.candidates[0].content.parts[0] && responseJson.candidates[0].content.parts[0].text) {
        return responseJson.candidates[0].content.parts[0].text;
    }
    return JSON.stringify(responseJson, null, 2);
}

function localFallback(prompt, note) {
    const lines = prompt.split(/\r?\n/);
    const hasError = lines.some((line) => /error|exception|traceback/i.test(line));
    const issue = hasError ? 'Error-like entries detected in logs/trace.' : 'No clear error markers found.';
    const root = hasError ? 'Likely runtime or integration failure in recent changes.' : 'Insufficient error details in current inputs.';
    const fix = hasError ? 'Check latest stack trace and touched files, then reproduce with minimal steps.' : 'Add explicit error logs and rerun.';

    return [
        '# Gemini Analysis',
        '',
        `Updated: ${new Date().toISOString()}`,
        '',
        note || 'Local fallback analysis was used.',
        '',
        '### ISSUE',
        issue,
        '',
        '### ROOT CAUSE',
        root,
        '',
        '### FIX',
        fix,
        '',
        '### BETTER APPROACH',
        'Split generation, debugging, and deployment tasks into small deterministic steps.',
        '',
        '### PERFORMANCE INSIGHT',
        'Use line limits and batch updates to reduce prompt size and trigger frequency.',
        '',
        '### PATTERN DETECTED',
        hasError ? 'Repeated error-like keywords found in session files.' : 'No stable error pattern detected.',
        '',
        '### FILE CHANGES',
        '- Validate latest edited files and add guard checks around failing paths.',
        '',
        '### CONFIDENCE',
        hasError ? 'Medium' : 'Low'
    ].join('\n');
}

async function sendPrompt(rawPrompt) {
    const prompt = (rawPrompt || '').slice(0, MAX_PROMPT_CHARS);
    const apiKey = process.env.GEMINI_API_KEY;
    const baseUrl = buildGeminiUrl();

    if (!apiKey) {
        safeWrite(OUTPUT_PATH, localFallback(prompt, 'GEMINI_API_KEY is not set.'));
        return;
    }

    try {
        const url = baseUrl.includes('?') ? `${baseUrl}&key=${apiKey}` : `${baseUrl}?key=${apiKey}`;
        const body = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 2048
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            safeWrite(OUTPUT_PATH, localFallback(prompt, `Gemini request failed: ${response.status} ${errText}`));
            return;
        }

        const json = await response.json();
        const text = extractText(json);
        const finalContent = [
            '# Gemini Analysis',
            '',
            `Updated: ${new Date().toISOString()}`,
            '',
            text
        ].join('\n');
        safeWrite(OUTPUT_PATH, finalContent);
    } catch (error) {
        safeWrite(OUTPUT_PATH, localFallback(prompt, `Gemini call error: ${error.message || String(error)}`));
    }
}

module.exports = { sendPrompt };
