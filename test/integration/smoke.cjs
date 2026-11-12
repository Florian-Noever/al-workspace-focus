const { mkdir, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');

const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const { prepare } = require('./prepareSmoke.cjs');
const { launchVSCode, waitForExit, stopOwnedProcess } = require('./vscodeProcess.cjs');
const { installProduction, optionalJson } = require('./browserFixture.cjs');
const { connectTo, grantFixtureTrust } = require('./browserUi.cjs');

async function main() {
    const repository = path.resolve(__dirname, '..', '..');
    const versionIndex = process.argv.indexOf('--version');
    const version = versionIndex === -1 ? 'stable' : process.argv[versionIndex + 1];
    if (!version) {
        throw new Error('--version needs a version.');
    }
    const executable = process.env.VSCODE_EXECUTABLE_PATH ? path.resolve(process.env.VSCODE_EXECUTABLE_PATH) : await downloadAndUnzipVSCode({ version, cachePath: process.env.ALWF_VSCODE_CACHE_PATH });
    const fixture = await prepare({ kind: process.argv.includes('--folder') ? 'folder' : 'workspace' });
    const profile = path.join(fixture.directory, 'profile');
    const extensions = path.join(fixture.directory, 'extensions');
    await mkdir(path.join(profile, 'User'), { recursive: true });
    await mkdir(extensions);
    await installProduction(repository, extensions);
    await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'security.workspace.trust.startupPrompt': 'never',
        'extensions.ignoreRecommendations': true
    }, null, 4) + '\n');
    const launch = target => launchVSCode(executable, [target, `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${fixture.driver}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--locale=en', '--new-window', ...process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []]);
    let launched = launch(fixture.original);
    let passed = false;
    let recorded;
    let client;
    try {
        client = await connectTo(launched, profile);
        const timeout = Number(process.env.ALWF_SMOKE_TIMEOUT_MS ?? 240000);
        if (!Number.isFinite(timeout) || timeout <= 0) {
            throw new Error('ALWF_SMOKE_TIMEOUT_MS must be positive.');
        }
        const deadline = Date.now() + timeout;
        let lastState = '';
        while (Date.now() < deadline) {
            const control = await optionalJson(fixture.controlFile);
            if (!control) {
                await delay(100);
                continue;
            }
            recorded = control;
            const state = `${control.phase}:${control.status}`;
            if (state !== lastState) {
                console.log(`Smoke ${state}${control.message ? `: ${control.message}` : ''}`);
                lastState = state;
            }
            if (control.status === 'failed') {
                throw new Error(control.message ?? 'The real-host smoke driver failed.');
            }
            if (control.status === 'awaiting-trust') {
                await grantFixtureTrust(client);
            } else if (control.status === 'awaiting-restart') {
                await waitForExit(launched);
                client.close();
                if (!control.cacheUri || !control.cacheUri.startsWith('file:')) {
                    throw new Error('The local process controller requires a recorded local cache URI. Remote journeys need their remote external controller.');
                }
                await writeFile(fixture.controlFile, JSON.stringify({ ...control, status: 'running' }, null, 4) + '\n');
                await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
                launched = launch(fileURLToPath(control.cacheUri));
                client = await connectTo(launched, profile);
            } else if (control.status === 'passed') {
                await waitForExit(launched);
                if (version !== 'stable' && control.hostVersion !== version) {
                    throw new Error(`Expected VS Code ${version}, but the smoke host reports ${control.hostVersion}.`);
                }
                console.log(JSON.stringify({ version: control.hostVersion, remoteName: control.remoteName, originKind: control.originKind, journeys: control.journeys, cacheUri: control.cacheUri, isolatedProfile: true }));
                passed = true;
                break;
            } else if (launched.state.finished) {
                throw new Error(`The owned VS Code process exited before completing the journey. ${launched.output()}`);
            }
            await delay(250);
        }
        if (!passed) {
            throw new Error(`Smoke timed out at ${recorded?.phase ?? 'startup'}:${recorded?.status ?? 'unknown'}. Native trust prompts must be answered for the owned fixture; this is not a passing result. ${launched.output()}`);
        }
    } finally {
        client?.close();
        await stopOwnedProcess(launched);
        if (passed && process.env.ALWF_KEEP_TEST_ARTIFACTS !== '1') {
            await rm(fixture.directory, { recursive: true, force: true });
        } else {
            console.log(`Smoke artifacts retained: ${fixture.directory}`);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
