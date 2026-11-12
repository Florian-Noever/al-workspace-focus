import * as vscode from 'vscode';

import { digest, containsUri } from '../../src/host/browserHost';
import { FocusCache } from '../../src/services/focusCache';
import { filesystemHost, WorkspaceUris } from '../../src/services/workspaceOrigin';
import { isRecord } from '../../src/shared/focusTypes';
import { BROWSER_CACHE_DIRECTORY } from '../../src/shared/settings';
import { parseControl } from './smokeControl';
import { assert, equal } from './assert';

import type { ActiveFocus } from '../../src/shared/focusTypes';
import type { SmokeControl } from './smokeControl';

async function writeControl(uri: vscode.Uri, control: SmokeControl): Promise<void> {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(control, null, 4) + '\n'));
}

async function sourceHashes(control: SmokeControl): Promise<void> {
    for (const source of control.sourceDigests) {
        equal(await digest(await vscode.workspace.fs.readFile(vscode.Uri.parse(source.uri))), source.digest, 'Source fixture changed');
    }
}

async function active(control: SmokeControl, cache: FocusCache): Promise<ActiveFocus> {
    const uri = vscode.workspace.workspaceFile;
    assert(uri !== undefined, 'Focused workspace has no URI');
    const state = await cache.recognize(uri.toString());
    assert(state.active !== null && !state.active.modified, state.diagnostic ?? `No valid focus at ${uri.toString()}`);
    equal(state.active.metadata.origin.uri, control.originUri, 'Original URI changed');
    equal(state.active.metadata.appCount, control.expectedAppCount, 'Wrong app count');
    equal(vscode.workspace.workspaceFolders?.length, control.expectedRootCount, 'Wrong focused root count');
    if (control.cacheUri !== null) {
        equal(uri.toString(), control.cacheUri, 'Focused workspace identity changed');
    }
    equal(uri.scheme, vscode.Uri.parse(control.originUri).scheme, 'Source/cache filesystem scheme differs');
    equal(uri.authority, vscode.Uri.parse(control.originUri).authority, 'Remote authority changed');
    return state.active;
}

