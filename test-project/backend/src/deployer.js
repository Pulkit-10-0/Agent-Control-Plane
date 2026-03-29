const { exec } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function runCommand(command, cwd = ROOT) {
    return new Promise((resolve) => {
        exec(command, { cwd }, (error, stdout, stderr) => {
            resolve({
                ok: !error,
                command,
                stdout: stdout || '',
                stderr: stderr || '',
                error: error ? error.message : null
            });
        });
    });
}

async function deployToVercel(projectDir = ROOT) {
    return runCommand('npx vercel --prod --yes', projectDir);
}

async function deployToGCP(projectDir = ROOT) {
    return runCommand('gcloud app deploy --quiet', projectDir);
}

if (require.main === module) {
    const target = (process.argv[2] || 'vercel').toLowerCase();
    (async () => {
        const result = target === 'gcp'
            ? await deployToGCP(ROOT)
            : await deployToVercel(ROOT);

        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
    })();
}

module.exports = { deployToVercel, deployToGCP };
