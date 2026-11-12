import * as vscode from 'vscode';

import { FocusError, isRecord } from '../shared/focusTypes';
import { FOCUS_READY_CONTEXT } from '../shared/settings';
import { FocusCache } from '../services/focusCache';
import { FocusController } from '../services/focusController';
import { WorkspaceFiles } from '../services/workspaceFiles';
import { filesystemHost, WorkspaceUris } from '../services/workspaceOrigin';

import type { CommandIds } from '../services/focusController';

function commandIds(manifest: unknown): CommandIds {
    if (!isRecord(manifest) || !isRecord(manifest.contributes) || !Array.isArray(manifest.contributes.commands)) {
        throw new FocusError('invalid-extension', 'The extension manifest has no command contributions.');
    }
    const commands: unknown[] = manifest.contributes.commands;
    function find(suffix: string): string {
        const match = commands.find(value => isRecord(value) && typeof value.command === 'string' && value.command.endsWith(`.${suffix}`));
        if (!isRecord(match) || typeof match.command !== 'string') {
            throw new FocusError('invalid-extension', `The extension manifest has no ${suffix} command.`);
        }
        return match.command;
    }
    return { focus: find('focus'), unfocus: find('unfocus'), refresh: find('refresh') };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const log = vscode.window.createOutputChannel('AL Workspace Focus', { log: true });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    context.subscriptions.push(log, status);
    const ids = commandIds(context.extension.packageJSON);
    await vscode.commands.executeCommand('setContext', FOCUS_READY_CONTEXT, false);
    const base = vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const uris = new WorkspaceUris(filesystemHost(base));
    const cache = new FocusCache(uris);
    const files = new WorkspaceFiles(uris);
    const controller = new FocusController(cache, files, uris, log, status, ids);
    context.subscriptions.push(controller);
    await controller.initialize();
    context.subscriptions.push(
        vscode.commands.registerCommand(ids.focus, (resource: unknown) => controller.focus(resource)),
        vscode.commands.registerCommand(ids.unfocus, () => controller.unfocus()),
        vscode.commands.registerCommand(ids.refresh, () => controller.refresh()),
        vscode.workspace.onDidGrantWorkspaceTrust(() => controller.updateAvailability()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => controller.updateAvailability())
    );
    await controller.updateAvailability();
}
