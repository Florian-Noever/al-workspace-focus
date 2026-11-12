import * as vscode from 'vscode';

import { isRecord } from '../../src/shared/focusTypes';
import { assert } from './assert';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const statusFile = vscode.Uri.joinPath(context.extensionUri, 'status.json');
    async function report(status: object): Promise<void> {
        await vscode.workspace.fs.writeFile(statusFile, new TextEncoder().encode(JSON.stringify(status) + '\n'));
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.extensionUri, 'done.json'));
    context.subscriptions.push(watcher, watcher.onDidCreate(() => {
        Promise.resolve(vscode.commands.executeCommand('workbench.action.quit')).catch((error: unknown) => report({ stage: 'failed', message: String(error) }));
    }));
    try {
        assert(typeof process === 'undefined', 'The readiness driver must run in the actual worker');
        const control: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'control.json'))));
        assert(isRecord(control) && typeof control.appUri === 'string', 'Invalid fixture control');
        const extension = vscode.extensions.getExtension('Florian-Noever.al-workspace-focus');
        assert(extension !== undefined, 'The production browser extension is missing');
        await extension.activate();
        if (!vscode.workspace.isTrusted) {
            const granted = new Promise<void>(resolve => {
                const listener = vscode.workspace.onDidGrantWorkspaceTrust(() => { listener.dispose(); resolve(); });
                context.subscriptions.push(listener);
            });
            await vscode.commands.executeCommand('workbench.trust.manage');
            await report({ stage: 'trust-needed' });
            await granted;
        }
        await vscode.commands.executeCommand('setContext', 'isWorkspaceTrusted', false);
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.parse(control.appUri));
        await report({ stage: 'menu-ready', nativeTrusted: vscode.workspace.isTrusted, hostVersion: vscode.version, browserWorker: true });
    } catch (error) {
        await report({ stage: 'failed', message: String(error) });
    }
}
