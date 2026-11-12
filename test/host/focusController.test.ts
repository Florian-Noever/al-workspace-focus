import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { resolveFocus } from '../../src/al/dependencyGraph';
import { digest } from '../support/digest';
import { FocusController } from '../../src/services/focusController';
import { FocusError } from '../../src/shared/focusTypes';
import { CACHE_FORMAT_VERSION, EXTENSION_NAME, FOCUS_READY_CONTEXT, PATH_POLICY, TRANSFORM_VERSION } from '../../src/shared/settings';
import { cacheInputs, sourceIdentity } from '../../src/workspace/cacheInputs';
import { appId, catalogFixture, dependency, rootFixture } from '../support/fixtures';
import { cancelProgress, commands, contextKeys, FileType, listenerCount, resetVscode, setFile, setSetting, Uri, window, workspace } from '../support/vscodeMock';

import type { FocusCache } from '../../src/services/focusCache';
import type { WorkspaceFiles } from '../../src/services/workspaceFiles';
import type { ActiveFocus, CacheRecognition, FocusSelection, WorkspaceCatalog } from '../../src/shared/focusTypes';

const HOST = 'f'.repeat(64);
const controllers: FocusController[] = [];

beforeEach(() => {
    resetVscode();
});

afterEach(() => {
    for (const controller of controllers.splice(0)) {
        controller.dispose();
    }
});

function focusFor(catalog: WorkspaceCatalog, selection: FocusSelection): ActiveFocus {
    const inputHash = digest(cacheInputs(catalog, selection, HOST));
    const sourceKey = digest(sourceIdentity(catalog.origin, HOST));
    return {
        workspaceUri: `file:///temp/al-workspace-focus/${sourceKey}/${inputHash}/focus.code-workspace`,
        modified: false,
        metadata: {
            owner: EXTENSION_NAME,
            formatVersion: CACHE_FORMAT_VERSION,
            transformVersion: TRANSFORM_VERSION,
            pathPolicy: PATH_POLICY,
            hostFingerprint: HOST,
            sourceKey,
            inputHash,
            workspaceDigest: 'a'.repeat(64),
            origin: catalog.origin,
            selectedIds: selection.selectedIds,
            selectedNames: selection.selectedNames,
            options: selection.options,
            roots: selection.roots.map(root => root.name),
            appCount: selection.apps.length
        }
    };
}

function controllerFixture(active = false) {
    const catalog = catalogFixture([
        rootFixture(0, 'Base'),
        rootFixture(1, 'WMS', { dependencies: [dependency(appId(1), 'Base')] }),
        rootFixture(2, 'Other'),
        rootFixture(3, 'WMS Test', { dependencies: [dependency(appId(1), 'Base')] }),
        rootFixture(4, '.resources', { id: null })
    ]);
    const selected = resolveFocus(catalog, [appId(2)], { includeTests: false });
    const focus = focusFor(catalog, selected);
    const recognition: CacheRecognition = active ? { candidate: true, active: focus, diagnostic: null } : { candidate: false, active: null, diagnostic: null };
    const cache = {
        recognize: vi.fn<FocusCache['recognize']>(() => Promise.resolve(recognition)),
        getOrCreate: vi.fn<FocusCache['getOrCreate']>((current, selection) => Promise.resolve({ active: focusFor(current, selection), hit: true, diagnostics: [] })),
        inputHash: vi.fn<FocusCache['inputHash']>((current, selection) => Promise.resolve(digest(cacheInputs(current, selection, HOST))))
    };
    const files = {
        load: vi.fn<WorkspaceFiles['load']>(() => Promise.resolve(catalog)),
        assertCatalogSaved: vi.fn<WorkspaceFiles['assertCatalogSaved']>()
    };
    const uris: ConstructorParameters<typeof FocusController>[2] = {
        same: (left, right) => left.toString() === right.toString(),
        validate: uri => {
            if (uri.scheme !== 'file') {
                throw new FocusError('unsupported-host', 'Unsupported fixture host');
            }
        },
        validateOrigin: origin => {
            if (!origin.uri.startsWith('file:')) {
                throw new FocusError('unsupported-host', 'Unsupported fixture origin');
            }
        }
    };
    const log = { error: vi.fn<() => void>(), warn: vi.fn<() => void>(), info: vi.fn<() => void>(), debug: vi.fn<() => void>(), show: vi.fn<() => void>() };
    const status: ConstructorParameters<typeof FocusController>[4] = { name: undefined, command: undefined, text: '', tooltip: undefined, backgroundColor: undefined, show: vi.fn<() => void>(), hide: vi.fn<() => void>() };
    const controller = new FocusController(cache, files, uris, log, status, { focus: 'alWorkspaceFocus.focus', unfocus: 'alWorkspaceFocus.unfocus', refresh: 'alWorkspaceFocus.refresh' });
    controllers.push(controller);
    workspace.workspaceFile = Uri.parse(active ? focus.workspaceUri : catalog.origin.uri);
    workspace.workspaceFolders = catalog.roots.map(root => ({ name: root.name, uri: Uri.parse(root.uri), index: root.index }));
    setFile(Uri.parse(catalog.origin.uri), catalog.workspaceText);
    return { controller, cache, files, catalog, focus, log, status };
}

