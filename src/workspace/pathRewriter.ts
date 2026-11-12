import { jsonLocation } from '../shared/jsonc';

import type { Diagnostic, WorkspaceRoot } from '../shared/focusTypes';

export interface PathContext {
    readonly roots: ReadonlyMap<number, WorkspaceRoot>;
    readonly retainedIndexes: ReadonlySet<number>;
    readonly removedNames: ReadonlySet<string>;
}

export function createPathContext(originalRoots: readonly WorkspaceRoot[], retainedRoots: readonly WorkspaceRoot[]): PathContext {
    const retainedIndexes = new Set(retainedRoots.map(root => root.index));
    return {
        roots: new Map(originalRoots.map(root => [root.index, root])),
        retainedIndexes,
        removedNames: new Set(originalRoots.filter(root => !retainedIndexes.has(root.index)).map(root => root.name))
    };
}

export interface RewrittenString {
    readonly value: string;
    readonly diagnostics: readonly Diagnostic[];
}

const APP_RELATIVE_AL_SETTINGS = new Set(['al.packageCachePath', 'al.ruleSetPath', 'al.assemblyProbingPaths', 'al.codeAnalyzers']);

export function isAbsolutePath(value: string): boolean {
    return /^[a-z]:[\\/]/i.test(value) || value.startsWith('/') || value.startsWith('\\\\');
}

function isUriOrVariable(value: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.includes('${');
}

export function rewriteString(value: string, path: ReadonlyArray<string | number>, context: PathContext): RewrittenString {
    const diagnostics: Diagnostic[] = [];
    for (const match of value.matchAll(/\$\{workspaceFolder:([^}]+)\}/g)) {
        const name = match[1];
        if (name !== undefined && context.removedNames.has(name)) {
            diagnostics.push({
                code: 'removed-workspace-variable',
                message: `A workspaceFolder variable names removed root ${name}; select that root's app if the variable is required.`,
                location: jsonLocation(path)
            });
        }
    }
    if (path.length === 3 && path[0] === 'folders' && typeof path[1] === 'number' && path[2] === 'path') {
        const root = context.roots.get(path[1]);
        if (root !== undefined && !isAbsolutePath(value) && !isUriOrVariable(value)) {
            return { value: root.absolutePath, diagnostics };
        }
        return { value, diagnostics };
    }
    if (path[0] === 'settings' && typeof path[1] === 'string' && APP_RELATIVE_AL_SETTINGS.has(path[1])) {
        return { value, diagnostics };
    }
    if (isAbsolutePath(value) || isUriOrVariable(value) || /[*?]/.test(value)) {
        return { value, diagnostics };
    }
    if (/^\.\.?[\\/]/.test(value)) {
        diagnostics.push({
            code: 'ambiguous-path',
            message: 'A relative path has setting-specific or ambiguous semantics and was left unchanged. Use an absolute path or a workspaceFolder variable if it is workspace-file-relative.',
            location: jsonLocation(path)
        });
    }
    return { value, diagnostics };
}
