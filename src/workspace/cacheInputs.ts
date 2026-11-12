import { CACHE_FORMAT_VERSION, PATH_POLICY, TRANSFORM_VERSION } from '../shared/settings';

import type { FocusSelection, WorkspaceCatalog, WorkspaceOrigin } from '../shared/focusTypes';

export function sourceIdentity(origin: WorkspaceOrigin, hostFingerprint: string): string {
    return JSON.stringify({ origin: { kind: origin.kind, uri: origin.uri }, hostFingerprint });
}

export function cacheInputs(catalog: WorkspaceCatalog, selection: FocusSelection, hostFingerprint: string): string {
    return JSON.stringify({
        formatVersion: CACHE_FORMAT_VERSION,
        transformVersion: TRANSFORM_VERSION,
        pathPolicy: PATH_POLICY,
        source: sourceIdentity(catalog.origin, hostFingerprint),
        workspaceText: catalog.workspaceText,
        roots: catalog.roots.map(root => ({
            entry: root.entry,
            uri: root.uri,
            manifest: root.manifestText === null ? { kind: 'no-manifest' } : { kind: 'manifest', text: root.manifestText }
        })),
        selectedIds: [...selection.selectedIds].sort(),
        options: { includeTests: selection.options.includeTests }
    });
}
