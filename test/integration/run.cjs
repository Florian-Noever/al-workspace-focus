const { spawnSync } = require('node:child_process');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
const { createFixture, sha256, uriFor } = require('./fixture.cjs');
const { fileUri, installProduction, installDriver, optionalJson } = require('./browserFixture.cjs');
const { launchVSCode, waitForExit, stopOwnedProcess } = require('./vscodeProcess.cjs');

async function main() {
    if (process.platform === 'linux' && !process.env.DISPLAY && process.env.ALWF_XVFB !== '1') {
        const result = spawnSync('xvfb-run', ['-a', process.execPath, path.join(__dirname, 'run.cjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ALWF_XVFB: '1' } });
        if (result.error) {
            throw result.error;
        }
        process.exitCode = result.status ?? 1;
        return;
    }
    const repository = path.resolve(__dirname, '..', '..');
    const index = process.argv.indexOf('--version');
    const version = index < 0 ? 'stable' : process.argv[index + 1];
    if (!version) {
        throw new Error('--version needs a value');
    }
    const fixture = await createFixture(await mkdtemp(path.join(tmpdir(), 'alwf-integration-spaces & paths-')));
    const profile = path.join(fixture.directory, 'profile');
    const extensions = path.join(fixture.directory, 'extensions');
    const resultFile = path.join(fixture.directory, 'activation-result.json');
    await mkdir(path.join(profile, 'User'), { recursive: true });
    await mkdir(extensions);
    await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
        'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'extensions.ignoreRecommendations': true,
        'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none',
        'security.workspace.trust.startupPrompt': 'never'
    }) + '\n');
    await installProduction(repository, extensions);
    await installDriver(path.join(__dirname, 'activation.test.ts'), path.join(extensions, 'owned-activation-driver'), 'al-workspace-focus-activation-driver', {
        originUri: fixture.control.originUri, sourceDigests: fixture.control.sourceDigests,
        expectedVersion: version === 'stable' ? '' : version, resultUri: fileUri(resultFile)
    });
    const executable = process.env.VSCODE_EXECUTABLE_PATH ?? await downloadAndUnzipVSCode({ version, cachePath: process.env.ALWF_VSCODE_CACHE_PATH });
    let launched;
    let passed = false;
    try {
        const args = [fixture.workspaceFile, `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, '--skip-welcome', '--skip-release-notes', '--disable-updates', '--new-window'];
        if (process.platform === 'linux' && process.getuid?.() === 0) {
            args.push('--no-sandbox');
        }
        launched = launchVSCode(executable, args);
        const deadline = Date.now() + 120000;
        let result;
        while (Date.now() < deadline) {
            result = await optionalJson(resultFile);
            if (result) {
                break;
            }
            if (launched.state.finished) {
                throw new Error(`The owned browser test host exited early. ${launched.output()}`);
            }
            await delay(100);
        }
        if (!result?.passed) {
            throw new Error(`Browser activation failed: ${result?.message ?? 'timeout'}. ${launched.output()}`);
        }
        await waitForExit(launched);
        for (const file of fixture.sourceFiles) {
            const entry = fixture.control.sourceDigests.find(item => item.uri === uriFor(file));
            if (!entry || sha256(await readFile(file)) !== entry.digest) {
                throw new Error('The owned source fixture changed');
            }
        }
        console.log(JSON.stringify({ ...result, isolatedProfile: true }));
        passed = true;
    } finally {
        await stopOwnedProcess(launched);
        if (passed && process.env.ALWF_KEEP_TEST_ARTIFACTS !== '1') {
            await rm(fixture.directory, { recursive: true, force: true });
        } else {
            console.error(`Owned activation artifacts retained: ${fixture.directory}`);
        }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