function openCalls(): readonly unknown[][] {
    return commands.executeCommand.mock.calls.filter(([command]) => command === 'vscode.openFolder');
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let complete: (value: T) => void = () => { throw new Error('Promise not initialized'); };
    const promise = new Promise<T>(resolve => { complete = resolve; });
    return { promise, resolve: complete };
}

describe('startup readiness notification', () => {
    it('shows the readiness message once after publishing UI availability without loading app manifests', async () => {
        const { controller, files } = controllerFixture();
        contextKeys.set('isWorkspaceTrusted', false);
        await controller.updateAvailability();
        await controller.updateAvailability();
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true);
        expect(contextKeys.get('isWorkspaceTrusted')).toBe(false);
        expect(window.showInformationMessage).toHaveBeenCalledExactlyOnceWith('AL Workspace Focus is ready. Open or reopen the app.json context menu to focus on an app.');
        expect(files.load).not.toHaveBeenCalled();
    });

    it('honors the disabled startup-notification setting without disabling the menu', async () => {
        const { controller } = controllerFixture();
        setSetting('alWorkspaceFocus.showStartupNotification', false);
        await controller.updateAvailability();
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(true);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('does not claim readiness before trust and workspace folders are available', async () => {
        const { controller } = controllerFixture();
        workspace.isTrusted = false;
        await controller.updateAvailability();
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(false);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        workspace.isTrusted = true;
        const folders = workspace.workspaceFolders;
        workspace.workspaceFolders = [];
        await controller.updateAvailability();
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(false);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        workspace.workspaceFolders = folders;
        await controller.updateAvailability();
        expect(window.showInformationMessage).toHaveBeenCalledOnce();
    });

    it('reports invalid settings rather than treating strings as booleans', async () => {
        const { controller, log } = controllerFixture();
        setSetting('alWorkspaceFocus.showStartupNotification', 'false');
        await controller.updateAvailability();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalled();
        expect(window.showErrorMessage).toHaveBeenCalled();
    });

    it('surfaces a rejected notification without rejecting startup', async () => {
        const { controller, log } = controllerFixture();
        window.showInformationMessage.mockRejectedValue(new Error('Notifications unavailable'));
        await controller.updateAvailability();
        await Promise.resolve();
        expect(log.error).toHaveBeenCalledWith('Showing startup notification: Notifications unavailable');
    });

    it('does not notify after disposal', async () => {
        const { controller } = controllerFixture();
        controller.dispose();
        await controller.updateAvailability();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('does not notify until the UI context update is acknowledged', async () => {
        const { controller } = controllerFixture();
        const acknowledged = deferred<unknown>();
        commands.executeCommand.mockReturnValue(acknowledged.promise);
        const update = controller.updateAvailability();
        await Promise.resolve();
        expect(commands.executeCommand).toHaveBeenCalledWith('setContext', FOCUS_READY_CONTEXT, true);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        acknowledged.resolve(undefined);
        await update;
        expect(window.showInformationMessage).toHaveBeenCalledOnce();
    });

    it('serializes UI updates and suppresses a notification for superseded availability', async () => {
        const { controller } = controllerFixture();
        const acknowledged = deferred<unknown>();
        commands.executeCommand.mockImplementation((command, ...args) => {
            if (command === 'setContext' && args[0] === FOCUS_READY_CONTEXT) {
                if (args[1] === true) {
                    return acknowledged.promise.then(() => { contextKeys.set(FOCUS_READY_CONTEXT, true); });
                }
                contextKeys.set(FOCUS_READY_CONTEXT, args[1]);
            }
            return Promise.resolve(undefined);
        });
        const first = controller.updateAvailability();
        await Promise.resolve();
        workspace.workspaceFolders = [];
        const second = controller.updateAvailability();
        expect(commands.executeCommand).toHaveBeenCalledTimes(1);
        acknowledged.resolve(undefined);
        await Promise.all([first, second]);
        expect(contextKeys.get(FOCUS_READY_CONTEXT)).toBe(false);
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });

    it('surfaces a failed UI update without announcing readiness', async () => {
        const { controller, log } = controllerFixture();
        commands.executeCommand.mockRejectedValue(new Error('UI context unavailable'));
        await controller.updateAvailability();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith('Updating Focus availability: UI context unavailable');
    });
});

describe('native focus command and original-catalog semantics', () => {
    it('opens a validated cached workspace in the same window without adding recent entries', async () => {
        const { controller, catalog, cache } = controllerFixture();
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(cache.getOrCreate).toHaveBeenCalledOnce();
        const call = openCalls()[0];
        expect(call?.[1]).toBeInstanceOf(Uri);
        expect(call?.[2]).toEqual({ forceReuseWindow: true, noRecentEntry: true });
        expect(listenerCount()).toBe(0);
    });

    it('uses a native multi-select picker and resolves the union of selected closures', async () => {
        const { controller, cache } = controllerFixture();
        window.showQuickPick.mockImplementation(items => Promise.resolve(items.slice(1, 3)));
        await controller.initialize();
        await controller.focus();
        expect(cache.getOrCreate.mock.calls[0]?.[1].selectedIds).toEqual([appId(2), appId(3)]);
        expect(cache.getOrCreate.mock.calls[0]?.[1].apps.map(app => app.root.name)).toEqual(['Base', 'WMS', 'Other']);
        expect(window.showQuickPick.mock.calls[0]?.[0]).toHaveLength(4);
    });

    it('always loads the original catalogue when selecting another focus from an active reduced workspace', async () => {
        const { controller, cache, files, catalog } = controllerFixture(true);
        workspace.workspaceFolders = [{ name: 'WMS', uri: Uri.parse(catalog.roots[1]?.uri ?? ''), index: 0 }];
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[2]?.manifestUri ?? ''));
        expect(files.load.mock.calls.every(([origin]) => origin.uri === catalog.origin.uri)).toBe(true);
        expect(cache.getOrCreate.mock.calls[0]?.[1].selectedIds).toEqual([appId(3)]);
        expect(openCalls()).toHaveLength(1);
    });

    it('treats choosing an identical intact active focus as a no-op while re-reading source inputs', async () => {
        const { controller, files, catalog, status } = controllerFixture(true);
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(files.load).toHaveBeenCalledTimes(2);
        expect(openCalls()).toHaveLength(0);
        expect(status.text).toBe('$(target) Focus: WMS (2 apps)');
    });

    it('captures effective automatic-tests options and includes only selected roots test pairs', async () => {
        const { controller, cache, catalog } = controllerFixture();
        setSetting('alWorkspaceFocus.includeTests', true);
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(cache.getOrCreate.mock.calls[0]?.[1].options.includeTests).toBe(true);
        expect(cache.getOrCreate.mock.calls[0]?.[1].apps.map(app => app.root.name)).toEqual(['Base', 'WMS', 'WMS Test']);
    });

    it('rejects invalid resource arguments and unlisted app.json context commands', async () => {
        const { controller, cache } = controllerFixture();
        await controller.initialize();
        await controller.focus('not a URI');
        await controller.focus(Uri.parse('file:///repo/nested/Unlisted/app.json'));
        expect(cache.getOrCreate).not.toHaveBeenCalled();
        expect(window.showErrorMessage).toHaveBeenCalledTimes(2);
        expect(openCalls()).toHaveLength(0);
    });

    it('treats cancelling or clearing the multi-select picker as cancellation, not an error', async () => {
        const { controller, cache } = controllerFixture();
        await controller.initialize();
        await controller.focus();
        window.showQuickPick.mockResolvedValue([]);
        await controller.focus();
        expect(cache.getOrCreate).not.toHaveBeenCalled();
        expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('surfaces diagnostics and lets warning-review cancellation retain the completed cache without opening it', async () => {
        const { controller, cache, catalog, log } = controllerFixture();
        cache.getOrCreate.mockImplementation((current, selection) => Promise.resolve({
            active: focusFor(current, selection),
            hit: false,
            diagnostics: [{ code: 'ambiguous-path', location: '$["settings"]["unknown"]', message: 'A relative path was preserved.' }]
        }));
        window.showWarningMessage.mockResolvedValue(undefined);
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(log.warn).toHaveBeenCalled();
        expect(window.showWarningMessage).toHaveBeenCalledOnce();
        expect(openCalls()).toHaveLength(0);
    });

    it('rejects changed source inputs after generation and before opening', async () => {
        const { controller, catalog, files } = controllerFixture();
        files.load.mockResolvedValueOnce(catalog).mockResolvedValueOnce({ ...catalog, workspaceText: `${catalog.workspaceText}// changed\n` });
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(openCalls()).toHaveLength(0);
        expect(window.showErrorMessage).toHaveBeenCalled();
    });

    it('rejects invalid options instead of silently defaulting them', async () => {
        const { controller, catalog, cache } = controllerFixture();
        setSetting('alWorkspaceFocus.includeTests', 'false');
        await controller.initialize();
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(cache.getOrCreate).not.toHaveBeenCalled();
        expect(window.showErrorMessage).toHaveBeenCalled();
    });
});

describe('trust, lifecycle and safe Unfocus', () => {
    it('reconstructs status from metadata without loading manifests on activation or simulated reload', async () => {
        const first = controllerFixture(true);
        await first.controller.initialize();
        expect(first.files.load).not.toHaveBeenCalled();
        expect(first.status.text).toBe('$(target) Focus: WMS (2 apps)');
        expect(first.status.command).toBe('alWorkspaceFocus.unfocus');
        expect(first.status.tooltip).toContain('Automatic tests: off');
        expect(first.status.tooltip).toContain('file:///repo/source.code-workspace');
        first.controller.dispose();
        const reloaded = controllerFixture(true);
        await reloaded.controller.initialize();
        expect(reloaded.files.load).not.toHaveBeenCalled();
        expect(reloaded.status.text).toBe(first.status.text);
    });

    it('blocks generation and refresh when untrusted while permitting validated Unfocus', async () => {
        const { controller, catalog, files } = controllerFixture(true);
        await controller.initialize();
        workspace.isTrusted = false;
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        await controller.refresh();
        expect(files.load).not.toHaveBeenCalled();
        await controller.unfocus();
        expect(openCalls()).toHaveLength(1);
        const target = openCalls()[0]?.[1];
        expect(target instanceof Uri ? target.toString() : null).toBe(catalog.origin.uri);
        expect(workspace.fs.writeFile).not.toHaveBeenCalled();
    });

    it('uses captured selections/options for Refresh rather than reducing the original catalogue', async () => {
        const { controller, catalog, cache } = controllerFixture(true);
        await controller.initialize();
        setSetting('alWorkspaceFocus.includeTests', true);
        await controller.refresh();
        expect(cache.getOrCreate.mock.calls[0]?.[0].origin.uri).toBe(catalog.origin.uri);
        expect(cache.getOrCreate.mock.calls[0]?.[1].options.includeTests).toBe(false);
    });

    it('keeps validated in-memory Unfocus available after OS temp cleanup in the current host', async () => {
        const { controller, cache, catalog } = controllerFixture(true);
        await controller.initialize();
        cache.recognize.mockResolvedValue({ candidate: true, active: null, diagnostic: 'Cache removed' });
        await controller.unfocus();
        const target = openCalls()[0]?.[1];
        expect(target instanceof Uri ? target.toString() : null).toBe(catalog.origin.uri);
    });

    it('does not fabricate an original after restart with missing sidecar metadata', async () => {
        const { controller, cache, status, files } = controllerFixture(true);
        cache.recognize.mockResolvedValue({ candidate: true, active: null, diagnostic: 'Cache removed; reopen the original manually.' });
        await controller.initialize();
        await controller.unfocus();
        expect(status.text).toBe('$(warning) Focus cache unavailable');
        expect(files.load).not.toHaveBeenCalled();
        expect(openCalls()).toHaveLength(0);
        expect(window.showErrorMessage).toHaveBeenCalled();
    });

    it('keeps modified-focus status and returns to the exact original URI without removing caches', async () => {
        const { controller, cache, catalog, focus, status } = controllerFixture(true);
        cache.recognize.mockResolvedValue({ candidate: true, active: { ...focus, modified: true }, diagnostic: 'Modified cache retained' });
        await controller.initialize();
        expect(status.tooltip).toContain('modified or removed');
        await controller.unfocus();
        const target = openCalls()[0]?.[1];
        expect(target instanceof Uri ? target.toString() : null).toBe(catalog.origin.uri);
        expect(cache.getOrCreate).not.toHaveBeenCalled();
        expect(workspace.fs.delete).not.toHaveBeenCalled();
    });

    it('opens an exact folder origin and reports a missing original rather than a successful restore', async () => {
        const { controller, cache, focus } = controllerFixture(true);
        const origin = { kind: 'folder' as const, uri: 'file:///repo/WMS', label: 'WMS' };
        cache.recognize.mockResolvedValue({ candidate: true, active: { ...focus, metadata: { ...focus.metadata, origin } }, diagnostic: null });
        setFile(Uri.parse(origin.uri), '', FileType.Directory);
        await controller.initialize();
        await controller.unfocus();
        const target = openCalls()[0]?.[1];
        expect(target instanceof Uri ? target.toString() : null).toBe(origin.uri);
        workspace.fs.stat.mockRejectedValue(new Error('Missing original'));
        commands.executeCommand.mockClear();
        await controller.unfocus();
        expect(openCalls()).toHaveLength(0);
        expect(window.showErrorMessage).toHaveBeenCalled();
    });

    it('cancels progress and prevents disposed or superseded async operations from opening a workspace', async () => {
        const fixture = controllerFixture();
        await fixture.controller.initialize();
        const pending = deferred<WorkspaceCatalog>();
        fixture.files.load.mockReturnValue(pending.promise);
        const running = fixture.controller.focus(Uri.parse(fixture.catalog.roots[1]?.manifestUri ?? ''));
        cancelProgress();
        pending.resolve(fixture.catalog);
        await running;
        expect(openCalls()).toHaveLength(0);
        expect(listenerCount()).toBe(0);
        expect(window.showErrorMessage).not.toHaveBeenCalled();
        resetVscode();
        const disposed = controllerFixture();
        await disposed.controller.initialize();
        const wait = deferred<WorkspaceCatalog>();
        disposed.files.load.mockReturnValue(wait.promise);
        const work = disposed.controller.focus(Uri.parse(disposed.catalog.roots[1]?.manifestUri ?? ''));
        disposed.controller.dispose();
        wait.resolve(disposed.catalog);
        await work;
        expect(openCalls()).toHaveLength(0);
        expect(window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('rejects a stale result when a second focus supersedes the first', async () => {
        const { controller, files, cache, catalog } = controllerFixture();
        await controller.initialize();
        const pending = deferred<WorkspaceCatalog>();
        files.load.mockReturnValueOnce(pending.promise).mockResolvedValue(catalog);
        const first = controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        const second = controller.focus(Uri.parse(catalog.roots[2]?.manifestUri ?? ''));
        await second;
        pending.resolve(catalog);
        await first;
        expect(openCalls()).toHaveLength(1);
        expect(cache.getOrCreate.mock.calls[0]?.[1].selectedIds).toEqual([appId(3)]);
    });

    it('reports a real staging cleanup failure even if the user cancelled the operation', async () => {
        const { controller, cache, catalog, log } = controllerFixture();
        await controller.initialize();
        cache.getOrCreate.mockImplementation(() => {
            cancelProgress();
            return Promise.reject(new AggregateError([new Error('Ownership marker changed')], 'Cache staging cleanup failed'));
        });
        await controller.focus(Uri.parse(catalog.roots[1]?.manifestUri ?? ''));
        expect(openCalls()).toHaveLength(0);
        expect(window.showErrorMessage).toHaveBeenCalled();
        expect(log.error).toHaveBeenCalled();
    });
});
