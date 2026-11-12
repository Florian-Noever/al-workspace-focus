import * as vscode from 'vscode';
import pMap from 'p-map';

import { createCatalog } from '../al/dependencyGraph';
import { uriKey } from '../host/browserHost';
import { FocusError, isRecord } from '../shared/focusTypes';
import { errorMessage } from '../shared/errors';
import { decodeUtf8, readJsoncObject } from '../shared/jsonc';
import type { WorkspaceUris } from './workspaceOrigin';

import type { WorkspaceCatalog, WorkspaceOrigin, WorkspaceRoot } from '../shared/focusTypes';

function isMissing(error: unknown): boolean {
    return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

export class WorkspaceFiles {
    public constructor(private readonly uris: WorkspaceUris) {}

    private assertSaved(resources: readonly vscode.Uri[]): void {
        const dirty = vscode.workspace.textDocuments.find(document => document.isDirty && resources.some(uri => this.uris.same(document.uri, uri)));
        if (dirty !== undefined) {
            throw new FocusError('dirty-source', `Save the unsaved workspace or app.json (${dirty.uri.toString()}) and retry. Focus never saves or discards source edits.`);
        }
    }

    private async readText(uri: vscode.Uri, label: string, signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        this.assertSaved([uri]);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            signal.throwIfAborted();
            this.assertSaved([uri]);
            return decodeUtf8(bytes, label);
        } catch (error) {
            if (error instanceof FocusError || signal.aborted) {
                throw error;
            }
            throw new FocusError('source-read', `${label} could not be read at ${uri.toString()}. ${errorMessage(error, 'The filesystem returned an unknown error.')}`);
        }
    }

    private async manifestText(uri: vscode.Uri, signal: AbortSignal): Promise<string | null> {
        signal.throwIfAborted();
        this.assertSaved([uri]);
        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(uri);
        } catch (error) {
            if (isMissing(error)) {
                return null;
            }
            throw new FocusError('manifest-read', `Cannot read listed root manifest ${uri.toString()}. ${errorMessage(error, 'The filesystem returned an unknown error.')}`);
        }
        signal.throwIfAborted();
        this.assertSaved([uri]);
        return decodeUtf8(bytes, uri.toString());
    }

    private async readRoot(origin: WorkspaceOrigin, value: unknown, index: number, signal: AbortSignal): Promise<WorkspaceRoot> {
        if (!isRecord(value)) {
            throw new FocusError('invalid-workspace', `Original folders[${index.toString()}] must contain an object.`);
        }
        if (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim().length === 0)) {
            throw new FocusError('invalid-workspace', `Original folders[${index.toString()}].name must be a nonempty string.`);
        }
        const uri = this.uris.resolveFolder(origin, value);
        signal.throwIfAborted();
        const manifestUri = vscode.Uri.joinPath(uri, 'app.json');
        const manifestText = await this.manifestText(manifestUri, signal);
        signal.throwIfAborted();
        // A readable manifest already requires a directory; only non-app roots need a separate stat.
        if (manifestText === null) {
            try {
                const info = await vscode.workspace.fs.stat(uri);
                if ((info.type & vscode.FileType.Directory) === 0) {
                    throw new FocusError('invalid-root', `Listed root ${uri.toString()} is not a directory.`);
                }
            } catch (error) {
                if (error instanceof FocusError) {
                    throw error;
                }
                throw new FocusError('root-read', `Listed root ${uri.toString()} is missing or unreadable. Restore it or remove it from the original workspace before focusing.`);
            }
        }
        const folderName = this.uris.basename(uri);
        return {
            index,
            uri: uri.toString(),
            manifestUri: manifestUri.toString(),
            absolutePath: this.uris.pathValue(uri),
            folderName,
            name: typeof value.name === 'string' ? value.name : folderName,
            entry: value,
            manifestText
        };
    }

    public assertCatalogSaved(catalog: WorkspaceCatalog): void {
        const resources = catalog.roots.map(root => vscode.Uri.parse(root.manifestUri, true));
        if (catalog.origin.kind === 'workspace') {
            resources.push(vscode.Uri.parse(catalog.origin.uri, true));
        }
        this.assertSaved(resources);
    }

    public async load(origin: WorkspaceOrigin, signal: AbortSignal): Promise<WorkspaceCatalog> {
        this.uris.validateOrigin(origin);
        const originUri = vscode.Uri.parse(origin.uri, true);
        const workspaceText = origin.kind === 'workspace' ? await this.readText(originUri, 'Original workspace', signal) : JSON.stringify({ folders: [{ uri: originUri.toString(), name: origin.label }] }, null, 4) + '\n';
        const { value } = readJsoncObject(workspaceText, 'Original workspace');
        const folderValues = value.folders;
        if (!Array.isArray(folderValues) || folderValues.length === 0 || folderValues.length > 10000) {
            throw new FocusError('invalid-workspace', 'The original workspace must list between 1 and 10000 folder roots.');
        }
        if (value.settings !== undefined && !isRecord(value.settings)) {
            throw new FocusError('invalid-workspace', 'The original workspace settings must be an object.');
        }
        const roots = await pMap(folderValues, (value: unknown, index) => this.readRoot(origin, value, index, signal), { concurrency: 64, stopOnError: true, signal });
        signal.throwIfAborted();
        const duplicates = new Set<string>();
        for (const root of roots) {
            const key = uriKey(vscode.Uri.parse(root.uri, true));
            if (duplicates.has(key)) {
                throw new FocusError('duplicate-root', `Original folder ${root.name} is listed more than once.`);
            }
            duplicates.add(key);
        }
        const catalog = createCatalog(origin, workspaceText, roots);
        this.assertCatalogSaved(catalog);
        if (origin.kind === 'workspace' && await this.readText(originUri, 'Original workspace', signal) !== workspaceText) {
            throw new FocusError('source-changed', 'The original workspace changed while its catalog was being read. Retry Focus.');
        }
        if (catalog.apps.length === 0) {
            throw new FocusError('no-listed-apps', origin.kind === 'folder' ? 'This folder itself has no app.json. Open a multi-root .code-workspace that explicitly lists the app folders; Focus does not recursively scan a repository.' : 'None of the original listed folder roots directly contains app.json. Add the app folders to the original workspace; Focus does not recursively discover apps.');
        }
        return catalog;
    }
}
