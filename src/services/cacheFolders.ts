import * as vscode from 'vscode';

import { digest, ensureDirectory, errorCode, normalizedUri, orMissing, randomToken, readOptional, sameUri } from '../host/browserHost';
import { FocusError } from '../shared/focusTypes';
import { errorMessage } from '../shared/errors';
import { BROWSER_CACHE_DIRECTORY } from '../shared/settings';
import { filesystemHost } from './workspaceOrigin';

import type { WorkspaceOrigin } from '../shared/focusTypes';

function cacheBase(origin: WorkspaceOrigin): vscode.Uri {
    const uri = vscode.Uri.parse(origin.uri, true);
    return normalizedUri(origin.kind === 'workspace' ? vscode.Uri.joinPath(uri, '..') : uri);
}

export function cacheRoot(origin: WorkspaceOrigin): vscode.Uri {
    return normalizedUri(vscode.Uri.joinPath(cacheBase(origin), BROWSER_CACHE_DIRECTORY));
}

export function hostFingerprint(origin: WorkspaceOrigin): Promise<string> {
    const identity = filesystemHost(vscode.Uri.parse(origin.uri, true));
    // 0.5.x hashed the root after a string round trip; keeping it leaves existing fingerprints byte-identical.
    const root = normalizedUri(vscode.Uri.parse(cacheRoot(origin).toString(), true)).toString();
    return digest(JSON.stringify({ scheme: identity.scheme, authority: identity.authority, cacheRoot: root }));
}

async function removeTemporary(uri: vscode.Uri, failure: unknown): Promise<void> {
    try {
        await orMissing(vscode.workspace.fs.delete(uri, { recursive: false }));
    } catch (error) {
        throw new AggregateError(failure === undefined ? [error] : [failure, error], `Cache setup cleanup failed: ${errorMessage(error, 'unknown cleanup error')}`);
    }
}

function assertSaved(target: vscode.Uri, label: string): void {
    if (vscode.workspace.textDocuments.some(document => document.isDirty && sameUri(document.uri, target))) {
        throw new FocusError('dirty-cache-file', `Save or close the unsaved edits to ${label} before retrying. Focus never saves or discards these edits.`);
    }
}

async function writeImmutable(target: vscode.Uri, payload: string, label: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    assertSaved(target, label);
    const existing = await readOptional(target, 65536, signal);
    assertSaved(target, label);
    if (existing !== null) {
        if (existing !== payload) {
            throw new FocusError('invalid-cache-state', `${label} was modified and has been preserved. Restore the generated file before retrying.`);
        }
        return;
    }
    const temporary = vscode.Uri.joinPath(target, '..', `${randomToken()}.tmp`);
    let moved = false;
    let failure: unknown;
    try {
        signal.throwIfAborted();
        await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(payload));
        signal.throwIfAborted();
        assertSaved(target, label);
        try {
            await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
            moved = true;
        } catch (error) {
            if (errorCode(error) !== 'FileExists') {
                throw error;
            }
            if (await readOptional(target, 65536, signal) !== payload) {
                throw new FocusError('invalid-cache-state', `${label} was changed by another writer and has been preserved.`);
            }
        }
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (!moved) {
            await removeTemporary(temporary, failure);
        }
    }
}

export async function ensureCacheRoot(origin: WorkspaceOrigin, signal: AbortSignal): Promise<vscode.Uri> {
    signal.throwIfAborted();
    const base = cacheBase(origin);
    if (vscode.workspace.fs.isWritableFileSystem(base.scheme) === false) {
        throw new FocusError('readonly-cache', 'The original workspace filesystem is read-only; its .focussed cache cannot be created.');
    }
    const info = await vscode.workspace.fs.stat(base);
    if ((info.type & vscode.FileType.Directory) === 0) {
        throw new FocusError('missing-cache-folder', 'The original workspace directory is unavailable; its .focussed cache cannot be created.');
    }
    signal.throwIfAborted();
    const root = cacheRoot(origin);
    await ensureDirectory(root, root);
    await writeImmutable(vscode.Uri.joinPath(root, '.gitignore'), '*\n', 'The generated .focussed/.gitignore', signal);
    signal.throwIfAborted();
    return root;
}
