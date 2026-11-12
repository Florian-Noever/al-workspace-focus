import * as vscode from 'vscode';

import { FocusError } from '../shared/focusTypes';
import { sameUri } from '../host/browserHost';
import { BROWSER_CACHE_DIRECTORY } from '../shared/settings';

import type { FilesystemHost } from '../host/browserHost';
import type { CacheRecognition, WorkspaceOrigin } from '../shared/focusTypes';

export function filesystemHost(uri: vscode.Uri | undefined): FilesystemHost {
    if (uri?.scheme === 'vscode-remote') {
        return { scheme: 'vscode-remote', authority: uri.authority };
    }
    return { scheme: 'file', authority: '' };
}

export class WorkspaceUris {
    public constructor(private readonly identity: FilesystemHost) {}

    public validate(uri: vscode.Uri): void {
        const sameHost = this.identity.scheme === 'file' ? uri.scheme === 'file' : uri.scheme === 'vscode-remote' && uri.authority === this.identity.authority;
        if (!sameHost || uri.query.length > 0 || uri.fragment.length > 0 || uri.path.includes('\0') || !uri.path.startsWith('/')) {
            throw new FocusError('unsupported-host', 'A focus requires an absolute filesystem URI on one filesystem host and remote authority. Local, remote and virtual roots cannot be mixed.');
        }
    }

    public basename(uri: vscode.Uri): string {
        return uri.path.slice(uri.path.lastIndexOf('/') + 1);
    }

    public pathValue(uri: vscode.Uri): string {
        if (/^\/[a-z]:\//i.test(uri.path)) {
            return uri.path.slice(1).replace(/\//g, '\\');
        }
        return uri.scheme === 'file' && uri.authority.length > 0 ? `\\\\${uri.authority}${uri.path.replace(/\//g, '\\')}` : uri.path;
    }

    public validateOrigin(origin: WorkspaceOrigin): void {
        const uri = vscode.Uri.parse(origin.uri, true);
        this.validate(uri);
        if (vscode.Uri.joinPath(uri, '.').path.split('/').includes(BROWSER_CACHE_DIRECTORY)) {
            throw new FocusError('invalid-cache-origin', 'Cached metadata points back into the focus cache instead of an original workspace or folder.');
        }
        if (origin.kind === 'workspace' && !uri.path.toLowerCase().endsWith('.code-workspace')) {
            throw new FocusError('invalid-cache-origin', 'Cached metadata does not identify a saved .code-workspace file.');
        }
    }

    public same(left: vscode.Uri, right: vscode.Uri): boolean {
        return sameUri(left, right);
    }

    public resolveFolder(origin: WorkspaceOrigin, entry: Readonly<Record<string, unknown>>): vscode.Uri {
        const pathValue = entry.path;
        const uriValue = entry.uri;
        const hasPath = Object.hasOwn(entry, 'path');
        const hasUri = Object.hasOwn(entry, 'uri');
        if (hasPath === hasUri || (hasPath && typeof pathValue !== 'string') || (hasUri && typeof uriValue !== 'string')) {
            throw new FocusError('invalid-workspace', 'Each original folder entry must have exactly one string path or uri.');
        }
        let uri: vscode.Uri;
        if (typeof uriValue === 'string') {
            uri = vscode.Uri.parse(uriValue, true);
        } else if (typeof pathValue === 'string' && pathValue.length > 0 && !pathValue.includes('${') && !/^[a-z]:[^\\/]/i.test(pathValue)) {
            const source = vscode.Uri.parse(origin.uri, true);
            const base = origin.kind === 'workspace' ? vscode.Uri.joinPath(source, '..') : source;
            const value = pathValue.replace(/\\/g, '/');
            if (/^[a-z]:\//i.test(value)) {
                uri = base.with({ path: `/${value}` });
            } else if (value.startsWith('//') && base.scheme === 'file') {
                const separator = value.indexOf('/', 2);
                if (separator < 0) {
                    throw new FocusError('invalid-workspace', 'A UNC folder path must contain a share.');
                }
                uri = base.with({ authority: value.slice(2, separator), path: value.slice(separator) });
            } else {
                uri = value.startsWith('/') ? base.with({ path: value }) : vscode.Uri.joinPath(base, value);
            }
        } else {
            throw new FocusError('invalid-workspace', 'An original folder path is empty, uses an unresolved variable or is drive-relative. Use a concrete folder path or URI in the original workspace.');
        }
        this.validate(uri);
        return uri;
    }
}

export function currentOrigin(recognition: CacheRecognition, uris: Pick<WorkspaceUris, 'validateOrigin' | 'validate'>): WorkspaceOrigin {
    if (recognition.active !== null) {
        uris.validateOrigin(recognition.active.metadata.origin);
        return recognition.active.metadata.origin;
    }
    if (recognition.candidate) {
        throw new FocusError('lost-origin', recognition.diagnostic ?? 'Focus metadata is unavailable. Reopen the original saved workspace or folder manually.');
    }
    const workspaceFile = vscode.workspace.workspaceFile;
    if (workspaceFile !== undefined) {
        if (workspaceFile.scheme === 'untitled') {
            throw new FocusError('untitled-workspace', 'Save this workspace as a .code-workspace file, then retry Focus. The extension never silently saves an untitled workspace.');
        }
        uris.validate(workspaceFile);
        return { kind: 'workspace', uri: workspaceFile.toString(), label: workspaceFile.path.slice(workspaceFile.path.lastIndexOf('/') + 1) };
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0] === undefined) {
        throw new FocusError('no-origin', 'Open a saved multi-root AL workspace or an individual app folder before focusing.');
    }
    uris.validate(folders[0].uri);
    return { kind: 'folder', uri: folders[0].uri.toString(), label: folders[0].name };
}
