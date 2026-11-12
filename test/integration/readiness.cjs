const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { createFixture, sha256, uriFor } = require('./fixture.cjs');
const { launchVSCode, stopOwnedProcess, waitForExit } = require('./vscodeProcess.cjs');
const { installProduction, installDriver, optionalJson } = require('./browserFixture.cjs');
const { connectTo, evaluate, click, waitFor: until } = require('./browserUi.cjs');

async function main() {
    const executable = process.env.VSCODE_EXECUTABLE_PATH;
    if (!executable) {
        throw new Error('Set VSCODE_EXECUTABLE_PATH to an existing VS Code executable for the real menu test.');
    }
    const repository = path.resolve(__dirname, '..', '..');
    const fixture = await createFixture(await mkdtemp(path.join(tmpdir(), 'alwf-readiness-')));
    const directory = fixture.directory;
    const profile = path.join(directory, 'profile');
    const extensions = path.join(directory, 'extensions');
    const driver = path.join(directory, 'driver');
    const statusFile = path.join(driver, 'status.json');
    await Promise.all([mkdir(path.join(profile, 'User'), { recursive: true }), mkdir(extensions), mkdir(driver)]);
    await installProduction(repository, extensions);
    await installDriver(path.join(__dirname, 'readinessDriver.ts'), driver, 'al-workspace-focus-readiness-driver', { appUri: fixture.control.focusAppUri });
    await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        'security.workspace.trust.startupPrompt': 'never'
    }) + '\n');
    let launched;
    let client;
    let passed = false;
    try {
        launched = launchVSCode(path.resolve(executable), [
            fixture.workspaceFile,
            `--user-data-dir=${profile}`,
            `--extensions-dir=${extensions}`,
            `--extensionDevelopmentPath=${driver}`,
            '--remote-debugging-port=0',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-updates',
            '--locale=en',
            '--new-window'
        ]);
        client = await connectTo(launched, profile);
        await client.call('Runtime.enable');
        const status = await until('the native trust or menu checkpoint', async () => {
            const current = await optionalJson(statusFile);
            if (current?.stage === 'failed') {
                throw new Error(current.message);
            }
            return current;
        });
        if (status.stage === 'trust-needed') {
            const trust = await until('the owned workspace Trust button', () => evaluate(client, `(() => {
                const button = [...document.querySelectorAll('.workspace-trust-editor button, .workspace-trust-editor .monaco-button')].find(item => item.textContent.trim() === 'Trust');
                if (!button) return null;
                const rectangle = button.getBoundingClientRect();
                return rectangle.width && rectangle.height ? { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 } : null;
            })()`));
            await click(client, trust);
        }
        const ready = await until('the menu-ready checkpoint', async () => {
            const current = await optionalJson(statusFile);
            if (current?.stage === 'failed') {
                throw new Error(current.message);
            }
            return current?.stage === 'menu-ready' ? current : null;
        });
        assert.equal(ready.nativeTrusted, true, 'Only a genuinely trusted owned fixture may report readiness.');
        await until('the acknowledged readiness notification', () => evaluate(client, `document.querySelector('.notifications-toasts')?.textContent.includes('AL Workspace Focus is ready. Open or reopen the app.json context menu')`));
        const manifest = await until('the revealed app.json Explorer item', () => evaluate(client, `(() => {
            const label = [...document.querySelectorAll('.explorer-folders-view .monaco-list-row .label-name')].find(item => item.textContent === 'app.json');
            if (!label) return null;
            const rectangle = label.getBoundingClientRect();
            return rectangle.width && rectangle.height ? { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 } : null;
        })()`));
        await click(client, manifest, 'right');
        const action = await until('the actual enabled Explorer Focus menu item', () => evaluate(client, `(() => {
            const label = [...document.querySelectorAll('.monaco-menu .action-label')].find(item => item.textContent.trim() === 'Focus on Apps...');
            if (!label) return null;
            return { label: label.textContent.trim(), disabled: !!label.closest('.disabled, [aria-disabled="true"]') };
        })()`));
        assert.equal(action.disabled, false, 'The actual Explorer menu item must be enabled.');
        const screenshot = process.env.ALWF_READINESS_SCREENSHOT;
        if (screenshot) {
            const capture = await client.call('Page.captureScreenshot', { format: 'png' });
            await writeFile(path.resolve(screenshot), Buffer.from(capture.data, 'base64'));
        }
        for (const file of fixture.sourceFiles) {
            const expected = fixture.control.sourceDigests.find(item => item.uri === uriFor(file));
            assert.ok(expected);
            assert.equal(sha256(await readFile(file)), expected.digest, 'Owned source inputs were changed by the UI check.');
        }
        console.log(JSON.stringify({ version: ready.hostVersion, actualExplorerMenuVisible: true, enabled: true, uiTrustKeySimulatedFalse: true, nativeTrusted: true, sourceHashesUnchanged: true }));
        await writeFile(path.join(driver, 'done.json'), '{}\n');
        const exited = await waitForExit(launched, 15000);
        assert.equal(exited.code, 0);
        passed = true;
    } catch (error) {
        if (client) {
            try {
                await writeFile(path.join(directory, 'ui-state.txt'), await evaluate(client, 'document.body.innerText'));
            } catch (diagnosticError) {
                throw new AggregateError([error, diagnosticError], 'The readiness check and its owned UI diagnostic failed.', { cause: diagnosticError });
            }
        }
        throw error;
    } finally {
        client?.close();
        await stopOwnedProcess(launched);
        if (passed) {
            await rm(directory, { recursive: true, force: true });
        } else {
            console.error(`Owned readiness artifacts retained: ${directory}`);
        }
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
