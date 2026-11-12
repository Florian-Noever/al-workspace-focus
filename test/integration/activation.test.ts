import * as vscode from 'vscode';

import { digest } from '../../src/host/browserHost';
import { isRecord } from '../../src/shared/focusTypes';
import { assert, equal } from './assert';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const control: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'control.json'))));
    assert(isRecord(control) && typeof control.resultUri === 'string', 'Invalid owned activation control');
    let result: object;
    try {
        assert(typeof process === 'undefined', 'The activation driver must actually run in the browser worker.');
        const extension = vscode.extensions.getExtension('Florian-Noever.al-workspace-focus');
        assert(extension !== undefined, 'The installed production extension is missing.');
        await extension.activate();
        const manifest: unknown = extension.packageJSON;
        assert(isRecord(manifest), 'The installed extension manifest is missing');
        equal(manifest.main, undefined, 'A Node main entry must not be shipped');
        equal(manifest.browser, './out/extension.js', 'The browser entry must be installed');
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['alWorkspaceFocus.focus', 'alWorkspaceFocus.unfocus', 'alWorkspaceFocus.refresh']) {
            assert(commands.includes(command), `Missing command ${command}`);
        }
        assert(typeof control.originUri === 'string' && Array.isArray(control.sourceDigests), 'Missing fixture inputs');
        equal(vscode.workspace.workspaceFile?.path.toLowerCase(), vscode.Uri.parse(control.originUri).path.toLowerCase(), 'The source workspace was not opened');
        equal(vscode.workspace.workspaceFolders?.length, 7, 'Wrong source root count');
        for (const entry of control.sourceDigests) {
            assert(isRecord(entry) && typeof entry.uri === 'string' && typeof entry.digest === 'string', 'Invalid fixture digest');
            equal(await digest(await vscode.workspace.fs.readFile(vscode.Uri.parse(entry.uri))), entry.digest, 'The source fixture was modified');
        }
        if (control.expectedVersion !== '') {
            equal(vscode.version, control.expectedVersion, 'Wrong VS Code version');
        }
        result = { passed: true, checks: 3, version: vscode.version, browserWorker: true, trusted: vscode.workspace.isTrusted, sourceHashesUnchanged: true };
    } catch (error) {
        result = { passed: false, message: error instanceof Error ? error.message : String(error), version: vscode.version };
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.parse(control.resultUri), new TextEncoder().encode(JSON.stringify(result) + '\n'));
    await vscode.commands.executeCommand('workbench.action.quit');
}
