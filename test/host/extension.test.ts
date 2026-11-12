import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import manifest from '../../package.json';
import { activate } from '../../src/extension/extension';
import { FocusController } from '../../src/services/focusController';
import { FOCUS_READY_CONTEXT } from '../../src/shared/settings';
import { changeWorkspaceFolders, commands, contextKeys, grantWorkspaceTrust, resetVscode, setSetting, Uri, window, workspace } from '../support/vscodeMock';

import type * as vscode from 'vscode';

const contexts: vscode.ExtensionContext[] = [];

beforeEach(() => {
    resetVscode();
    workspace.workspaceFile = Uri.file(path.join(process.cwd(), 'source.code-workspace'));
    workspace.workspaceFolders = [{ name: 'App', uri: Uri.file(process.cwd()), index: 0 }];
});

afterEach(() => {
    for (const context of contexts.splice(0)) {
        for (const subscription of context.subscriptions) {
            subscription.dispose();
        }
    }
});

function contextFixture(): vscode.ExtensionContext {
    const subscriptions: vscode.ExtensionContext['subscriptions'] = [];
    const context = { subscriptions, extension: { packageJSON: manifest } } as vscode.ExtensionContext;
    contexts.push(context);
    return context;
}

describe('activation readiness', () => {
    it('notifies after initialization and command registration without waiting for dismissal', async () => {
        let complete: () => void = () => { throw new Error('Initialization promise not created'); };
        const initialization = new Promise<void>(resolve => { complete = resolve; });
        vi.spyOn(FocusController.prototype, 'initialize').mockReturnValue(initialization);
        let dismiss: (value: string | undefined) => void = () => { throw new Error('Notification promise not created'); };
        const notification = new Promise<string | undefined>(resolve => { dismiss = resolve; });
        window.showInformationMessage.mockReturnValue(notification);
        const activation = activate(contextFixture());
        expect(commands.registerCommand).not.toHaveBeenCalled();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        complete();
        await activation;
        expect(commands.registerCommand.mock.calls.map(([id]) => id)).toEqual(['alWorkspaceFocus.focus', 'alWorkspaceFocus.unfocus', 'alWorkspaceFocus.refresh']);
        expect(window.showInformationMessage).toHaveBeenCalledOnce();
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true);
        expect(window.showInformationMessage.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...commands.registerCommand.mock.invocationCallOrder));
        expect(workspace.fs.readFile).not.toHaveBeenCalled();
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
        dismiss(undefined);
    });

    it('still registers commands when the notification is disabled', async () => {
        setSetting('alWorkspaceFocus.showStartupNotification', false);
        await activate(contextFixture());
        expect(commands.registerCommand).toHaveBeenCalledTimes(3);
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('notifies once when an initially untrusted workspace becomes trusted', async () => {
        workspace.isTrusted = false;
        await activate(contextFixture());
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        grantWorkspaceTrust();
        grantWorkspaceTrust();
        await vi.waitFor(() => { expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true); });
        expect(window.showInformationMessage).toHaveBeenCalledOnce();
    });

    it('notifies once when an empty window gains workspace folders', async () => {
        workspace.workspaceFile = undefined;
        const folders = workspace.workspaceFolders;
        workspace.workspaceFolders = undefined;
        await activate(contextFixture());
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        changeWorkspaceFolders(folders);
        changeWorkspaceFolders(folders);
        await vi.waitFor(() => { expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true); });
        expect(window.showInformationMessage).toHaveBeenCalledOnce();
    });

    it('disposes readiness listeners with the extension', async () => {
        workspace.isTrusted = false;
        const context = contextFixture();
        await activate(context);
        for (const subscription of context.subscriptions.splice(0)) {
            subscription.dispose();
        }
        grantWorkspaceTrust();
        changeWorkspaceFolders(workspace.workspaceFolders);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });
});
