import * as vscode from 'vscode';

import { digest, ensureDirectory, isDirectory, isToken, readOptional, relativeParts, sameUri, Stage, variants } from '../host/browserHost';
import { FocusError } from '../shared/focusTypes';
import { errorMessage } from '../shared/errors';
import { readJsoncObject } from '../shared/jsonc';
import { BROWSER_CACHE_DIRECTORY, CACHE_FORMAT_VERSION, EXTENSION_NAME, PATH_POLICY, TRANSFORM_VERSION } from '../shared/settings';
import { cacheInputs, sourceIdentity } from '../workspace/cacheInputs';
import { isDigest, parseMetadata } from '../workspace/cacheMetadata';
import { transformWorkspace } from '../workspace/workspaceTransform';
import { cacheRoot, ensureCacheRoot, hostFingerprint } from './cacheFolders';

import type { WorkspaceUris } from './workspaceOrigin';
import type { ActiveFocus, CacheRecognition, Diagnostic, FocusMetadata, FocusSelection, WorkspaceCatalog } from '../shared/focusTypes';

export interface CacheResult {
    readonly active: ActiveFocus;
    readonly hit: boolean;
    readonly diagnostics: readonly Diagnostic[];
}

export class FocusCache {
    public constructor(private readonly uris: WorkspaceUris) {}

    public async inputHash(catalog: WorkspaceCatalog, selection: FocusSelection, fingerprint: string): Promise<string> {
        return digest(cacheInputs(catalog, selection, fingerprint));
    }

    private async readEntry(root: vscode.Uri, directory: vscode.Uri, signal?: AbortSignal): Promise<ActiveFocus | null> {
        signal?.throwIfAborted();
        const parts = relativeParts(root, directory);
        if (parts?.length !== 3 || !isDigest(parts[0]) || !isDigest(parts[1]) || !isToken(parts[2])) {
            throw new FocusError('invalid-cache-path', 'The cache entry does not have a supported source/selection/publication identity.');
        }
        const directories = [root, vscode.Uri.joinPath(root, parts[0]), vscode.Uri.joinPath(directory, '..'), directory];
        if ((await Promise.all(directories.map(folder => isDirectory(folder)))).includes(false)) {
            return null;
        }
        const workspaceUri = vscode.Uri.joinPath(directory, 'focus.code-workspace');
        const [text, workspaceText] = await Promise.all([
            readOptional(vscode.Uri.joinPath(directory, 'focus.json'), 1024 * 1024, signal),
            readOptional(workspaceUri, 16 * 1024 * 1024, signal)
        ]);
        if (text === null) {
            return null;
        }
        const metadata = parseMetadata(text);
        this.uris.validateOrigin(metadata.origin);
        const fingerprint = await hostFingerprint(metadata.origin);
        if (!sameUri(root, cacheRoot(metadata.origin)) || metadata.hostFingerprint !== fingerprint || metadata.sourceKey !== parts[0] || metadata.inputHash !== parts[1] || await digest(sourceIdentity(metadata.origin, fingerprint)) !== metadata.sourceKey) {
            throw new FocusError('invalid-cache', 'Focus metadata does not match its cache location or original source.');
        }
        const modified = workspaceText === null || await digest(workspaceText) !== metadata.workspaceDigest;
        if (!modified) {
            const { value } = readJsoncObject(workspaceText, 'Cached workspace');
            if (!Array.isArray(value.folders) || value.folders.length !== metadata.roots.length) {
                throw new FocusError('invalid-cache', 'The cached workspace root count does not match its metadata.');
            }
        }
        return { workspaceUri: workspaceUri.toString(), metadata, modified };
    }