async function times(value: string): Promise<{ workspaceMtime: number; metadataMtime: number }> {
    const uri = vscode.Uri.parse(value);
    const [workspace, metadata] = await Promise.all([vscode.workspace.fs.stat(uri), vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, '..', 'focus.json'))]);
    return { workspaceMtime: workspace.mtime, metadataMtime: metadata.mtime };
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('AL Workspace Focus Smoke', { log: true });
    const operation = new AbortController();
    const file = vscode.Uri.joinPath(context.extensionUri, 'control.json');
    let running = false;
    let rerun = false;
    context.subscriptions.push(output, { dispose: () => { operation.abort(); } });
    async function drive(): Promise<void> {
        if (running) {
            return;
        }
        running = true;
        let control: SmokeControl | null = null;
        try {
            assert(typeof process === 'undefined', 'The lifecycle driver must run in a real browser worker');
            control = parseControl(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
            if (['passed', 'failed', 'awaiting-restart'].includes(control.status)) {
                return;
            }
            const fixture = vscode.Uri.parse(control.fixtureUri);
            assert(fixture.path.split('/').at(-1)?.startsWith('alwf-'), 'Not an owned fixture');
            const marker: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fixture, '.alwf-fixture.json'))));
            assert(isRecord(marker) && marker.owner === control.owner && marker.token === control.token, 'Fixture ownership mismatch');
            for (const source of [control.originUri, control.focusAppUri, ...control.sourceDigests.map(item => item.uri)]) {
                assert(containsUri(fixture, vscode.Uri.parse(source)), 'A fixture source escapes its directory');
            }
            const origin = control.originKind === 'workspace' ? vscode.workspace.workspaceFile : vscode.workspace.workspaceFolders?.[0]?.uri;
            const uris = new WorkspaceUris(filesystemHost(origin));
            const original = vscode.Uri.parse(control.originUri);
            const automaticRoot = vscode.Uri.joinPath(control.originKind === 'workspace' ? vscode.Uri.joinPath(original, '..') : original, BROWSER_CACHE_DIRECTORY);
            const cache = new FocusCache(uris);
            output.info(JSON.stringify({ worker: true, workspace: vscode.workspace.workspaceFile?.toString(), roots: vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()), remote: vscode.env.remoteName, cacheRoot: automaticRoot.toString() }));
            if (!vscode.workspace.isTrusted) {
                await writeControl(file, { ...control, status: 'awaiting-trust', message: 'Trust only the owned source fixture/cache through native Workspace Trust.' });
                await vscode.commands.executeCommand('workbench.trust.manage');
                return;
            }
            const extension = vscode.extensions.getExtension('Florian-Noever.al-workspace-focus');
            assert(extension !== undefined, 'Production extension is missing');
            await extension.activate();
            operation.signal.throwIfAborted();
            control = { ...control, status: 'running', message: null, hostVersion: vscode.version, remoteName: vscode.env.remoteName ?? null };
            if (control.phase === 'focus') {
                assert(origin !== undefined && uris.same(origin, vscode.Uri.parse(control.originUri)), 'Wrong original fixture');
                control = { ...control, originUri: origin.toString() };
                await sourceHashes(control);
                await writeControl(file, { ...control, phase: 'focused' });
                await vscode.commands.executeCommand('alWorkspaceFocus.focus', vscode.Uri.parse(control.focusAppUri));
                return;
            }
            if (control.phase === 'focused') {
                const focus = await active(control, cache);
                const before = await times(focus.workspaceUri);
                control = { ...control, cacheUri: focus.workspaceUri, ...before };
                const ignore = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(automaticRoot, '.gitignore'));
                equal(new TextDecoder().decode(ignore), '*\n', 'The automatic cache is not self-ignored');
                await vscode.commands.executeCommand('alWorkspaceFocus.focus', vscode.Uri.parse(control.focusAppUri));
                equal(await times(focus.workspaceUri), before, 'Cache hit rewrote files');
                await vscode.commands.executeCommand('alWorkspaceFocus.refresh');
                equal(await times(focus.workspaceUri), before, 'Refresh rewrote files');
                await writeControl(file, { ...control, phase: 'reloaded', journeys: [...control.journeys, 'focus', 'cache-hit', 'refresh-no-op'] });
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return;
            }
            if (control.phase !== 'unfocused') {
                await active(control, cache);
            }
            if (control.phase === 'reloaded') {
                await writeControl(file, { ...control, phase: 'restarted', status: 'awaiting-restart', journeys: [...control.journeys, 'reload'] });
                await vscode.commands.executeCommand('workbench.action.quit');
                return;
            }
            if (control.phase === 'restarted') {
                await writeControl(file, { ...control, phase: 'unfocused', journeys: [...control.journeys, 'application-restart'] });
                await vscode.commands.executeCommand('alWorkspaceFocus.unfocus');
                return;
            }
            equal(origin?.toString(), control.originUri, 'Unfocus did not restore the exact original');
            assert(control.cacheUri !== null, 'Missing completed cache URI');
            equal(await times(control.cacheUri), { workspaceMtime: control.workspaceMtime, metadataMtime: control.metadataMtime }, 'Unfocus changed the cache');
            await sourceHashes(control);
            await writeControl(file, { ...control, status: 'passed', journeys: [...control.journeys, 'unfocus', 'source-hashes-unchanged', 'completed-cache-retained'] });
            await vscode.commands.executeCommand('workbench.action.quit');
        } catch (error) {
            if (!operation.signal.aborted) {
                const message = error instanceof Error ? error.message : String(error);
                output.error(message);
                if (control !== null) {
                    await writeControl(file, { ...control, status: 'failed', message });
                }
            }
        } finally {
            running = false;
            if (rerun && !operation.signal.aborted) {
                rerun = false;
                start();
            }
        }
    }
    function start(): void {
        if (running) {
            rerun = true;
            return;
        }
        drive().catch((error: unknown) => { output.error(`Smoke control persistence failed: ${String(error)}`); });
    }
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(start));
    start();
}
