import { readAppManifest, readGuid, compareVersions } from './appManifest';
import { isTestApp, matchTestApp } from './testAppMatcher';
import { FocusError } from '../shared/focusTypes';

import type { App, Diagnostic, FocusSelection, WorkspaceCatalog, WorkspaceOrigin, WorkspaceRoot } from '../shared/focusTypes';
import type { FocusOptions } from '../shared/settings';

function appIndex(apps: readonly App[]): ReadonlyMap<string, App> {
    const byId = new Map<string, App>();
    for (const app of apps) {
        const duplicate = byId.get(app.manifest.id);
        if (duplicate !== undefined) {
            throw new FocusError('duplicate-app-id', `Duplicate app ID ${app.manifest.id}: ${duplicate.root.name} and ${app.root.name}. Fix the original listed roots before focusing.`);
        }
        byId.set(app.manifest.id, app);
    }
    return byId;
}

function validateCycles(apps: readonly App[], byId: ReadonlyMap<string, App>): void {
    const states = new Map<string, 'visiting' | 'visited'>();
    const chain: App[] = [];
    function visit(app: App): void {
        const state = states.get(app.manifest.id);
        if (state === 'visited') {
            return;
        }
        if (state === 'visiting') {
            const start = chain.findIndex(entry => entry.manifest.id === app.manifest.id);
            const cycle = [...chain.slice(start), app].map(entry => entry.root.name).join(' -> ');
            throw new FocusError('dependency-cycle', `The original workspace contains a local dependency cycle: ${cycle}.`);
        }
        states.set(app.manifest.id, 'visiting');
        chain.push(app);
        for (const dependency of app.manifest.dependencies) {
            const local = byId.get(dependency.id);
            if (local !== undefined) {
                visit(local);
            }
        }
        chain.pop();
        states.set(app.manifest.id, 'visited');
    }
    for (const app of apps) {
        visit(app);
    }
}

export function createCatalog(origin: WorkspaceOrigin, workspaceText: string, roots: readonly WorkspaceRoot[]): WorkspaceCatalog {
    const apps: App[] = [];
    for (const root of roots) {
        if (root.manifestText !== null) {
            const manifest = readAppManifest(root.manifestText, root.manifestUri);
            apps.push({ root, manifest, isTest: isTestApp(root.folderName, manifest.name) });
        }
    }
    const byId = appIndex(apps);
    validateCycles(apps, byId);
    return { origin, workspaceText, roots, apps, byId };
}

export function resolveFocus(catalog: WorkspaceCatalog, requestedIds: readonly string[], options: FocusOptions): FocusSelection {
    const selectedIds = [...new Set(requestedIds.map(id => readGuid(id, 'Selected app ID')))].sort();
    if (selectedIds.length === 0) {
        throw new FocusError('empty-selection', 'Select at least one app to focus.');
    }
    const byId = catalog.byId;
    const selected = selectedIds.map(id => {
        const app = byId.get(id);
        if (app === undefined) {
            throw new FocusError('selected-app-missing', `Selected app ${id} is no longer listed in the original workspace. Choose the focus again.`);
        }
        return app;
    });
    const diagnostics: Diagnostic[] = [];
    const seeds = [...selected];
    if (options.includeTests) {
        for (const production of selected.filter(app => !app.isTest)) {
            const match = matchTestApp(production, catalog.apps);
            if (match.app !== null) {
                seeds.push(match.app);
            }
            if (match.diagnostic !== null) {
                diagnostics.push(match.diagnostic);
            }
        }
    }
    const included = new Set<string>();
    function include(app: App): void {
        if (included.has(app.manifest.id)) {
            return;
        }
        included.add(app.manifest.id);
        for (const dependency of app.manifest.dependencies) {
            const local = byId.get(dependency.id);
            if (local === undefined) {
                diagnostics.push({
                    code: 'external-dependency',
                    message: `${app.root.name} requests ${dependency.name} (${dependency.publisher}), ID ${dependency.id}, version ${dependency.version}; it is not a listed local app. No folder is added or package downloaded.`
                });
                continue;
            }
            if (local.manifest.name !== dependency.name || local.manifest.publisher !== dependency.publisher) {
                diagnostics.push({
                    code: 'dependency-identity',
                    message: `${app.root.name} requests ${dependency.name} (${dependency.publisher}), ID ${dependency.id}; the listed app is ${local.manifest.name} (${local.manifest.publisher}). The ID is used for dependency resolution.`
                });
            }
            if (compareVersions(local.manifest.version, dependency.version) !== 0) {
                const constraint = compareVersions(local.manifest.version, dependency.version) < 0 ? 'is below the required minimum' : 'differs from the requested minimum';
                diagnostics.push({
                    code: 'dependency-version',
                    message: `${app.root.name} requests ID ${dependency.id}, version ${dependency.version}; listed ${local.root.name} version ${local.manifest.version} ${constraint}.`
                });
            }
            include(local);
        }
    }
    for (const app of seeds) {
        include(app);
    }
    const apps = catalog.apps.filter(app => included.has(app.manifest.id));
    const includedRootIndexes = new Set(apps.map(app => app.root.index));
    return {
        selectedIds,
        selectedNames: selected.map(app => app.root.name),
        apps,
        roots: catalog.roots.filter(root => root.manifestText === null || includedRootIndexes.has(root.index)),
        diagnostics,
        options
    };
}
