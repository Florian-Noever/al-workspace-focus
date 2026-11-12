import * as vscode from 'vscode';

import { resolveFocus } from '../al/dependencyGraph';
import { FocusError } from '../shared/focusTypes';
import { errorMessage } from '../shared/errors';
import { CONFIGURATION_SECTION, FOCUS_READY_CONTEXT, INCLUDE_TESTS_SETTING, SHOW_STARTUP_NOTIFICATION_SETTING } from '../shared/settings';
import { currentOrigin } from './workspaceOrigin';

import type { App, CacheRecognition, Diagnostic, FocusSelection, WorkspaceCatalog, WorkspaceOrigin } from '../shared/focusTypes';
import type { FocusOptions } from '../shared/settings';
import type { FocusCache } from './focusCache';
import type { WorkspaceFiles } from './workspaceFiles';
import type { WorkspaceUris } from './workspaceOrigin';

export interface CommandIds {
    readonly focus: string;
    readonly unfocus: string;
    readonly refresh: string;
}

interface AppQuickPickItem extends vscode.QuickPickItem {
    readonly app: App;
}

type FocusLog = Pick<vscode.LogOutputChannel, 'error' | 'info' | 'warn' | 'debug' | 'show'>;
type FocusStatus = Pick<vscode.StatusBarItem, 'name' | 'command' | 'text' | 'tooltip' | 'backgroundColor' | 'show' | 'hide'>;

export class FocusController implements vscode.Disposable {
    private recognition: CacheRecognition = { candidate: false, active: null, diagnostic: null };
    private operation: AbortController | null = null;
    private disposed = false;
    private startupNotified = false;
    private availabilityRevision = 0;
    private availabilityUpdate: Promise<void> = Promise.resolve();

    public constructor(private readonly cache: Pick<FocusCache, 'recognize' | 'getOrCreate' | 'inputHash'>, private readonly files: Pick<WorkspaceFiles, 'load' | 'assertCatalogSaved'>, private readonly uris: Pick<WorkspaceUris, 'same' | 'validate' | 'validateOrigin'>, private readonly log: FocusLog, private readonly status: FocusStatus, private readonly commands: CommandIds) {}

    public dispose(): void {
        this.disposed = true;
        this.availabilityRevision++;
        this.operation?.abort();
        this.operation = null;
    }

    private checkCurrent(signal: AbortSignal): void {
        signal.throwIfAborted();
        if (this.disposed || this.operation?.signal !== signal) {
            throw new FocusError('stale-operation', 'The extension host was disposed or another focus operation superseded this one.');
        }
    }

    private reportError(label: string, error: unknown): void {
        if (this.disposed) {
            return;
        }
        const message = errorMessage(error, 'An unknown error occurred.');
        this.log.error(`${label}: ${message}`);
        Promise.resolve(vscode.window.showErrorMessage(`AL Workspace Focus: ${message}`, 'Show Log')).then(action => {
            if (!this.disposed && action === 'Show Log') {
                this.log.show();
            }
        }).catch((notificationError: unknown) => {
            if (!this.disposed) {
                this.log.error(`Cannot display the error notification: ${errorMessage(notificationError, 'unknown notification error')}`);
            }
        });
    }

    private startOperation(): AbortController {
        this.operation?.abort();
        const operation = new AbortController();
        this.operation = operation;
        return operation;
    }

    public async initialize(): Promise<void> {
        const operation = this.startOperation();
        try {
            const recognition = await this.cache.recognize(vscode.workspace.workspaceFile?.toString(), operation.signal);
            this.checkCurrent(operation.signal);
            this.recognition = recognition;
            await this.render(operation.signal);
            if (recognition.diagnostic !== null) {
                this.log.warn(recognition.diagnostic);
                if (recognition.active === null) {
                    this.reportError('Recognizing active focus', new FocusError('cache-recovery', recognition.diagnostic));
                }
            }
        } catch (error) {
            if (!operation.signal.aborted) {
                this.reportError('Recognizing active focus', error);
            }
        } finally {
            if (this.operation === operation) {
                this.operation = null;
            }
        }
    }

