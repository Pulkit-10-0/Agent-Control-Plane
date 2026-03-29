const fs = require('fs');
const path = require('path');
const parser = require('./parser');
const geminiClient = require('./geminiClient');

const ROOT = path.join(__dirname, '..', '..');
const LOCK_PATH = path.join(ROOT, 'backend', '.watcher.run.lock');
const RUNTIME_LOG = path.join(ROOT, 'traces', 'session_log', 'watcher_runtime.log');

const WATCHED_FILES = [
    path.join(ROOT, 'traces', 'session_log', 'logs.txt'),
    path.join(ROOT, 'traces', 'session_log', 'agent_trace.txt'),
    path.join(ROOT, 'traces', 'history', 'history_log.txt'),
    path.join(ROOT, 'traces', 'performance', 'memory.txt'),
    path.join(ROOT, 'traces', 'performance', 'latency.txt')
];

let debounceTimer = null;
let isRunning = false;
let pendingRun = false;

function safeWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

function readSafe(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        return '';
    }
}

function logRuntime(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    const previous = readSafe(RUNTIME_LOG);
    safeWrite(RUNTIME_LOG, previous + line + '\n');
    console.log(line);
}

function ensureFile(filePath, initialContent = '') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
        safeWrite(filePath, initialContent);
    }
}

function ensureRequiredFiles() {
    WATCHED_FILES.forEach((filePath) => ensureFile(filePath, ''));
    ensureFile(path.join(ROOT, 'traces', 'summary', 'summary.md'), '# Session Summary\n');
    ensureFile(path.join(ROOT, 'GEMINI', 'src', 'output.md'), '# Gemini Analysis\n\nWaiting for first run...\n');
}

function acquireRunLock() {
    fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });

    const isProcessRunning = (pid) => {
        if (!pid || Number.isNaN(pid)) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return false;
        }
    };

    try {
        const fd = fs.openSync(LOCK_PATH, 'wx');
        fs.writeFileSync(fd, `${process.pid}`);
        fs.closeSync(fd);
        return true;
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            const existing = readSafe(LOCK_PATH).trim();
            const existingPid = parseInt(existing, 10);

            if (!isProcessRunning(existingPid)) {
                try {
                    fs.unlinkSync(LOCK_PATH);
                    const fd = fs.openSync(LOCK_PATH, 'wx');
                    fs.writeFileSync(fd, `${process.pid}`);
                    fs.closeSync(fd);
                    return true;
                } catch (retryError) {
                    return false;
                }
            }
        }
        return false;
    }
}

function releaseRunLock() {
    try {
        if (fs.existsSync(LOCK_PATH)) {
            fs.unlinkSync(LOCK_PATH);
        }
    } catch (error) {
        // no-op
    }
}

async function runPipeline(trigger) {
    if (isRunning) {
        pendingRun = true;
        logRuntime(`Run already in progress; queued next run (trigger: ${trigger}).`);
        return;
    }

    isRunning = true;
    try {
        logRuntime(`Pipeline start (trigger: ${trigger}).`);
        const prompt = await parser.buildPrompt();
        await geminiClient.sendPrompt(prompt);
        logRuntime('Pipeline success: output.md updated.');
    } catch (error) {
        logRuntime(`Pipeline error: ${error.message || String(error)}`);
    } finally {
        isRunning = false;
        if (pendingRun) {
            pendingRun = false;
            scheduleRun('pending');
        }
    }
}

function scheduleRun(trigger) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        runPipeline(trigger).catch(() => { });
    }, 1000);
}

function startWatching() {
    ensureRequiredFiles();

    if (!acquireRunLock()) {
        console.error('Watcher is already running (lock exists).');
        process.exit(1);
    }

    process.on('SIGINT', () => {
        logRuntime('Received SIGINT; shutting down watcher.');
        releaseRunLock();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        logRuntime('Received SIGTERM; shutting down watcher.');
        releaseRunLock();
        process.exit(0);
    });
    process.on('exit', () => {
        releaseRunLock();
    });

    WATCHED_FILES.forEach((filePath) => {
        fs.watch(filePath, () => {
            scheduleRun(path.basename(filePath));
        });
    });

    logRuntime('Watcher started. Monitoring session, history, and performance files.');
    scheduleRun('startup');
}

if (require.main === module) {
    try {
        startWatching();
    } catch (error) {
        console.error('Fatal watcher error:', error.message || String(error));
        process.exit(1);
    }
}

module.exports = { startWatching, scheduleRun };