    public async recognize(workspaceUri: string | undefined, signal?: AbortSignal): Promise<CacheRecognition> {
        if (workspaceUri === undefined) {
            return { candidate: false, active: null, diagnostic: null };
        }
        const uri = vscode.Uri.parse(workspaceUri, true);
        if (!uri.path.split('/').includes(BROWSER_CACHE_DIRECTORY)) {
            return { candidate: false, active: null, diagnostic: null };
        }
        try {
            this.uris.validate(uri);
            const directory = vscode.Uri.joinPath(uri, '..');
            const root = vscode.Uri.joinPath(directory, '../../..');
            if (this.uris.basename(root) !== BROWSER_CACHE_DIRECTORY || this.uris.basename(uri) !== 'focus.code-workspace') {
                throw new FocusError('invalid-cache-path', 'The active workspace is not a supported focus entry.');
            }
            const active = await this.readEntry(root, directory, signal);
            return {
                candidate: true,
                active,
                diagnostic: active === null ? 'Focus metadata is missing or incomplete. Reopen the original workspace manually.' : active.modified ? 'The focused workspace was modified or removed. It is preserved; validated Unfocus is still available.' : null
            };
        } catch (error) {
            signal?.throwIfAborted();
            return { candidate: true, active: null, diagnostic: `Focus cache cannot be validated: ${errorMessage(error, 'unknown filesystem error')}` };
        }
    }

    public async getOrCreate(catalog: WorkspaceCatalog, selection: FocusSelection, signal: AbortSignal): Promise<CacheResult> {
        this.uris.validateOrigin(catalog.origin);
        const root = await ensureCacheRoot(catalog.origin, signal);
        const fingerprint = await hostFingerprint(catalog.origin);
        const sourceKey = await digest(sourceIdentity(catalog.origin, fingerprint));
        const inputHash = await this.inputHash(catalog, selection, fingerprint);
        const transformed = transformWorkspace(catalog, selection);
        const workspaceDigest = await digest(transformed.text);
        const metadata: FocusMetadata = {
            owner: EXTENSION_NAME,
            formatVersion: CACHE_FORMAT_VERSION,
            transformVersion: TRANSFORM_VERSION,
            pathPolicy: PATH_POLICY,
            hostFingerprint: fingerprint,
            sourceKey,
            inputHash,
            workspaceDigest,
            origin: catalog.origin,
            selectedIds: selection.selectedIds,
            selectedNames: selection.selectedNames,
            options: selection.options,
            roots: selection.roots.map(entry => entry.name),
            appCount: selection.apps.length
        };
        signal.throwIfAborted();
        const directory = vscode.Uri.joinPath(root, sourceKey, inputHash);
        const created = await ensureDirectory(root, directory);
        const diagnostics: Diagnostic[] = [...transformed.diagnostics];
        const current = vscode.workspace.workspaceFile;
        // Another window may publish after the missing-directory check; an immutable duplicate is safe.
        const names = created ? [] : [...await variants(directory)];
        const activeParts = current === undefined ? null : relativeParts(root, current);
        const activeName = activeParts?.[0] === sourceKey && activeParts[1] === inputHash ? activeParts[2] : undefined;
        if (activeName !== undefined && names.includes(activeName)) {
            names.splice(names.indexOf(activeName), 1);
            names.unshift(activeName);
        }
        for (const name of names) {
            signal.throwIfAborted();
            let entry: ActiveFocus | null;
            try {
                entry = await this.readEntry(root, vscode.Uri.joinPath(directory, name), signal);
            } catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof FocusError)) {
                    throw error;
                }
                diagnostics.push({ code: 'preserved-cache', message: `An invalid cache entry was preserved: ${error.message}` });
                continue;
            }
            if (entry !== null && !entry.modified && JSON.stringify(entry.metadata) === JSON.stringify(metadata)) {
                return { active: entry, hit: true, diagnostics };
            }
            if (entry?.modified === true) {
                diagnostics.push({ code: 'preserved-cache', message: 'A modified focus workspace was preserved. A different intact entry will be used.' });
            }
        }
        const stage = await Stage.create(directory);
        try {
            await stage.write('focus.code-workspace', transformed.text, signal);
            // A valid sidecar written last is the logical completion marker, not a filesystem atomicity promise.
            await stage.write('focus.json', JSON.stringify(metadata, null, 4) + '\n', signal);
        } catch (failure) {
            try {
                await stage.remove();
            } catch (error) {
                throw new AggregateError([failure, error], `Cache staging cleanup failed: ${errorMessage(error, 'unknown cleanup error')}`, { cause: error });
            }
            throw failure;
        }
        const active = await this.readEntry(root, stage.directory, signal);
        if (active === null || active.modified || active.metadata.workspaceDigest !== workspaceDigest) {
            throw new FocusError('cache-publication', 'The completed cache entry failed integrity validation and was preserved.');
        }
        return { active, hit: false, diagnostics };
    }
}