    private canFocus(): boolean {
        return !this.disposed && vscode.workspace.isTrusted && (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    }

    public updateAvailability(): Promise<void> {
        const revision = ++this.availabilityRevision;
        this.availabilityUpdate = this.availabilityUpdate.then(async () => {
            if (this.disposed || revision !== this.availabilityRevision) {
                return;
            }
            const ready = this.canFocus();
            await vscode.commands.executeCommand('setContext', FOCUS_READY_CONTEXT, ready);
            if (revision !== this.availabilityRevision || ready !== this.canFocus()) {
                return;
            }
            if (ready) {
                this.notifyReady();
            }
        }).catch((error: unknown) => {
            this.reportError('Updating Focus availability', error);
        });
        return this.availabilityUpdate;
    }

    private notifyReady(): void {
        if (this.startupNotified || !this.canFocus()) {
            return;
        }
        try {
            const enabled = this.booleanSetting(SHOW_STARTUP_NOTIFICATION_SETTING, true);
            if (!enabled) {
                return;
            }
            this.startupNotified = true;
            // Notification promises settle on dismissal, so they must not delay activation.
            Promise.resolve(vscode.window.showInformationMessage('AL Workspace Focus is ready. Open or reopen the app.json context menu to focus on an app.')).catch((error: unknown) => {
                this.reportError('Showing startup notification', error);
            });
        } catch (error) {
            this.reportError('Showing startup notification', error);
        }
    }

    private async render(signal: AbortSignal): Promise<void> {
        this.checkCurrent(signal);
        const active = this.recognition.active;
        this.status.name = 'AL Workspace Focus';
        this.status.command = this.commands.unfocus;
        if (active !== null) {
            const metadata = active.metadata;
            const firstName = metadata.selectedNames[0] ?? metadata.origin.label;
            const label = metadata.selectedNames.length > 1 ? `${firstName} +${(metadata.selectedNames.length - 1).toString()}` : firstName;
            this.status.text = `$(target) Focus: ${label} (${metadata.appCount.toString()} apps)`;
            this.status.tooltip = [
                'Click to Unfocus and reopen the exact original workspace or folder.',
                `Original: ${metadata.origin.uri}`,
                `Selected: ${metadata.selectedNames.join(', ')}`,
                `Automatic tests: ${metadata.options.includeTests ? 'on (selected production apps only)' : 'off'}`,
                ...(active.modified ? ['The cached workspace was modified or removed. It will be preserved.'] : []),
                'Retained roots:',
                ...metadata.roots.map(root => `  ${root}`)
            ].join('\n');
            this.status.backgroundColor = active.modified ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
            this.status.show();
        } else if (this.recognition.candidate) {
            this.status.text = '$(warning) Focus cache unavailable';
            this.status.tooltip = this.recognition.diagnostic ?? 'Reopen the original workspace manually.';
            this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.status.show();
        } else {
            this.status.hide();
        }
        await vscode.commands.executeCommand('setContext', 'alWorkspaceFocus.active', this.recognition.candidate);
    }

    private booleanSetting(key: string, fallback: boolean): boolean {
        const value = vscode.workspace.getConfiguration(CONFIGURATION_SECTION).get<unknown>(key, fallback);
        if (typeof value !== 'boolean') {
            throw new FocusError('invalid-setting', `${CONFIGURATION_SECTION}.${key} must be a boolean. Correct the setting and retry.`);
        }
        return value;
    }

    private effectiveOptions(): FocusOptions {
        return { includeTests: this.booleanSetting(INCLUDE_TESTS_SETTING, false) };
    }

    private requireTrust(): void {
        if (!vscode.workspace.isTrusted) {
            throw new FocusError('untrusted-workspace', 'Creating or refreshing a focus requires a trusted workspace. Native Workspace Trust remains in charge; validated Unfocus is available without trust.');
        }
    }

    private async run(label: string, work: (signal: AbortSignal, token: vscode.CancellationToken) => Promise<void>): Promise<void> {
        if (this.disposed) {
            return;
        }
        const operation = this.startOperation();
        try {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `AL Workspace Focus: ${label}`, cancellable: true }, async (_progress, token) => {
                const cancellation = token.onCancellationRequested(() => {
                    operation.abort();
                });
                try {
                    if (token.isCancellationRequested) {
                        operation.abort();
                    }
                    this.checkCurrent(operation.signal);
                    await work(operation.signal, token);
                } finally {
                    cancellation.dispose();
                }
            });
        } catch (error) {
            if (error instanceof AggregateError) {
                this.reportError(`${label} cache cleanup`, error);
            } else if (this.operation === operation) {
                if (operation.signal.aborted || error instanceof FocusError && error.code === 'cancelled') {
                    this.log.debug(`${label}: cancelled.`);
                } else {
                    this.reportError(label, error);
                }
            }
        } finally {
            if (this.operation === operation) {
                this.operation = null;
            }
        }
    }

    private async pickApps(catalog: WorkspaceCatalog, resource: unknown, options: FocusOptions, signal: AbortSignal, token: vscode.CancellationToken): Promise<readonly string[] | null> {
        if (resource !== undefined) {
            if (!(resource instanceof vscode.Uri)) {
                throw new FocusError('invalid-resource', 'Run Focus from the command palette or the context menu of a listed root app.json.');
            }
            const app = catalog.apps.find(candidate => this.uris.same(vscode.Uri.parse(candidate.root.manifestUri, true), resource));
            if (app === undefined) {
                throw new FocusError('unlisted-app', 'This app.json does not belong directly to a root listed in the original workspace. Add its app folder to the original workspace first.');
            }
            return [app.manifest.id];
        }
        const selectedIds = new Set(this.recognition.active?.metadata.selectedIds ?? []);
        const items: AppQuickPickItem[] = catalog.apps.map(app => ({
            label: app.root.name,
            description: `${app.manifest.name} | ${app.manifest.publisher} | ${app.manifest.version}${app.isTest ? ' | test' : ''}`,
            detail: app.root.uri,
            picked: selectedIds.has(app.manifest.id),
            app
        }));
        const picked = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            ignoreFocusOut: true,
            title: 'AL Workspace Focus',
            placeHolder: `Select apps; listed dependencies are included. Automatic tests: ${options.includeTests ? 'on for your selected production apps' : 'off'}.`
        }, token);
        this.checkCurrent(signal);
        if (picked === undefined || picked.length === 0) {
            this.log.debug('Focus cancelled: no apps selected.');
            return null;
        }
        return picked.map(item => item.app.manifest.id);
    }

    private async reviewDiagnostics(diagnostics: readonly Diagnostic[], signal: AbortSignal): Promise<boolean> {
        if (diagnostics.length === 0) {
            return true;
        }
        const unique = [...new Map(diagnostics.map(diagnostic => [`${diagnostic.code}:${diagnostic.location ?? ''}:${diagnostic.message}`, diagnostic])).values()];
        for (const diagnostic of unique) {
            this.log.warn(`${diagnostic.code}${diagnostic.location === undefined ? '' : ` at ${diagnostic.location}`}: ${diagnostic.message}`);
        }
        this.checkCurrent(signal);
        const detail = unique.slice(0, 6).map(diagnostic => `${diagnostic.location ?? diagnostic.code}: ${diagnostic.message}`).join('\n\n') + (unique.length > 6 ? '\n\nAll warnings are available in the AL Workspace Focus log.' : '');
        const action = await vscode.window.showWarningMessage(`The focus has ${unique.length.toString()} warning(s). Review paths, dependencies and test matches before opening it.`, { modal: true, detail }, 'Continue Focus', 'Show Log');
        this.checkCurrent(signal);
        if (action === 'Show Log') {
            this.log.show();
        }
        return action === 'Continue Focus';
    }

    private async generateAndOpen(catalog: WorkspaceCatalog, selectedIds: readonly string[], options: FocusOptions, signal: AbortSignal): Promise<void> {
        this.requireTrust();
        this.checkCurrent(signal);
        const selection = resolveFocus(catalog, selectedIds, options);
        const generated = await this.cache.getOrCreate(catalog, selection, signal);
        this.checkCurrent(signal);
        const target = vscode.Uri.parse(generated.active.workspaceUri, true);
        const current = vscode.workspace.workspaceFile;
        if (current !== undefined && this.uris.same(current, target) && !generated.active.modified) {
            const verified = await this.verifyInputs(catalog.origin, selection, generated.active.metadata.inputHash, generated.active.metadata.hostFingerprint, signal);
            this.files.assertCatalogSaved(verified);
            this.recognition = { candidate: true, active: generated.active, diagnostic: null };
            await this.render(signal);
            this.log.info('The identical focus is already active; no files were rewritten and the window was not reopened.');
            return;
        }
        if (!await this.reviewDiagnostics([...selection.diagnostics, ...generated.diagnostics], signal)) {
            this.log.debug('Focus cancelled while reviewing warnings. Completed cache files are retained.');
            return;
        }
        const verified = await this.verifyInputs(catalog.origin, selection, generated.active.metadata.inputHash, generated.active.metadata.hostFingerprint, signal);
        this.files.assertCatalogSaved(verified);
        this.requireTrust();
        this.checkCurrent(signal);
        this.log.info(`${generated.hit ? 'Reusing' : 'Opening'} a validated focus with ${selection.apps.length.toString()} apps and ${selection.roots.length.toString()} roots.`);
        await vscode.commands.executeCommand('vscode.openFolder', target, { forceReuseWindow: true, noRecentEntry: true });
    }

    private async verifyInputs(origin: WorkspaceOrigin, selection: FocusSelection, expectedHash: string, fingerprint: string, signal: AbortSignal): Promise<WorkspaceCatalog> {
        const current = await this.files.load(origin, signal);
        this.checkCurrent(signal);
        const currentSelection = resolveFocus(current, selection.selectedIds, selection.options);
        if (await this.cache.inputHash(current, currentSelection, fingerprint) !== expectedHash) {
            throw new FocusError('source-changed', 'The original workspace or a listed manifest changed during focus generation or warning review. Retry; no stale focus was opened.');
        }
        return current;
    }

    public async focus(resource?: unknown): Promise<void> {
        await this.run('Focus', async (signal, token) => {
            this.requireTrust();
            const origin = currentOrigin(this.recognition, this.uris);
            const catalog = await this.files.load(origin, signal);
            this.checkCurrent(signal);
            const options = this.effectiveOptions();
            const selected = await this.pickApps(catalog, resource, options, signal, token);
            if (selected !== null) {
                await this.generateAndOpen(catalog, selected, options, signal);
            }
        });
    }

    public async refresh(): Promise<void> {
        await this.run('Refresh', async signal => {
            this.requireTrust();
            const active = this.recognition.active;
            if (active === null) {
                throw new FocusError('no-active-focus', this.recognition.diagnostic ?? 'There is no validated active focus to refresh.');
            }
            const catalog = await this.files.load(active.metadata.origin, signal);
            await this.generateAndOpen(catalog, active.metadata.selectedIds, active.metadata.options, signal);
        });
    }

    public async unfocus(): Promise<void> {
        await this.run('Unfocus', async signal => {
            const liveUri = vscode.workspace.workspaceFile;
            const recognition = await this.cache.recognize(liveUri?.toString(), signal);
            this.checkCurrent(signal);
            const previous = this.recognition.active;
            const retained = previous !== null && liveUri !== undefined && this.uris.same(liveUri, vscode.Uri.parse(previous.workspaceUri, true)) ? previous : null;
            const active = recognition.active ?? retained;
            if (active === null) {
                throw new FocusError('no-active-focus', recognition.diagnostic ?? 'There is no validated active focus. Open the original saved workspace or folder manually.');
            }
            this.uris.validateOrigin(active.metadata.origin);
            const original = vscode.Uri.parse(active.metadata.origin.uri, true);
            try {
                const info = await vscode.workspace.fs.stat(original);
                const expected = active.metadata.origin.kind === 'folder' ? vscode.FileType.Directory : vscode.FileType.File;
                if ((info.type & expected) === 0) {
                    throw new FocusError('missing-origin', 'The original workspace or folder no longer has the expected filesystem type.');
                }
            } catch (error) {
                if (error instanceof FocusError) {
                    throw error;
                }
                throw new FocusError('missing-origin', `The original workspace or folder is unavailable at ${original.toString()}. Restore it or open its new location manually; caches are retained.`);
            }
            this.checkCurrent(signal);
            this.log.info('Reopening the exact original workspace/folder URI. Completed focuses remain cached.');
            await vscode.commands.executeCommand('vscode.openFolder', original, { forceReuseWindow: true, noRecentEntry: true });
        });
    }
}
