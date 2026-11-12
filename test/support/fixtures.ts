import { createCatalog } from '../../src/al/dependencyGraph';

import type { AppDependency, WorkspaceCatalog, WorkspaceOrigin, WorkspaceRoot } from '../../src/shared/focusTypes';

export interface RootOptions {
    readonly id?: string | null;
    readonly manifestName?: string;
    readonly publisher?: string;
    readonly version?: string;
    readonly dependencies?: readonly AppDependency[];
    readonly folderName?: string;
    readonly absolutePath?: string;
    readonly uri?: string;
    readonly entry?: Readonly<Record<string, unknown>>;
}

export const ORIGIN: WorkspaceOrigin = { kind: 'workspace', uri: 'file:///repo/source.code-workspace', label: 'source.code-workspace' };

export function appId(number: number): string {
    return `00000000-0000-0000-0000-${number.toString(16).padStart(12, '0')}`;
}

export function manifestText(overrides: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({ id: appId(1), name: 'WMS', publisher: 'Publisher', version: '1.2.3.4', dependencies: [], ...overrides });
}

export function rootFixture(index: number, name: string, options: RootOptions = {}): WorkspaceRoot {
    const folderName = options.folderName ?? name;
    const uri = options.uri ?? `file:///repo/${encodeURIComponent(folderName)}`;
    return {
        index,
        uri,
        manifestUri: `${uri}/app.json`,
        absolutePath: options.absolutePath ?? `/repo/${folderName}`,
        folderName,
        name,
        entry: options.entry ?? { path: folderName, name },
        manifestText: options.id === null ? null : manifestText({
            id: options.id ?? appId(index + 1),
            name: options.manifestName ?? name,
            publisher: options.publisher ?? 'Publisher',
            version: options.version ?? '1.2.3.4',
            dependencies: options.dependencies ?? []
        })
    };
}

export function dependency(id: string, name: string, version = '1.2.3.4', publisher = 'Publisher'): AppDependency {
    return { id, name, publisher, version };
}

export function catalogFixture(roots: readonly WorkspaceRoot[], extra: Readonly<Record<string, unknown>> = {}, origin = ORIGIN): WorkspaceCatalog {
    return createCatalog(origin, JSON.stringify({ folders: roots.map(root => root.entry), ...extra }, null, 4) + '\n', roots);
}
