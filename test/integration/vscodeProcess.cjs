const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// Linux CI users cannot start Chromium's setuid or namespace sandbox; @vscode/test-electron passes the same flags.
const sandboxArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu-sandbox'] : [];

function launchVSCode(executable, args, { env = {}, mirrorOutput = false } = {}) {
    const child = spawn(executable, [...args, ...sandboxArgs, '--force-renderer-accessibility'], { env: { ...process.env, ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    let output = '';
    const state = { error: null, finished: false };
    function capture(bytes, stream) {
        output = (output + bytes.toString()).slice(-20000);
        if (mirrorOutput) {
            stream.write(bytes);
        }
    }
    child.stdout?.on('data', bytes => { capture(bytes, process.stdout); });
    child.stderr?.on('data', bytes => { capture(bytes, process.stderr); });
    const exited = new Promise(resolve => {
        child.once('error', error => {
            state.error = error;
            state.finished = true;
            resolve({ code: null, signal: null, error });
        });
        child.once('exit', (code, signal) => {
            state.finished = true;
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve({ code, signal, error: state.error });
        });
    });
    return { child, state, exited, output: () => output };
}

async function waitForExit(launched, milliseconds = 15000) {
    const timer = new globalThis.AbortController();
    try {
        return await Promise.race([
            launched.exited,
            delay(milliseconds, undefined, { signal: timer.signal }).then(() => { throw new Error(`The isolated VS Code process ${launched.child.pid} did not exit within ${milliseconds} ms.`); })
        ]);
    } finally {
        timer.abort();
    }
}

async function stopOwnedProcess(launched) {
    const child = launched?.child;
    if (!child || launched.state.finished || !Number.isSafeInteger(child.pid)) {
        return;
    }
    if (process.platform === 'win32') {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${child.pid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true, shell: false });
        if (result.error) {
            throw result.error;
        }
    } else {
        child.kill('SIGTERM');
    }
    await waitForExit(launched);
}

module.exports = { launchVSCode, waitForExit, stopOwnedProcess };
